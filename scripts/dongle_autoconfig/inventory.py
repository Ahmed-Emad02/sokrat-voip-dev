"""Discover tty interfaces from /dev/serial/by-path and udev properties."""
import os
import re
from pathlib import Path
from typing import Callable, Iterable, List, Optional, Tuple

from .model import Device, Interface
from .util import CommandResult, parse_udev_properties, run_command

BY_PATH_SUFFIX_RE = re.compile(r"^(?P<path>.+):(?P<iface>1\.[0-9]+)-port0$")
Runner = Callable[[list], CommandResult]


def parse_interface_from_id_path(id_path, interface_num=""):
    # type: (str, str) -> Tuple[str, str]
    """Return (port, interface) from a udev ID_PATH such as ...:1.2."""
    if interface_num:
        iface = "1.%d" % int(interface_num)
        suffix = ":%s" % iface
        if id_path.endswith(suffix):
            return id_path[:-len(suffix)], iface
    match = BY_PATH_SUFFIX_RE.match(id_path)
    if match:
        return match.group("path"), match.group("iface")
    raise ValueError("cannot derive port/interface from %r" % id_path)


def parse_by_path_name(name):
    # type: (str) -> Optional[Tuple[str, str]]
    match = BY_PATH_SUFFIX_RE.match(name)
    if not match:
        return None
    return match.group("path"), match.group("iface")


def _properties(link, runner, udevadm):
    # type: (Path, Runner, str) -> dict
    result = runner([udevadm, "info", "--query=property", "--name", str(link)])
    if result.returncode != 0:
        return {}
    return parse_udev_properties(result.stdout)


def scan(by_path_dir=Path("/dev/serial/by-path"), runner=run_command,
         udevadm="udevadm"):
    # type: (Path, Runner, str) -> List[Device]
    """Scan by-path links and group them into physical devices."""
    by_path_dir = Path(by_path_dir)
    by_port = {}
    if not by_path_dir.is_dir():
        return []
    for link in sorted(by_path_dir.iterdir()):
        if not link.is_symlink():
            continue
        try:
            if not link.exists():
                continue
            real = str(link.resolve())
        except OSError:
            continue
        props = _properties(link, runner, udevadm)
        id_path = props.get("ID_PATH", "")
        interface_num = props.get("ID_USB_INTERFACE_NUM", "")
        try:
            if id_path:
                port, iface = parse_interface_from_id_path(id_path, interface_num)
            else:
                parsed = parse_by_path_name(link.name)
                if not parsed:
                    continue
                port, iface = parsed
        except ValueError:
            continue
        if not iface.startswith("1."):
            continue
        by_port.setdefault(port, {})
        if iface not in by_port[port]:
            by_port[port][iface] = Interface(
                port=port,
                interface=iface,
                tty=real,
                by_path=str(link),
                vendor_id=props.get("ID_VENDOR_ID", ""),
                model_id=props.get("ID_MODEL_ID", ""),
                model=props.get("ID_MODEL", ""),
                serial=props.get("ID_SERIAL", ""),
            )
    devices = []
    for port in sorted(by_port):
        interfaces = tuple(by_port[port][key] for key in sorted(by_port[port]))
        devices.append(Device(port=port, interfaces=interfaces))
    return devices


def find_device(devices, port):
    # type: (Iterable[Device], str) -> Optional[Device]
    for device in devices:
        if device.port == port:
            return device
    return None


def by_path_for(by_path_dir, port, interface):
    # type: (Path, str, str) -> str
    return str(Path(by_path_dir) / ("%s:%s-port0" % (port, interface)))


def inventory_payload(devices):
    # type: (Iterable[Device]) -> List[dict]
    payload = []
    for device in devices:
        payload.append({
            "port": device.port,
            "model": device.model_key,
            "serial": device.serial,
            "interfaces": [
                {
                    "interface": item.interface,
                    "tty": item.tty,
                    "by_path": item.by_path,
                    "model": item.model_key,
                    "serial": item.serial,
                }
                for item in device.interfaces
            ],
        })
    return payload
