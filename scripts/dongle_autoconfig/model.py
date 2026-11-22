"""Configuration and inventory data models."""
import json
import re
from pathlib import Path
from typing import Any, Dict, Optional

from .util import parse_bool, read_json, write_json_atomic


class ConfigError(ValueError):
    """Raised when the slot map or a policy value is invalid."""


DONGLE_ID_RE = re.compile(r"^dongle[0-9]+$")
PORT_RE = re.compile(r"^pci-[0-9A-Fa-f:.]+-usb-[0-9]+(?::[0-9.]+)*$")
INTERFACE_RE = re.compile(r"^1\.[0-9]+$")
MODEL_RE = re.compile(r"^[0-9a-f]{4}:[0-9a-f]{4}$")
IMSI_RE = re.compile(r"^[0-9]{6,20}$")


class Interface(object):
    def __init__(self, port, interface, tty, by_path, vendor_id="",
                 model_id="", model="", serial=""):
        # type: (str, str, str, str, str, str, str, str) -> None
        self.port = port
        self.interface = interface
        self.tty = tty
        self.by_path = by_path
        self.vendor_id = vendor_id
        self.model_id = model_id
        self.model = model
        self.serial = serial

    @property
    def model_key(self):
        # type: () -> str
        if self.vendor_id and self.model_id:
            return "%s:%s" % (self.vendor_id.lower(), self.model_id.lower())
        return ""


class Device(object):
    def __init__(self, port, interfaces=None):
        # type: (str, Optional[list]) -> None
        self.port = port
        self.interfaces = tuple(interfaces or ())

    @property
    def model_key(self):
        # type: () -> str
        for iface in self.interfaces:
            if iface.model_key:
                return iface.model_key
        return ""

    @property
    def serial(self):
        # type: () -> str
        for iface in self.interfaces:
            if iface.serial:
                return iface.serial
        return ""

    def interface(self, iface):
        # type: (str) -> Optional[Interface]
        for item in self.interfaces:
            if item.interface == iface:
                return item
        return None

    @property
    def ttys(self):
        # type: () -> tuple
        return tuple(item.tty for item in self.interfaces)


class Slot(object):
    def __init__(self, id, port, enabled=True, audio_interface=None,
                 data_interface=None, expected_model=None, expected_imsi=None,
                 description=""):
        # type: (str, str, bool, Optional[str], Optional[str], Optional[str], Optional[str], str) -> None
        self.id = id
        self.port = port
        self.enabled = enabled
        self.audio_interface = audio_interface
        self.data_interface = data_interface
        self.expected_model = expected_model
        self.expected_imsi = expected_imsi
        self.description = description

    def validate(self):
        # type: () -> None
        if not DONGLE_ID_RE.match(self.id):
            raise ConfigError("invalid dongle id: %r" % (self.id,))
        if not PORT_RE.match(self.port):
            raise ConfigError("invalid USB port path for %s: %r" % (self.id, self.port))
        for label, value in (("audio_interface", self.audio_interface),
                             ("data_interface", self.data_interface)):
            if value is not None and not INTERFACE_RE.match(value):
                raise ConfigError("invalid %s for %s: %r" % (label, self.id, value))
        if self.audio_interface and self.audio_interface == self.data_interface:
            raise ConfigError("%s: audio and data interface must differ" % self.id)
        if self.expected_model and not MODEL_RE.match(self.expected_model.lower()):
            raise ConfigError("invalid expected_model for %s: %r" %
                              (self.id, self.expected_model))
        if self.expected_imsi and not IMSI_RE.match(self.expected_imsi):
            raise ConfigError("invalid expected_imsi for %s: %r" %
                              (self.id, self.expected_imsi))

    def to_dict(self):
        # type: () -> dict
        value = {"port": self.port}
        if not self.enabled:
            value["enabled"] = False
        if self.audio_interface:
            value["audio_interface"] = self.audio_interface
        if self.data_interface:
            value["data_interface"] = self.data_interface
        if self.expected_model:
            value["expected_model"] = self.expected_model
        if self.expected_imsi:
            value["expected_imsi"] = self.expected_imsi
        if self.description:
            value["description"] = self.description
        return value


class SlotMap(object):
    def __init__(self, path, slots, options=None):
        # type: (Path, Dict[str, Slot], Optional[dict]) -> None
        self.path = Path(path)
        self.slots = slots
        self.options = options or {}

    @classmethod
    def load(cls, path):
        # type: (Path) -> SlotMap
        raw = read_json(path)
        if raw is None:
            raise ConfigError("cannot read slot map: %s" % path)
        if not isinstance(raw, dict):
            raise ConfigError("slot map root must be a JSON object")
        if raw.get("version", 1) != 1:
            raise ConfigError("unsupported slot map version")
        slots_raw = raw.get("slots")
        if not isinstance(slots_raw, dict):
            raise ConfigError("slot map must contain a 'slots' object")
        slots = {}
        for name, entry in slots_raw.items():
            if not isinstance(entry, dict):
                raise ConfigError("slot %s: expected an object" % name)
            slot = Slot(
                id=name,
                port=str(entry.get("port", "")),
                enabled=parse_bool(entry.get("enabled", True), True),
                audio_interface=entry.get("audio_interface"),
                data_interface=entry.get("data_interface"),
                expected_model=entry.get("expected_model"),
                expected_imsi=entry.get("expected_imsi"),
                description=str(entry.get("description", "")),
            )
            slot.validate()
            slots[name] = slot
        ports = {}
        for slot in slots.values():
            if slot.port in ports:
                raise ConfigError("port %s is assigned to both %s and %s" %
                                  (slot.port, ports[slot.port], slot.id))
            ports[slot.port] = slot.id
        options = raw.get("options", {})
        if not isinstance(options, dict):
            raise ConfigError("'options' must be an object")
        return cls(path=path, slots=slots, options=options)

    def to_dict(self):
        # type: () -> dict
        return {
            "version": 1,
            "slots": {name: slot.to_dict() for name, slot in sorted(self.slots.items())},
            "options": dict(self.options),
        }

    def write(self, path=None, mode=0o644):
        # type: (Optional[Path], int) -> Path
        target = Path(path or self.path)
        write_json_atomic(target, self.to_dict(), mode=mode)
        return target


def json_dumps(value):
    # type: (Any) -> str
    return json.dumps(value, indent=2, sort_keys=True)
