const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

test('Schema & Multi-Installer Parity: Laya scheduled restart settings seeded across installers', () => {
    // 1. backend/install_db.sql
    const sql = fs.readFileSync(path.join(rootDir, 'backend', 'install_db.sql'), 'utf8');
    assert.match(sql, /laya_scheduled_restart_enabled/, 'install_db.sql must seed laya_scheduled_restart_enabled');
    assert.match(sql, /laya_scheduled_restart_start/, 'install_db.sql must seed laya_scheduled_restart_start');
    assert.match(sql, /laya_scheduled_restart_end/, 'install_db.sql must seed laya_scheduled_restart_end');
    assert.match(sql, /laya_scheduled_restart_cooldown_sec/, 'install_db.sql must seed laya_scheduled_restart_cooldown_sec');

    // 2. scripts/safe-upgrade.sh
    const upgradeScript = fs.readFileSync(path.join(rootDir, 'scripts', 'safe-upgrade.sh'), 'utf8');
    assert.match(upgradeScript, /laya_scheduled_restart_enabled/, 'safe-upgrade.sh must include laya_scheduled_restart_enabled');
    assert.match(upgradeScript, /laya_scheduled_restart_start/, 'safe-upgrade.sh must include laya_scheduled_restart_start');

    // 3. install.sh
    const installScript = fs.readFileSync(path.join(rootDir, 'install.sh'), 'utf8');
    assert.match(installScript, /laya_scheduled_restart_enabled/, 'install.sh must seed laya_scheduled_restart_enabled');
    assert.match(installScript, /laya_scheduled_restart_start/, 'install.sh must seed laya_scheduled_restart_start');

    // 4. installer-bundle/install-sokrat.sh
    const bundleScript = fs.readFileSync(path.join(rootDir, 'installer-bundle', 'install-sokrat.sh'), 'utf8');
    assert.match(bundleScript, /laya_scheduled_restart_enabled/, 'install-sokrat.sh must seed laya_scheduled_restart_enabled');
});

test('Window Calculation: Accurately evaluates standard and midnight-crossing maintenance windows', () => {
    const pythonScript = `
import sys
sys.path.insert(0, '${rootDir}')
from laya.engine import LayaEngine

engine = LayaEngine()

# Standard window 03:00 to 07:00
assert engine.is_time_in_window("03:00", "03:00", "07:00") == True, "03:00 should be inside [03:00, 07:00)"
assert engine.is_time_in_window("04:30", "03:00", "07:00") == True, "04:30 should be inside [03:00, 07:00)"
assert engine.is_time_in_window("06:59", "03:00", "07:00") == True, "06:59 should be inside [03:00, 07:00)"
assert engine.is_time_in_window("07:00", "03:00", "07:00") == False, "07:00 should be outside [03:00, 07:00)"
assert engine.is_time_in_window("02:59", "03:00", "07:00") == False, "02:59 should be outside [03:00, 07:00)"
assert engine.is_time_in_window("12:00", "03:00", "07:00") == False, "12:00 should be outside [03:00, 07:00)"

# Overnight window crossing midnight 23:00 to 04:00
assert engine.is_time_in_window("23:00", "23:00", "04:00") == True, "23:00 should be inside [23:00, 04:00)"
assert engine.is_time_in_window("23:45", "23:00", "04:00") == True, "23:45 should be inside [23:00, 04:00)"
assert engine.is_time_in_window("00:00", "23:00", "04:00") == True, "00:00 should be inside [23:00, 04:00)"
assert engine.is_time_in_window("02:30", "23:00", "04:00") == True, "02:30 should be inside [23:00, 04:00)"
assert engine.is_time_in_window("03:59", "23:00", "04:00") == True, "03:59 should be inside [23:00, 04:00)"
assert engine.is_time_in_window("04:00", "23:00", "04:00") == False, "04:00 should be outside [23:00, 04:00)"
assert engine.is_time_in_window("12:00", "23:00", "04:00") == False, "12:00 should be outside [23:00, 04:00)"
assert engine.is_time_in_window("22:59", "23:00", "04:00") == False, "22:59 should be outside [23:00, 04:00)"

print("WINDOW_OK")
`;
    const res = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf8' });
    assert.equal(res.status, 0, `Python window verification failed: ${res.stderr}`);
    assert.match(res.stdout, /WINDOW_OK/);
});

test('Safety Call Guard: Aborts scheduled restart if active calls are in progress', () => {
    const pythonScript = `
import sys
sys.path.insert(0, '${rootDir}')
from laya.engine import LayaEngine
import laya.engine as eng_module

engine = LayaEngine()

# Mock get_total_active_calls to return 2 active calls
eng_module.get_total_active_calls = lambda: 2
eng_module.is_any_dongle_call_active = lambda: False

res = engine.execute_scheduled_dongle_restarts(force=False, source="Test Guard")
assert res["success"] == False, "Should fail when active calls exist"
assert res["aborted"] == True, "Should flag as aborted"
assert "Active calls on PBX" in res["reason"]
assert len(res["restarted"]) == 0, "No dongles should be restarted"

# Mock cellular dongle call active
eng_module.get_total_active_calls = lambda: 0
eng_module.is_any_dongle_call_active = lambda: True

res2 = engine.execute_scheduled_dongle_restarts(force=False, source="Test Cellular Guard")
assert res2["success"] == False, "Should fail when cellular call active"
assert res2["aborted"] == True, "Should flag as aborted"
assert "Active cellular call in progress" in res2["reason"]

print("GUARD_OK")
`;
    const res = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf8' });
    assert.equal(res.status, 0, `Safety call guard test failed: ${res.stderr}`);
    assert.match(res.stdout, /GUARD_OK/);
});

test('CLI Integration: laya-cli schedule parses arguments and outputs valid JSON', () => {
    const cliPath = path.join(rootDir, 'laya', 'cli.py');
    const res = spawnSync('python3', [cliPath, '--json', 'schedule'], { encoding: 'utf8' });
    assert.equal(res.status, 0, `laya-cli schedule --json failed: ${res.stderr}`);

    const data = JSON.parse(res.stdout);
    assert.equal(typeof data.enabled, 'boolean', 'enabled must be boolean');
    assert.equal(typeof data.start_time, 'string', 'start_time must be string');
    assert.equal(typeof data.end_time, 'string', 'end_time must be string');
    assert.equal(typeof data.cooldown_sec, 'number', 'cooldown_sec must be number');
    assert.equal(typeof data.in_window, 'boolean', 'in_window must be boolean');
});
