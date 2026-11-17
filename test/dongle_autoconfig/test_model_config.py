import json
import tempfile
import unittest
from pathlib import Path

from helpers import make_device  # noqa: F401

from dongle_autoconfig.config import DongleConfig
from dongle_autoconfig.model import ConfigError, SlotMap


VALID = {
    "version": 1,
    "slots": {
        "dongle0": {
            "port": "pci-0000:02:00.0-usb-0:2",
            "expected_model": "12d1:1506",
            "audio_interface": "1.2",
            "data_interface": "1.3",
        },
        "dongle1": {
            "port": "pci-0000:02:00.0-usb-0:4",
            "enabled": False,
        },
    },
}


class ModelTests(unittest.TestCase):
    def test_slot_map_round_trip_and_disable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "slots.json"
            path.write_text(json.dumps(VALID), encoding="utf-8")
            slots = SlotMap.load(path)
            self.assertIn("dongle0", slots.slots)
            self.assertFalse(slots.slots["dongle1"].enabled)
            self.assertEqual(slots.slots["dongle0"].audio_interface, "1.2")
            out = slots.to_dict()
            self.assertEqual(out["slots"]["dongle0"]["port"],
                             "pci-0000:02:00.0-usb-0:2")

    def test_duplicate_port_rejected(self):
        raw = {"version": 1, "slots": {
            "dongle0": {"port": "pci-0000:02:00.0-usb-0:2"},
            "dongle1": {"port": "pci-0000:02:00.0-usb-0:2"},
        }}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "slots.json"
            path.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaises(ConfigError):
                SlotMap.load(path)

    def test_invalid_interface_rejected(self):
        raw = {"version": 1, "slots": {
            "dongle0": {"port": "pci-0000:02:00.0-usb-0:2",
                         "audio_interface": "2.1"},
        }}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "slots.json"
            path.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaises(ConfigError):
                SlotMap.load(path)


class ConfigTests(unittest.TestCase):
    def test_edit_preserves_unrelated_lines_and_comments(self):
        text = "\n".join([
            "[general]",
            "interval = 15",
            "",
            "[dongle0]",
            "txgain=3",
            "audio=/dev/ttyUSB1 ; old audio",
            "data=/dev/ttyUSB2",
            "imei=123",
            "",
            "[dongle2]",
            "txgain=5",
        ]) + "\n"
        config = DongleConfig.from_text(text)
        config.set_paths("dongle0",
                         "/dev/serial/by-path/pci-0000:02:00.0-usb-0:2:1.2-port0",
                         "/dev/serial/by-path/pci-0000:02:00.0-usb-0:2:1.3-port0")
        rendered = config.render()
        self.assertIn("interval = 15", rendered)
        self.assertIn("txgain=3", rendered)
        self.assertIn("[dongle2]", rendered)
        self.assertIn("txgain=5", rendered)
        self.assertIn("audio=/dev/serial/by-path", rendered)
        self.assertIn("; old audio", rendered)
        self.assertNotIn("audio=/dev/ttyUSB1", rendered)

    def test_new_section_and_duplicate_key_cleanup(self):
        config = DongleConfig.from_text("[dongle0]\naudio=/a\naudio=/b\n")
        config.set_paths("dongle1", "/audio", "/data")
        text = config.render()
        self.assertEqual(text.count("[dongle1]"), 1)
        self.assertEqual(text.count("audio=/a\n"), 1)
        self.assertIn("data=/data", text)


if __name__ == "__main__":
    unittest.main()
