"""Build an idempotent plan between the slot map and dongle.conf."""
from typing import Callable, List, Optional

from .classify import resolve
from .config import DongleConfig
from .inventory import find_device
from .model import Device, SlotMap
from .probe import AtResult


class PlanItem(object):
    def __init__(self, slot_id, status, current_audio, current_data,
                 desired_audio, desired_data, reason, device_present, resolution):
        # type: (str, str, str, str, str, str, str, bool, object) -> None
        self.slot_id = slot_id
        self.status = status
        self.current_audio = current_audio
        self.current_data = current_data
        self.desired_audio = desired_audio
        self.desired_data = desired_data
        self.reason = reason
        self.device_present = device_present
        self.resolution = resolution

    @property
    def changes(self):
        # type: () -> bool
        return self.status == "update"


class Plan(object):
    def __init__(self, slots, devices, config, generated, items=None,
                 unmanaged_ports=None):
        # type: (SlotMap, List[Device], DongleConfig, DongleConfig, Optional[List[PlanItem]], Optional[List[str]]) -> None
        self.slots = slots
        self.devices = devices
        self.config = config
        self.generated = generated
        self.items = items or []
        self.unmanaged_ports = unmanaged_ports or []

    @property
    def changes(self):
        # type: () -> List[PlanItem]
        return [item for item in self.items if item.changes]

    @property
    def review(self):
        # type: () -> List[PlanItem]
        return [item for item in self.items
                if item.status in {"review", "probe_error"}]

    @property
    def missing(self):
        # type: () -> List[PlanItem]
        return [item for item in self.items if item.status == "missing"]

    @property
    def changed(self):
        # type: () -> bool
        return self.generated.render() != self.config.render()

    def payload(self):
        # type: () -> dict
        return {
            "slots_path": str(self.slots.path),
            "devices": [
                {"port": device.port, "model": device.model_key,
                 "interfaces": [item.interface for item in device.interfaces]}
                for device in self.devices
            ],
            "unmanaged_ports": self.unmanaged_ports,
            "items": [
                {
                    "slot": item.slot_id,
                    "status": item.status,
                    "device_present": item.device_present,
                    "current": {"audio": item.current_audio, "data": item.current_data},
                    "desired": {"audio": item.desired_audio, "data": item.desired_data},
                    "reason": item.reason,
                }
                for item in self.items
            ],
            "changed": self.changed,
            "changes": [item.slot_id for item in self.changes],
            "review": [item.slot_id for item in self.review],
            "missing": [item.slot_id for item in self.missing],
        }


def build_plan(slots, devices, config, probe=None, verify_data=False):
    # type: (SlotMap, List[Device], DongleConfig, Optional[Callable[[str], AtResult]], bool) -> Plan
    generated = config.copy()
    items = []
    managed_ports = {slot.port for slot in slots.slots.values() if slot.enabled}
    unmanaged = sorted(device.port for device in devices
                       if device.port not in managed_ports)
    for slot_id in sorted(slots.slots):
        slot = slots.slots[slot_id]
        device = find_device(devices, slot.port)
        resolution = resolve(slot, device, probe=probe, verify_data=verify_data)
        current_audio = config.get(slot_id, "audio")
        current_data = config.get(slot_id, "data")
        desired_audio = resolution.audio_path
        desired_data = resolution.data_path
        if resolution.usable:
            if current_audio == desired_audio and current_data == desired_data:
                status = "unchanged"
                reason = ""
            else:
                status = "update"
                reason = "stable path differs from dongle.conf"
                generated.set_paths(slot_id, desired_audio, desired_data)
        else:
            status = resolution.status
            reason = resolution.reason
        items.append(PlanItem(
            slot_id=slot_id,
            status=status,
            current_audio=current_audio,
            current_data=current_data,
            desired_audio=desired_audio,
            desired_data=desired_data,
            reason=reason,
            device_present=resolution.present,
            resolution=resolution,
        ))
    return Plan(slots=slots, devices=devices, config=config,
                generated=generated, items=items,
                unmanaged_ports=unmanaged)
