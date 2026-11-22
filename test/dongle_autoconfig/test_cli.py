import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "scripts" / "dongle-autoconfig.py"


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.by_path = self.root / "by-path"
        self.by_path.mkdir()
        self.udev = self.root / "udevadm"
        self.udev.write_text(
            "#!/usr/bin/env python3\n"
            "import os, sys\n"
            "name = os.path.basename(sys.argv[-1])\n"
            "port, rest = name.rsplit(':', 1)\n"
            "iface = rest.replace('-port0', '')\n"
            "print('ID_PATH=%s:%s' % (port, iface))\n"
            "print('ID_USB_INTERFACE_NUM=%02d' % int(iface.split('.')[1]))\n"
            "print('ID_VENDOR_ID=12d1')\n"
            "print('ID_MODEL_ID=1506')\n"
            "print('ID_MODEL=HUAWEI_Mobile')\n"
            "print('ID_SERIAL=HUAWEI_HUAWEI_Mobile')\n")
        self.udev.chmod(0o755)
        for iface in ("1.0", "1.2", "1.3"):
            target = self.root / ("tty-%s" % iface)
            target.write_text("")
            name = "pci-0000:02:00.0-usb-0:2:%s-port0" % iface
            (self.by_path / name).symlink_to(target)
        self.slots = self.root / "slots.json"
        self.slots.write_text(json.dumps({
            "version": 1,
            "slots": {"dongle0": {"port": "pci-0000:02:00.0-usb-0:2"}},
        }))
        self.conf = self.root / "dongle.conf"
        self.conf.write_text("[dongle0]\naudio=/dev/ttyUSB1\ndata=/dev/ttyUSB2\n")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(CLI)] + list(args),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True)

    def test_inventory_and_plan_json(self):
        inv = self.run_cli("inventory", "--json",
                           "--by-path-dir", str(self.by_path),
                           "--udevadm", str(self.udev))
        self.assertEqual(inv.returncode, 0, inv.stderr)
        data = json.loads(inv.stdout)
        self.assertEqual(len(data["devices"]), 1)
        self.assertEqual(data["devices"][0]["model"], "12d1:1506")

        plan = self.run_cli("plan", "--json",
                            "--slots", str(self.slots),
                            "--dongle-conf", str(self.conf),
                            "--by-path-dir", str(self.by_path),
                            "--udevadm", str(self.udev))
        self.assertEqual(plan.returncode, 0, plan.stderr)
        payload = json.loads(plan.stdout)
        self.assertTrue(payload["changed"])
        self.assertEqual(payload["changes"], ["dongle0"])


    def test_rollback_restores_backup_and_disables(self):
        old = "[dongle0]\naudio=/dev/ttyUSB1\ndata=/dev/ttyUSB2\n"
        current = "[dongle0]\naudio=/new\ndata=/new2\n"
        backup_dir = self.root / "state" / "backups"
        backup_dir.mkdir(parents=True)
        backup = backup_dir / "dongle.conf.20260101T000000Z.bak"
        backup.write_text(old)
        self.conf.write_text(current)
        fake = self.root / "asterisk"
        fake.write_text(
            "#!/usr/bin/env python3\n"
            "import sys\n"
            "cmd = sys.argv[-1]\n"
            "if 'core show channels count' in cmd:\n"
            "    print('0 active channels')\n"
            "    print('0 active calls')\n"
            "elif 'module reload' in cmd:\n"
            "    print(\"Module 'chan_dongle.so' reloaded successfully.\")\n"
            "else:\n"
            "    print('OK')\n")
        fake.chmod(0o755)
        disabled = self.root / "disabled"
        result = self.run_cli(
            "rollback", "--yes", "--json",
            "--slots", str(self.slots),
            "--dongle-conf", str(self.conf),
            "--state-dir", str(self.root / "state"),
            "--disabled-file", str(disabled),
            "--asterisk", str(fake))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.conf.read_text(), old)
        self.assertTrue(disabled.exists())
        self.assertIn("rolled_back", json.loads(result.stdout))


    def test_apply_end_to_end_in_temp_tree(self):
        fake = self.root / "asterisk-apply"
        fake.write_text(
            "#!/usr/bin/env python3\n"
            "import sys\n"
            "cmd = sys.argv[-1]\n"
            "if 'core show channels count' in cmd:\n"
            "    print('0 active channels')\n"
            "    print('0 active calls')\n"
            "elif 'dongle show device state' in cmd:\n"
            "    print('  State                   : Free')\n"
            "    print('  IMSI                    : 420034224069179')\n"
            "    print('  Calls/Channels          : 0')\n"
            "elif 'module reload' in cmd:\n"
            "    print(\"Module 'chan_dongle.so' reloaded successfully.\")\n"
            "else:\n"
            "    print('OK')\n")
        fake.chmod(0o755)
        self.slots.write_text(json.dumps({
            "version": 1,
            "slots": {"dongle0": {
                "port": "pci-0000:02:00.0-usb-0:2",
                "expected_imsi": "420034224069179",
            }},
        }))
        result = self.run_cli(
            "apply", "--yes", "--json", "--settle", "0",
            "--slots", str(self.slots),
            "--dongle-conf", str(self.conf),
            "--state-dir", str(self.root / "state"),
            "--by-path-dir", str(self.by_path),
            "--udevadm", str(self.udev),
            "--asterisk", str(fake))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(":1.2-port0", self.conf.read_text())
        self.assertIn(":1.3-port0", self.conf.read_text())
        self.assertTrue((self.root / "state" / "backups" / "pre-autoconfig.bak").exists())


if __name__ == "__main__":
    unittest.main()
