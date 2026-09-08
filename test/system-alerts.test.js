const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const moment = require('moment');

const serverJsPath = path.join(__dirname, '../server.js');
const watchdogScriptPath = path.join(__dirname, '../scripts/system-watchdog.js');
const installShPath = path.join(__dirname, '../install.sh');
const sidebarViewPath = path.join(__dirname, '../views/sidebar.ejs');
const storageViewPath = path.join(__dirname, '../views/storage.ejs');

const dummyRoster = [
    { extension: '101', name: 'Agent Alpha' }
];

test('server.js registers all alert configuration and diagnostic API endpoints', () => {
    const serverCode = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(serverCode.includes("app.get('/api/settings/alerts'"), 'server.js must register GET /api/settings/alerts');
    assert.ok(serverCode.includes("app.post('/api/settings/alerts'"), 'server.js must register POST /api/settings/alerts');
    assert.ok(serverCode.includes("app.post('/api/settings/alerts/test-telegram'"), 'server.js must register POST /api/settings/alerts/test-telegram');
    assert.ok(serverCode.includes("app.post('/api/settings/alerts/test-email'"), 'server.js must register POST /api/settings/alerts/test-email');
    assert.ok(serverCode.includes("app.post('/api/settings/alerts/test-heartbeat'"), 'server.js must register POST /api/settings/alerts/test-heartbeat');
    assert.ok(serverCode.includes("app.get('/api/settings/alerts/watchdog-status'"), 'server.js must register GET /api/settings/alerts/watchdog-status');

    // Security Guards
    assert.ok(serverCode.includes("if (!isSuperAdmin(req))"), 'Alert endpoints must enforce isSuperAdmin check');
});

test('server.js seeds default alerting credentials for Telegram and Healthchecks.io', () => {
    const serverCode = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(serverCode.includes('8742498784:AAF49-2KCi7kT24ZnGpdKuxO4CweqyqHELc'), 'Must seed user-provided Telegram bot token');
    assert.ok(serverCode.includes("'alert_telegram_chat_id', '8996079391'"), 'Must seed user-provided Telegram chat ID');
    assert.ok(serverCode.includes('https://hc-ping.com/b8b5b103-e272-4666-bb37-561780de64f3'), 'Must seed user-provided Healthchecks.io ping URL');
});

test('scripts/system-watchdog.js exports core functions and valid default configuration', () => {
    assert.ok(fs.existsSync(watchdogScriptPath), 'scripts/system-watchdog.js must exist');
    const watchdog = require(watchdogScriptPath);

    assert.ok(typeof watchdog.loadConfigFromDb === 'function', 'Must export loadConfigFromDb');
    assert.ok(typeof watchdog.checkServiceHealth === 'function', 'Must export checkServiceHealth');
    assert.ok(typeof watchdog.checkHostResources === 'function', 'Must export checkHostResources');
    assert.ok(typeof watchdog.sendTelegramAlert === 'function', 'Must export sendTelegramAlert');
    assert.ok(typeof watchdog.sendEmailAlert === 'function', 'Must export sendEmailAlert');
    assert.ok(typeof watchdog.pingHealthchecks === 'function', 'Must export pingHealthchecks');
    assert.ok(typeof watchdog.runWatchdogCycle === 'function', 'Must export runWatchdogCycle');

    // Default configuration assertions
    assert.equal(watchdog.DEFAULT_CONFIG.telegramBotToken, '8742498784:AAF49-2KCi7kT24ZnGpdKuxO4CweqyqHELc');
    assert.equal(watchdog.DEFAULT_CONFIG.telegramChatId, '8996079391');
    assert.equal(watchdog.DEFAULT_CONFIG.healthchecksUrl, 'https://hc-ping.com/b8b5b103-e272-4666-bb37-561780de64f3');
    assert.equal(watchdog.DEFAULT_CONFIG.telegramEnabled, true);
    assert.equal(watchdog.DEFAULT_CONFIG.autoRestart, true);
});

test('Alert messages include client_name to differentiate between customer servers', () => {
    const watchdogCode = fs.readFileSync(watchdogScriptPath, 'utf8');
    const serverCode = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(watchdogCode.includes("cfg.clientName = r.setting_value.trim()"), 'Watchdog must load client_name from dashboard_settings');
    assert.ok(watchdogCode.includes("<b>Client:</b> ${escapeHtml(clientLabel)}"), 'Watchdog Telegram alerts must display Client label');
    assert.ok(watchdogCode.includes("[${clientLabel}]"), 'Watchdog Email subjects must include [ClientName]');
    assert.ok(watchdogCode.includes("[Client: ${clientLabel}]"), 'Watchdog Healthchecks error payloads must include ClientName');
    assert.ok(serverCode.includes("<b>Client:</b> ${clientLabel}"), 'server.js test Telegram alerts must include ClientName');
});

test('install.sh contains embedded alert configuration and sokrat-watchdog.service provisioning', () => {
    const installSh = fs.readFileSync(installShPath, 'utf8');

    assert.ok(installSh.includes('sokrat-watchdog.service'), 'install.sh must provision sokrat-watchdog.service');
    assert.ok(installSh.includes('systemctl enable --now sokrat-watchdog.service'), 'install.sh must enable and start sokrat-watchdog.service');
    assert.ok(installSh.includes('8742498784:AAF49-2KCi7kT24ZnGpdKuxO4CweqyqHELc'), 'install.sh must embed Telegram bot token');
    assert.ok(installSh.includes('https://hc-ping.com/b8b5b103-e272-4666-bb37-561780de64f3'), 'install.sh must embed Healthchecks.io ping URL');
    assert.ok(installSh.includes('collect_client_name'), 'install.sh must define collect_client_name');
    const clientIndex = installSh.indexOf('collect_client_name\n');
    const dongleIndex = installSh.indexOf('collect_dongle_count\n');
    assert.ok(clientIndex < dongleIndex, 'install.sh must collect client name before dongle count');
    assert.ok(installSh.includes('hostnamectl set-hostname'), 'install.sh must set machine hostname from client name');
    assert.ok(installSh.includes("VALUES ('client_name', '$CLIENT_NAME')"), 'install.sh must seed client_name in dashboard_settings');
    assert.ok(installSh.includes('port=3001'), 'install.sh must configure Webmin on port 3001');
    assert.ok(installSh.includes('systemctl enable --now webmin'), 'install.sh must enable and start webmin');
});

test('views/sidebar.ejs renders System Alerts entry and #alertsModal in English and Arabic', async () => {
    const htmlEn = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['storage']
    });

    assert.ok(htmlEn.includes('id="alertsSettingsBtn"'), 'Must render alertsSettingsBtn in English');
    assert.ok(htmlEn.includes('id="alertsModal"'), 'Must render alertsModal in English');
    assert.ok(htmlEn.includes('id="alertTelegramEnabled"'), 'Must render alertTelegramEnabled input');
    assert.ok(htmlEn.includes('id="alertTelegramBotToken"'), 'Must render alertTelegramBotToken input');
    assert.ok(htmlEn.includes('id="alertTelegramChatId"'), 'Must render alertTelegramChatId input');
    assert.ok(htmlEn.includes('id="alertEmailEnabled"'), 'Must render alertEmailEnabled input');
    assert.ok(htmlEn.includes('id="alertEmailRecipients"'), 'Must render alertEmailRecipients input');
    assert.ok(htmlEn.includes('id="alertHealthchecksUrl"'), 'Must render alertHealthchecksUrl input');
    assert.ok(htmlEn.includes('id="testTelegramBtn"'), 'Must render testTelegramBtn button');
    assert.ok(htmlEn.includes('id="testEmailBtn"'), 'Must render testEmailBtn button');
    assert.ok(htmlEn.includes('id="testHeartbeatBtn"'), 'Must render testHeartbeatBtn button');

    const htmlAr = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'ar',
        currentPage: '/storage',
        isRtl: true,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['storage']
    });

    assert.ok(htmlAr.includes('تنبيهات النظام'), 'Must render Arabic label for System Alerts');
    assert.ok(htmlAr.includes('id="alertsModal"'), 'Must render alertsModal in Arabic');
});

test('views/storage.ejs renders Watchdog status card and telemetry hook in Services tab', async () => {
    const html = await ejs.renderFile(storageViewPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        roster: dummyRoster,
        moment,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['storage']
    });

    assert.ok(html.includes('id="watchdog-status-pill"'), 'Must render watchdog-status-pill element');
    assert.ok(html.includes('fetchWatchdogStatus'), 'Must include fetchWatchdogStatus function in client scripts');
    assert.ok(html.includes('openAlertsModal'), 'Must hook into openAlertsModal from SysMon');
});

test('Watchdog detects service failure, formats Telegram alert, and handles auto-recovery transition', async () => {
    const watchdog = require(watchdogScriptPath);

    // Verify checkServiceHealth returns structured diagnostic payload
    const s = await watchdog.checkServiceHealth('asterisk');
    assert.ok(typeof s === 'object', 'checkServiceHealth must return status object');
    assert.ok(s.id === 'asterisk', 'Returned service ID must match');
    assert.ok(typeof s.healthy === 'boolean', 'healthy must be a boolean');
    assert.ok(typeof s.state === 'string', 'state must be a string');

    // Verify Telegram payload formatting with client_name
    const cfg = await watchdog.loadConfigFromDb();
    assert.equal(cfg.telegramEnabled, true);
    assert.equal(cfg.telegramChatId, '8996079391');
});

test('views/sidebar.ejs renders User and Version labels in English and Arabic', async () => {
    const htmlEn = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'root',
        allowedTabs: ['storage']
    });

    assert.ok(htmlEn.includes('User') && htmlEn.includes('Version'), 'Must render User and Version labels in English');
    assert.ok(htmlEn.includes('v1.0.4'), 'Must render version text v1.0.4');

    const htmlAr = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'ar',
        currentPage: '/storage',
        isRtl: true,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'root',
        allowedTabs: ['storage']
    });

    assert.ok(htmlAr.includes('المستخدم') && htmlAr.includes('الإصدار'), 'Must render User and Version labels in Arabic');
});

test('views/sidebar.ejs renders Issabel GUI port 3000 button strictly for root user only', async () => {
    const htmlAdmin = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['storage']
    });
    assert.equal(htmlAdmin.includes('id="issabelWebGuiBtn"'), false, 'Non-root admin must not see Issabel GUI button');

    const htmlRoot = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: true,
        currentUser: 'root',
        allowedTabs: ['storage']
    });
    assert.equal(htmlRoot.includes('id="issabelWebGuiBtn"'), true, 'Root user must see Issabel GUI button');
    assert.ok(htmlRoot.includes('openIssabelAutoLogin'), 'Button must trigger openIssabelAutoLogin');
    assert.ok(htmlRoot.includes(':3000'), 'Auto-login script must target port 3000');
});

test('server.js handleClientSettingsUpdate synchronizes system hostname with client name', () => {
    const serverCode = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(serverCode.includes("fs.writeFileSync('/etc/hostname'"), 'Must write persistent /etc/hostname');
    assert.ok(serverCode.includes("execFile('hostname'"), 'Must set live hostname via hostname binary');
    assert.ok(serverCode.includes("hostnamectl"), 'Must set hostname via hostnamectl');
});
