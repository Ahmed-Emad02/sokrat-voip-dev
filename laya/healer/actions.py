"""
Laya Healer — Concrete Remediation Actions
Implements targeted, safe recovery actions adhering strictly to Asterisk driver safety.
"""

import time
import os
import urllib.request
import urllib.parse
import json
import socket
from laya.sensors.cli import (
    send_dongle_at_command,
    hangup_asterisk_channel,
    restart_dongle_module,
    parse_active_channels
)
from laya.sensors.sysfs import (
    find_modem_sysfs_for_port,
    find_modem_sysfs_for_dongle,
    get_dongles_sharing_sysfs_device,
    get_usb_raw_dev_node,
    trigger_usbdevfs_reset
)
from laya.sensors.db import (
    record_maintenance_event,
    update_maintenance_event_result,
    get_alert_settings
)

def send_telegram_notification(bot_token, chat_id, message_html, timeout=8):
    """
    Sends an HTML alert via Telegram Bot API using Python standard library.
    """
    if not bot_token or not chat_id:
        return False, "Missing bot_token or chat_id"
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": message_html,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            res_body = response.read().decode("utf-8")
            res_json = json.loads(res_body)
            if res_json.get("ok"):
                msg_id = res_json.get("result", {}).get("message_id")
                return True, f"Telegram message sent (ID: {msg_id})"
            return False, f"Telegram response not ok: {res_body}"
    except Exception as e:
        return False, f"Telegram HTTP error: {e}"

def is_call_active_on_dongle(dongle_id):
    """
    STRICT ISOLATION GUARD: Returns True if there is ANY live call leg on this dongle.
    Never restart or reset a dongle while an active call is running!
    """
    channels = parse_active_channels()
    target = dongle_id.lower().strip()
    for ch in channels:
        if ch.get("dongle_id") == target:
            if ch.get("state") in ("Up", "Ringing", "Ring", "Dialing") or ch.get("bridged"):
                return True
    return False

def action_soft_at_probe(dongle_id, reason="Soft AT status inquiry"):
    """
    Level 1: Soft inquiry via AT command to wake modem state machine.
    Isolated strictly to target dongle_id.
    """
    target = dongle_id.lower().strip()
    if is_call_active_on_dongle(target):
        return False, f"Skipped AT probe: Active call on {target}"

    event_id = record_maintenance_event(
        dongle_name=target,
        trigger_reason=reason,
        recovery_level=1,
        action_taken=f"Soft AT Query ({target}: AT+CPAS & AT+CSQ)",
        result="in_progress"
    )
    
    success1, resp1, _ = send_dongle_at_command(target, "AT+CPAS")
    success2, resp2, _ = send_dongle_at_command(target, "AT+CSQ")
    
    ok = success1 or success2
    result_str = "success" if ok else "failed"
    details = f"CPAS: {resp1} | CSQ: {resp2}"
    update_maintenance_event_result(event_id, result_str, details)
    return ok, details

def action_hangup_channel(dongle_id, channel_name, reason="Hangup orphaned channel"):
    """
    Level 2: Target single orphaned channel leg without restarting modem.
    STRICT ISOLATION GUARD: Verifies channel_name strictly belongs to dongle_id.
    """
    target = dongle_id.lower().strip()
    safe_prefix = f"dongle/{target}-"
    if not channel_name or not channel_name.lower().startswith(safe_prefix):
        details = f"Safety Abort: Channel '{channel_name}' does not belong to {dongle_id}. Aborting to protect other calls."
        record_maintenance_event(target, reason, 2, "Channel Request Hangup (Aborted)", "failed", details)
        return False, details

    event_id = record_maintenance_event(
        dongle_name=target,
        trigger_reason=reason,
        recovery_level=2,
        action_taken=f"Channel Request Hangup ({channel_name})",
        result="in_progress"
    )
    
    success, stdout, stderr = hangup_asterisk_channel(channel_name)
    result_str = "success" if success else "failed"
    details = stdout or stderr or "Hangup requested"
    update_maintenance_event_result(event_id, result_str, details)
    return success, details

def action_restart_dongle(dongle_id, reason="Targeted dongle restart"):
    """
    Level 3: Safe targeted restart of only the affected dongle in chan_dongle.
    Never restarts all dongles.
    """
    target = dongle_id.lower().strip()
    if not target or not target.startswith("dongle"):
        return False, "Safety Abort: Invalid dongle identifier"

    if is_call_active_on_dongle(target):
        details = f"Aborted restart: Active voice call in progress on {target}"
        record_maintenance_event(target, reason, 3, f"Dongle Restart ({target})", "failed", details)
        return False, details

    event_id = record_maintenance_event(
        dongle_name=target,
        trigger_reason=reason,
        recovery_level=3,
        action_taken=f"Dongle Restart Now ({target})",
        result="in_progress"
    )
    
    success, stdout, stderr = restart_dongle_module(target)
    time.sleep(2)
    result_str = "success" if success else "failed"
    details = stdout or stderr or "Restart signal emitted"
    update_maintenance_event_result(event_id, result_str, details)
    return success, details

def action_sysfs_usb_reset(dongle_id, audio_port=None, reason="Hardware sysfs USB bus reset", data_port=None):
    """
    Level 4: Kernel-level hardware USB bus reset (USBDEVFS_RESET) and driver re-bind.
    STRICT MULTI-DONGLE ISOLATION:
      1. Resolves USB sysfs path ONLY from ports configured for THIS dongle in dongle.conf.
      2. Checks all shared dongles on this physical USB device to ensure NONE have active calls.
      3. Sends hardware USBDEVFS_RESET ioctl directly to physical /dev/bus/usb node (Layer 2).
      4. Re-binds sysfs driver to refresh kernel interfaces.
      5. Only re-inits the affected dongles in Asterisk.
      6. Verifies the modem actually came back before reporting success.
    """
    target = dongle_id.lower().strip()
    if is_call_active_on_dongle(target):
        details = f"Aborted USB reset: Active voice call in progress on {target}"
        record_maintenance_event(target, reason, 4, f"Sysfs USB Rebind ({target})", "failed", details)
        return False, details

    # Strictly locate USB sysfs path for this dongle's configured ports only
    sysfs_name, _ = find_modem_sysfs_for_dongle(target, audio_port, data_port)
    if not sysfs_name:
        details = f"Safety Abort: Cannot verify physical USB sysfs device for {target}. Aborting to protect other dongles."
        record_maintenance_event(target, reason, 4, f"Sysfs USB Rebind ({target})", "failed", details)
        return False, details

    # Check for any shared dongles on this physical device
    shared_dongles = get_dongles_sharing_sysfs_device(sysfs_name)
    for other in shared_dongles:
        if other != target and is_call_active_on_dongle(other):
            details = f"Safety Abort: USB device {sysfs_name} is shared with '{other}' which has an active call. Aborting."
            record_maintenance_event(target, reason, 4, f"Sysfs USB Rebind ({target})", "failed", details)
            return False, details

    event_id = record_maintenance_event(
        dongle_name=target,
        trigger_reason=reason,
        recovery_level=4,
        action_taken=f"Hardware USB Bus Reset ({sysfs_name})",
        result="in_progress"
    )

    # 1. Execute Layer 2 Hardware Bus Reset via raw device node if available
    raw_node = get_usb_raw_dev_node(sysfs_name)
    hw_reset_msg = ""
    hw_reset_ok = False
    if raw_node:
        hw_reset_ok, hw_msg = trigger_usbdevfs_reset(raw_node)
        hw_reset_msg = f" [USBDEVFS_RESET: {'OK' if hw_reset_ok else hw_msg}]"
        time.sleep(1)

    # 2. Kernel driver unbind & re-bind
    unbind_path = "/sys/bus/usb/drivers/usb/unbind"
    bind_path = "/sys/bus/usb/drivers/usb/bind"

    try:
        if os.path.exists(unbind_path) and os.path.exists(bind_path):
            with open(unbind_path, "w") as f:
                f.write(sysfs_name)
            time.sleep(2)
            with open(bind_path, "w") as f:
                f.write(sysfs_name)
            time.sleep(3)
            # Re-init ONLY the affected dongles in Asterisk
            restarted = []
            for d in (shared_dongles or [target]):
                restart_dongle_module(d)
                restarted.append(d)

            # 3. Post-heal verification: the modem must actually come back.
            recovered, verify_details = verify_dongle_recovered(target, timeout=45)
            summary_details = f"Rebound {sysfs_name}{hw_reset_msg}; restarted {', '.join(restarted)}; {verify_details}"
            if recovered:
                update_maintenance_event_result(event_id, "success", summary_details)
                return True, summary_details
            else:
                update_maintenance_event_result(event_id, "failed", summary_details)
                return False, summary_details
        else:
            details = "Sysfs driver unbind/bind paths not writable"
            update_maintenance_event_result(event_id, "failed", details)
            return False, details
    except Exception as e:
        details = f"Sysfs reset error: {str(e)}"
        update_maintenance_event_result(event_id, "failed", details)
        return False, details

def verify_dongle_recovered(dongle_id, timeout=45, poll_interval=3):
    """
    Post-heal verification: waits for the modem to return to a usable state.

    A recovery action is only reported as successful when the modem actually
    re-registers with the carrier. Without this, a failed hardware reset would
    still be logged as 'success' and would burn a recovery rung silently.

    Returns (recovered: bool, details: str).
    """
    from laya.sensors.cli import parse_dongle_devices_summary

    target = dongle_id.lower().strip()
    deadline = time.time() + timeout
    last_state = "Unknown"

    while time.time() < deadline:
        for dev in parse_dongle_devices_summary():
            if dev.get("id", "").lower() == target:
                last_state = dev.get("state", "Unknown")
                if last_state in ("Free", "Active"):
                    return True, f"Recovered: {target} is '{last_state}' (RSSI {dev.get('rssi', 0)})"
                break
        time.sleep(poll_interval)

    return False, f"NOT recovered: {target} still '{last_state}' after {timeout}s"

def action_escalate_alert(dongle_id, reason, details="", dry_run=False):
    """
    Level 5: Critical escalation record when all lower levels fail.
    Dispatches immediate Telegram alarm to operator (supports dry_run mode for tests).
    """
    event_id = record_maintenance_event(
        dongle_name=dongle_id,
        trigger_reason=reason,
        recovery_level=5,
        action_taken="Escalate Critical Alert (Telegram)" if not dry_run else "Escalate Critical Alert (Dry-Run)",
        result="in_progress",
        details=details
    )

    alert_cfg = get_alert_settings()
    now_str = time.strftime("%Y-%m-%d %H:%M:%S")
    host_name = socket.gethostname() or "sokrat-pbx"
    client_label = alert_cfg.get("client_name") or host_name

    msg_html = (
        f"🚨 <b>[Sokrat VoIP · LAYA AGENT] Critical Cellular Escalation</b>\n\n"
        f"<b>Server / Host:</b> <code>{host_name}</code> ({client_label})\n"
        f"<b>Target Modem:</b> <code>{dongle_id}</code>\n"
        f"<b>Escalation Level:</b> <b>Level 5 (Hardware Escalation)</b>\n"
        f"<b>Anomaly Trigger:</b> <i>{reason}</i>\n"
        f"<b>Autonomous Interventions Attempted:</b>\n"
        f"  • Level 1: Soft AT Inquiries (CPAS/CSQ) ❌\n"
        f"  • Level 2: Orphan Channel Terminations ❌\n"
        f"  • Level 3: Targeted Dongle Restarts ❌\n"
        f"  • Level 4: Hardware USB Bus Reset (USBDEVFS_RESET + sysfs rebind) ❌\n\n"
        f"<b>Diagnostic Telemetry:</b>\n"
        f"<code>{details or 'Repeated hardware or carrier timeouts'}</code>\n\n"
        f"<b>Required Action:</b> Please inspect physical modem USB connection or SIM card seating.\n"
        f"<b>Timestamp:</b> <code>{now_str}</code>"
    )

    if dry_run:
        tg_ok, tg_info = True, "Simulated Telegram dispatch (dry-run mode, no message sent)"
    else:
        tg_ok, tg_info = False, "Telegram disabled in settings"
        if alert_cfg.get("telegram_enabled"):
            tg_ok, tg_info = send_telegram_notification(
                alert_cfg.get("telegram_bot_token"),
                alert_cfg.get("telegram_chat_id"),
                msg_html
            )

    res_str = "success" if tg_ok else "failed"
    update_maintenance_event_result(event_id, res_str, tg_info)
    return tg_ok, tg_info

# =============================================================================
# Layer 4 — Baseband Hygiene Actions
# =============================================================================

def snapshot_modem_identity(dongle_id):
    """
    Captures the modem's identity fingerprint (IMEI / IMSI / model / firmware /
    subscriber number) so that a post-action verification can prove the SAME
    physical modem and SAME SIM came back.

    Without this check a driver that silently re-binds to the wrong USB device
    would look like a successful recovery.

    Returns a dict snapshot (empty values when unavailable).
    """
    from laya.sensors.cli import get_dongle_device_state

    detail = get_dongle_device_state(dongle_id) or {}
    return {
        "imei": detail.get("imei"),
        "imsi": detail.get("imsi"),
        "model": detail.get("model"),
        "firmware": detail.get("firmware"),
        "subscriber_number": detail.get("subscriber_number"),
        "state": detail.get("state"),
    }

def verify_modem_identity(dongle_id, snapshot):
    """
    Verifies that the modem that came back carries the SAME identity as the
    snapshot taken before the action.

    Returns (ok: bool, details: str).
    """
    from laya.sensors.cli import get_dongle_device_state

    detail = get_dongle_device_state(dongle_id) or {}
    if not detail:
        return False, "Modem state could not be read after the action"

    problems = []
    for field in ("imei", "imsi"):
        before = (snapshot or {}).get(field)
        after = detail.get(field)
        if before and after and before != after:
            problems.append(f"{field} changed {before} -> {after}")

    state = (detail.get("state") or "").lower()
    if "not connected" in state or "not initialized" in state:
        problems.append(f"state is '{detail.get('state')}'")

    if problems:
        return False, "; ".join(problems)
    return True, (f"identity verified (IMEI {detail.get('imei')}, "
                  f"IMSI {detail.get('imsi')}, state '{detail.get('state')}')")

def action_cfun_restart(dongle_id, reason="Baseband radio stack re-attach (AT+CFUN=1)"):
    """
    Layer 4-A: SAFE baseband hygiene.

    Sends AT+CFUN=1 which restarts ONLY the radio / protocol stack. The USB
    composite device is NOT rebooted, so the modem never drops off the bus,
    never loses its USB session and never requires a physical replug.

    Verified on Huawei E173 hardware: the modem answers 'OK', stays on the bus,
    keeps its IMEI / IMSI, re-registers with the carrier and remains able to
    place calls.

    The action is asynchronous: the modem restarts its radio stack underneath
    the driver, so the driver's in-flight AT command times out and the driver
    re-initialises. We therefore wait for the driver to come back and verify.

    Returns (success: bool, details: str).
    """
    from laya.sensors.cli import get_dongle_device_state, send_dongle_at_command
    from laya.config import BASEBAND_REINIT_TIMEOUT_SEC

    target = dongle_id.lower().strip()
    if not target.startswith("dongle"):
        return False, "Safety Abort: Invalid dongle identifier"

    if is_call_active_on_dongle(target):
        details = f"Aborted AT+CFUN=1: Active voice call in progress on {target}"
        record_maintenance_event(target, reason, 1, f"Baseband Radio Re-attach ({target})", "failed", details)
        return False, details

    before = snapshot_modem_identity(target)
    event_id = record_maintenance_event(
        dongle_name=target,
        trigger_reason=reason,
        recovery_level=1,
        action_taken=f"Baseband Radio Re-attach AT+CFUN=1 ({target})",
        result="in_progress"
    )

    ok, resp, err = send_dongle_at_command(target, "AT+CFUN=1")
    if not ok:
        details = f"AT+CFUN=1 could not be queued: {err or resp}"
        update_maintenance_event_result(event_id, "failed", details)
        return False, details

    # The radio stack restarts asynchronously. Give the driver time to notice,
    # time out its pending command and re-initialise the modem.
    time.sleep(5)

    deadline = time.time() + BASEBAND_REINIT_TIMEOUT_SEC
    state = "Unknown"
    while time.time() < deadline:
        detail = get_dongle_device_state(target) or {}
        state = detail.get("state", "Unknown")
        if state and "not connected" not in state.lower() and "not initialized" not in state.lower():
            break
        time.sleep(2)

    identity_ok, identity_details = verify_modem_identity(target, before)
    if identity_ok:
        update_maintenance_event_result(event_id, "success", identity_details)
        return True, identity_details

    # The modem did not come back cleanly on its own. Escalate to a targeted
    # Asterisk-level restart, which is still safe (no USB bus reset).
    logger_msg = f"AT+CFUN=1 did not yield a clean return ({identity_details}); issuing targeted dongle restart"
    update_maintenance_event_result(event_id, "in_progress", logger_msg)
    restart_ok, restart_details = action_restart_dongle(target, reason=f"{reason} (post-CFUN recovery)")
    time.sleep(3)
    identity_ok2, identity_details2 = verify_modem_identity(target, before)
    if identity_ok2:
        update_maintenance_event_result(event_id, "success", f"{identity_details2} after targeted restart")
        return True, f"{identity_details2} (after targeted restart)"
    update_maintenance_event_result(event_id, "failed", f"{identity_details2} | {restart_details}")
    return False, f"{identity_details2} | {restart_details}"

def action_baseband_reboot(dongle_id, reason="Full baseband reboot (AT^RESET)"):
    """
    Layer 4-C: FULL baseband reboot via AT^RESET.  DESTRUCTIVE / OPERATOR-ONLY.

    Empirically verified on Huawei E173 hardware: AT^RESET is accepted with
    'OK' and reboots the baseband, BUT the modem then removes itself from the
    USB bus entirely and does NOT re-enumerate. Neither USBDEVFS_RESET, nor a
    sysfs driver rebind, nor a USB hub port power-cycle can bring it back.
    Only a physical replug does.

    Because of that, this action is:
      * disabled by default ('laya_baseband_reboot_enabled'),
      * additionally gated behind an explicit acknowledgement
        ('laya_baseband_reboot_confirmed'),
      * never part of any automated schedule,
      * and always captures the physical USB location first so the operator
        escalation can name the exact port that needs a physical reseat.

    Returns (success: bool, details: str).
    """
    from laya.sensors.cli import get_dongle_device_state, send_dongle_at_command
    from laya.sensors.db import get_baseband_hygiene_settings
    from laya.sensors.sysfs import find_modem_sysfs_for_dongle, get_usb_raw_dev_node
    from laya.config import BASEBAND_REBOOT_DEFAULT_TIMEOUT

    target = dongle_id.lower().strip()
    if not target.startswith("dongle"):
        return False, "Safety Abort: Invalid dongle identifier"

    settings = get_baseband_hygiene_settings()
    if not settings.get("reboot_enabled"):
        return False, ("Safety Abort: Full baseband reboot is DISABLED "
                       "(laya_baseband_reboot_enabled = false)")
    if not settings.get("reboot_confirmed"):
        return False, ("Safety Abort: Full baseband reboot requires explicit operator "
                       "acknowledgement (laya_baseband_reboot_confirmed = false)")

    if is_call_active_on_dongle(target):
        details = f"Aborted AT^RESET: Active voice call in progress on {target}"
        record_maintenance_event(target, reason, 1, f"Baseband Reboot ({target})", "failed", details)
        return False, details

    # Capture the physical USB location BEFORE the modem disappears from the bus
    sysfs_name, _ = find_modem_sysfs_for_dongle(target)
    raw_node = get_usb_raw_dev_node(sysfs_name) if sysfs_name else None
    physical_hint = f"USB sysfs '{sysfs_name}'" if sysfs_name else "unknown USB port"
    if raw_node:
        physical_hint += f" ({raw_node})"

    before = snapshot_modem_identity(target)
    event_id = record_maintenance_event(
        dongle_name=target,
        trigger_reason=reason,
        recovery_level=1,
        action_taken=f"Full Baseband Reboot AT^RESET ({target})",
        result="in_progress"
    )

    ok, resp, err = send_dongle_at_command(target, "AT^RESET")
    if not ok:
        details = f"AT^RESET could not be queued: {err or resp}"
        update_maintenance_event_result(event_id, "failed", details)
        return False, details

    timeout = settings.get("recovery_timeout_sec") or BASEBAND_REBOOT_DEFAULT_TIMEOUT
    deadline = time.time() + timeout
    reappeared = False
    last_state = "Unknown"

    while time.time() < deadline:
        time.sleep(3)
        detail = get_dongle_device_state(target) or {}
        last_state = detail.get("state", "Unknown")
        # The modem is back when Asterisk reports a live identity again
        if detail.get("imei") and "not connected" not in last_state.lower():
            reappeared = True
            break

    if reappeared:
        identity_ok, identity_details = verify_modem_identity(target, before)
        if identity_ok:
            update_maintenance_event_result(event_id, "success", identity_details)
            return True, identity_details
        update_maintenance_event_result(event_id, "failed", identity_details)
        return False, identity_details

    # The modem did not come back. This is the documented, EXPECTED failure mode
    # for AT^RESET on several Huawei firmwares: a physical reseat is required.
    physical_msg = (
        f"Physical reseat required at {physical_hint}. "
        f"Last known IMEI {before.get('imei')}, IMSI {before.get('imsi')}, "
        f"subscriber {before.get('subscriber_number')}. "
        f"Modem did not re-enumerate within {timeout}s (last state: {last_state})."
    )
    update_maintenance_event_result(event_id, "failed", physical_msg)
    return False, physical_msg
