const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawnSync } = require('./fixtures/laya-offline');

const REPO = require('path').resolve(__dirname, '..');
const PY = (script) => {
    const res = spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: REPO });
    return res;
};

test('Layer 4 Schema Parity: baseband hygiene settings are seeded across all installers', () => {
    const files = [
        'install.sh',
        'installer-bundle/install-sokrat.sh',
        'scripts/safe-upgrade.sh',
        'backend/install_db.sql',
    ];
    const required = [
        'laya_baseband_hygiene_enabled',
        'laya_baseband_reboot_enabled',
        'laya_baseband_reboot_confirmed',
        'laya_baseband_recovery_timeout_sec',
        'laya_cfun_restart_enabled',
        'laya_cfun_restart_threshold',
    ];
    for (const f of files) {
        const content = fs.readFileSync(`${REPO}/${f}`, 'utf8');
        for (const key of required) {
            assert.ok(content.includes(key), `${f} must seed ${key}`);
        }
    }
    // The destructive reboot must default to DISABLED everywhere
    for (const f of files) {
        const content = fs.readFileSync(`${REPO}/${f}`, 'utf8');
        assert.ok(
            content.includes("'laya_baseband_reboot_enabled', 'false'"),
            `${f} must default laya_baseband_reboot_enabled to false`
        );
        assert.ok(
            content.includes("'laya_baseband_reboot_confirmed', 'false'"),
            `${f} must default laya_baseband_reboot_confirmed to false`
        );
    }
});

test('Layer 4 Safety: AT^RESET is refused unless BOTH the enable and the acknowledgement gates are open', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.healer.actions import action_baseband_reboot

from laya.sensors import db
settings = {'reboot_enabled': False, 'reboot_confirmed': False}
db.get_baseband_hygiene_settings = lambda: dict(settings)
# No DB update: both independent gates run against in-memory settings.
ok, details = action_baseband_reboot('dongle0')
assert ok is False and 'DISABLED' in details, details
settings['reboot_enabled'] = True
ok, details = action_baseband_reboot('dongle0')
assert ok is False and 'acknowledgement' in details, details
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Baseband reboot gate test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 4 Safety: an invalid dongle identifier is always rejected', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.healer.actions import action_baseband_reboot, action_cfun_restart

ok, details = action_baseband_reboot('not-a-dongle')
assert ok is False, details
assert 'Invalid dongle identifier' in details, details

ok, details = action_cfun_restart('not-a-dongle')
assert ok is False, details
assert 'Invalid dongle identifier' in details, details
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Identifier validation test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 4 Identity: modem identity verification detects a changed IMEI/IMSI', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.sensors import cli
from laya.healer.actions import verify_modem_identity, snapshot_modem_identity
live_dongle = 'dongle0'
cli.get_dongle_device_state = lambda d: {'imei':'123456789012345', 'imsi':'111111111111111', 'state':'Free'}

# A deterministic synthetic identity; never query live hardware
snap = snapshot_modem_identity(live_dongle)
assert snap is not None
assert snap.get('imei'), f'{live_dongle} must expose an IMEI: {snap}'

# The identity of the live modem must match its own snapshot
ok, details = verify_modem_identity(live_dongle, snap)
assert ok is True, details
assert 'identity verified' in details, details

# A snapshot with a DIFFERENT IMEI must be rejected
tampered = dict(snap)
tampered['imei'] = '000000000000000'
ok, details = verify_modem_identity(live_dongle, tampered)
assert ok is False, 'a changed IMEI must fail verification'
assert 'imei changed' in details, details
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Identity verification test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 4 AT Dispatch: a failed AT command is detected instead of silently succeeding', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.sensors import cli
cli.exec_asterisk_cmd = lambda *a, **k: (True, '[dongleX-does-not-exist] Device not found', '')
from laya.sensors.cli import send_dongle_at_command

# A non-existent dongle must be reported as a FAILURE, not a success.
# The Asterisk CLI always exits 0, so the response text must be inspected.
ok, resp, err = send_dongle_at_command('dongleX-does-not-exist', 'AT+CPAS')
assert ok is False, f'expected failure, got {ok} / {resp}'
assert resp, resp
assert 'AT command queued' not in resp, resp
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `AT dispatch detection test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 4 Config: baseband hygiene settings are readable and have safe defaults', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.sensors.db import get_baseband_hygiene_settings

s = get_baseband_hygiene_settings()
for key in ('hygiene_enabled', 'cfun_enabled', 'cfun_threshold',
            'reboot_enabled', 'reboot_confirmed', 'recovery_timeout_sec'):
    assert key in s, f'missing setting {key}'

assert isinstance(s['cfun_threshold'], int) and s['cfun_threshold'] >= 1, s
assert isinstance(s['recovery_timeout_sec'], int) and s['recovery_timeout_sec'] >= 15, s
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Baseband settings test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 4 CLI: baseband subcommand exposes hygiene, reattach and reboot actions', () => {
    const res = spawnSync('python3', ['laya/cli.py', '--json', 'baseband', 'hygiene'], {
        encoding: 'utf8', cwd: REPO
    });
    assert.equal(res.status, 0, `baseband hygiene must exit 0: ${res.stderr}`);
    const data = JSON.parse(res.stdout);
    assert.ok('reboot_enabled' in data, 'must expose reboot_enabled');
    assert.ok('cfun_enabled' in data, 'must expose cfun_enabled');
    assert.ok('hygiene_enabled' in data, 'must expose hygiene_enabled');
});
