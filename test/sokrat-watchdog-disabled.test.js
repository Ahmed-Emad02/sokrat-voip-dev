'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Deployment policy is exercised without a host in dongle-deployment.test.js.
// This separate smoke check is meaningful only on an explicitly selected PBX.
test('host watchdog is installed, disabled and inactive', { skip: process.env.SOKRAT_HOST_TESTS !== '1' }, () => {
    assert.ok(fs.existsSync('/etc/systemd/system/sokrat-watchdog.service'), 'watchdog unit is missing');
    const enabled = spawnSync('systemctl', ['is-enabled', 'sokrat-watchdog.service'], { encoding: 'utf8', timeout: 20000 });
    assert.ok(!enabled.error, enabled.error && enabled.error.message);
    assert.ok([0, 1].includes(enabled.status), enabled.stderr);
    assert.match(enabled.stdout.trim(), /^(disabled|masked)$/, enabled.stderr || 'unit is not confirmed disabled');
    const active = spawnSync('systemctl', ['is-active', 'sokrat-watchdog.service'], { encoding: 'utf8', timeout: 20000 });
    assert.ok(!active.error, active.error && active.error.message);
    assert.equal(active.status, 3, active.stderr || 'unit is not confirmed inactive');
    assert.equal(active.stdout.trim(), 'inactive', active.stderr || 'cannot determine unit activity');
});
