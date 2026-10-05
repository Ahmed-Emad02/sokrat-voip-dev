const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');

test('chan_dongle Patch: Enforces callwaiting=no, rejects waiting calls with UDUB (AT+CHLD=0), and restores audio master', () => {
    const patchPath = path.join(rootDir, 'asterisk', 'chan_dongle.patch');
    assert.ok(fs.existsSync(patchPath), 'chan_dongle.patch must exist');
    const patch = fs.readFileSync(patchPath, 'utf8');

    // 1. AT+CHLD=0 definition and enqueue
    assert.match(patch, /AT_CHLD_0/, 'patch must define AT_CHLD_0 command');
    assert.match(patch, /at_enqueue_reject_waiting/, 'patch must implement at_enqueue_reject_waiting');

    // 2. at_response_ccwa rejection
    assert.match(patch, /CONF_SHARED\(pvt, callwaiting\) == CALL_WAITING_DISALLOWED/, 'at_response_ccwa must check CALL_WAITING_DISALLOWED');

    // 3. at_response_clcc waiting call drop
    assert.match(patch, /Dropping waiting call idx/, 'at_response_clcc must drop waiting calls when callwaiting=no');

    // 4. channel.c audio master restoration on release & hangup
    assert.match(patch, /Restoring audio master on remaining active call idx/, 'channel.c must restore audio master to remaining active call');

    // 5. +CRING mapping and AT+CRC=0 initialization
    assert.match(patch, /RES_RING.*DEF_STR\("\+CRING:"\)/, 'patch must map +CRING: to RES_RING');
    assert.match(patch, /AT\+CRC=0/, 'patch must initialize AT+CRC=0');
    assert.match(patch, /AT_CRC/, 'patch must define AT_CRC command');

    // 6. Binary sync
    const binPath = path.join(rootDir, 'installer-bundle', 'binaries', 'chan_dongle.so');
    assert.ok(fs.existsSync(binPath), 'installer-bundle/binaries/chan_dongle.so must exist');
    const binStat = fs.statSync(binPath);
    assert.ok(binStat.size > 200000 && binStat.size < 400000, `chan_dongle.so binary must be stripped and sane size (current: ${binStat.size} bytes)`);
});
