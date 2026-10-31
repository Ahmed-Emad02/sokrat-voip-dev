"""
Laya Evaluator — Anomaly Detection & Diagnostic Heuristics
Analyzes telemetry to pinpoint failure modes before initiating recovery actions.
"""

from laya.config import STUCK_STATE_THRESHOLD_SEC

# Anomaly Constants
ANOMALY_NONE = "NONE"
ANOMALY_ZOMBIE_CHANNEL = "ZOMBIE_CHANNEL"
ANOMALY_MODEM_DEADLOCK = "MODEM_DEADLOCK"
ANOMALY_UNINITIALIZED_CONNECTED = "UNINITIALIZED_CONNECTED"
ANOMALY_CARRIER_DROP = "CARRIER_DROP"
ANOMALY_MODEM_FIRMWARE_DEAD = "MODEM_FIRMWARE_DEAD"
ANOMALY_HARDWARE_ABSENT = "HARDWARE_ABSENT"
ANOMALY_SMS_STORAGE_FULL = "SMS_STORAGE_FULL"

# States that indicate the modem is genuinely not usable right now
BROKEN_STATES = (
    "Not connected",
    "Not initialized",
    "GSM not responding",
    "Free",           # only broken when combined with a confirmed AT fault
    "Unknown",
)

def evaluate_dongle_anomalies(health_data, detail=None):
    """
    Evaluates health_data and detail dictionary to identify any actionable anomalies.
    Returns (anomaly_type: str, reason: str, recommended_level: int).
    """
    state = health_data.get("curr_state", "Unknown")
    stuck_duration = health_data.get("stuck_state_duration", 0)
    matching_channels = health_data.get("matching_channels", [])
    usb_present = health_data.get("usb_present", False)
    dongle_name = health_data.get("dongle_name", "")

    # 1. Check for Zombie / Orphaned Channel
    if matching_channels:
        for ch in matching_channels:
            ch_state = ch.get("state", "")
            duration = ch.get("duration", 0)
            bridged = ch.get("bridged", "")
            # If channel has been in Dialing/Ring/Down for > STUCK_STATE_THRESHOLD without bridge
            if not bridged and ch_state in ("Dialing", "Ring", "Down", "Rsrvd") and duration >= STUCK_STATE_THRESHOLD_SEC:
                return (
                    ANOMALY_ZOMBIE_CHANNEL,
                    f"Orphaned channel {ch.get('channel')} lingering in state '{ch_state}' for {duration}s without bridge",
                    2  # Level 2: Soft Channel Hangup
                )

    # 2. Check for Stuck State in chan_dongle without active call
    if state in ("Dialing", "Waiting", "Alerting", "Incoming") and stuck_duration >= STUCK_STATE_THRESHOLD_SEC:
        return (
            ANOMALY_MODEM_DEADLOCK,
            f"Modem state '{state}' frozen for {stuck_duration}s without active bridged call",
            3  # Level 3: Targeted Dongle Restart
        )

    # 3. Check for Modem Command Queue Deadlock
    if detail:
        tasks = detail.get("tasks_in_queue", 0)
        commands = detail.get("commands_in_queue", 0)
        # Avoid false-positive during device boot/init when 27+ commands are legitimately queued
        if state in ("Not initialized", "Initializing", "Not connected"):
            if (tasks > 8 or commands > 8) and stuck_duration >= STUCK_STATE_THRESHOLD_SEC:
                return (
                    ANOMALY_MODEM_DEADLOCK,
                    f"Modem initialization stuck ({commands} commands, {tasks} tasks in queue for {stuck_duration}s)",
                    3  # Level 3: Targeted Dongle Restart
                )
        elif (tasks > 8 or commands > 8) and state != "Active":
            return (
                ANOMALY_MODEM_DEADLOCK,
                f"Modem AT queue deadlock ({commands} commands, {tasks} tasks in queue)",
                3  # Level 3: Targeted Dongle Restart
            )

    # 3b. Check for Modem SMS Flash Storage Full / Carrier Retry Storm
    if health_data.get("sms_fault_confirmed"):
        return (
            ANOMALY_SMS_STORAGE_FULL,
            f"Modem SMS flash storage full or memory error ('{health_data.get('sms_fault_signature')}', "
            f"{health_data.get('sms_fault_count')} occurrence(s))",
            1  # Level 1: Soft hygiene purge AT+CMGD=1,4
        )

    # 4. MODEM FIRMWARE DEADLOCK (ground truth from the driver's own error signature).
    #    The chan_dongle driver logs "timedout while waiting 'OK' in response to 'AT'"
    #    when the modem baseband stops answering. A single transient timeout during
    #    normal call teardown is harmless, so this anomaly REQUIRES the dongle to
    #    currently be in a non-healthy state as well.
    if health_data.get("at_fault_confirmed") and state not in ("Free", "Active"):
        return (
            ANOMALY_MODEM_FIRMWARE_DEAD,
            f"Modem baseband stopped answering AT ('{health_data.get('at_fault_signature')}', "
            f"{health_data.get('at_fault_count')} occurrence(s)) while state='{state}'",
            4  # Level 4: Hardware USB Bus Reset - soft restarts cannot revive a dead baseband
        )

    # 5. Check for Physical USB Present but Asterisk "Not connected"
    if state == "Not connected" and usb_present:
        consecutive_errors = health_data.get("consecutive_errors", 0)
        if consecutive_errors >= 3:
            return (
                ANOMALY_UNINITIALIZED_CONNECTED,
                f"Modem present on physical USB bus but Asterisk reports 'Not connected' ({consecutive_errors} cycles)",
                3  # Level 3: Restart dongle module in Asterisk
            )

    # 6. Check for Carrier Drop while supposed to be Free
    if state == "Free":
        carrier_reg = health_data.get("carrier_registered", 1)
        rssi = health_data.get("rssi", 0)
        if not carrier_reg and rssi == 0:
            consecutive_errors = health_data.get("consecutive_errors", 0)
            if consecutive_errors >= 4:
                return (
                    ANOMALY_CARRIER_DROP,
                    f"Modem in Free state but completely unregistered with 0 RSSI for {consecutive_errors} cycles",
                    1  # Level 1: Soft AT inquiry to trigger network re-search
                )

    # 7. HARDWARE ABSENT - the modem is simply not plugged in / not enumerated.
    #    This is a physical situation, not a software fault. Healing cannot fix it,
    #    so we report it quietly instead of burning recovery rungs and spamming alerts.
    if state == "Not connected" and not usb_present:
        return (
            ANOMALY_HARDWARE_ABSENT,
            f"Modem hardware not enumerated on the USB bus "
            f"(configured ports: {health_data.get('configured_ports')}) - physical check required",
            0  # No automated healing; escalate to operator awareness only
        )

    return (ANOMALY_NONE, "Modem operational", 0)
