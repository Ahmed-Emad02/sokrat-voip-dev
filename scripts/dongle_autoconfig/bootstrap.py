"""Build a proposed slot map from current devices and dongle.conf."""
import os
from pathlib import Path
from typing import List

from .config import DongleConfig
from .model import Device, Slot, SlotMap


def _real(path):
    # type: (str) -> str
    if not path:
        return ""
    try:
        return os.path.realpath(path)
    except OSError:
        return path


def _matching_section(device, config):
    # type: (Device, DongleConfig) -> str
    device_ttys = {_real(tty) for tty in device.ttys}
    for section in config.sections():
        if not section.name.startswith("dongle"):
            continue
        audio = _real(config.get(section.name, "audio"))
        data = _real(config.get(section.name, "data"))
        if audio in device_ttys or data in device_ttys:
            return section.name
    return ""


def bootstrap_slots(devices, config, path):
    # type: (List[Device], DongleConfig, Path) -> SlotMap
    used = set()
    slots = {}
    next_index = 0
    for device in sorted(devices, key=lambda item: item.port):
        section = _matching_section(device, config)
        if section:
            slot_id = section
        else:
            while "dongle%d" % next_index in used:
                next_index += 1
            slot_id = "dongle%d" % next_index
            next_index += 1
        used.add(slot_id)

        audio_iface = ""
        data_iface = ""
        if section:
            audio_real = _real(config.get(section, "audio"))
            data_real = _real(config.get(section, "data"))
            for iface in device.interfaces:
                if _real(iface.tty) == audio_real:
                    audio_iface = iface.interface
                if _real(iface.tty) == data_real:
                    data_iface = iface.interface
        slots[slot_id] = Slot(
            id=slot_id,
            port=device.port,
            audio_interface=audio_iface or None,
            data_interface=data_iface or None,
            expected_model=device.model_key or None,
            expected_imsi=(config.get(section, "imsi", "") if section else "") or None,
            description=("auto-discovered %s" % device.model_key).strip(),
        )
    return SlotMap(path=path, slots=slots)


def bootstrap_payload(slots):
    # type: (SlotMap) -> dict
    return {"version": 1, "slots": {name: slot.to_dict()
                                    for name, slot in sorted(slots.slots.items())},
            "options": {}}
