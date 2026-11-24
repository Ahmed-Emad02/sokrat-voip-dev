'use strict';

/** Project unassigned config slots as disconnected devices, never as live modems. */
function mergeEmptySlotDevices(observedDevices, sections) {
    const devices = [...observedDevices];
    const observedNames = new Set(observedDevices.map(device => String(device.ID || '').toLowerCase()));
    for (const [slot, section] of sections) {
        if (!/^dongle[0-9]+$/.test(slot) || observedNames.has(slot)) continue;
        if (['imei', 'imsi', 'audio', 'data'].some(key => String(section[key] || '').trim())) continue;
        devices.push({
            ID: slot,
            Group: '0',
            State: 'Not connected',
            'Link State': 'Not connected',
            RSSI: 0,
            'Provider Name': 'NONE',
            Number: '',
            IMEI: '',
            IMSI: '',
            Model: '',
            Firmware: '',
            Mode: '',
            Submode: '',
            audio: '',
            data: '',
            slotOnly: true,
            emptySlot: true
        });
    }
    return devices;
}

module.exports = { mergeEmptySlotDevices };
