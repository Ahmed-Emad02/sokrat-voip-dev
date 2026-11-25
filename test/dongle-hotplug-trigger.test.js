const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextFireAt, usbEnumerationPending } = require('../lib/dongle-hotplug');

test('trailing debounce postpones each event but respects the cap', () => {
    const first = nextFireAt({ now: 1000, settleMs: 1200, deadlineAt: 0, capMs: 15000 });
    assert.equal(first.fireAt, 2200);
    assert.equal(first.deadlineAt, 16000);

    const second = nextFireAt({ now: 1700, settleMs: 1200, deadlineAt: first.deadlineAt, capMs: 15000 });
    assert.equal(second.fireAt, 2900, 'a later event moves the run');

    const late = nextFireAt({ now: 15500, settleMs: 1200, deadlineAt: first.deadlineAt, capMs: 15000 });
    assert.equal(late.fireAt, 16000, 'cap prevents an endless wait');
});

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dongle-hotplug-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const devRoot = path.join(root, 'dev', 'serial', 'by-path');
    const sysRoot = path.join(root, 'sys');
    fs.mkdirSync(devRoot, { recursive: true });
    fs.mkdirSync(path.join(sysRoot, 'class', 'tty'), { recursive: true });
    fs.mkdirSync(path.join(sysRoot, 'bus', 'usb', 'devices'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dev'), { recursive: true });
    return { root, devRoot, sysRoot };
}

function addDevice({ root, devRoot, sysRoot }, port, interfaces, linkedInterfaces) {
    const usb = path.join(sysRoot, 'bus', 'usb', 'devices', `1-${port}`);
    fs.mkdirSync(usb, { recursive: true });
    fs.writeFileSync(path.join(usb, 'idVendor'), '12d1\n');
    fs.writeFileSync(path.join(usb, 'idProduct'), '1001\n');
    for (const iface of interfaces) {
        const dir = path.join(usb, `1-${port}:1.${iface}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.symlinkSync(`../../../../../bus/usb/drivers/option`, path.join(dir, 'driver'));
        const ttyName = `ttyUSB${port}${iface}`;
        const ttyDir = path.join(sysRoot, 'class', 'tty', ttyName);
        fs.mkdirSync(ttyDir, { recursive: true });
        fs.symlinkSync(path.join(dir, ttyName), path.join(ttyDir, 'device'));
        const devTty = path.join(root, 'dev', ttyName);
        fs.writeFileSync(devTty, '');
        fs.mkdirSync(path.join(dir, ttyName));
        if (linkedInterfaces.includes(iface)) {
            fs.symlinkSync(devTty, path.join(devRoot, `pci-0000:02:00.0-usb-0:${port}:1.${iface}-port0`));
        }
    }
}

test('enumeration is pending until every option interface has its link', (t) => {
    const ctx = fixture(t);
    addDevice(ctx, 4, [0, 1, 2], [0, 1]);
    const links = () => fs.readdirSync(ctx.devRoot);
    assert.equal(usbEnumerationPending(links(), ctx), true, 'one interface still missing');

    fs.symlinkSync(
        path.join(ctx.root, 'dev', 'ttyUSB42'),
        path.join(ctx.devRoot, 'pci-0000:02:00.0-usb-0:4:1.2-port0')
    );
    assert.equal(usbEnumerationPending(links(), ctx), false, 'all links present');
});

test('a complete device with no siblings resolves without pending work', (t) => {
    const ctx = fixture(t);
    addDevice(ctx, 3, [0, 2, 3], [0, 2, 3]);
    assert.equal(usbEnumerationPending(fs.readdirSync(ctx.devRoot), ctx), false);
});
