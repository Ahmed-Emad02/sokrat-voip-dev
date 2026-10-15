"""
Laya Healer — Graduated Recovery Ladder
Orchestrates progressive, step-by-step healing with cooldown and safety enforcement.
"""

import time
from laya.config import (
    HEALING_COOLDOWN_SEC,
    USB_RESET_COOLDOWN_SEC,
    ALERT_THROTTLE_SEC
)
from laya.evaluator.heuristics import (
    ANOMALY_NONE,
    ANOMALY_ZOMBIE_CHANNEL,
    ANOMALY_MODEM_DEADLOCK,
    ANOMALY_UNINITIALIZED_CONNECTED,
    ANOMALY_CARRIER_DROP
)
from laya.healer.actions import (
    action_soft_at_probe,
    action_hangup_channel,
    action_restart_dongle,
    action_sysfs_usb_reset,
    action_escalate_alert,
    is_call_active_on_dongle
)

class RecoveryLadder:
    def __init__(self):
        # Tracking: { dongle_id: { 'last_level': int, 'last_action_time': float, 'attempts_at_level': int, 'last_alert_time': float } }
        self._history = {}

    def get_dongle_history(self, dongle_id):
        dongle_id = dongle_id.lower()
        if dongle_id not in self._history:
            self._history[dongle_id] = {
                "last_level": 0,
                "last_action_time": 0,
                "attempts_at_level": 0,
                "last_alert_time": 0
            }
        return self._history[dongle_id]

    def reset_dongle_ladder(self, dongle_id):
        dongle_id = dongle_id.lower()
        if dongle_id in self._history:
            prev_level = self._history[dongle_id].get("last_level", 0)
            self._history[dongle_id]["last_level"] = 0
            self._history[dongle_id]["attempts_at_level"] = 0
            return prev_level
        return 0

    def attempt_recovery(self, dongle_id, anomaly_type, reason, health_data, detail=None):
        """
        Executes the appropriate recovery step based on the anomaly and past history.
        Returns (action_taken: str, level: int, success: bool, details: str).
        """
        dongle_id = dongle_id.lower()
        now = time.time()
        rec = self.get_dongle_history(dongle_id)

        # Safety Check: Never heal if there's an active bridged customer voice call!
        if is_call_active_on_dongle(dongle_id):
            return "Skipped (Active Call)", 0, False, "Active voice call on dongle"

        # Cooldown Check
        elapsed = now - rec["last_action_time"]
        cooldown = USB_RESET_COOLDOWN_SEC if rec["last_level"] >= 4 else HEALING_COOLDOWN_SEC
        if elapsed < cooldown:
            return "Cooldown In Effect", rec["last_level"], False, f"Waiting {int(cooldown - elapsed)}s for cooldown"

        # Determine next level
        target_level = 1
        if anomaly_type == ANOMALY_ZOMBIE_CHANNEL:
            target_level = 2
        elif anomaly_type in (ANOMALY_MODEM_DEADLOCK, ANOMALY_UNINITIALIZED_CONNECTED):
            target_level = 3 if rec["last_level"] < 3 else 4
        elif anomaly_type == ANOMALY_CARRIER_DROP:
            target_level = 1 if rec["last_level"] < 1 else 3

        # Escalate if already failed at Level 3
        if rec["last_level"] == 3 and rec["attempts_at_level"] >= 2:
            target_level = 4
        elif rec["last_level"] >= 4 and rec["attempts_at_level"] >= 2:
            target_level = 5

        # Execute recovery action based on target_level
        action_name = "None"
        success = False
        details = ""

        if target_level == 1:
            action_name = "Level 1: Soft AT Probe"
            success, details = action_soft_at_probe(dongle_id, reason)
        elif target_level == 2:
            channel_name = health_data.get("active_channel")
            if channel_name:
                action_name = f"Level 2: Hangup Orphan Channel ({channel_name})"
                success, details = action_hangup_channel(dongle_id, channel_name, reason)
            else:
                action_name = "Level 2: Soft AT Probe (No channel named)"
                success, details = action_soft_at_probe(dongle_id, reason)
        elif target_level == 3:
            action_name = f"Level 3: Targeted Dongle Restart ({dongle_id})"
            success, details = action_restart_dongle(dongle_id, reason)
        elif target_level == 4:
            audio_port = detail.get("audio_port") if detail else None
            action_name = f"Level 4: Sysfs USB Driver Rebind ({dongle_id})"
            success, details = action_sysfs_usb_reset(dongle_id, audio_port, reason)
        elif target_level >= 5:
            # 30-minute repeat alert throttle
            last_alert = rec.get("last_alert_time", 0)
            time_since_alert = now - last_alert
            if last_alert > 0 and time_since_alert < ALERT_THROTTLE_SEC:
                rem_sec = int(ALERT_THROTTLE_SEC - time_since_alert)
                action_name = f"Level 5: Alert Throttled ({dongle_id})"
                details = f"Alert throttle active (next dispatch in {rem_sec}s)"
                return action_name, 5, True, details

            action_name = f"Level 5: Escalate Alert ({dongle_id})"
            success, details = action_escalate_alert(dongle_id, reason, "Repeated failures across Levels 1-4")
            rec["last_alert_time"] = now

        # Update history
        rec["last_action_time"] = now
        if rec["last_level"] == target_level:
            rec["attempts_at_level"] += 1
        else:
            rec["last_level"] = target_level
            rec["attempts_at_level"] = 1

        return action_name, target_level, success, details
