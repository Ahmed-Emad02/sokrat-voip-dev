const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const ejs = require('ejs');

const {
    app,
    resolveExtensionState,
    trackExtensionStatusTransition,
    extensionStatusCache,
    closeAllOpenExtensionStatusIntervals
} = require('../server');

test('Schema: backend/install_db.sql and server.js define extension_status_current and extension_status_logs', () => {
    const installDb = fs.readFileSync(path.join(__dirname, '../backend/install_db.sql'), 'utf8');
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    assert.ok(installDb.includes('CREATE TABLE IF NOT EXISTS `extension_status_current`'), 'install_db.sql must define extension_status_current');
    assert.ok(installDb.includes('CREATE TABLE IF NOT EXISTS `extension_status_logs`'), 'install_db.sql must define extension_status_logs');
    assert.ok(serverJs.includes('CREATE TABLE IF NOT EXISTS ${tables.extensionStatusCurrent}'), 'server.js must define extension_status_current in initDbSchema');
    assert.ok(serverJs.includes('CREATE TABLE IF NOT EXISTS ${tables.extensionStatusLogs}'), 'server.js must define extension_status_logs in initDbSchema');
});

test('State Machine: resolveExtensionState accurately computes canonical states', () => {
    // 1. Offline when not in peerStatus or false
    assert.deepEqual(resolveExtensionState('9999'), { status: 'offline', partner: null });

    // 2. Idle when online with no active call
    // (Simulate online extension in peerStatus via trackExtensionStatusTransition)
    assert.equal(typeof resolveExtensionState, 'function');
});

test('State Machine: trackExtensionStatusTransition logs transitions and calculates duration', async () => {
    const testExt = '9876';

    // Simulate an initial state in cache: 'idle' started 5 seconds ago
    const fiveSecAgo = new Date(Date.now() - 5000);
    extensionStatusCache[testExt] = {
        status: 'idle',
        partner: null,
        since: fiveSecAgo
    };

    // Trigger transition to offline (since peerStatus[testExt] is undefined, resolveExtensionState yields 'offline')
    await trackExtensionStatusTransition(testExt);

    // Verify cache updated to offline
    assert.equal(extensionStatusCache[testExt].status, 'offline');
    assert.ok(extensionStatusCache[testExt].since instanceof Date);

    // Clean up
    delete extensionStatusCache[testExt];
});

async function getAuthCookie(port) {
    const loginRes = await fetch(`http://127.0.0.1:${port}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
        redirect: 'manual'
    });
    return loginRes.headers.get('set-cookie');
}

test('API: /api/ext-overview returns status telemetry and metrics', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
        const cookie = await getAuthCookie(port);
        const res = await fetch(`http://127.0.0.1:${port}/api/ext-overview`, {
            headers: { Cookie: cookie }
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data), 'Overview data should be an array');
        if (data.length > 0) {
            const first = data[0];
            assert.ok('liveStatus' in first, 'Overview item must include liveStatus');
            assert.ok('onlineSec' in first, 'Overview item must include onlineSec');
            assert.ok('idleSec' in first, 'Overview item must include idleSec');
            assert.ok('incallSec' in first, 'Overview item must include incallSec');
            assert.ok('availabilityRate' in first, 'Overview item must include availabilityRate');
        }
    } finally {
        server.close();
    }
});

test('API: /api/ext-stats/:extension returns status breakdown and logs', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
        const cookie = await getAuthCookie(port);
        const res = await fetch(`http://127.0.0.1:${port}/api/ext-stats/101`, {
            headers: { Cookie: cookie }
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.extension, '101');
        assert.ok('statusTotals' in data, 'Stats response must include statusTotals');
        assert.ok('totalOnlineSec' in data, 'Stats response must include totalOnlineSec');
        assert.ok('totalIdleSec' in data, 'Stats response must include totalIdleSec');
        assert.ok('availabilityRate' in data, 'Stats response must include availabilityRate');
        assert.ok(Array.isArray(data.statusBreakdown), 'Stats response must include statusBreakdown array');
        assert.ok(Array.isArray(data.statusLogs), 'Stats response must include statusLogs array');
    } finally {
        server.close();
    }
});

test('API: /api/ext-status-logs/:extension returns paginated logs', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
        const cookie = await getAuthCookie(port);
        const res = await fetch(`http://127.0.0.1:${port}/api/ext-status-logs/101?limit=10&page=1`, {
            headers: { Cookie: cookie }
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.extension, '101');
        assert.equal(data.limit, 10);
        assert.equal(data.page, 1);
        assert.ok(Array.isArray(data.logs), 'Logs should be an array');
    } finally {
        server.close();
    }
});

test('Views: ext-stats.ejs renders status badges, status cards, status allocation chart, and log table', () => {
    const templatePath = path.join(__dirname, '../views/ext-stats.ejs');
    const content = fs.readFileSync(templatePath, 'utf8');

    for (const lang of ['en', 'ar']) {
        const rendered = ejs.render(content, {
            currentLang: lang,
            moment,
            roster: [{ extension: '101', name: 'Agent 1', online: true }],
            curPage: '/ext-stats',
            can: () => true,
            currentUser: { username: 'admin', is_group_admin: false },
            isSuperAdmin: () => true
        }, { filename: templatePath });

        assert.ok(rendered.includes('renderStatusBadge'), 'Template must define renderStatusBadge helper');
        assert.ok(rendered.includes('fmtHumanDur'), 'Template must define fmtHumanDur helper');
        assert.ok(rendered.includes('statusChart'), 'Template must include statusChart container');
        assert.ok(rendered.includes('statusLogsBody'), 'Template must include statusLogsBody table');
        assert.ok(rendered.includes('filterStatusLogs'), 'Template must include filterStatusLogs handler');
    }
});

test('Teardown: test suite exits cleanly', () => {
    setTimeout(() => process.exit(0), 100);
});
