const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

test('backend/install_db.sql has full schema parity for extension scoping, dongle logs, dynamic dongles, and queues', () => {
    const sqlPath = path.join(__dirname, '..', 'backend', 'install_db.sql');
    assert.ok(fs.existsSync(sqlPath), 'install_db.sql must exist');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // dashboard_users table
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `dashboard_users`/, 'dashboard_users table must be created');
    assert.match(sql, /`extension` VARCHAR\(20\) DEFAULT NULL/, 'dashboard_users must define extension column');
    assert.match(sql, /KEY `idx_dash_users_extension` \(`extension`\)/, 'dashboard_users must index extension');

    // gsm_dongles & dongle_state_logs table
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `gsm_dongles`/, 'gsm_dongles table must be created');
    assert.match(sql, /`dynamic_enabled` TINYINT\(1\) NOT NULL DEFAULT 0/, 'gsm_dongles must define dynamic_enabled column');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `dongle_state_logs`/, 'dongle_state_logs table must be created');
    assert.match(sql, /`dongle_name` VARCHAR\(50\) NOT NULL/, 'dongle_state_logs must define dongle_name column');

    // storage_settings table
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `storage_settings`/, 'storage_settings table must be created');
    assert.match(sql, /`queue_provisioned` TINYINT\(1\) DEFAULT 0/, 'storage_settings must define queue_provisioned column');
    assert.match(sql, /INSERT IGNORE INTO `storage_settings` \(`id`\) VALUES \(1\);/, 'storage_settings default row must be seeded');
});

test('install.sh contains schema migrations, rnnoise builds, and inbound blacklist dialplan', () => {
    const installPath = path.join(__dirname, '..', 'install.sh');
    assert.ok(fs.existsSync(installPath), 'install.sh must exist');
    const script = fs.readFileSync(installPath, 'utf8');

    // Schema migrations
    assert.match(script, /ensure_db_column "dashboard_users" "extension"/, 'install.sh must migrate dashboard_users.extension');
    assert.match(script, /ensure_db_column "gsm_dongles" "dynamic_enabled"/, 'install.sh must migrate gsm_dongles.dynamic_enabled');
    assert.match(script, /ensure_db_column "storage_settings" "queue_provisioned"/, 'install.sh must migrate storage_settings.queue_provisioned');

    // Dialplan blacklist check
    assert.match(script, /CLEAN_CALLER=\$\{FILTER\(0123456789,\$\{CALLER_NUMBER\}\)\}/, 'install.sh must clean caller number');
    assert.match(script, /ExecIf\(\$\["\$\{DB\(blacklist\/\$\{CALLER_NUMBER\}\)\}" != ""/, 'install.sh must check DB(blacklist/...)');
    assert.match(script, /same => n\(blacklisted\),NoOp\(--- INBOUND CALL REJECTED BY BLACKLIST RULE:/, 'install.sh must define blacklisted rejection label');
    assert.match(script, /same => n,Playback\(ss-noservice\)/, 'install.sh must play ss-noservice on blacklist rejection');
});

test('install.sh and uninstall.sh pass bash syntax validation', () => {
    const rootDir = path.join(__dirname, '..');
    assert.doesNotThrow(() => {
        execSync('bash -n install.sh', { cwd: rootDir, stdio: 'pipe' });
    }, 'install.sh must pass bash -n syntax check');

    assert.doesNotThrow(() => {
        execSync('bash -n uninstall.sh', { cwd: rootDir, stdio: 'pipe' });
    }, 'uninstall.sh must pass bash -n syntax check');
});
