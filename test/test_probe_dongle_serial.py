"""Isolated probe safety regressions; no real modem, sysfs, or /proc access.

Run from the repository root: python3 -m unittest discover -s test -p 'test_probe_dongle_serial.py'
"""

import contextlib
import importlib.util
import os
from pathlib import Path
import pty
import stat
import tempfile
import termios
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "probe-dongle-serial.py"
SPEC = importlib.util.spec_from_file_location("probe_dongle_serial", str(SCRIPT))
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dev = self.root / "dev"
        self.sys = self.root / "sys"
        self.proc = self.root / "proc"
        self.locks = (self.root / "var-lock", self.root / "run-lock")
        self.scan_lock = self.root / "scan.lock"
        for directory in (self.dev, self.proc) + self.locks:
            directory.mkdir()
        (self.sys / "class" / "tty").mkdir(parents=True)
        self.add_tty("ttyUSB0")
        self.add_tty("ttyUSB1")

    def add_tty(self, name, usb="1-1"):
        parent = self.sys / "devices" / usb
        parent.mkdir(parents=True, exist_ok=True)
        (parent / "idVendor").write_text("12d1\n")
        (parent / "idProduct").write_text("1001\n")
        interface = parent / (usb + ":1." + name)
        interface.mkdir()
        tty = self.sys / "class" / "tty" / name
        tty.mkdir()
        (tty / "device").symlink_to(interface)
        (self.dev / name).touch()

    def add_process(self, port=None):
        descriptors = self.proc / "4242" / "fd"
        descriptors.mkdir(parents=True, exist_ok=True)
        if port is not None:
            (descriptors / "9").symlink_to(self.dev / port)

    def scan(self):
        return probe.scan(
            dev_root=str(self.dev), sys_root=str(self.sys), proc_root=str(self.proc),
            lock_dirs=tuple(str(path) for path in self.locks),
            scan_lock_path=str(self.scan_lock),
        )

    @contextlib.contextmanager
    def forbid_serial_io(self):
        real_open = os.open

        def guarded_open(path, flags, *args):
            self.assertFalse(str(path).startswith(str(self.dev) + "/"),
                             "inventory/owned devices must never open a tty")
            return real_open(path, flags, *args)

        with mock.patch.object(probe.os, "open", side_effect=guarded_open), \
                mock.patch.object(probe.os, "write", side_effect=AssertionError("unexpected serial write")):
            yield

    def test_live_pid_lock_blocks_unlocked_sibling(self):
        self.add_process()
        for directory in self.locks:
            for content in ("4242\n", "      4242         9\n"):
                with self.subTest(directory=directory, content=content):
                    lock = directory / "LCK..ttyUSB0"
                    lock.write_text(content)
                    with self.forbid_serial_io():
                        self.assertEqual(self.scan(), [])
                    lock.unlink()

    def test_open_descriptor_without_lock_blocks_unlocked_sibling(self):
        self.add_process("ttyUSB0")
        with self.forbid_serial_io():
            self.assertEqual(self.scan(), [])

    def test_non_usb_named_tty_sibling_is_also_checked(self):
        self.add_tty("ttyACM0")
        self.add_process("ttyACM0")
        with self.forbid_serial_io():
            self.assertEqual(self.scan(), [])

    def test_stale_lock_is_not_live_ownership(self):
        (self.locks[0] / "LCK..ttyUSB0").write_text("9999 9\n")
        with self.forbid_serial_io():
            inventory = probe.inventory(str(self.dev), str(self.sys))
            self.assertEqual(len(inventory), 2)
            self.assertFalse(probe.device_owned(
                inventory[str(self.dev / "ttyUSB0")], str(self.proc),
                tuple(str(path) for path in self.locks)))

    def test_malformed_lock_fails_closed(self):
        for content in (b"", b"not a pid", b"0\n", b"4242 9 extra\n", b"\xff"):
            with self.subTest(content=content):
                (self.locks[0] / "LCK..ttyUSB0").write_bytes(content)
                with self.forbid_serial_io():
                    self.assertEqual(self.scan(), [])

    def test_missing_proc_fails_closed(self):
        self.proc.rmdir()
        with self.forbid_serial_io():
            self.assertEqual(self.scan(), [])

    def test_unreadable_process_descriptors_fail_closed(self):
        self.add_process()
        real_listdir = os.listdir

        def denied(path):
            if str(path) == str(self.proc / "4242" / "fd"):
                raise PermissionError("synthetic /proc denial")
            return real_listdir(path)

        with self.forbid_serial_io(), mock.patch.object(probe.os, "listdir", side_effect=denied):
            self.assertEqual(self.scan(), [])

    def test_missing_fd_directory_of_live_process_fails_closed(self):
        (self.proc / "4242").mkdir()
        with self.forbid_serial_io():
            self.assertEqual(self.scan(), [])

    def test_unknown_usb_topology_fails_closed(self):
        (self.sys / "class" / "tty" / "ttyUSB1" / "device").unlink()
        with self.forbid_serial_io():
            self.assertEqual(self.scan(), [])

    def test_ownership_is_rechecked_immediately_before_open(self):
        real_owned = probe.device_owned
        checks = []

        def checked(*args):
            checks.append(None)
            if len(checks) == 2:
                self.add_process("ttyUSB0")
            return real_owned(*args)

        with self.forbid_serial_io(), mock.patch.object(probe, "device_owned", side_effect=checked):
            self.assertEqual(self.scan(), [])
        self.assertGreaterEqual(len(checks), 2)

    def test_bound_device_does_not_hide_independent_unowned_device(self):
        self.add_process("ttyUSB0")
        self.add_tty("ttyUSB2", usb="1-2")
        self.add_tty("ttyUSB3", usb="1-2")
        seen = []

        def unowned_probe(port, ownership_check):
            self.assertFalse(ownership_check())
            seen.append(port)
            return {"port": port, "baud": 115200, "imei": "123456789012345",
                    "imsi": "", "model": "fixture", "simReady": False}

        with self.forbid_serial_io(), mock.patch.object(probe, "probe", side_effect=unowned_probe):
            results = self.scan()
        self.assertEqual(seen, [str(self.dev / "ttyUSB2"), str(self.dev / "ttyUSB3")])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["audioPort"], seen[0])
        self.assertEqual(results[0]["dataPort"], seen[1])
        self.assertEqual(results[0]["port"], seen[1])

    def test_scan_lock_excludes_other_scans(self):
        fd = probe.acquire_scan_lock(str(self.scan_lock))
        try:
            self.assertEqual(stat.S_IMODE(os.fstat(fd).st_mode), 0o600)
            with self.forbid_serial_io():
                self.assertEqual(self.scan(), [])
        finally:
            os.close(fd)

    def test_scan_lock_rejects_symlink_and_permissive_file(self):
        target = self.root / "target"
        target.write_text("unchanged")
        self.scan_lock.symlink_to(target)
        with self.forbid_serial_io():
            self.assertEqual(self.scan(), [])
        self.assertEqual(target.read_text(), "unchanged")
        self.scan_lock.unlink()
        self.scan_lock.touch(mode=0o600)
        self.scan_lock.chmod(0o666)
        with self.forbid_serial_io():
            self.assertEqual(self.scan(), [])


class TermiosTests(unittest.TestCase):
    def setUp(self):
        self.master, self.slave = pty.openpty()
        self.addCleanup(os.close, self.master)
        self.addCleanup(os.close, self.slave)
        self.port = os.ttyname(self.slave)
        self.original = termios.tcgetattr(self.slave)
        self.opened = []
        real_open = os.open

        def open_pty_only(port, flags, *args):
            self.assertEqual(port, self.port)
            fd = real_open(port, flags, *args)
            self.opened.append(fd)
            return fd

        patcher = mock.patch.object(probe.os, "open", side_effect=open_pty_only)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.object(probe.time, "sleep")
        patcher.start()
        self.addCleanup(patcher.stop)

    def assert_restored_and_closed(self):
        self.assertEqual(termios.tcgetattr(self.slave), self.original)
        self.assertTrue(self.opened)
        for fd in self.opened:
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_restore_after_success_and_keep_command_set(self):
        replies = [b"", b"\r\nModel: fixture\r\nIMEI: 123456789012345\r\nOK\r\n",
                   b"\r\n234567890123456\r\nOK\r\n", b"\r\n+CPIN: READY\r\nOK\r\n"]
        real_write = os.write
        with mock.patch.object(probe, "read_for", side_effect=replies), \
                mock.patch.object(probe.os, "write", wraps=real_write) as write:
            result = probe.probe(self.port, lambda: False)
        self.assertEqual(result["imei"], "123456789012345")
        self.assertTrue(result["simReady"])
        self.assertEqual([call[0][1] for call in write.call_args_list],
                         [b"ATI\r", b"AT+CIMI\r", b"AT+CPIN?\r"])
        self.assert_restored_and_closed()

    def test_restore_after_probe_io_failure(self):
        with mock.patch.object(probe, "read_for", side_effect=OSError("synthetic tty read failure")):
            self.assertIsNone(probe.probe(self.port, lambda: False))
        self.assertEqual(len(self.opened), len(probe.BAUDS))
        self.assert_restored_and_closed()

    def test_restore_after_partial_raw_configuration_failure(self):
        real_setraw = probe.tty.setraw

        def failed_setraw(fd):
            real_setraw(fd)
            raise termios.error("synthetic failure after raw configuration")

        with mock.patch.object(probe.tty, "setraw", side_effect=failed_setraw):
            self.assertIsNone(probe.probe(self.port, lambda: False))
        self.assert_restored_and_closed()

    def test_ownership_is_checked_again_before_second_baud(self):
        with mock.patch.object(probe, "read_for", return_value=b""), \
                mock.patch.object(probe.os, "write", wraps=os.write) as write:
            self.assertIsNone(probe.probe(self.port, mock.Mock(side_effect=[False, True])))
        self.assertEqual(len(self.opened), 1)
        self.assertEqual(write.call_count, 1)
        self.assert_restored_and_closed()


if __name__ == "__main__":
    unittest.main()
