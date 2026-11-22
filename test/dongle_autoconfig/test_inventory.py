import tempfile
import unittest
from pathlib import Path

from helpers import FakeRunner

from dongle_autoconfig.inventory import (find_device,
                                         parse_interface_from_id_path,
                                         scan)
from dongle_autoconfig.util import CommandResult


class InventoryTests(unittest.TestCase):
    def test_parse_id_path(self):
        self.assertEqual(
            parse_interface_from_id_path(
                "pci-0000:02:00.0-usb-0:2:1.2", "02"),
            ("pci-0000:02:00.0-usb-0:2", "1.2"))

    def test_scan_groups_interfaces_by_port(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            by_path = root / "by-path"
            by_path.mkdir()
            responses = {}
            for iface in ("1.0", "1.2", "1.3"):
                target = root / ("tty-%s" % iface)
                target.write_text("")
                name = "pci-0000:02:00.0-usb-0:2:%s-port0" % iface
                link = by_path / name
                link.symlink_to(target)
                responses[name] = CommandResult(0, "\n".join([
                    "ID_PATH=pci-0000:02:00.0-usb-0:2:%s" % iface,
                    "ID_USB_INTERFACE_NUM=%02d" % int(iface.split(".")[1]),
                    "ID_VENDOR_ID=12d1",
                    "ID_MODEL_ID=1506",
                    "ID_MODEL=HUAWEI_Mobile",
                    "ID_SERIAL=HUAWEI_HUAWEI_Mobile",
                ]) + "\n", "")
            devices = scan(by_path, runner=FakeRunner(responses))
            self.assertEqual(len(devices), 1)
            device = devices[0]
            self.assertEqual(device.port, "pci-0000:02:00.0-usb-0:2")
            self.assertEqual([i.interface for i in device.interfaces],
                             ["1.0", "1.2", "1.3"])
            self.assertEqual(device.model_key, "12d1:1506")
            self.assertEqual(find_device(devices, device.port).port, device.port)

    def test_scan_ignores_dangling_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            by_path = Path(tmp)
            (by_path / "pci-0000:02:00.0-usb-0:9:1.2-port0").symlink_to(
                by_path / "missing")
            self.assertEqual(scan(by_path, runner=FakeRunner()), [])


if __name__ == "__main__":
    unittest.main()
