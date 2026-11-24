#!/usr/bin/env python3
"""Read identity from a Huawei-style USB modem serial port.

Only ATI/+CIMI/+CPIN? are sent, for the local auto-provisioner. Inventory
never opens a tty. A USB device is skipped if any sibling is owned or ownership
cannot be inspected; a scan lock serializes cooperating probes. Ownership is
checked again before each open, but an unrelated driver can still start between
that check and open: this is not an atomic reservation against driver startup.
"""

import fcntl
import json
import os
import re
from pathlib import Path
import select
import stat
import termios
import time
import tty

BAUDS = (115200, 57600)
COMMANDS = (b"ATI\r", b"AT+CIMI\r", b"AT+CPIN?\r")
SCAN_LOCK = "/run/lock/sokrat-dongle-serial-probe.lock"


def usb_device(tty_path, sys_root):
    """Resolve a tty's physical USB parent without opening its device node."""
    try:
        device = (tty_path / "device").resolve(strict=True)
    except FileNotFoundError:
        return None
    if sys_root not in device.parents:
        return None
    for parent in (device,) + tuple(device.parents):
        if parent == sys_root:
            break
        try:
            (parent / "idVendor").stat()
            (parent / "idProduct").stat()
        except FileNotFoundError:
            continue
        return parent
    return None


def inventory(dev_root, sys_root):
    """Map candidates to every tty sibling; an uncertain inventory is unusable."""
    try:
        candidates = sorted(
            (name for name in os.listdir(dev_root) if name.startswith("ttyUSB")),
            key=lambda name: int("".join(c for c in name if c.isdigit()) or 0),
        )
        sys_root = Path(sys_root).resolve(strict=True)
        tty_root = sys_root / "class" / "tty"
        devices = {}
        parents = {}
        for name in os.listdir(tty_root):
            parent = usb_device(tty_root / name, sys_root)
            if parent is not None:
                devices.setdefault(parent, []).append(os.path.join(dev_root, name))
                parents[name] = parent
        if any(name not in parents for name in candidates):
            return {}
        return {
            os.path.join(dev_root, name): tuple(devices[parents[name]])
            for name in candidates
        }
    except OSError:
        return {}


def tty_identity(info):
    # Device aliases can have different inodes but still address the same tty.
    if stat.S_ISCHR(info.st_mode):
        return ("device", info.st_rdev)
    return ("inode", info.st_dev, info.st_ino)


def device_owned(ports, proc_root, lock_dirs):
    """Treat live lock claims, open descriptors, and inspection errors as busy."""
    try:
        identities = {tty_identity(os.stat(port)) for port in ports}
        for port in ports:
            for directory in lock_dirs:
                try:
                    with open(os.path.join(directory, "LCK.." + os.path.basename(port)), "rb") as lock:
                        content = lock.read(128)
                except FileNotFoundError:
                    continue
                # chan_dongle writes a PID, optionally followed by its tty FD.
                match = re.fullmatch(rb"\s*([0-9]+)(?:\s+[0-9]+)?\s*", content)
                if not match or int(match.group(1)) <= 0:
                    return True
                try:
                    os.stat(os.path.join(proc_root, str(int(match.group(1)))))
                except FileNotFoundError:
                    continue
                return True
        for pid in os.listdir(proc_root):
            if not pid.isdigit():
                continue
            process = os.path.join(proc_root, pid)
            descriptors = os.path.join(process, "fd")
            try:
                names = os.listdir(descriptors)
            except FileNotFoundError:
                # A vanished process is harmless; an uninspectable live one is not.
                try:
                    os.stat(process)
                except FileNotFoundError:
                    continue
                return True
            for name in names:
                try:
                    info = os.stat(os.path.join(descriptors, name))
                except FileNotFoundError:
                    # Descriptors can close while /proc is being enumerated.
                    continue
                if tty_identity(info) in identities:
                    return True
        return False
    except OSError:
        return True


def acquire_scan_lock(path):
    """Never follow a link or accept a permissive/untrusted shared lock file."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_nlink != 1):
            raise OSError("Unsafe serial probe lock file")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_for(fd, seconds):
    data = b""
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.15)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 1024)
        except OSError:
            break
        if not chunk:
            break
        data += chunk
    return data


def probe(port, ownership_check):
    for baud in BAUDS:
        if ownership_check():
            return None
        fd = None
        saved_attrs = None
        try:
            fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
            saved_attrs = termios.tcgetattr(fd)
            tty.setraw(fd)
            attrs = termios.tcgetattr(fd)
            speed = getattr(termios, "B%d" % baud)
            attrs[4] = speed
            attrs[5] = speed
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
            termios.tcflush(fd, termios.TCIOFLUSH)
            read_for(fd, 0.10)
            os.write(fd, COMMANDS[0])
            time.sleep(0.15)
            text = read_for(fd, 1.0).decode("utf-8", "replace")
            imei_match = re.search(r"IMEI:\s*([0-9]{15})", text)
            if not imei_match:
                # ATI is authoritative; do not guess from stray binary data.
                continue
            imei = imei_match.group(1)
            os.write(fd, COMMANDS[1])
            time.sleep(0.15)
            cimi_text = read_for(fd, 0.8).decode("utf-8", "replace")
            text += cimi_text
            os.write(fd, COMMANDS[2])
            time.sleep(0.15)
            text += read_for(fd, 0.8).decode("utf-8", "replace")
            imsi = ""
            cimi = re.search(r"\r?\n([0-9]{14,15})\r?\n", cimi_text)
            if cimi and cimi.group(1) != imei:
                imsi = cimi.group(1)
            model = ""
            model_match = re.search(r"Model:\s*([^\r\n]+)", text)
            if model_match:
                model = model_match.group(1).strip()
            sim_ready = bool(re.search(r"\+CPIN:\s*READY", text))
            return {
                "port": port,
                "baud": baud,
                "imei": imei,
                "imsi": imsi,
                "model": model,
                "simReady": sim_ready,
            }
        except (OSError, termios.error):
            continue
        finally:
            if fd is not None:
                try:
                    if saved_attrs is not None:
                        termios.tcsetattr(fd, termios.TCSANOW, saved_attrs)
                finally:
                    os.close(fd)
    return None

def scan(dev_root="/dev", sys_root="/sys", proc_root="/proc",
         lock_dirs=("/var/lock", "/run/lock"), scan_lock_path=SCAN_LOCK):
    try:
        lock_fd = acquire_scan_lock(scan_lock_path)
    except OSError:
        return []
    try:
        return scan_locked(dev_root, sys_root, proc_root, lock_dirs)
    except (OSError, termios.error):
        # Including failed tty restoration: do not continue touching devices.
        return []
    finally:
        os.close(lock_fd)


def scan_locked(dev_root, sys_root, proc_root, lock_dirs):
    grouped = {}
    for port, siblings in inventory(dev_root, sys_root).items():
        if device_owned(siblings, proc_root, lock_dirs):
            continue
        result = probe(port, lambda: device_owned(siblings, proc_root, lock_dirs))
        if not result:
            continue
        entry = grouped.get(result["imei"])
        if not entry:
            entry = dict(result)
            entry["ports"] = []
            grouped[result["imei"]] = entry
        entry["ports"].append({"port": port, "baud": result["baud"]})
        if result.get("imsi") and not entry.get("imsi"):
            entry["imsi"] = result["imsi"]
        if result.get("simReady"):
            entry["simReady"] = True

    results = []
    for entry in grouped.values():
        port_numbers = sorted(
            {item["port"] for item in entry.get("ports", [])},
            key=lambda p: int("".join(c for c in p if c.isdigit()) or 0)
        )
        if port_numbers:
            entry["audioPort"] = port_numbers[0]
            entry["dataPort"] = port_numbers[-1]
        entry["port"] = entry["dataPort"] or entry.get("port")
        results.append(entry)
    return results


def main():
    print(json.dumps(scan()))


if __name__ == "__main__":
    main()
