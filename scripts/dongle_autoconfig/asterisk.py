"""Thin, testable wrapper around the Asterisk CLI."""
import re
from typing import Callable

from .util import CommandResult, run_command

Runner = Callable[[list], CommandResult]


class Asterisk(object):
    def __init__(self, binary="/usr/sbin/asterisk", runner=run_command):
        # type: (str, Runner) -> None
        self.binary = binary
        self.runner = runner

    def _rx(self, command):
        # type: (str) -> CommandResult
        return self.runner([self.binary, "-rx", command])

    def available(self):
        # type: () -> bool
        return self._rx("core show version").returncode == 0

    def active_calls(self):
        # type: () -> Optional[int]
        result = self._rx("core show channels count")
        if result.returncode != 0:
            return None
        match = re.search(r"(\d+)\s+active calls", result.stdout)
        return int(match.group(1)) if match else None

    def device_state(self, dongle_id):
        # type: (str) -> dict
        result = self._rx("dongle show device state %s" % dongle_id)
        if result.returncode != 0:
            return {}
        state = {}
        for line in result.stdout.splitlines():
            match = re.match(r"^\s*([^:]+?)\s*:\s*(.*?)\s*$", line)
            if match:
                state[match.group(1).strip()] = match.group(2).strip()
        return state

    def reload(self):
        # type: () -> CommandResult
        return self._rx("module reload chan_dongle.so")

    @staticmethod
    def reload_ok(result):
        # type: (CommandResult) -> bool
        if result.returncode != 0:
            return False
        text = (result.stdout + "\n" + result.stderr).lower()
        if re.search(r"\b(error|unable|failed|not loaded)\b", text):
            return False
        return "success" in text or "reloaded" in text

    def reset(self, dongle_id):
        # type: (str) -> CommandResult
        return self._rx("dongle reset %s" % dongle_id)
