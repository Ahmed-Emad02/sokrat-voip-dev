'use strict';
// Explicit host smoke checks; ordinary CI must not depend on a live PBX.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const MODULE = process.env.SOKRAT_CHAN_DONGLE_MODULE || '/usr/lib64/asterisk/modules/chan_dongle.so';
const host = { skip: process.env.SOKRAT_HOST_TESTS === '1' ? false : 'Set SOKRAT_HOST_TESTS=1 for read-only deployed-host checks.' };

test('deployed module bytes match the shipped release', host, () => {
    const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(digest(MODULE), digest(path.join(ROOT, 'installer-bundle/binaries/chan_dongle.so')));
});

test('Asterisk actually maps the current installed driver, not an obsolete inode', host, () => {
    const status = execFileSync('/usr/sbin/asterisk', ['-rx', 'module show like chan_dongle'], {
        encoding: 'utf8', timeout: 10000,
    });
    assert.match(status, /chan_dongle\.so\s+.*Running/);
    const pids = execFileSync('pgrep', ['-x', 'asterisk'], { encoding: 'utf8', timeout: 5000 }).trim().split(/\s+/);
    assert.equal(pids.length, 1, 'Asterisk process must be unambiguous');
    const inode = String(fs.statSync(MODULE).ino);
    const mappings = fs.readFileSync(`/proc/${pids[0]}/maps`, 'utf8').split('\n')
        .map(line => line.trim().split(/\s+/))
        .filter(fields => fields[5] === MODULE);
    assert.ok(mappings.length > 0, 'installed driver is not mapped');
    for (const fields of mappings) {
        assert.equal(fields[4], inode, 'running driver is stale; config reload cannot activate a new binary');
        assert.equal(fields.length, 6, 'running driver mapping must not be marked deleted');
    }
});
