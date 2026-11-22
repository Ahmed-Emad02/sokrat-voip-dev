import tempfile
import unittest
from pathlib import Path

from helpers import FakeAsterisk, make_device

from dongle_autoconfig.apply import ApplyBusy, apply_plan
from dongle_autoconfig.config import DongleConfig
from dongle_autoconfig.model import Slot, SlotMap
from dongle_autoconfig.plan import build_plan


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.conf = self.root / "dongle.conf"
        self.conf.write_text("[dongle0]\naudio=/dev/ttyUSB1\ndata=/dev/ttyUSB2\n")
        self.slots = SlotMap(path=self.root / "slots.json", slots={
            "dongle0": Slot("dongle0", "pci-0000:02:00.0-usb-0:2")
        })
        self.plan = build_plan(self.slots, [make_device()],
                               DongleConfig.from_path(self.conf))

    def tearDown(self):
        self.tmp.cleanup()

    def test_apply_writes_and_backs_up(self):
        asterisk = FakeAsterisk(calls=0)
        result = apply_plan(self.plan, asterisk, self.conf, self.root,
                            settle_seconds=0, sleep=lambda _: None)
        self.assertTrue(result.applied)
        self.assertTrue(result.verified)
        self.assertFalse(result.rolled_back)
        self.assertTrue(Path(result.backed_up).exists())
        self.assertTrue((self.root / "backups" / "pre-autoconfig.bak").exists())
        self.assertIn("/dev/serial/by-path/", self.conf.read_text())

    def test_busy_does_not_write(self):
        before = self.conf.read_text()
        with self.assertRaises(ApplyBusy):
            apply_plan(self.plan, FakeAsterisk(calls=2), self.conf, self.root,
                       settle_seconds=0, sleep=lambda _: None)
        self.assertEqual(before, self.conf.read_text())

    def test_validation_failure_rolls_back(self):
        before = self.conf.read_text()
        asterisk = FakeAsterisk(calls=0, state={"State": "Not connected",
                                                 "IMSI": ""})
        result = apply_plan(self.plan, asterisk, self.conf, self.root,
                            settle_seconds=0, sleep=lambda _: None)
        self.assertTrue(result.applied)
        self.assertTrue(result.rolled_back)
        self.assertFalse(result.verified)
        self.assertEqual(before, self.conf.read_text())
        self.assertGreaterEqual(asterisk.reloads, 2)

    def test_reload_failure_rolls_back(self):
        before = self.conf.read_text()
        asterisk = FakeAsterisk(calls=0, reload_ok=False)
        result = apply_plan(self.plan, asterisk, self.conf, self.root,
                            settle_seconds=0, sleep=lambda _: None)
        self.assertTrue(result.rolled_back)
        self.assertEqual(before, self.conf.read_text())


if __name__ == "__main__":
    unittest.main()
