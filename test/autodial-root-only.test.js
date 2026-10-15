const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const rootDir = path.join(__dirname, '..');
const sidebarPath = path.join(rootDir, 'views', 'sidebar.ejs');
const dialerPath = path.join(rootDir, 'views', 'dialer.ejs');
const serverPath = path.join(rootDir, 'server.js');

test('Auto-Dial Renaming: Sidebar and Dialer templates use "Auto-Dial" / "الاتصال التلقائي"', () => {
    const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
    const dialerContent = fs.readFileSync(dialerPath, 'utf8');

    // Sidebar text in English and Arabic
    assert.match(sidebarContent, /dialerLink:\s*"Auto-Dial"/, 'sidebarWords.en must define dialerLink as "Auto-Dial"');
    assert.match(sidebarContent, /dialerLink:\s*"الاتصال التلقائي"/, 'sidebarWords.ar must define dialerLink as "الاتصال التلقائي"');

    // Dialer view page title
    assert.match(dialerContent, /title:\s*"Auto-Dial"/, 'dialer.ejs words.en must define title as "Auto-Dial"');
    assert.match(dialerContent, /title:\s*"الاتصال التلقائي"/, 'dialer.ejs words.ar must define title as "الاتصال التلقائي"');
});

test('Sidebar Security: Auto-Dial navigation link is rendered strictly for root user only', async () => {
    // 1. Root user sees Auto-Dial link
    const rootHtml = await ejs.renderFile(sidebarPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: true,
        currentUser: 'root',
        allowedTabs: ['dashboard']
    });
    assert.ok(rootHtml.includes('/dialer?lang='), 'Sidebar must render Auto-Dial link for root user');
    assert.ok(rootHtml.includes('Auto-Dial'), 'Sidebar must render "Auto-Dial" text for root user');

    // 2. Non-root user (even with allowedTabs containing campaigns or dialer) does NOT see Auto-Dial link
    const nonRootHtml = await ejs.renderFile(sidebarPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'agent_user',
        allowedTabs: ['dashboard', 'campaigns', 'dialer', 'campaigns-manage']
    });
    assert.equal(nonRootHtml.includes('/dialer?lang='), false, 'Sidebar must NOT render Auto-Dial link for non-root user');
    assert.equal(nonRootHtml.includes('<span class="sidebar-text">Auto-Dial</span>'), false, 'Sidebar must NOT render Auto-Dial label for non-root user');
});

test('Server & API Security: GET /dialer and /api/dialer/* enforce root authorization', () => {
    const serverCode = fs.readFileSync(serverPath, 'utf8');

    // 1. GET /dialer route definition has isRoot check or requireRootForDialer
    assert.match(serverCode, /app\.get\('\/dialer',\s*requireAuth/, 'GET /dialer must requireAuth');
    assert.match(serverCode, /requireRootForDialer/, 'server.js must define requireRootForDialer middleware');

    // 2. Tab route middleware redirects non-root users trying to access /dialer
    assert.match(serverCode, /if\s*\(tab === 'campaigns'\)\s*\{\s*if\s*\(!res\.locals\.isRootUser\)/, 'tab route middleware must block non-root users from campaigns');

    // 3. Campaign management APIs use requireRootForDialer
    assert.match(serverCode, /app\.get\('\/api\/dialer\/campaigns',\s*requireAuth,\s*requireRootForDialer/, 'GET /api/dialer/campaigns must require root');
    assert.match(serverCode, /app\.post\('\/api\/dialer\/campaigns',\s*requireAuth,\s*requireRootForDialer/, 'POST /api/dialer/campaigns must require root');
    assert.match(serverCode, /app\.put\('\/api\/dialer\/campaigns\/:id',\s*requireAuth,\s*requireRootForDialer/, 'PUT /api/dialer/campaigns/:id must require root');
    assert.match(serverCode, /app\.post\('\/api\/dialer\/campaigns\/:id\/control',\s*requireAuth,\s*requireRootForDialer/, 'control endpoint must require root');
    assert.match(serverCode, /app\.post\('\/api\/dialer\/leads\/import',\s*requireAuth,\s*requireRootForDialer/, 'leads/import must require root');
});
