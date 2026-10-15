const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

test('Schema & Multi-Installer Parity: Laya tables and service synced across installers', () => {
    // 1. backend/install_db.sql
    const sql = fs.readFileSync(path.join(rootDir, 'backend', 'install_db.sql'), 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `laya_dongle_health`/, 'install_db.sql must define laya_dongle_health');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `laya_maintenance_events`/, 'install_db.sql must define laya_maintenance_events');
    assert.match(sql, /`health_score`\s+TINYINT/, 'laya_dongle_health must include health_score');
    assert.match(sql, /`recovery_level`\s+TINYINT/, 'laya_maintenance_events must include recovery_level');

    // 2. scripts/safe-upgrade.sh
    const upgradeScript = fs.readFileSync(path.join(rootDir, 'scripts', 'safe-upgrade.sh'), 'utf8');
    assert.match(upgradeScript, /laya_dongle_health/, 'safe-upgrade.sh must include laya_dongle_health');
    assert.match(upgradeScript, /laya_maintenance_events/, 'safe-upgrade.sh must include laya_maintenance_events');
    assert.match(upgradeScript, /sokrat-laya\.service/, 'safe-upgrade.sh must restart sokrat-laya.service');

    // 3. install.sh
    const installScript = fs.readFileSync(path.join(rootDir, 'install.sh'), 'utf8');
    assert.match(installScript, /sokrat-laya\.service/, 'install.sh must provision sokrat-laya.service');
    assert.match(installScript, /laya\/cli\.py/, 'install.sh must symlink laya-cli');

    // 4. installer-bundle/install-sokrat.sh
    const bundleScript = fs.readFileSync(path.join(rootDir, 'installer-bundle', 'install-sokrat.sh'), 'utf8');
    assert.match(bundleScript, /sokrat-laya\.service/, 'install-sokrat.sh must provision sokrat-laya.service');
});

test('Python Engine & Modules: Core Laya files exist and have valid syntax', () => {
    const layaDir = path.join(rootDir, 'laya');
    const pyFiles = [
        '__init__.py',
        'config.py',
        'engine.py',
        'cli.py',
        'sensors/__init__.py',
        'sensors/cli.py',
        'sensors/sysfs.py',
        'sensors/ami.py',
        'sensors/db.py',
        'evaluator/__init__.py',
        'evaluator/state_machine.py',
        'evaluator/heuristics.py',
        'healer/__init__.py',
        'healer/actions.py',
        'healer/ladder.py'
    ];

    for (const f of pyFiles) {
        const fullPath = path.join(layaDir, f);
        assert.ok(fs.existsSync(fullPath), `Laya file ${f} must exist`);
        // Syntax check with python3 -m py_compile
        const res = spawnSync('python3', ['-m', 'py_compile', fullPath], { encoding: 'utf8' });
        assert.equal(res.status, 0, `Python syntax validation must pass for ${f}: ${res.stderr}`);
    }
});

test('Evaluator & Heuristics: Accurately identifies stuck channels, deadlocks, and carrier drops', () => {
    const pythonScript = `
import sys
sys.path.insert(0, '${rootDir}')
from laya.evaluator.heuristics import (
    evaluate_dongle_anomalies,
    ANOMALY_NONE,
    ANOMALY_ZOMBIE_CHANNEL,
    ANOMALY_MODEM_DEADLOCK,
    ANOMALY_CARRIER_DROP
)
from laya.evaluator.state_machine import DongleStateManager

# Scenario 1: Normal Free Dongle
h1 = {'dongle_name': 'dongle0', 'curr_state': 'Free', 'stuck_state_duration': 0, 'matching_channels': [], 'carrier_registered': 1, 'rssi': 14}
a1, _, lvl1 = evaluate_dongle_anomalies(h1)
assert a1 == ANOMALY_NONE, f"Expected NONE, got {a1}"

# Scenario 2: Zombie Channel lingering in Dialing for 120s
h2 = {
    'dongle_name': 'dongle0',
    'curr_state': 'Dialing',
    'stuck_state_duration': 120,
    'matching_channels': [{'channel': 'Dongle/dongle0-01', 'state': 'Dialing', 'duration': 120, 'bridged': ''}],
    'carrier_registered': 1,
    'rssi': 14
}
a2, _, lvl2 = evaluate_dongle_anomalies(h2)
assert a2 == ANOMALY_ZOMBIE_CHANNEL, f"Expected ZOMBIE_CHANNEL, got {a2}"
assert lvl2 == 2, f"Expected Level 2, got {lvl2}"

# Scenario 3: Modem Deadlock (tasks/commands in queue)
detail3 = {'tasks_in_queue': 12, 'commands_in_queue': 10}
h3 = {'dongle_name': 'dongle0', 'curr_state': 'Dialing', 'stuck_state_duration': 120, 'matching_channels': []}
a3, _, lvl3 = evaluate_dongle_anomalies(h3, detail3)
assert a3 == ANOMALY_MODEM_DEADLOCK, f"Expected MODEM_DEADLOCK, got {a3}"
assert lvl3 == 3, f"Expected Level 3, got {lvl3}"

# Scenario 4: Carrier Drop while Free
h4 = {'dongle_name': 'dongle0', 'curr_state': 'Free', 'stuck_state_duration': 0, 'matching_channels': [], 'carrier_registered': 0, 'rssi': 0, 'consecutive_errors': 5}
a4, _, lvl4 = evaluate_dongle_anomalies(h4)
assert a4 == ANOMALY_CARRIER_DROP, f"Expected CARRIER_DROP, got {a4}"

print("OK")
`;
    const res = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf8' });
    assert.equal(res.status, 0, `Heuristics test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Healer Actions & Safety: Prevents destructive actions when voice call is active and isolates other dongles', () => {
    const pythonScript = `
import sys
sys.path.insert(0, '${rootDir}')
from laya.healer.actions import is_call_active_on_dongle, action_hangup_channel, action_sysfs_usb_reset
from laya.sensors.sysfs import find_modem_sysfs_for_dongle
from laya.healer.ladder import RecoveryLadder

ladder = RecoveryLadder()
# Should return True/False without throwing
active = is_call_active_on_dongle('dongle0')
assert isinstance(active, bool), "is_call_active_on_dongle must return bool"

# Strict Isolation Test 1: Hangup on wrong channel must fail with Safety Abort
ok, details = action_hangup_channel('dongle0', 'Dongle/dongle1-01')
assert ok is False, "action_hangup_channel must refuse to touch channels of other dongles"
assert 'Safety Abort' in details, "Must report Safety Abort"

# Strict Isolation Test 2: Hangup on SIP channel must fail
ok, details = action_hangup_channel('dongle0', 'PJSIP/101-00000001')
assert ok is False, "action_hangup_channel must refuse to touch SIP extensions"
assert 'Safety Abort' in details

# Strict Isolation Test 3: Sysfs device lookup for unassigned dongle must not grab another dongle's USB port
dev, _ = find_modem_sysfs_for_dongle('dongle9')
assert dev is None, "find_modem_sysfs_for_dongle must return None for dongle9 rather than grabbing dongle0's port"

# Strict Isolation Test 4: Sysfs reset must refuse if device cannot be strictly resolved
ok, details = action_sysfs_usb_reset('dongle9')
assert ok is False, "action_sysfs_usb_reset must refuse to reset USB when ports cannot be verified"
assert 'Safety Abort' in details


print("OK")
`;
    const res = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf8' });
    assert.equal(res.status, 0, `Healer actions safety test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Local CLI & IPC: laya-cli status outputs structured telemetry in json and table modes', () => {
    // 1. laya status --json
    const res = spawnSync('/usr/local/bin/laya', ['--json', 'status'], { encoding: 'utf8' });
    assert.equal(res.status, 0, `laya --json status must exit 0: ${res.stderr}`);
    const data = JSON.parse(res.stdout);
    assert.ok(data.dongles && Array.isArray(data.dongles), 'Output must contain dongles array');
    assert.ok(data.dongles.length > 0, 'Must report at least one dongle');

    // 2. laya audit-usb
    const usbRes = spawnSync('/usr/local/bin/laya', ['--json', 'audit-usb'], { encoding: 'utf8' });
    assert.equal(usbRes.status, 0, `laya --json audit-usb must exit 0: ${usbRes.stderr}`);

    // 3. laya simulate-escalation
    const simRes = spawnSync('/usr/local/bin/laya', ['simulate-escalation', 'dongle0', '--dry-run'], { encoding: 'utf8' });
    assert.equal(simRes.status, 0, `laya simulate-escalation must exit 0: ${simRes.stderr}`);
    assert.match(simRes.stdout, /Telegram Alarm Dispatched Successfully/, 'Must confirm Telegram alarm dispatch');
});

test('Systemd Service: sokrat-laya.service is installed in /etc/systemd/system/', () => {
    const unitPath = '/etc/systemd/system/sokrat-laya.service';
    assert.ok(fs.existsSync(unitPath), 'sokrat-laya.service must exist in /etc/systemd/system/');
    const status = execSync('systemctl is-enabled sokrat-laya.service || true', { encoding: 'utf8' }).trim();
    assert.ok(['enabled', 'disabled'].includes(status), 'sokrat-laya.service must be a recognized systemd unit');
});

test('Server Engine & Dashboard Views: Registers Laya endpoints and renders UI badge & modal', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
    assert.match(serverCode, /\/api\/laya\/status/, 'server.js must define /api/laya/status');
    assert.match(serverCode, /\/api\/laya\/events/, 'server.js must define /api/laya/events');
    assert.match(serverCode, /\/api\/laya\/heal\/:dongle/, 'server.js must define /api/laya/heal/:dongle');

    const gsmView = fs.readFileSync(path.join(rootDir, 'views', 'gsm-dongles.ejs'), 'utf8');
    assert.match(gsmView, /id="btn-open-laya-modal"/, 'gsm-dongles.ejs must define btn-open-laya-modal button');
    assert.match(gsmView, /id="laya-modal"/, 'gsm-dongles.ejs must define laya-modal container');
    assert.match(gsmView, /openLayaModal/, 'gsm-dongles.ejs must define openLayaModal function');
    assert.match(gsmView, /fetchLayaStatus/, 'gsm-dongles.ejs must define fetchLayaStatus function');
    assert.match(gsmView, /triggerLayaHeal/, 'gsm-dongles.ejs must define triggerLayaHeal function');
});
