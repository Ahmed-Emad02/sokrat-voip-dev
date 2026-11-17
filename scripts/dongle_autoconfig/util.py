"""Small shared utilities for the dongle autoconfiguration tool."""
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable, Optional


class CommandResult(object):
    def __init__(self, returncode, stdout="", stderr=""):
        # type: (int, str, str) -> None
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    def __repr__(self):
        return "CommandResult(%r, %r, %r)" % (self.returncode, self.stdout, self.stderr)


def run_command(argv, timeout=10.0):
    # type: (Iterable[str], float) -> CommandResult
    """Run a command without a shell and return captured output."""
    try:
        proc = subprocess.run(
            list(argv),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return CommandResult(127, "", str(exc))
    return CommandResult(proc.returncode, proc.stdout, proc.stderr)


def parse_udev_properties(text):
    # type: (str) -> dict
    props = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key:
            props[key] = value.strip()
    return props


def read_json(path, default=None):
    # type: (Path, Any) -> Any
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (IOError, OSError, ValueError):
        return default


def atomic_write(path, data, mode=None, uid=None, gid=None):
    # type: (Path, bytes, Optional[int], Optional[int], Optional[int]) -> None
    """Write a file atomically, preserving requested ownership/mode."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".%s." % path.name, dir=str(path.parent))
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if uid is not None or gid is not None:
            os.chown(temp, uid if uid is not None else -1,
                     gid if gid is not None else -1)
        if mode is not None:
            os.chmod(temp, mode)
        os.replace(temp, path)
        try:
            dir_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
    finally:
        if temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass


def write_json_atomic(path, value, mode=0o644):
    # type: (Path, Any, int) -> None
    atomic_write(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode(),
                 mode=mode)


def timestamp():
    # type: () -> str
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def iso_now():
    # type: () -> str
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def parse_bool(value, default=False):
    # type: (Any, bool) -> bool
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default
