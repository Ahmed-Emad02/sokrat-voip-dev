"""Resolve a slot to audio/data tty paths."""
from typing import Callable, Optional

from .model import Device, Slot
from .probe import AtResult

# Interface layouts observed in this fleet.  Unknown models are not guessed:
# they require explicit audio_interface/data_interface overrides in the slot map.
MODEL_INTERFACES = {
    "12d1:1001": ("1.1", "1.2"),  # Huawei E169/E620 style
    "12d1:1506": ("1.2", "1.3"),  # Huawei K3765 (local server)
}


class Resolution(object):
    def __init__(self, slot, device, audio_path="", data_path="",
                 status="missing", reason="", probe=None):
        # type: (Slot, Optional[Device], str, str, str, str, Optional[AtResult]) -> None
        self.slot = slot
        self.device = device
        self.audio_path = audio_path
        self.data_path = data_path
        self.status = status
        self.reason = reason
        self.probe = probe

    @property
    def present(self):
        # type: () -> bool
        return self.device is not None

    @property
    def usable(self):
        # type: () -> bool
        return self.status == "ok" and bool(self.audio_path and self.data_path)


def resolve(slot, device, probe=None, verify_data=False):
    # type: (Slot, Optional[Device], Optional[Callable[[str], AtResult]], bool) -> Resolution
    """Resolve one slot using explicit overrides, then the model map."""
    if not slot.enabled:
        return Resolution(slot=slot, device=device, status="disabled",
                          reason="slot disabled")
    if device is None:
        return Resolution(slot=slot, device=None, status="missing",
                          reason="no dongle on %s" % slot.port)
    if slot.expected_model and device.model_key and \
            device.model_key != slot.expected_model.lower():
        return Resolution(slot=slot, device=device, status="review",
                          reason="model %s does not match expected %s" %
                                 (device.model_key, slot.expected_model))

    audio_iface = slot.audio_interface
    data_iface = slot.data_interface
    model_ifaces = MODEL_INTERFACES.get(device.model_key.lower())
    if model_ifaces:
        if not audio_iface:
            audio_iface = model_ifaces[0]
        if not data_iface:
            data_iface = model_ifaces[1]
    if not audio_iface or not data_iface:
        return Resolution(slot=slot, device=device, status="review",
                          reason=("unknown model %s; set audio_interface "
                                  "and data_interface" %
                                  (device.model_key or "?")))
    if audio_iface == data_iface:
        return Resolution(slot=slot, device=device, status="review",
                          reason="audio and data interfaces are identical")

    audio = device.interface(audio_iface)
    data = device.interface(data_iface)
    if audio is None or data is None:
        missing = [iface for iface, item in
                   ((audio_iface, audio), (data_iface, data)) if item is None]
        return Resolution(slot=slot, device=device, status="review",
                          reason="interface(s) not present: %s" % ", ".join(missing))

    result = None
    if verify_data and probe is not None:
        result = probe(data.tty)
        if not result.ok:
            return Resolution(slot=slot, device=device, audio_path=audio.by_path,
                              data_path=data.by_path, status="probe_error",
                              reason=result.error or "AT probe failed",
                              probe=result)
        if slot.expected_imsi and result.cimi and result.cimi != slot.expected_imsi:
            return Resolution(slot=slot, device=device, audio_path=audio.by_path,
                              data_path=data.by_path, status="probe_error",
                              reason="SIM IMSI %s does not match expected %s" %
                                     (result.cimi, slot.expected_imsi),
                              probe=result)

    return Resolution(slot=slot, device=device, audio_path=audio.by_path,
                      data_path=data.by_path, status="ok",
                      reason="", probe=result)
