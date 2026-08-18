const test = require('node:test');
const assert = require('node:assert/strict');

function extractDeepestUsbBusId(realPath) {
    const parts = realPath.split('/');
    let specificBusId = null;
    for (const part of parts) {
        if (/^\d+-\d+(\.\d+)*$/.test(part) && !part.includes(':')) {
            specificBusId = part;
        }
    }
    return specificBusId;
}

test('extractDeepestUsbBusId returns the deepest specific USB device instead of root hub', () => {
    // Dongle 0 connected to sub-port 1 of root hub 1-1
    const dongle0Path = '/sys/devices/pci0000:00/0000:00:1a.0/usb1/1-1/1-1.1/1-1.1:1.3/ttyUSB1';
    assert.equal(extractDeepestUsbBusId(dongle0Path), '1-1.1');

    // Dongle 1 connected to sub-port 2 of root hub 1-1
    const dongle1Path = '/sys/devices/pci0000:00/0000:00:1a.0/usb1/1-1/1-1.2/1-1.2:1.2/ttyUSB4';
    assert.equal(extractDeepestUsbBusId(dongle1Path), '1-1.2');

    // Multi-tier hub path (e.g. 1-1.2.3)
    const tieredPath = '/sys/devices/pci0000:00/0000:00:1a.0/usb1/1-1/1-1.2/1-1.2.3/1-1.2.3:1.0/ttyUSB6';
    assert.equal(extractDeepestUsbBusId(tieredPath), '1-1.2.3');

    // Direct root device (e.g. 2-1)
    const directPath = '/sys/devices/pci0000:00/0000:00:1d.0/usb2/2-1/2-1:1.0/ttyUSB0';
    assert.equal(extractDeepestUsbBusId(directPath), '2-1');
});
