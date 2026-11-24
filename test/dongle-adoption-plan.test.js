const test = require('node:test');
const assert = require('node:assert/strict');
const { planAdoption } = require('../lib/dongle-provisioning');

function sections(entries) {
    return new Map(entries.map(([name, fields]) => [name, { name, imei: '', imsi: '', audio: '', data: '', ...fields }]));
}

test('adoption fills a vacant slot and never grows the config', () => {
    const existing = sections([
        ['dongle0', { imei: '111111111111111' }],
        ['dongle1', {}]
    ]);
    const ops = planAdoption([
        { imei: '222222222222222', imsi: '602000000000001' },
        { imei: '333333333333333', imsi: '602000000000002' }
    ], existing, { vacantSlots: ['dongle1'] });

    assert.deepEqual(ops.map(op => [op.kind, op.slot]), [
        ['reclaim', 'dongle1'],
        ['blocked', undefined]
    ]);
    assert.ok(!ops.some(op => op.kind === 'new'), 'a pass must not create a slot');
});

test('without a vacancy every new modem is blocked for manual action', () => {
    const existing = sections([['dongle0', { imei: '111111111111111' }]]);
    const ops = planAdoption([{ imei: '222222222222222' }], existing, {});
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'blocked');
    assert.equal(ops[0].imei, '222222222222222');
});

test('a known IMEI still refreshes its own slot without a vacancy', () => {
    const existing = sections([['dongle0', { imei: '111111111111111', imsi: '602000000000001' }]]);
    const ops = planAdoption([{ imei: '111111111111111', imsi: '602000000000009' }], existing, {});
    assert.deepEqual(ops.map(op => [op.kind, op.slot, op.imsi]), [
        ['refresh', 'dongle0', '602000000000009']
    ]);
});
