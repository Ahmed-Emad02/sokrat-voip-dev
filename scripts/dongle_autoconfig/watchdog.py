"""Health state machine for stuck dongles.

A dongle that reports Not connected/unknown/empty IMSI for longer than the
threshold is reset with `dongle reset` (AT+CFUN=1,1), with a cooldown and a
bounded number of attempts per window.
"""
from typing import Any, Dict, List, Optional

from .plan import Plan

BAD_STATES = ("not connec", "not connected", "unknown", "no service")


class WatchdogPolicy(object):
    def __init__(self, threshold_seconds=120.0, cooldown_seconds=600.0,
                 max_resets=3, reset_window_seconds=3600.0):
        # type: (float, float, int, float) -> None
        self.threshold_seconds = threshold_seconds
        self.cooldown_seconds = cooldown_seconds
        self.max_resets = max_resets
        self.reset_window_seconds = reset_window_seconds


class WatchdogAction(object):
    def __init__(self, slot_id, action, reason, duration_seconds=0.0):
        # type: (str, str, str, float) -> None
        self.slot_id = slot_id
        self.action = action
        self.reason = reason
        self.duration_seconds = duration_seconds


class HealthState(object):
    def __init__(self, dongles=None):
        # type: (Optional[Dict[str, dict]]) -> None
        self.dongles = dongles or {}

    @classmethod
    def from_payload(cls, payload):
        # type: (Any) -> HealthState
        if not isinstance(payload, dict):
            return cls()
        dongles = payload.get("dongles")
        if not isinstance(dongles, dict):
            return cls()
        return cls(dongles={str(k): v for k, v in dongles.items()
                            if isinstance(v, dict)})

    def to_payload(self):
        # type: () -> dict
        return {"dongles": self.dongles}


def _is_bad(state):
    # type: (Dict[str, str]) -> bool
    current = state.get("State", "").strip().lower()
    imsi = state.get("IMSI", "").strip()
    if not current or current in BAD_STATES:
        return True
    if any(bad in current for bad in BAD_STATES):
        return True
    if not imsi or imsi in {"-", "unknown"}:
        return True
    return False


def evaluate(plan, states, health, now, policy=None):
    # type: (Plan, Dict[str, Dict[str, str]], HealthState, float, Optional[WatchdogPolicy]) -> List[WatchdogAction]
    policy = policy or WatchdogPolicy()
    actions = []
    for item in plan.items:
        if not item.device_present:
            continue
        slot_id = item.slot_id
        state = states.get(slot_id, {})
        record = health.dongles.get(slot_id, {})
        if not _is_bad(state):
            health.dongles.pop(slot_id, None)
            continue
        first_bad = float(record.get("first_bad", now))
        record["first_bad"] = first_bad
        resets = [float(value) for value in record.get("resets", [])
                  if now - float(value) <= policy.reset_window_seconds]
        record["resets"] = resets
        last_reset = float(record.get("last_reset", 0))
        duration = now - first_bad
        if duration < policy.threshold_seconds:
            health.dongles[slot_id] = record
            continue
        if now - last_reset < policy.cooldown_seconds:
            health.dongles[slot_id] = record
            continue
        if len(resets) >= policy.max_resets:
            health.dongles[slot_id] = record
            actions.append(WatchdogAction(
                slot_id, "alert",
                "still unhealthy after %d resets; manual review" % len(resets),
                duration))
            continue
        record["last_reset"] = now
        record["resets"] = resets + [now]
        health.dongles[slot_id] = record
        actions.append(WatchdogAction(
            slot_id, "reset",
            "state=%s imsi=%s" % (state.get("State", "empty"),
                                  state.get("IMSI", "")),
            duration))
    return actions
