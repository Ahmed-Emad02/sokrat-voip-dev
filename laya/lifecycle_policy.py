"""
Authoritative persisted dongle lifecycle policy shared with the Node service.

Default: manual/read-only. Observation, CLCC/status reads and USB presence
discovery stay enabled, but the Laya watcher must not restart, reset, rebind,
reconnect or mutate a healthy session autonomously. Autonomous recovery is
opt-in through the same JSON file the Node service reads.
"""

import json
import os

DEFAULT_PATH = "/etc/sokrat/dongle-lifecycle-policy.json"

DEFAULTS = {
    "version": 1,
    "mode": "manual",
    "autonomousRecovery": False,
    "maxRecoveryAttempts": 3,
    "backoffBaseMs": 60000,
    "backoffMaxMs": 1800000,
    "recoveryPauseMs": 1800000,
}


def policy_path():
    return os.environ.get("SOKRAT_DONGLE_LIFECYCLE_POLICY", DEFAULT_PATH)


def _clamp_int(value, fallback, minimum, maximum):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def normalize_policy(raw=None):
    raw = raw if isinstance(raw, dict) else {}
    mode = str(raw.get("mode", DEFAULTS["mode"])).strip().lower()
    return {
        "version": _clamp_int(raw.get("version"), DEFAULTS["version"], 1, 1000),
        "mode": "autonomous" if mode in ("autonomous", "auto") else "manual",
        "autonomousRecovery": raw.get("autonomousRecovery") is True
        or str(raw.get("autonomousRecovery", "")).lower() == "true",
        "maxRecoveryAttempts": _clamp_int(
            raw.get("maxRecoveryAttempts"), DEFAULTS["maxRecoveryAttempts"], 1, 10
        ),
        "backoffBaseMs": _clamp_int(
            raw.get("backoffBaseMs"), DEFAULTS["backoffBaseMs"], 1000, 3600000
        ),
        "backoffMaxMs": _clamp_int(
            raw.get("backoffMaxMs"), DEFAULTS["backoffMaxMs"], 1000, 86400000
        ),
        "recoveryPauseMs": _clamp_int(
            raw.get("recoveryPauseMs"), DEFAULTS["recoveryPauseMs"], 60000, 86400000
        ),
    }


def read_lifecycle_policy(path=None):
    target = path or policy_path()
    try:
        with open(target, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        policy = normalize_policy(raw)
        policy.update({"path": target, "source": "file"})
        return policy
    except FileNotFoundError:
        policy = dict(DEFAULTS)
        policy.update({"path": target, "source": "default-missing-file"})
        return policy
    except Exception as error:  # invalid JSON or unreadable file
        policy = dict(DEFAULTS)
        policy.update({"path": target, "source": "default-invalid-file", "error": str(error)})
        return policy


def autonomous_recovery_allowed(policy=None):
    effective = normalize_policy(policy) if isinstance(policy, dict) else read_lifecycle_policy()
    return effective["mode"] == "autonomous" and effective["autonomousRecovery"] is True


def recovery_backoff_seconds(policy=None, failures=1):
    effective = normalize_policy(policy) if isinstance(policy, dict) else read_lifecycle_policy()
    exponent = max(0, min(20, int(failures) - 1))
    return min(
        effective["backoffMaxMs"] / 1000.0,
        (effective["backoffBaseMs"] / 1000.0) * (2 ** exponent),
    )
