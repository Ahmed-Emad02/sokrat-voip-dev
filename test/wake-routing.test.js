'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const asterisk = process.env.WAKE_ASTERISK_BIN;

test('wake routing matrix on isolated Asterisk', { skip: !asterisk }, () => {
    const result = spawnSync('python3', [
        path.join(__dirname, 'wake-routing-harness.py'),
        '--asterisk', asterisk,
    ], { encoding: 'utf8', timeout: 180_000 });
    assert.equal(result.status, 0, String(result.stderr || '') + String(result.stdout || ''));
});

test('installer push hooks select numeric PJSIP targets by metadata, not number', { skip: !asterisk }, () => {
    const result = spawnSync('python3', [
        path.join(__dirname, 'wake-routing-harness.py'),
        '--asterisk', asterisk, '--installer-hooks',
    ], { encoding: 'utf8', timeout: 180_000 });
    assert.equal(result.status, 0, String(result.stderr || '') + String(result.stdout || ''));
});
