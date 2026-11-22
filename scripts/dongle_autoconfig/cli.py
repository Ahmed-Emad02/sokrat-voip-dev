"""Command-line interface for Sokrat dongle autoconfiguration."""
import argparse
import fcntl
import json
import logging
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from .apply import ApplyBusy, ApplyError, apply_plan
from .asterisk import Asterisk
from .bootstrap import bootstrap_payload, bootstrap_slots
from .classify import MODEL_INTERFACES
from .config import DongleConfig
from .inventory import inventory_payload, scan
from .model import ConfigError, SlotMap
from .plan import build_plan
from .probe import SerialProbe
from .util import atomic_write, read_json, timestamp, write_json_atomic
from .watchdog import HealthState, WatchdogPolicy, evaluate

DEFAULT_SLOTS = Path("/etc/sokrat/dongle-slots.json")
DEFAULT_CONF = Path("/etc/asterisk/dongle.conf")
DEFAULT_STATE = Path("/var/lib/sokrat/dongle-autoconfig")
DEFAULT_BY_PATH = Path("/dev/serial/by-path")
DEFAULT_DISABLED = Path("/etc/sokrat/dongle-autoconfig.disabled")
DEFAULT_ASTERISK = "/usr/sbin/asterisk"
LOG = logging.getLogger("dongle-autoconfig")

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2
EXIT_BUSY = 75


def _add_common(parser):
    # type: (argparse.ArgumentParser) -> None
    parser.add_argument("--slots", type=Path, default=DEFAULT_SLOTS)
    parser.add_argument("--dongle-conf", type=Path, default=DEFAULT_CONF)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--by-path-dir", type=Path, default=DEFAULT_BY_PATH)
    parser.add_argument("--disabled-file", type=Path, default=DEFAULT_DISABLED)
    parser.add_argument("--asterisk", default=DEFAULT_ASTERISK)
    parser.add_argument("--udevadm", default="udevadm")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--quiet", action="store_true")


@contextmanager
def _lock(state_dir):
    # type: (Path) -> object
    state_dir.mkdir(parents=True, exist_ok=True)
    handle = (state_dir / "lock").open("a+")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        try:
            fcntl.flock(handle, fcntl.LOCK_UN)
        finally:
            handle.close()


def _load_slots(path):
    # type: (Path) -> SlotMap
    return SlotMap.load(path)


def _load_config(path):
    # type: (Path) -> DongleConfig
    if not path.exists():
        raise ConfigError("missing dongle.conf: %s" % path)
    return DongleConfig.from_path(path)


def _print_json(value):
    # type: (object) -> None
    print(json.dumps(value, indent=2, sort_keys=True))


def _devices(args):
    # type: (argparse.Namespace) -> list
    return scan(args.by_path_dir, udevadm=args.udevadm)


def _probe(args):
    # type: (argparse.Namespace) -> object
    return SerialProbe().identify if getattr(args, "probe", False) else None


def _check_probe_safe(args):
    # type: (argparse.Namespace) -> None
    if not getattr(args, "probe", False):
        return
    calls = Asterisk(args.asterisk).active_calls()
    if calls is None:
        raise ApplyError("cannot read Asterisk active-call count before probing")
    if calls > 0:
        raise ApplyBusy("%d active calls; refusing to probe tty ports" % calls)


def _plan(args):
    # type: (argparse.Namespace) -> tuple
    _check_probe_safe(args)
    slots = _load_slots(args.slots)
    config = _load_config(args.dongle_conf)
    devices = _devices(args)
    return slots, build_plan(slots, devices, config, probe=_probe(args),
                             verify_data=getattr(args, "probe", False))


def _format_plan(plan):
    # type: (object) -> str
    lines = []
    for item in plan.items:
        detail = item.reason
        if item.changes:
            detail = "%s -> %s ; %s -> %s" % (
                item.current_audio or "-", item.desired_audio,
                item.current_data or "-", item.desired_data)
        lines.append("%s: %s%s" % (item.slot_id, item.status,
                                   (" (%s)" % detail) if detail else ""))
    if plan.unmanaged_ports:
        lines.append("unmanaged ports: " + ", ".join(plan.unmanaged_ports))
    return "\n".join(lines)


def cmd_inventory(args):
    # type: (argparse.Namespace) -> int
    devices = _devices(args)
    payload = {"devices": inventory_payload(devices),
               "models": {key: list(value) for key, value in MODEL_INTERFACES.items()}}
    if args.json:
        _print_json(payload)
    else:
        for device in devices:
            print("%s model=%s serial=%s" %
                  (device.port, device.model_key or "?", device.serial or "-"))
            for iface in device.interfaces:
                print("  %s %s %s" % (iface.interface, iface.tty, iface.by_path))
    return EXIT_OK


def cmd_plan(args):
    # type: (argparse.Namespace) -> int
    slots, plan = _plan(args)
    if args.json:
        _print_json(plan.payload())
    else:
        print(_format_plan(plan))
    if args.fail_on_drift and plan.changed:
        return 3
    return EXIT_OK


def cmd_apply(args):
    # type: (argparse.Namespace) -> int
    slots, plan = _plan(args)
    if not plan.changes:
        payload = {"applied": False, "reason": "no changes", "plan": plan.payload()}
        _print_json(payload) if args.json else print("no changes")
        return EXIT_OK
    if not args.yes:
        if args.json:
            _print_json({"applied": False, "reason": "pass --yes to write",
                         "plan": plan.payload()})
        else:
            print(_format_plan(plan))
            print("refusing to write without --yes", file=sys.stderr)
        return EXIT_USAGE
    asterisk = Asterisk(args.asterisk)
    try:
        with _lock(args.state_dir):
            result = apply_plan(plan, asterisk, args.dongle_conf, args.state_dir,
                                force=args.force, settle_seconds=args.settle)
    except ApplyBusy as exc:
        LOG.warning("%s", exc)
        _print_json({"applied": False, "busy": True, "reason": str(exc)}) \
            if args.json else print("deferred: %s" % exc)
        return EXIT_BUSY
    except (ApplyError, OSError) as exc:
        LOG.error("%s", exc)
        _print_json({"applied": False, "error": str(exc)}) \
            if args.json else print("error: %s" % exc, file=sys.stderr)
        return EXIT_ERROR
    if args.json:
        _print_json({"apply": result.payload(), "plan": plan.payload()})
    else:
        print("applied=%s verified=%s rolled_back=%s" %
              (result.applied, result.verified, result.rolled_back))
        for error in result.errors:
            print("  %s" % error, file=sys.stderr)
    if result.rolled_back or not result.verified:
        return EXIT_ERROR
    return EXIT_OK


def _watchdog_states(slots, asterisk):
    # type: (SlotMap, Asterisk) -> dict
    return {name: asterisk.device_state(name) for name in slots.slots}


def _run_watchdog(args, slots, plan, asterisk, auto):
    # type: (argparse.Namespace, SlotMap, object, Asterisk, bool) -> tuple
    if auto and args.disabled_file.exists():
        return [{"action": "skip", "reason": "autoconfig disabled"}], False
    states = _watchdog_states(slots, asterisk)
    health_path = args.state_dir / "health.json"
    health = HealthState.from_payload(read_json(health_path, {}))
    actions = evaluate(plan, states, health, time.time(), WatchdogPolicy())
    write_json_atomic(health_path, health.to_payload())
    payload = [{"slot": action.slot_id, "action": action.action,
                "reason": action.reason,
                "duration_seconds": round(action.duration_seconds, 1)}
               for action in actions]
    failed = False
    for action in actions:
        if action.action == "reset" and auto:
            result = asterisk.reset(action.slot_id)
            ok = result.returncode == 0
            LOG.warning("watchdog reset %s: %s", action.slot_id,
                        "queued" if ok else result.stderr.strip())
            if not ok:
                failed = True
        elif action.action == "alert":
            LOG.error("watchdog alert %s: %s", action.slot_id, action.reason)
    return payload, failed


def cmd_watchdog(args):
    # type: (argparse.Namespace) -> int
    slots, plan = _plan(args)
    asterisk = Asterisk(args.asterisk)
    if not asterisk.available():
        LOG.error("Asterisk is not reachable")
        return EXIT_ERROR
    try:
        with _lock(args.state_dir):
            actions, failed = _run_watchdog(args, slots, plan, asterisk,
                                           args.auto_recover)
    except OSError as exc:
        LOG.error("%s", exc)
        return EXIT_ERROR
    if args.json:
        _print_json({"actions": actions, "plan": plan.payload()})
    else:
        print("no watchdog actions" if not actions else
              "\n".join("%s: %s (%s)" % (item["slot"], item["action"], item["reason"])
                        for item in actions))
    return EXIT_ERROR if failed else EXIT_OK


def cmd_reconcile(args):
    # type: (argparse.Namespace) -> int
    if args.disabled_file.exists():
        payload = {"disabled": True, "reason": str(args.disabled_file)}
        _print_json(payload) if args.json else print("autoconfig disabled")
        return EXIT_OK
    slots, plan = _plan(args)
    if plan.changes and not args.yes:
        if args.json:
            _print_json({"applied": False, "reason": "pass --yes to write",
                         "plan": plan.payload()})
        else:
            print(_format_plan(plan))
            print("refusing to write without --yes", file=sys.stderr)
        return EXIT_USAGE
    asterisk = Asterisk(args.asterisk)
    if not asterisk.available():
        LOG.error("Asterisk is not reachable")
        return EXIT_ERROR
    try:
        with _lock(args.state_dir):
            apply_payload = {"applied": False, "reason": "no changes"}
            if plan.changes:
                calls = asterisk.active_calls()
                if calls is None:
                    raise ApplyError("cannot read Asterisk active-call count")
                if calls > 0 and not args.force:
                    raise ApplyBusy("%d active calls; deferring" % calls)
                result = apply_plan(plan, asterisk, args.dongle_conf, args.state_dir,
                                    force=args.force, settle_seconds=args.settle)
                apply_payload = result.payload()
                if result.rolled_back or not result.verified:
                    if args.json:
                        _print_json({"apply": apply_payload, "plan": plan.payload()})
                    else:
                        print("apply failed and rolled back", file=sys.stderr)
                        for error in result.errors:
                            print("  %s" % error, file=sys.stderr)
                    return EXIT_ERROR
            actions, failed = _run_watchdog(args, slots, plan, asterisk,
                                           args.auto_recover)
    except ApplyBusy as exc:
        LOG.warning("%s", exc)
        _print_json({"deferred": True, "reason": str(exc)}) \
            if args.json else print("deferred: %s" % exc)
        return EXIT_BUSY
    except (ApplyError, OSError) as exc:
        LOG.error("%s", exc)
        _print_json({"error": str(exc)}) if args.json else print("error: %s" % exc,
                                                                  file=sys.stderr)
        return EXIT_ERROR
    if args.json:
        _print_json({"apply": apply_payload, "watchdog": actions, "plan": plan.payload()})
    else:
        print("apply: %s" % apply_payload)
        print("watchdog: " + ("no actions" if not actions else
                              ", ".join("%s:%s" % (a["slot"], a["action"])
                                        for a in actions)))
    return EXIT_ERROR if failed else EXIT_OK


def cmd_bootstrap(args):
    # type: (argparse.Namespace) -> int
    config = _load_config(args.dongle_conf)
    devices = _devices(args)
    slots = bootstrap_slots(devices, config, args.slots)
    payload = bootstrap_payload(slots)
    if args.write:
        if args.slots.exists() and not args.force:
            print("refusing to overwrite %s; pass --force" % args.slots,
                  file=sys.stderr)
            return EXIT_USAGE
        slots.write(mode=0o644)
        payload["written"] = str(args.slots)
    if args.json:
        _print_json(payload)
    else:
        print(json.dumps(payload, indent=2, sort_keys=True))
    return EXIT_OK


def _latest_backup(state_dir):
    # type: (Path) -> object
    backups = sorted((state_dir / "backups").glob("dongle.conf.*.bak"),
                     key=lambda item: item.stat().st_mtime, reverse=True)
    return backups[0] if backups else None


def _pre_backup(state_dir):
    # type: (Path) -> object
    path = state_dir / "backups" / "pre-autoconfig.bak"
    return path if path.exists() else None


def cmd_status(args):
    # type: (argparse.Namespace) -> int
    backup = _latest_backup(args.state_dir)
    pre = _pre_backup(args.state_dir)
    payload = {
        "slots": str(args.slots),
        "slots_exists": args.slots.exists(),
        "dongle_conf": str(args.dongle_conf),
        "disabled": args.disabled_file.exists(),
        "pre_autoconfig_backup": str(pre) if pre else "",
        "latest_backup": str(backup) if backup else "",
        "latest_backup_mtime": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(backup.stat().st_mtime)) if backup else "",
    }
    _print_json(payload) if args.json else print(json.dumps(payload, indent=2))
    return EXIT_OK


def cmd_rollback(args):
    # type: (argparse.Namespace) -> int
    if not args.yes:
        print("refusing to rollback without --yes", file=sys.stderr)
        return EXIT_USAGE
    if args.backup:
        backup = Path(args.backup)
    else:
        backup = _pre_backup(args.state_dir) or _latest_backup(args.state_dir)
    if not backup or not backup.exists():
        print("no autoconfig backup found under %s" % (args.state_dir / "backups"),
              file=sys.stderr)
        return EXIT_ERROR
    asterisk = Asterisk(args.asterisk)
    calls = asterisk.active_calls()
    if calls is None:
        print("cannot read Asterisk active-call count", file=sys.stderr)
        return EXIT_ERROR
    if calls > 0 and not args.force:
        print("deferred: %d active calls" % calls, file=sys.stderr)
        return EXIT_BUSY
    config_path = Path(args.dongle_conf)
    if not config_path.exists():
        print("missing %s" % config_path, file=sys.stderr)
        return EXIT_ERROR
    original = config_path.read_bytes()
    stat = config_path.stat()
    pre = args.state_dir / "backups" / ("pre-rollback.%s.bak" % timestamp())
    pre.parent.mkdir(parents=True, exist_ok=True)
    pre.write_bytes(original)
    try:
        atomic_write(config_path, backup.read_bytes(),
                     mode=stat.st_mode & 0o777,
                     uid=stat.st_uid if os.geteuid() == 0 else None,
                     gid=stat.st_gid if os.geteuid() == 0 else None)
        reloaded = asterisk.reload()
        if not Asterisk.reload_ok(reloaded):
            atomic_write(config_path, original, mode=stat.st_mode & 0o777,
                         uid=stat.st_uid if os.geteuid() == 0 else None,
                         gid=stat.st_gid if os.geteuid() == 0 else None)
            asterisk.reload()
            print("rollback reload failed; restored previous file", file=sys.stderr)
            return EXIT_ERROR
        args.disabled_file.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(args.disabled_file,
                     ("disabled by rollback at %s; restored %s\n" %
                      (timestamp(), backup)).encode(), mode=0o644)
    except OSError as exc:
        print("rollback failed: %s" % exc, file=sys.stderr)
        return EXIT_ERROR
    payload = {"rolled_back": True, "backup": str(backup),
               "pre_rollback_backup": str(pre),
               "disabled": True}
    _print_json(payload) if args.json else print(
        "rolled back to %s; automatic autoconfig disabled" % backup)
    return EXIT_OK


def build_parser():
    # type: () -> argparse.ArgumentParser
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log-level", default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    sub = parser.add_subparsers(dest="command")

    inv = sub.add_parser("inventory", help="show discovered by-path interfaces")
    _add_common(inv)
    inv.set_defaults(func=cmd_inventory)

    plan = sub.add_parser("plan", help="show drift without writing")
    _add_common(plan)
    plan.add_argument("--probe", action="store_true",
                      help="probe the data port with read-only AT commands")
    plan.add_argument("--fail-on-drift", action="store_true")
    plan.set_defaults(func=cmd_plan)

    apply = sub.add_parser("apply", help="write and reload when idle")
    _add_common(apply)
    apply.add_argument("--yes", action="store_true", help="required to write")
    apply.add_argument("--force", action="store_true", help="bypass idle gate")
    apply.add_argument("--probe", action="store_true")
    apply.add_argument("--settle", type=float, default=12.0)
    apply.set_defaults(func=cmd_apply)

    watch = sub.add_parser("watchdog", help="check health and optionally reset")
    _add_common(watch)
    watch.add_argument("--auto-recover", action="store_true")
    watch.set_defaults(func=cmd_watchdog)

    rec = sub.add_parser("reconcile", help="plan, apply when idle, then watchdog")
    _add_common(rec)
    rec.add_argument("--yes", action="store_true")
    rec.add_argument("--force", action="store_true")
    rec.add_argument("--probe", action="store_true")
    rec.add_argument("--settle", type=float, default=12.0)
    rec.add_argument("--auto-recover", "--auto", dest="auto_recover",
                     action="store_true")
    rec.set_defaults(func=cmd_reconcile)

    boot = sub.add_parser("bootstrap", help="propose a slot map from current state")
    _add_common(boot)
    boot.add_argument("--write", action="store_true")
    boot.add_argument("--force", action="store_true")
    boot.set_defaults(func=cmd_bootstrap)

    status = sub.add_parser("status", help="show autoconfig/backup state")
    _add_common(status)
    status.set_defaults(func=cmd_status)

    rollback = sub.add_parser("rollback", help="restore a pre-autoconfig backup")
    _add_common(rollback)
    rollback.add_argument("--backup", default="")
    rollback.add_argument("--yes", action="store_true")
    rollback.add_argument("--force", action="store_true")
    rollback.set_defaults(func=cmd_rollback)
    return parser


def main(argv=None):
    # type: (object) -> int
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.error("a command is required")
    logging.basicConfig(level=getattr(logging, args.log_level),
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        return int(args.func(args))
    except ConfigError as exc:
        LOG.error("%s", exc)
        return EXIT_USAGE
    except ApplyBusy as exc:
        LOG.warning("%s", exc)
        return EXIT_BUSY
    except ApplyError as exc:
        LOG.error("%s", exc)
        return EXIT_ERROR
    except KeyboardInterrupt:
        return 130
