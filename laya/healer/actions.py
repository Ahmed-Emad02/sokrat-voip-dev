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
    get_dongles_sharing_sysfs_device
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

def action_sysfs_usb_reset(dongle_id, audio_port=None, reason="Hardware sysfs USB bus reset"):
    """
    Level 4: Kernel-level USB device unbind and re-bind for wedged hardware.
    STRICT MULTI-DONGLE ISOLATION:
      1. Resolves USB sysfs path ONLY from ports configured for THIS dongle in dongle.conf.
      2. Checks all shared dongles on this physical USB device to ensure NONE have active calls.
      3. Only re-inits the affected dongles in Asterisk.
    """
    target = dongle_id.lower().strip()
    if is_call_active_on_dongle(target):
        details = f"Aborted USB reset: Active voice call in progress on {target}"
        record_maintenance_event(target, reason, 4, f"Sysfs USB Rebind ({target})", "failed", details)
        return False, details

    # Strictly locate USB sysfs path for this dongle's configured ports only
    sysfs_name, _ = find_modem_sysfs_for_dongle(target, audio_port)
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
        action_taken=f"Sysfs USB Driver Rebind ({sysfs_name})",
        result="in_progress"
    )

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
            update_maintenance_event_result(event_id, "success", f"Rebound {sysfs_name}; restarted {', '.join(restarted)}")
            return True, f"Rebound {sysfs_name}"
        else:
            details = "Sysfs driver unbind/bind paths not writable"
            update_maintenance_event_result(event_id, "failed", details)
            return False, details
    except Exception as e:
        details = f"Sysfs reset error: {str(e)}"
        update_maintenance_event_result(event_id, "failed", details)
        return False, details

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
        f"  • Level 4: Kernel Sysfs USB Bus Re-binds ❌\n\n"
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
