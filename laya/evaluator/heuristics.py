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
        if (tasks > 8 or commands > 8) and state != "Active":
            return (
                ANOMALY_MODEM_DEADLOCK,
                f"Modem AT queue deadlock ({commands} commands, {tasks} tasks in queue)",
                3  # Level 3: Targeted Dongle Restart
            )

    # 4. Check for Physical USB Present but Asterisk "Not connected"
    if state == "Not connected" and usb_present:
        consecutive_errors = health_data.get("consecutive_errors", 0)
        if consecutive_errors >= 3:
            return (
                ANOMALY_UNINITIALIZED_CONNECTED,
                f"Modem present on physical USB bus but Asterisk reports 'Not connected' ({consecutive_errors} cycles)",
                3  # Level 3: Restart dongle module in Asterisk
            )

    # 5. Check for Carrier Drop while supposed to be Free
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

    return (ANOMALY_NONE, "Modem operational", 0)
