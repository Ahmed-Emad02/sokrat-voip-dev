import tempfile
import unittest
from pathlib import Path

from helpers import make_device

from dongle_autoconfig.config import DongleConfig
from dongle_autoconfig.model import Slot, SlotMap
from dongle_autoconfig.plan import build_plan
from dongle_autoconfig.probe import AtResult


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "slots.json"
        self.slots = SlotMap(path=self.path, slots={
            "dongle0": Slot("dongle0", "pci-0000:02:00.0-usb-0:2")
        })

    def tearDown(self):
        self.tmp.cleanup()

    def test_update_to_by_path(self):
        device = make_device()
        config = DongleConfig.from_text(
            "[dongle0]\ntxgain=3\naudio=/dev/ttyUSB1\ndata=/dev/ttyUSB2\n")
        plan = build_plan(self.slots, [device], config)
        self.assertEqual(plan.changes[0].slot_id, "dongle0")
        text = plan.generated.render()
        self.assertIn(
            "audio=/dev/serial/by-path/pci-0000:02:00.0-usb-0:2:1.2-port0", text)
        self.assertIn(
            "data=/dev/serial/by-path/pci-0000:02:00.0-usb-0:2:1.3-port0", text)
        self.assertIn("txgain=3", text)

    def test_unchanged(self):
        device = make_device()
        config = DongleConfig.from_text(
            "[dongle0]\n"
            "audio=/dev/serial/by-path/pci-0000:02:00.0-usb-0:2:1.2-port0\n"
            "data=/dev/serial/by-path/pci-0000:02:00.0-usb-0:2:1.3-port0\n")
        plan = build_plan(self.slots, [device], config)
        self.assertEqual(plan.items[0].status, "unchanged")
        self.assertFalse(plan.changed)

    def test_missing_device(self):
        config = DongleConfig.from_text("[dongle0]\naudio=/a\ndata=/b\n")
        plan = build_plan(self.slots, [], config)
        self.assertEqual(plan.items[0].status, "missing")
        self.assertFalse(plan.changed)

    def test_unknown_model_requires_review(self):
        device = make_device(model="12d1:9999")
        config = DongleConfig.from_text("[dongle0]\naudio=/a\ndata=/b\n")
        plan = build_plan(self.slots, [device], config)
        self.assertEqual(plan.items[0].status, "review")
        self.assertIn("unknown model", plan.items[0].reason)

    def test_probe_verifies_sim(self):
        device = make_device()
        config = DongleConfig.from_text("[dongle0]\naudio=/a\ndata=/b\n")
        plan = build_plan(self.slots, [device], config, verify_data=True,
                          probe=lambda tty: AtResult(True, "READY",
                                                     "420034224069179"))
        self.assertEqual(plan.items[0].status, "update")

    def test_probe_imsi_mismatch_fails_closed(self):
        self.slots.slots["dongle0"].expected_imsi = "420000000000000"
        device = make_device()
        config = DongleConfig.from_text("[dongle0]\naudio=/a\ndata=/b\n")
        plan = build_plan(self.slots, [device], config, verify_data=True,
                          probe=lambda tty: AtResult(True, "READY",
                                                     "420034224069179"))
        self.assertEqual(plan.items[0].status, "probe_error")
        self.assertFalse(plan.changed)


if __name__ == "__main__":
    unittest.main()
