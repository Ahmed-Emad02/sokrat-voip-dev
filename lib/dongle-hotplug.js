'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Trailing-debounce deadline for adoption scheduling.
 * Each new event postpones the run by settleMs, but never beyond the first
 * deadline + capMs, so a flapping bus still gets a pass.
 */
function nextFireAt({ now, settleMs, deadlineAt, capMs }) {
    const deadline = deadlineAt || (now + capMs);
    return { fireAt: Math.min(now + Math.max(0, settleMs), deadline), deadlineAt: deadline };
}

function deviceKeyOf(linkName) {
    const match = String(linkName || '').match(/^(.*):[0-9]+\.[0-9]+-port0$/);
    return match ? match[1] : null;
}

function usbDeviceDirForTty(ttyPath, sysRoot) {
    const tty = path.basename(ttyPath);
    let device;
    try {
        device = fs.realpathSync(path.join(sysRoot, 'class', 'tty', tty, 'device'));
    } catch (_) {
        return null;
    }
    const usbDevice = path.dirname(path.dirname(device));
    return fs.existsSync(path.join(usbDevice, 'idVendor')) ? usbDevice : null;
}

function optionInterfaceCount(usbDevice) {
    let count = 0;
    let names;
    try {
        names = fs.readdirSync(usbDevice);
    } catch (_) {
        return null;
    }
    for (const name of names) {
        if (!/^\d+-[\d.]+:1\.[0-9]+$/.test(name)) continue;
        try {
            if (String(fs.readlinkSync(path.join(usbDevice, name, 'driver'))).endsWith('/option')) count += 1;
        } catch (_) {
            // Driver not bound yet: enumeration is still in progress.
            return null;
        }
    }
    return count;
}

/**
 * True while a USB modem still has option interfaces without their by-path
 * links. Resolving a single link per device is enough: the link count must
 * match the number of AT/tty interfaces the device exposes.
 */
function usbEnumerationPending(links, { devRoot = '/dev/serial/by-path', sysRoot = '/sys' } = {}) {
    const perDevice = new Map();
    for (const name of Array.isArray(links) ? links : []) {
        const key = deviceKeyOf(name);
        if (!key) continue;
        perDevice.set(key, (perDevice.get(key) || 0) + 1);
    }
    for (const [key, linkCount] of perDevice) {
        const sample = (Array.isArray(links) ? links : []).find(name => deviceKeyOf(name) === key);
        if (!sample) continue;
        let ttyPath;
        try {
            ttyPath = fs.realpathSync(path.join(devRoot, sample));
        } catch (_) {
            return true;
        }
        const usbDevice = usbDeviceDirForTty(ttyPath, sysRoot);
        if (!usbDevice) return true;
        const expected = optionInterfaceCount(usbDevice);
        if (expected === null) return true;
        if (linkCount < expected) return true;
    }
    return false;
}

module.exports = { nextFireAt, usbEnumerationPending, deviceKeyOf };
