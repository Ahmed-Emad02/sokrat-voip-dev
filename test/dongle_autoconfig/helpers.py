import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from dongle_autoconfig.model import Device, Interface  # noqa: E402
from dongle_autoconfig.util import CommandResult  # noqa: E402


def make_device(port="pci-0000:02:00.0-usb-0:2", model="12d1:1506"):
    vendor, model_id = model.split(":")
    return Device(port=port, interfaces=(
        Interface(port, "1.0", "/dev/ttyUSB0",
                  "/dev/serial/by-path/%s:1.0-port0" % port,
                  vendor, model_id, "HUAWEI_Mobile", "HUAWEI_HUAWEI_Mobile"),
        Interface(port, "1.2", "/dev/ttyUSB1",
                  "/dev/serial/by-path/%s:1.2-port0" % port,
                  vendor, model_id, "HUAWEI_Mobile", "HUAWEI_HUAWEI_Mobile"),
        Interface(port, "1.3", "/dev/ttyUSB2",
                  "/dev/serial/by-path/%s:1.3-port0" % port,
                  vendor, model_id, "HUAWEI_Mobile", "HUAWEI_HUAWEI_Mobile"),
    ))


class FakeRunner(object):
    def __init__(self, responses=None):
        self.responses = responses or {}

    def __call__(self, argv):
        key = " ".join(argv)
        for needle, value in self.responses.items():
            if needle in key:
                if isinstance(value, CommandResult):
                    return value
                return CommandResult(0, value, "")
        return CommandResult(1, "", "not configured: %s" % key)


class FakeAsterisk(object):
    def __init__(self, calls=0, state=None, reload_ok=True):
        self.calls = calls
        self.state = state or {"State": "Free", "IMSI": "420034224069179"}
        self.reload_ok = reload_ok
        self.reloads = 0
        self.resets = []

    def active_calls(self):
        return self.calls

    def reload(self):
        self.reloads += 1
        if self.reload_ok:
            return CommandResult(0, "Module 'chan_dongle.so' reloaded successfully.", "")
        return CommandResult(1, "", "reload failed")

    def device_state(self, dongle_id):
        return self.state

    def reset(self, dongle_id):
        self.resets.append(dongle_id)
        return CommandResult(0, "Reset command queued for execute", "")
