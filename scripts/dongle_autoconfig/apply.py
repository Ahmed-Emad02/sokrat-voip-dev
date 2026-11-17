"""Atomic, idle-gated application of a dongle plan with rollback."""
import os
import shutil
import time
from pathlib import Path
from typing import List

from .asterisk import Asterisk
from .plan import Plan
from .util import atomic_write, timestamp


class ApplyBusy(RuntimeError):
    pass


class ApplyError(RuntimeError):
    pass


class ApplyResult(object):
    def __init__(self, applied=False, backed_up="", verified=False,
                 rolled_back=False, errors=None):
        # type: (bool, str, bool, bool, Optional[List[str]]) -> None
        self.applied = applied
        self.backed_up = backed_up
        self.verified = verified
        self.rolled_back = rolled_back
        self.errors = errors or []

    def payload(self):
        # type: () -> dict
        return {
            "applied": self.applied,
            "backed_up": self.backed_up,
            "verified": self.verified,
            "rolled_back": self.rolled_back,
            "errors": self.errors,
        }


def _backup(path, state_dir):
    # type: (Path, Path) -> Path
    backup_dir = state_dir / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / ("dongle.conf.%s.bak" % timestamp())
    shutil.copy2(str(path), str(backup))
    # Keep the first pre-autoconfig file forever; this is what the UI's
    # "Rollback Autoconfig" button restores.
    pre = backup_dir / "pre-autoconfig.bak"
    if not pre.exists():
        shutil.copy2(str(path), str(pre))
    backups = sorted(backup_dir.glob("dongle.conf.*.bak"),
                     key=lambda item: item.stat().st_mtime, reverse=True)
    for old in backups[20:]:
        try:
            old.unlink()
        except OSError:
            pass
    return backup


def _validate(plan, asterisk):
    # type: (Plan, Asterisk) -> List[str]
    errors = []
    for item in plan.changes:
        if not item.device_present:
            continue
        state = asterisk.device_state(item.slot_id)
        if not state:
            errors.append("%s: no device state returned" % item.slot_id)
            continue
        current = state.get("State", "")
        if not current or "not connec" in current.lower() or current.lower() == "unknown":
            errors.append("%s: state is %s" % (item.slot_id, current or "empty"))
        imsi = state.get("IMSI", "").strip()
        if not imsi or imsi in {"-", "Unknown"}:
            errors.append("%s: IMSI is empty" % item.slot_id)
        expected = plan.slots.slots[item.slot_id].expected_imsi
        if expected and imsi and imsi != expected:
            errors.append("%s: IMSI %s != expected %s" %
                          (item.slot_id, imsi, expected))
    return errors


def apply_plan(plan, asterisk, config_path, state_dir, force=False,
               settle_seconds=12.0, sleep=time.sleep):
    # type: (Plan, Asterisk, Path, Path, bool, float, object) -> ApplyResult
    result = ApplyResult()
    if not plan.changes:
        result.verified = True
        return result

    calls = asterisk.active_calls()
    if calls is None:
        raise ApplyError("cannot read Asterisk active-call count")
    if calls > 0 and not force:
        raise ApplyBusy("%d active calls; refusing to reload chan_dongle" % calls)

    config_path = Path(config_path)
    if not config_path.exists():
        raise ApplyError("missing %s" % config_path)
    original = config_path.read_bytes()
    stat = config_path.stat()
    backup = _backup(config_path, state_dir)
    result.backed_up = str(backup)
    uid = stat.st_uid if os.geteuid() == 0 else None
    gid = stat.st_gid if os.geteuid() == 0 else None

    def rollback(why):
        # type: (str) -> None
        result.errors.append(why)
        try:
            atomic_write(config_path, original, mode=stat.st_mode & 0o777,
                         uid=uid, gid=gid)
            undo = asterisk.reload()
            if not Asterisk.reload_ok(undo):
                result.errors.append("rollback reload was not confirmed")
            result.rolled_back = True
        except OSError as exc:
            result.errors.append("rollback write failed: %s" % exc)

    try:
        atomic_write(config_path, plan.generated.render().encode("utf-8"),
                     mode=stat.st_mode & 0o777, uid=uid, gid=gid)
    except OSError as exc:
        raise ApplyError("cannot write %s: %s" % (config_path, exc))
    result.applied = True
    reloaded = asterisk.reload()
    if not Asterisk.reload_ok(reloaded):
        rollback("chan_dongle reload failed: %s %s" %
                 (reloaded.stdout.strip(), reloaded.stderr.strip()))
        return result
    if settle_seconds:
        sleep(settle_seconds)
    errors = _validate(plan, asterisk)
    if errors:
        rollback("post-reload validation failed: " + "; ".join(errors))
        return result
    result.verified = True
    return result
