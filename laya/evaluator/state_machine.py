"""
Laya Evaluator — Dongle State Machine & Health Scoring
Maintains state histories, duration timers, and computes dynamic health scores.
"""

import time
from laya.config import STUCK_STATE_THRESHOLD_SEC

class DongleStateManager:
    def __init__(self):
        # Memory map: { dongle_id: { 'state': str, 'since': float, 'stuck_since': float, ... } }
        self._history = {}

    def update_dongle(self, dongle_summary, detail=None, active_channels=None, usb_modems=None):
        """
        Updates in-memory telemetry for a single dongle and returns enriched health dict.
        """
        dongle_id = dongle_summary.get("id", "").lower()
        now = time.time()
        
        if dongle_id not in self._history:
            self._history[dongle_id] = {
                "last_state": None,
                "state_entered_at": now,
                "stuck_entered_at": None,
                "consecutive_errors": 0,
                "healing_level": 0,
                "last_heal_action": None,
                "last_heal_at": None
            }

        rec = self._history[dongle_id]
        curr_state = dongle_summary.get("state", "Unknown")
        
        # Check state transition
        if rec["last_state"] != curr_state:
            rec["last_state"] = curr_state
            rec["state_entered_at"] = now
            # If transitioning to a clean state, reset stuck timer
            if curr_state in ("Free", "Active"):
                rec["stuck_entered_at"] = None
                rec["consecutive_errors"] = 0

        # Assess stuck duration (e.g., lingering Dialing/Waiting/Alerting/Incoming without bridge)
        stuck_duration = 0
        is_stuck_candidate = curr_state in ("Dialing", "Alerting", "Waiting", "Incoming")
        
        # Check if there is an active channel for this dongle
        matching_channels = [c for c in (active_channels or []) if c.get("dongle_id") == dongle_id]
        has_active_call = any(c.get("state") in ("Up", "Ringing") and c.get("bridged") for c in matching_channels)
        
        if is_stuck_candidate and not has_active_call:
            if rec["stuck_entered_at"] is None:
                rec["stuck_entered_at"] = now
            stuck_duration = int(now - rec["stuck_entered_at"])
        elif curr_state in ("Free", "Active"):
            rec["stuck_entered_at"] = None
            stuck_duration = 0
        elif rec["stuck_entered_at"] is not None:
            stuck_duration = int(now - rec["stuck_entered_at"])

        # Determine Carrier Registration
        gsm_reg = (detail.get("gsm_registration") if detail else "Unknown") or "Unknown"
        is_carrier_registered = 1 if ("Registered" in gsm_reg or curr_state in ("Free", "Active")) else 0
        if curr_state == "Not connected":
            is_carrier_registered = 0

        # Physical USB presence check
        usb_present = False
        if usb_modems is not None:
            # Check if any port matches detail's audio or data port
            for m in usb_modems:
                for p in m.get("ports", []):
                    if detail and (p.get("node") in (detail.get("audio_port"), detail.get("data_port"))):
                        usb_present = True
                        break
                if usb_present:
                    break
        else:
            usb_present = (curr_state != "Not connected")

        # Compute Health Score (0 to 100)
        rssi = dongle_summary.get("rssi", 0)
        health_score = 100
        status = "healthy"

        if curr_state == "Not connected":
            health_score = 15 if usb_present else 0
            status = "offline"
            rec["consecutive_errors"] += 1
        elif stuck_duration >= STUCK_STATE_THRESHOLD_SEC:
            health_score = 25
            status = "frozen"
            rec["consecutive_errors"] += 1
        elif curr_state in ("Dialing", "Alerting", "Waiting", "Incoming") and stuck_duration > 30:
            health_score = 60
            status = "degraded"
        elif not is_carrier_registered and curr_state != "Free":
            health_score = 45
            status = "degraded"
            rec["consecutive_errors"] += 1
        elif rssi < 5 and rssi > 0:
            health_score = 65
            status = "degraded"
        elif rssi <= 0 and curr_state == "Free":
            health_score = 75
            status = "degraded"
        elif rec["healing_level"] > 0 and (now - (rec["last_heal_at"] or 0) < 60):
            health_score = 70
            status = "healing"
        else:
            health_score = 100
            status = "healthy"
            rec["consecutive_errors"] = 0

        health_data = {
            "dongle_name": dongle_id,
            "health_score": max(0, min(100, health_score)),
            "status": status,
            "rssi": rssi,
            "carrier_registered": is_carrier_registered,
            "provider_name": (detail.get("subscriber_number") if detail else None),
            "model": (detail.get("model") if detail else None) or dongle_summary.get("model"),
            "firmware": (detail.get("firmware") if detail else None) or dongle_summary.get("firmware"),
            "imei": dongle_summary.get("imei") or (detail.get("imei") if detail else None),
            "imsi": dongle_summary.get("imsi") or (detail.get("imsi") if detail else None),
            "phone_number": dongle_summary.get("number") or (detail.get("subscriber_number") if detail else None),
            "active_channel": matching_channels[0]["channel"] if matching_channels else None,
            "stuck_state_duration": stuck_duration,
            "healing_level": rec["healing_level"],
            "last_heal_action": rec["last_heal_action"],
            "last_heal_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(rec["last_heal_at"])) if rec["last_heal_at"] else None,
            "consecutive_errors": rec["consecutive_errors"],
            "usb_present": usb_present,
            "curr_state": curr_state,
            "matching_channels": matching_channels
        }
        return health_data

    def mark_healing_action(self, dongle_id, level, action_name):
        dongle_id = dongle_id.lower()
        if dongle_id in self._history:
            self._history[dongle_id]["healing_level"] = level
            self._history[dongle_id]["last_heal_action"] = action_name
            self._history[dongle_id]["last_heal_at"] = time.time()
