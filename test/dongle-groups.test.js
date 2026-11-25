'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const groups = require('../lib/dongle-groups');

test('normalizeConfig normalizes groups and deduplicates ids', () => {
    const config = groups.normalizeConfig({
        groups: [
            { name: 'Sales Team', dongles: ['dongle1', 'dongle1', ''] },
            { name: 'Sales Team', dongles: ['dongle2'] },
            { name: '', dongles: ['ignored'] }
        ],
        dongles: { dongle1: { label: 'SIM 1' }, bad: 'not-an-object' }
    });
    assert.equal(config.version, 1);
    assert.equal(config.groups.length, 2);
    assert.match(config.groups[0].id, /^sales-team/);
    assert.notEqual(config.groups[0].id, config.groups[1].id);
    assert.deepEqual(config.groups[0].dongles, ['dongle1']);
    assert.deepEqual(config.groups[1].dongles, ['dongle2']);
    assert.deepEqual(config.dongles, { dongle1: { label: 'SIM 1' } });
});

test('normalizeConfig seeds employee groups only when requested', () => {
    const withoutSeed = groups.normalizeConfig({});
    assert.equal(withoutSeed.groups.length, 0);

    const seeded = groups.normalizeConfig({}, { includeEmployeeGroups: true, employeeGroups: ['Management', 'Support'] });
    assert.deepEqual(seeded.groups.map(group => group.name), ['Management', 'Support']);
    assert.equal(seeded.groups[0].dongles.length, 0);
});

test('writeConfig round-trips through a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-dongle-groups-'));
    const file = path.join(dir, 'groups.json');
    try {
        const written = groups.writeConfig({ groups: [{ name: 'Main', dongles: ['dongle0'] }] }, file);
        const read = groups.readConfig(file);
        assert.deepEqual(read.groups, written.groups);
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(raw.groups[0].name, 'Main');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
