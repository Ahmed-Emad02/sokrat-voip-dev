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

    // dashboard_user_extensions & dashboard_user_preferences
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `dashboard_user_extensions`/, 'dashboard_user_extensions table must be created');
    assert.match(sql, /`extension` VARCHAR\(20\) NOT NULL/, 'dashboard_user_extensions must define extension column');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `dashboard_user_preferences`/, 'dashboard_user_preferences table must be created');
    assert.match(sql, /`preferences_json` LONGTEXT NOT NULL/, 'dashboard_user_preferences must define preferences_json column');

    // gsm_dongles & dongle_state_logs table
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `gsm_dongles`/, 'gsm_dongles table must be created');
    assert.match(sql, /`dynamic_enabled` TINYINT\(1\) NOT NULL DEFAULT 0/, 'gsm_dongles must define dynamic_enabled column');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `dongle_state_logs`/, 'dongle_state_logs table must be created');
    assert.match(sql, /`dongle_name` VARCHAR\(50\) NOT NULL/, 'dongle_state_logs must define dongle_name column');

    // storage_settings table
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `storage_settings`/, 'storage_settings table must be created');
    assert.match(sql, /`queue_provisioned` TINYINT\(1\) DEFAULT 0/, 'storage_settings must define queue_provisioned column');
    assert.match(sql, /INSERT IGNORE INTO `storage_settings` \(`id`\) VALUES \(1\);/, 'storage_settings default row must be seeded');

    // RCONFFAIL notification cleanup
    assert.match(sql, /DELETE FROM `asterisk`\.`notifications` WHERE `id` = 'RCONFFAIL';/, 'install_db.sql must delete stale RCONFFAIL notifications');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `asterisk`\.`sipsettings`/, 'install_db.sql must ensure sipsettings table exists before updates');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `asterisk`\.`pjsipsettings`/, 'install_db.sql must ensure pjsipsettings table exists before updates');
});

test('install.sh contains schema migrations, rnnoise builds, and inbound blacklist dialplan', () => {
    const installPath = path.join(__dirname, '..', 'install.sh');
    assert.ok(fs.existsSync(installPath), 'install.sh must exist');
    const script = fs.readFileSync(installPath, 'utf8');

    // Schema migrations & tables
    assert.match(script, /CREATE TABLE IF NOT EXISTS \\`dashboard_user_extensions\\`/, 'install.sh must create dashboard_user_extensions table');
    assert.match(script, /CREATE TABLE IF NOT EXISTS \\`dashboard_user_preferences\\`/, 'install.sh must create dashboard_user_preferences table');
    assert.match(script, /ensure_db_column "dashboard_users" "extension"/, 'install.sh must migrate dashboard_users.extension');
    assert.match(script, /ensure_db_column "gsm_dongles" "dynamic_enabled"/, 'install.sh must migrate gsm_dongles.dynamic_enabled');
    assert.match(script, /ensure_db_column "storage_settings" "queue_provisioned"/, 'install.sh must migrate storage_settings.queue_provisioned');

    // Dialplan blacklist check
    assert.match(script, /CLEAN_CALLER=\$\{FILTER\(0123456789,\$\{CALLER_NUMBER\}\)\}/, 'install.sh must clean caller number');
    assert.match(script, /ExecIf\(\$\["\$\{DB\(blacklist\/\$\{CALLER_NUMBER\}\)\}" != ""/, 'install.sh must check DB(blacklist/...)');
    assert.match(script, /same => n\(blacklisted\),NoOp\(--- INBOUND CALL REJECTED BY BLACKLIST RULE:/, 'install.sh must define blacklisted rejection label');
    assert.match(script, /same => n,Playback\(ss-noservice\)/, 'install.sh must play ss-noservice on blacklist rejection');

    // amportal-reload.service boot race prevention & notification cleanup
    assert.match(script, /DELETE FROM \\`notifications\\` WHERE \\`id\\` = 'RCONFFAIL';/, 'install.sh must clear stale RCONFFAIL notification');
    assert.match(script, /AMPORTAL_SERVICE in \/usr\/lib\/systemd\/system\/amportal-reload\.service \/etc\/systemd\/system\/amportal-reload\.service/, 'install.sh must inspect amportal-reload.service unit locations');
    assert.match(script, /ExecStartPre=\/bin\/bash -c '\\''for i in \$\(seq 1 30\); do if \/usr\/sbin\/asterisk -rx "core show version"/, 'install.sh must configure ExecStartPre readiness check on amportal-reload.service');

    // PicoTTS AGI self-provisioning & DB prerequisites
    assert.match(script, /write_embedded_picotts_agi/, 'install.sh must define write_embedded_picotts_agi fallback');
    assert.match(script, /CREATE TABLE IF NOT EXISTS \\`sipsettings\\`/, 'install.sh must ensure sipsettings table exists before import');

    // Sokrat MOTD installation after cloning in Step 3
    assert.match(script, /MOTD_SCRIPT="\$INSTALL_DIR\/scripts\/sokrat-motd\.sh"/, 'install.sh must define MOTD_SCRIPT relative to INSTALL_DIR');
    assert.match(script, /cp "\$MOTD_SCRIPT" \/etc\/profile\.d\/sokrat-motd\.sh/, 'install.sh must copy MOTD script to profile.d');

    // Call transfer protection & dongle dialplan sanitization
    assert.match(script, /sed -i '\/dongle restart now\/d' \/etc\/asterisk\/extensions\*\.conf/, 'install.sh must sanitize rogue dongle restart commands');
    assert.match(script, /re\.sub\([^)]*dongle-hangup-cleanup[^)]*\)/, 'install.sh must strip dongle-hangup-cleanup');
    assert.doesNotMatch(script, /same => n,Set\(CHANNEL\(hangup_handler_push\)=dongle-hangup-cleanup,s,1\)/, 'install.sh must not push dongle-hangup-cleanup');
});

test('installer-bundle/install-sokrat.sh prevents duplicate cloning and passes bash syntax validation', () => {
    const rootDir = path.join(__dirname, '..');
    const bundleInstallerPath = path.join(rootDir, 'installer-bundle', 'install-sokrat.sh');
    assert.ok(fs.existsSync(bundleInstallerPath), 'install-sokrat.sh must exist');
    assert.doesNotThrow(() => {
        execSync(`bash -n "${bundleInstallerPath}"`, { cwd: rootDir, stdio: 'pipe' });
    }, 'install-sokrat.sh must pass bash -n syntax check');

    const script = fs.readFileSync(bundleInstallerPath, 'utf8');
    assert.match(script, /SCRIPT_DIR=/, 'install-sokrat.sh must define SCRIPT_DIR dynamically');
    assert.match(script, /PARENT_DIR=/, 'install-sokrat.sh must define PARENT_DIR dynamically');
    assert.match(script, /elif \[ -f "\$PARENT_DIR\/server\.js" \]/, 'install-sokrat.sh must detect existing parent source to prevent duplicate cloning');
    assert.match(script, /elif \[ -f "\$SCRIPT_DIR\/binaries\/node" \]/, 'install-sokrat.sh must look for node binary in SCRIPT_DIR');
    assert.match(script, /if \[ -f "\$SCRIPT_DIR\/binaries\/chan_dongle\.so" \]/, 'install-sokrat.sh must look for chan_dongle.so in SCRIPT_DIR');
    assert.match(script, /command -v git/, 'install-sokrat.sh must check and install git at the beginning');
    assert.match(script, /packages\/nodejs-\*\.rpm/, 'install-sokrat.sh must check for offline nodejs RPM');
    assert.match(script, /webmin-\*\.rpm/, 'install-sokrat.sh must check for offline webmin RPM');
    assert.match(script, /librnnoise\.so/, 'install-sokrat.sh must check for offline rnnoise library');
    assert.match(script, /binaries\/ffmpeg/, 'install-sokrat.sh must check for offline ffmpeg binary');
    assert.match(script, /cand_pico.*binaries/, 'install-sokrat.sh must check for offline pico2wave binary');
    assert.match(script, /mod_ssl-\*\.rpm/, 'install-sokrat.sh must check for offline mod_ssl package');
    assert.match(script, /\/boot\/efi\/EFI\/rocky\/grub\.cfg/, 'install-sokrat.sh must support Rocky Linux UEFI grub path');

    // Call transfer protection & dongle dialplan sanitization
    assert.match(script, /sed -i '\/dongle restart now\/d' \/etc\/asterisk\/extensions\*\.conf/, 'install-sokrat.sh must sanitize rogue dongle restart commands');
    assert.match(script, /re\.sub\([^)]*dongle-hangup-cleanup[^)]*\)/, 'install-sokrat.sh must strip dongle-hangup-cleanup');
    assert.doesNotMatch(script, /same => n,Set\(CHANNEL\(hangup_handler_push\)=dongle-hangup-cleanup,s,1\)/, 'install-sokrat.sh must not push dongle-hangup-cleanup');
});

test('installer-bundle/setup-issabel-asterisk.sh passes syntax validation and does not repeat package or binary installation', () => {
    const rootDir = path.join(__dirname, '..');
    const setupScriptPath = path.join(rootDir, 'installer-bundle', 'setup-issabel-asterisk.sh');
    assert.ok(fs.existsSync(setupScriptPath), 'setup-issabel-asterisk.sh must exist');
    assert.doesNotThrow(() => {
        execSync(`bash -n "${setupScriptPath}"`, { cwd: rootDir, stdio: 'pipe' });
    }, 'setup-issabel-asterisk.sh must pass bash -n syntax check');

    const script = fs.readFileSync(setupScriptPath, 'utf8');

    // Verify rpm installation command is not duplicated
    const rpmAllMatches = script.match(/rpm -Uvh --replacepkgs --nodeps "\$\{RPM_DIR\}"\/\*\.rpm/g);
    assert.strictEqual(rpmAllMatches ? rpmAllMatches.length : 0, 1, 'setup-issabel-asterisk.sh must not repeat the full RPM directory install');

    // Verify chan_dongle copy is not duplicated
    const chanDongleMatches = script.match(/cp "\$SCRIPT_DIR\/binaries\/chan_dongle\.so"/g);
    assert.strictEqual(chanDongleMatches ? chanDongleMatches.length : 0, 1, 'setup-issabel-asterisk.sh must not repeat chan_dongle.so installation');

    // Verify core binary installation is not erroneously nested
    assert.match(script, /packages\/nodejs-\*\.rpm/, 'setup-issabel-asterisk.sh must check for offline nodejs RPM');
    assert.match(script, /packages\/webmin-\*\.rpm/, 'setup-issabel-asterisk.sh must check for offline webmin RPM');
    assert.match(script, /export WEBMIN_PORT=3001/, 'setup-issabel-asterisk.sh must export WEBMIN_PORT=3001');
    assert.match(script, /systemctl restart webmin/, 'setup-issabel-asterisk.sh must restart webmin service');
    assert.match(script, /librnnoise\.so/, 'setup-issabel-asterisk.sh must install rnnoise libraries');
    assert.match(script, /func_rnnoise\.so/, 'setup-issabel-asterisk.sh must install func_rnnoise.so module');
    assert.match(script, /--exclude="binaries\/chan_dongle\.so"/, 'setup-issabel-asterisk.sh must protect patched chan_dongle.so from tar overwrite');
    assert.match(script, /load => chan_sip\.so/, 'setup-issabel-asterisk.sh must use valid Asterisk load => directive syntax');
    assert.doesNotMatch(script, /if \[ -f "\$SCRIPT_DIR\/binaries\/node" \]; then[\s\S]*if \[ -f "\$SCRIPT_DIR\/binaries\/node" \]; then/, 'setup-issabel-asterisk.sh must not nest binary installations inside duplicate node checks');
});

test('inbound call webhook is wired to the asterisk database and fires on dongle Newchannel', () => {
    const rootDir = path.join(__dirname, '..');
    const serverPath = path.join(rootDir, 'server.js');
    assert.ok(fs.existsSync(serverPath), 'server.js must exist');

    const server = fs.readFileSync(serverPath, 'utf8');

    // Schema + installer seeding of the webhook settings keys
    const sql = fs.readFileSync(path.join(rootDir, 'backend', 'install_db.sql'), 'utf8');
    assert.match(sql, /'webhook_incoming_call_enabled'/, 'install_db.sql must seed webhook_incoming_call_enabled');
    assert.match(sql, /'webhook_incoming_call_url'/, 'install_db.sql must seed webhook_incoming_call_url');
    assert.match(sql, /'webhook_incoming_call_secret'/, 'install_db.sql must seed webhook_incoming_call_secret');

    for (const installer of ['install.sh', path.join('installer-bundle', 'install-sokrat.sh')]) {
        const s = fs.readFileSync(path.join(rootDir, installer), 'utf8');
        assert.match(s, /'webhook_incoming_call_url'/, `${installer} must seed webhook settings`);
    }

    const safeUpgrade = fs.readFileSync(path.join(rootDir, 'scripts', 'safe-upgrade.sh'), 'utf8');
    assert.match(safeUpgrade, /webhook_incoming_call_enabled/, 'safe-upgrade.sh must seed webhook settings idempotently');

    // The shared pool points at the CDR database, so webhook reads/writes must use a
    // dedicated connection qualified to ASTERISK_DB or they will hit the wrong schema.
    const loader = server.match(/async function loadWebhookConfigFromDb\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(loader, 'server.js must define loadWebhookConfigFromDb');
    assert.match(loader[0], /database:\s*ASTERISK_DB/, 'loadWebhookConfigFromDb must connect to ASTERISK_DB (dashboard_settings lives in the asterisk schema)');

    const saveHandler = server.match(/app\.post\('\/api\/settings\/webhook',[\s\S]*?\n\}\);/);
    assert.ok(saveHandler, 'server.js must define POST /api/settings/webhook');
    assert.match(saveHandler[0], /database:\s*ASTERISK_DB/, 'POST /api/settings/webhook must write to ASTERISK_DB');

    // API surface
    assert.match(server, /app\.get\('\/api\/settings\/webhook', requireAuth/, 'server.js must expose GET /api/settings/webhook');
    assert.match(server, /app\.post\('\/api\/settings\/webhook\/test', requireAuth/, 'server.js must expose POST /api/settings/webhook/test');
    assert.match(saveHandler[0], /isSuperAdmin\(req\)/, 'webhook settings must be restricted to super admin');

    // Trigger on inbound GSM calls
    const newChannelBlock = server.match(/if \(event\.Event === 'Newchannel'\)\s*\{[\s\S]{0,2000}?broadcastTrunkStatus\(\);\s*\}/);
    assert.ok(newChannelBlock, 'server.js must have a Newchannel AMI handler');
    assert.match(newChannelBlock[0], /extractDongleIdFromChannel\(event\.Channel\)/, 'Newchannel handler must detect dongle channels');
    assert.match(newChannelBlock[0], /fireInboundCallWebhook\(/, 'Newchannel handler must fire the inbound call webhook for dongle calls');

    // Payload contract + signing
    const fire = server.match(/function fireInboundCallWebhook\([\s\S]*?\n\}/);
    assert.ok(fire, 'server.js must define fireInboundCallWebhook');
    for (const field of ['event', 'caller_number', 'called_number', 'dongle', 'timestamp']) {
        assert.match(fire[0], new RegExp(field), `webhook payload must include ${field}`);
    }
    assert.match(fire[0], /createHmac\('sha256'/, 'webhook must support HMAC-SHA256 signing');
    assert.match(fire[0], /X-Sokrat-Signature/, 'webhook must send the X-Sokrat-Signature header');

    // Cached config must be loaded at boot
    assert.match(server, /await loadWebhookConfigFromDb\(\)/, 'server.js must load webhook config at startup');

    // UI
    const sidebar = fs.readFileSync(path.join(rootDir, 'views', 'sidebar.ejs'), 'utf8');
    assert.match(sidebar, /id="webhookModal"/, 'sidebar must contain the webhook modal');
    assert.match(sidebar, /function openWebhookModal\(\)/, 'sidebar must define openWebhookModal');
    assert.match(sidebar, /function saveWebhookSettings\(event\)/, 'sidebar must define saveWebhookSettings');
    assert.match(sidebar, /function testWebhook\(\)/, 'sidebar must define testWebhook');
    assert.match(sidebar, /\/api\/settings\/webhook/, 'sidebar must call the webhook settings API');
});

test('offline installer packages and binaries are present in installer-bundle', () => {
    const rootDir = path.join(__dirname, '..');
    const packagesDir = path.join(rootDir, 'installer-bundle', 'packages');
    const binariesDir = path.join(rootDir, 'installer-bundle', 'binaries');

    assert.ok(fs.existsSync(packagesDir), 'installer-bundle/packages must exist');
    assert.ok(fs.existsSync(binariesDir), 'installer-bundle/binaries must exist');

    // Check Node.js and Webmin packages
    const pkgFiles = fs.readdirSync(packagesDir);
    assert.ok(pkgFiles.some(f => f.startsWith('nodejs-') && f.endsWith('.rpm')), 'nodejs RPM must be present in packages');
    assert.ok(pkgFiles.some(f => f.startsWith('webmin-') && f.endsWith('.rpm')), 'webmin RPM must be present in packages');

    // Check RNNoise binaries
    const binFiles = fs.readdirSync(binariesDir);
    assert.ok(binFiles.some(f => f.startsWith('librnnoise.so')), 'librnnoise must be present in binaries');
    assert.ok(binFiles.includes('func_rnnoise.so'), 'func_rnnoise.so must be present in binaries');
    assert.ok(binFiles.includes('rnnoise.h'), 'rnnoise.h must be present in binaries');
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

test('scripts/safe-upgrade.sh passes bash syntax validation and includes non-destructive schema and dialplan updates', () => {
    const rootDir = path.join(__dirname, '..');
    const upgradeScriptPath = path.join(rootDir, 'scripts', 'safe-upgrade.sh');
    assert.ok(fs.existsSync(upgradeScriptPath), 'safe-upgrade.sh must exist');
    assert.doesNotThrow(() => {
        execSync(`bash -n "${upgradeScriptPath}"`, { cwd: rootDir, stdio: 'pipe' });
    }, 'safe-upgrade.sh must pass bash -n syntax check');

    const script = fs.readFileSync(upgradeScriptPath, 'utf8');
    assert.match(script, /backend\/install_db\.sql/, 'safe-upgrade.sh must apply install_db.sql schema');
    assert.match(script, /ensure_db_column/, 'safe-upgrade.sh must define ensure_db_column migration');
    assert.match(script, /chan_dongle\.patch/, 'safe-upgrade.sh must apply chan_dongle.patch');
    assert.match(script, /re\.sub\([^)]*dongle-hangup-cleanup[^)]*\)/, 'safe-upgrade.sh must sanitize dongle-hangup-cleanup');
    assert.match(script, /sed -i '\/dongle restart now\/d'/, 'safe-upgrade.sh must strip rogue dongle restart triggers');
});

test('scripts/retrieve-backups.sh passes bash syntax validation and supports snapshot listing and streaming', () => {
    const rootDir = path.join(__dirname, '..');
    const retrieveScriptPath = path.join(rootDir, 'scripts', 'retrieve-backups.sh');
    assert.ok(fs.existsSync(retrieveScriptPath), 'retrieve-backups.sh must exist');
    assert.doesNotThrow(() => {
        execSync(`bash -n "${retrieveScriptPath}"`, { cwd: rootDir, stdio: 'pipe' });
    }, 'retrieve-backups.sh must pass bash -n syntax check');

    const script = fs.readFileSync(retrieveScriptPath, 'utf8');
    assert.match(script, /--stream/, 'retrieve-backups.sh must support streaming mode');
    assert.match(script, /--list/, 'retrieve-backups.sh must support list mode');
    assert.match(script, /sha256sum/, 'retrieve-backups.sh must generate checksums');
    assert.match(script, /tar -czf/, 'retrieve-backups.sh must compress archives with tar');

    const listOutput = execSync(`bash "${retrieveScriptPath}" --list`, { cwd: rootDir, encoding: 'utf8' });
    assert.match(listOutput, /Available Backup Snapshots/, 'retrieve-backups.sh --list should output snapshot table');
});
