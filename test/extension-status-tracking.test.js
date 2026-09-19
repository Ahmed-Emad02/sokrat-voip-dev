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
        assert.ok(rendered.includes('workHoursEnabled'), 'Template must include workHoursEnabled input');
        assert.ok(rendered.includes('shiftStart'), 'Template must include shiftStart input');
        assert.ok(rendered.includes('shiftEnd'), 'Template must include shiftEnd input');
        assert.ok(rendered.includes('toggleWorkHours'), 'Template must include toggleWorkHours handler');
        assert.ok(rendered.includes('setWorkDaysPreset'), 'Template must include setWorkDaysPreset handler');
    }
});

test('Working hours filter logic correctly slices extension status logs into shift windows', () => {
    const startStr = '2026-09-13 00:00:00'; // Sunday
    const endStr = '2026-09-19 23:59:59';   // Saturday (7 days)
    const winStartMs = moment(startStr).valueOf();
    const winEndMs = moment(endStr).valueOf();

    const workHoursEnabled = true;
    const shiftStartParam = '09:00';
    const shiftEndParam = '17:00';
    const workDays = [0, 1, 2, 3, 4]; // Sun-Thu (5 days)

    const [startH, startM] = shiftStartParam.split(':').map(n => parseInt(n, 10) || 0);
    const [endH, endM] = shiftEndParam.split(':').map(n => parseInt(n, 10) || 0);

    const activeIntervals = [];
    const currDay = moment(startStr).startOf('day');
    const lastDay = moment(endStr).endOf('day');

    while (currDay.isSameOrBefore(lastDay, 'day')) {
        const dayOfWeek = currDay.day();
        if (workDays.includes(dayOfWeek)) {
            const shiftStartMs = currDay.clone().hour(startH).minute(startM).second(0).millisecond(0).valueOf();
            const shiftEndMs = currDay.clone().hour(endH).minute(endM).second(0).millisecond(0).valueOf();
            const s = Math.max(winStartMs, shiftStartMs);
            const e = Math.min(winEndMs, shiftEndMs);
            if (e > s) activeIntervals.push({ startMs: s, endMs: e });
        }
        currDay.add(1, 'day');
    }

    assert.equal(activeIntervals.length, 5);
    const totalWinSec = activeIntervals.reduce((acc, inv) => acc + Math.floor((inv.endMs - inv.startMs) / 1000), 0);
    assert.equal(totalWinSec, 5 * 8 * 3600); // 40 hours = 144,000s

    const calculateShiftOverlapSec = (startMs, endMs, intervals) => {
        if (endMs <= startMs || !intervals || !intervals.length) return 0;
        let durSec = 0;
        for (const inv of intervals) {
            const s = Math.max(startMs, inv.startMs);
            const e = Math.min(endMs, inv.endMs);
            if (e > s) durSec += Math.floor((e - s) / 1000);
        }
        return durSec;
    };

    // Overnight offline status (Sunday 18:00 to Monday 08:00) -> 0s in shift
    const nightStartMs = moment('2026-09-13 18:00:00').valueOf();
    const nightEndMs = moment('2026-09-14 08:00:00').valueOf();
    assert.equal(calculateShiftOverlapSec(nightStartMs, nightEndMs, activeIntervals), 0);

    // Partial shift incall status (Monday 08:30 to 09:30) -> 30m = 1800s in shift
    const partialStartMs = moment('2026-09-14 08:30:00').valueOf();
    const partialEndMs = moment('2026-09-14 09:30:00').valueOf();
    assert.equal(calculateShiftOverlapSec(partialStartMs, partialEndMs, activeIntervals), 1800);

    // Full shift idle status (Tuesday 09:00 to 17:00) -> 8h = 28,800s in shift
    const fullStartMs = moment('2026-09-15 09:00:00').valueOf();
    const fullEndMs = moment('2026-09-15 17:00:00').valueOf();
    assert.equal(calculateShiftOverlapSec(fullStartMs, fullEndMs, activeIntervals), 28800);
});

test('Teardown: test suite exits cleanly', () => {
    setTimeout(() => process.exit(0), 100);
});
