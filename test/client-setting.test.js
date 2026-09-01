const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const sidebarViewPath = path.join(__dirname, '../views/sidebar.ejs');
const configViewPath = path.join(__dirname, '../views/config.ejs');
const serverJsPath = path.join(__dirname, '../server.js');

test('views/sidebar.ejs renders client text field right above system clock in English (en)', async () => {
    const html = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        clientName: 'Acme Corporation',
        allowedTabs: ['dashboard', 'cdr', 'config']
    });

    // 1. Key is "client" in English
    assert.ok(/client/i.test(html), 'Sidebar must render "client" key');
    assert.ok(html.includes('id="sidebarClientName"'), 'Sidebar must render #sidebarClientName element');
    assert.ok(html.includes('Acme Corporation'), 'Sidebar must display the client name value');

    // 2. Position: Client row must appear before System Clock row in DOM inside sidebar-info-row
    const clientPos = html.indexOf('id="sidebarClientName"');
    const clockPos = html.indexOf('id="digitalClock"');
    assert.ok(clientPos > 0, 'sidebarClientName must be present');
    assert.ok(clockPos > 0, 'digitalClock must be present');
    assert.ok(clientPos < clockPos, 'Client text field must be positioned above the system clock in the sidebar');
});

test('views/sidebar.ejs renders client text field right above system clock in Arabic (ar)', async () => {
    const html = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'ar',
        currentPage: '/',
        isRtl: true,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        clientName: 'شركة النور',
        allowedTabs: ['dashboard', 'cdr', 'config']
    });

    // 1. Key is "عميل" in Arabic
    assert.ok(html.includes('عميل'), 'Sidebar must render Arabic "عميل" key');
    assert.ok(html.includes('id="sidebarClientName"'), 'Sidebar must render #sidebarClientName element');
    assert.ok(html.includes('شركة النور'), 'Sidebar must display the Arabic client name value');

    // 2. Position: Client row must appear before System Clock row in DOM inside sidebar-info-row
    const clientPos = html.indexOf('id="sidebarClientName"');
    const clockPos = html.indexOf('id="digitalClock"');
    assert.ok(clientPos > 0, 'sidebarClientName must be present');
    assert.ok(clockPos > 0, 'digitalClock must be present');
    assert.ok(clientPos < clockPos, 'Client text field must be positioned above the system clock in the sidebar (Arabic)');
});

test('views/sidebar.ejs renders Client settings button in settings menu for Super Admins', async () => {
    const html = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['dashboard', 'cdr', 'config']
    });

    assert.ok(html.includes('onclick="openClientModal()"'), 'Settings menu must include button with onclick="openClientModal()"');
    assert.ok(html.includes('id="clientSettingsBtn"'), 'Settings menu must render #clientSettingsBtn');
});

test('views/sidebar.ejs renders Client Modal markup with form and input controls', async () => {
    const html = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['dashboard', 'cdr', 'config']
    });

    assert.ok(html.includes('id="clientModal"'), 'Sidebar must render #clientModal');
    assert.ok(html.includes('id="clientSettingsForm"'), 'Modal must contain #clientSettingsForm');
    assert.ok(html.includes('id="clientNameInput"'), 'Modal must contain #clientNameInput');
    assert.ok(html.includes('id="clientSaveBtn"'), 'Modal must contain #clientSaveBtn');
    assert.ok(html.includes('function openClientModal()'), 'Sidebar must define openClientModal');
    assert.ok(html.includes('function closeClientModal()'), 'Sidebar must define closeClientModal');
    assert.ok(html.includes('async function loadClientSettings()'), 'Sidebar must define loadClientSettings');
    assert.ok(html.includes('async function saveClientSettings('), 'Sidebar must define saveClientSettings');
});

test('views/config.ejs registers clientModal in PBX_CONFIG_MODAL_IDS', () => {
    const configContent = fs.readFileSync(configViewPath, 'utf8');
    assert.ok(configContent.includes("'clientModal'"), 'config.ejs PBX_CONFIG_MODAL_IDS must include clientModal');
});

test('server.js defines client settings routes and database persistence', () => {
    const serverContent = fs.readFileSync(serverJsPath, 'utf8');
    assert.ok(serverContent.includes("app.get('/api/settings/client'"), 'server.js must define GET /api/settings/client');
    assert.ok(serverContent.includes("app.post('/api/settings/client'"), 'server.js must define POST /api/settings/client');
    assert.ok(serverContent.includes("setting_key = 'client_name'") || serverContent.includes("'client_name'"), 'server.js must reference client_name in dashboard_settings');
    assert.ok(serverContent.includes("res.locals.clientName"), 'server.js must set res.locals.clientName in view middleware');
});

test('all client script blocks in views/sidebar.ejs parse as valid JavaScript', async () => {
    const rendered = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        clientName: 'Sokrat',
        allowedTabs: ['dashboard', 'cdr', 'config']
    });

    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    let scriptIdx = 0;
    while ((match = scriptRegex.exec(rendered)) !== null) {
        const js = match[1];
        if (!js.trim()) continue;
        scriptIdx++;
        try {
            new Function(js);
        } catch (err) {
            assert.fail(`Syntax error in views/sidebar.ejs script block #${scriptIdx}: ${err.message}\nCode:\n${js.substring(0, 300)}`);
        }
    }
    assert.ok(scriptIdx > 0, 'Rendered sidebar.ejs should contain script blocks');
});
