'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveDongleMappingState,
    normalizeMappingOverride
} = require('../lib/dongle-mapping');

const IMSI_A = '460010000000001';
const IMSI_B = '460010000000002';
const IMSI_UNKNOWN = '460010000000003';
const IMEI_0 = '861000000000001';
const IMEI_1 = '861000000000002';
const IMEI_NEW = '861000000000003';
const DID_A = '+201000000001';
const DID_B = '+201000000002';

function row(name, imsi, imei, did, dynamic = 1, override = 'auto') {
    return {
        dongle_name: name,
        imsi,
        imei,
        phone_number: did,
        dynamic_enabled: dynamic,
        mapping_override: override
    };
}

function device(name, imsi, imei) {
    return { ID: name, IMSI: imsi, IMEI: imei, State: 'Free', Number: 'Unknown' };
}

function inventory() {
    return [
        { imsi: IMSI_A, did: DID_A, enabled: 1 },
        { imsi: IMSI_B, did: DID_B, enabled: 1 }
    ];
}

function baseSlots() {
    return [
        row('dongle0', IMSI_A, IMEI_0, DID_A),
        row('dongle1', IMSI_B, IMEI_1, DID_B)
    ];
}

function slotMap(result) {
    return Object.fromEntries(result.slots.map(slot => [slot.dongle_name, slot]));
}

function actionKeys(actions) {
    return actions.map(action => `${action.family}/${action.key}`);
}

test('keeps each DID with its SIM when two SIMs swap slots', () => {
    const result = resolveDongleMappingState({
        observedDevices: [
            device('dongle0', IMSI_B, IMEI_0),
            device('dongle1', IMSI_A, IMEI_1)
        ],
        slotRows: baseSlots(),
        inventory: inventory(),
        configuredSlots: ['dongle0', 'dongle1']
    });

    const slots = slotMap(result);
    assert.equal(slots.dongle0.imsi, IMSI_B);
    assert.equal(slots.dongle0.phone_number, DID_B);
    assert.equal(slots.dongle0.dynamic_enabled, 1);
    assert.equal(slots.dongle1.imsi, IMSI_A);
    assert.equal(slots.dongle1.phone_number, DID_A);
    assert.equal(slots.dongle1.dynamic_enabled, 1);
    assert.deepEqual(result.deleteSlots, []);
    assert.ok(actionKeys(result.astdbWrites).includes(`sim_map/${IMSI_A}`));
    assert.ok(actionKeys(result.astdbWrites).includes(`sim_map/${IMSI_B}`));
    assert.ok(!actionKeys(result.astdbDeletes).some(key => key.startsWith('sim_map/')));
});

test('keeps the DID and dynamic routing when a dongle is replaced with the same SIM', () => {
    const result = resolveDongleMappingState({
        observedDevices: [
            device('dongle0', IMSI_A, IMEI_NEW),
            device('dongle1', IMSI_B, IMEI_1)
        ],
        slotRows: baseSlots(),
        inventory: inventory(),
        configuredSlots: ['dongle0', 'dongle1']
    });

    const slots = slotMap(result);
    assert.equal(slots.dongle0.imei, IMEI_NEW);
    assert.equal(slots.dongle0.phone_number, DID_A);
    assert.equal(slots.dongle0.dynamic_enabled, 1);
    assert.ok(actionKeys(result.astdbWrites).includes('dongle_map/dongle0'));
});

test('moves a known SIM DID to an empty slot and clears the old slot', () => {
    const result = resolveDongleMappingState({
        observedDevices: [
            device('dongle0', '', IMEI_0),
            device('dongle1', IMSI_A, IMEI_1)
        ],
        slotRows: baseSlots(),
        inventory: inventory(),
        configuredSlots: ['dongle0', 'dongle1']
    });

    const slots = slotMap(result);
    assert.equal(slots.dongle0.imsi, null);
    assert.equal(slots.dongle0.phone_number, null);
    assert.equal(slots.dongle0.dynamic_enabled, 0);
    assert.equal(slots.dongle1.imsi, IMSI_A);
    assert.equal(slots.dongle1.phone_number, DID_A);
    assert.equal(slots.dongle1.dynamic_enabled, 1);
    assert.ok(actionKeys(result.astdbDeletes).includes('dongle_map/dongle0'));
});

test('does not retain a removed SIM DID on the slot', () => {
    const result = resolveDongleMappingState({
        observedDevices: [
            device('dongle0', '', IMEI_0),
            device('dongle1', IMSI_B, IMEI_1)
        ],
        slotRows: baseSlots(),
        inventory: inventory(),
        configuredSlots: ['dongle0', 'dongle1']
    });

    const slots = slotMap(result);
    assert.equal(slots.dongle0.phone_number, null);
    assert.equal(slots.dongle0.dynamic_enabled, 0);
    assert.ok(result.alerts.some(alert => alert.type === 'missing_sim'));
});

test('never assigns a DID to an unknown SIM', () => {
    const result = resolveDongleMappingState({
        observedDevices: [device('dongle0', IMSI_UNKNOWN, IMEI_0)],
        slotRows: [row('dongle0', IMSI_A, IMEI_0, DID_A)],
        inventory: inventory(),
        configuredSlots: ['dongle0']
    });

    const slots = slotMap(result);
    assert.equal(slots.dongle0.imsi, IMSI_UNKNOWN);
    assert.equal(slots.dongle0.phone_number, null);
    assert.equal(slots.dongle0.dynamic_enabled, 0);
    assert.ok(result.alerts.some(alert => alert.type === 'unknown_sim'));
});

test('refuses a DID when the same IMSI is visible on two slots', () => {
    const result = resolveDongleMappingState({
        observedDevices: [
            device('dongle0', IMSI_A, IMEI_0),
            device('dongle1', IMSI_A, IMEI_1)
        ],
        slotRows: baseSlots(),
        inventory: inventory(),
        configuredSlots: ['dongle0', 'dongle1']
    });

    const slots = slotMap(result);
    assert.equal(slots.dongle0.phone_number, null);
    assert.equal(slots.dongle1.phone_number, null);
    assert.equal(slots.dongle0.dynamic_enabled, 0);
    assert.equal(slots.dongle1.dynamic_enabled, 0);
    assert.ok(result.alerts.some(alert => alert.type === 'duplicate_imsi'));
});

test('a manual disable keeps the DID cached but disables dynamic routing', () => {
    const result = resolveDongleMappingState({
        observedDevices: [device('dongle0', IMSI_A, IMEI_0)],
        slotRows: [row('dongle0', IMSI_A, IMEI_0, DID_A, 0, 'disabled')],
        inventory: inventory(),
        configuredSlots: ['dongle0']
    });

    const slots = slotMap(result);
    assert.equal(slots.dongle0.phone_number, DID_A);
    assert.equal(slots.dongle0.dynamic_enabled, 0);
    assert.ok(actionKeys(result.astdbDeletes).includes('dongle_map/dongle0'));
    assert.ok(actionKeys(result.astdbWrites).includes(`sim_map/${IMSI_A}`));
});

test('an absent dongle is unmapped without deleting the persistent SIM mapping', () => {
    const result = resolveDongleMappingState({
        observedDevices: [],
        slotRows: baseSlots(),
        inventory: inventory(),
        configuredSlots: ['dongle0', 'dongle1']
    });

    const slots = slotMap(result);
    assert.equal(slots.dongle0.dynamic_enabled, 0);
    assert.ok(actionKeys(result.astdbDeletes).includes('dongle_map/dongle0'));
    assert.ok(!actionKeys(result.astdbDeletes).some(key => key.startsWith('sim_map/')));
});

test('a stale slot row is reported for deletion', () => {
    const result = resolveDongleMappingState({
        observedDevices: [
            device('dongle0', IMSI_A, IMEI_0),
            device('dongle1', IMSI_B, IMEI_1)
        ],
        slotRows: baseSlots().concat([row('dongle9', IMSI_A, '861000000000099', DID_A)]),
        inventory: inventory(),
        configuredSlots: ['dongle0', 'dongle1']
    });

    assert.deepEqual(result.deleteSlots, ['dongle9']);
});

test('mapping override normalization defaults to auto', () => {
    assert.equal(normalizeMappingOverride(undefined), 'auto');
    assert.equal(normalizeMappingOverride('bogus'), 'auto');
    assert.equal(normalizeMappingOverride('disabled'), 'disabled');
});
