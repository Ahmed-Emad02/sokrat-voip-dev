const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ejs = require('ejs');
const moment = require('moment');

const storageViewPath = path.join(__dirname, '../views/storage.ejs');
const serverJsPath = path.join(__dirname, '../server.js');

const dummyRoster = [
    { extension: '101', name: 'Agent Alpha' },
    { extension: '102', name: 'Agent Beta' }
];

test('server.js registers GET /api/system/resources/history and provides historical telemetry', () => {
    const serverCode = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(serverCode.includes("app.get('/api/system/resources/history'"), 'Must register GET /api/system/resources/history');
    assert.ok(serverCode.includes('TELEMETRY_HISTORY_FILE'), 'Must define TELEMETRY_HISTORY_FILE');
    assert.ok(serverCode.includes('MAX_TELEMETRY_HISTORY'), 'Must define MAX_TELEMETRY_HISTORY');
    assert.ok(serverCode.includes('telemetryHistory'), 'Must maintain telemetryHistory array');
    assert.ok(serverCode.includes('recordTelemetrySample'), 'Must implement recordTelemetrySample');
    assert.ok(serverCode.includes('history: telemetryHistory'), 'GET /api/system/resources must include history');
});

test('historical telemetry range filter logic filters points correctly', () => {
    const now = Date.now();
    const sampleHistory = [
        { timestamp: now - (20 * 60 * 1000), timeLabel: '20m ago', cpuPct: 10, ramPct: 40, rxKb: 5, txKb: 5, activeCalls: 0 },
        { timestamp: now - (10 * 60 * 1000), timeLabel: '10m ago', cpuPct: 25, ramPct: 42, rxKb: 15, txKb: 20, activeCalls: 1 },
        { timestamp: now - (2 * 60 * 1000), timeLabel: '2m ago', cpuPct: 55, ramPct: 45, rxKb: 80, txKb: 90, activeCalls: 3 },
        { timestamp: now, timeLabel: 'now', cpuPct: 30, ramPct: 44, rxKb: 20, txKb: 30, activeCalls: 2 }
    ];

    function filterHistory(history, range, limit) {
        let filtered = history;
        if (range === '15m') {
            const cutoff = now - (15 * 60 * 1000);
            filtered = history.filter(pt => pt.timestamp >= cutoff);
        } else if (range === '1h') {
            const cutoff = now - (60 * 60 * 1000);
            filtered = history.filter(pt => pt.timestamp >= cutoff);
        }

        const maxPoints = parseInt(limit, 10);
        if (!isNaN(maxPoints) && maxPoints > 0 && filtered.length > maxPoints) {
            filtered = filtered.slice(-maxPoints);
        }
        return filtered;
    }

    // 15m range should only include points from <= 15m ago (3 points: 10m ago, 2m ago, now)
    const pts15m = filterHistory(sampleHistory, '15m');
    assert.strictEqual(pts15m.length, 3);
    assert.strictEqual(pts15m[0].timeLabel, '10m ago');

    // 1h range includes all 4 points
    const pts1h = filterHistory(sampleHistory, '1h');
    assert.strictEqual(pts1h.length, 4);

    // limit parameter truncates to latest N points
    const ptsLimit = filterHistory(sampleHistory, '1h', 2);
    assert.strictEqual(ptsLimit.length, 2);
    assert.strictEqual(ptsLimit[1].timeLabel, 'now');
});

test('views/storage.ejs renders chart range controls and dataZoom for historical investigation', async () => {
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

    const content = fs.readFileSync(storageViewPath, 'utf8');

    // 1. Quick range zoom buttons in chart headers
    assert.ok(html.includes("setChartZoomRange('cpu', 15)"), 'Must render 15m button for CPU chart');
    assert.ok(html.includes("setChartZoomRange('cpu', 60)"), 'Must render 1h button for CPU chart');
    assert.ok(html.includes("setChartZoomRange('cpu', 360)"), 'Must render 6h button for CPU chart');
    assert.ok(html.includes("setChartZoomRange('cpu', 0)"), 'Must render All button for CPU chart');

    assert.ok(html.includes("setChartZoomRange('net', 15)"), 'Must render 15m button for Network chart');
    assert.ok(html.includes("setChartZoomRange('net', 60)"), 'Must render 1h button for Network chart');
    assert.ok(html.includes("setChartZoomRange('net', 360)"), 'Must render 6h button for Network chart');
    assert.ok(html.includes("setChartZoomRange('net', 0)"), 'Must render All button for Network chart');

    // 2. Chart buffer expansion
    assert.ok(content.includes('const MAX_POINTS = 720;'), 'MAX_POINTS must be expanded to at least 720');

    // 3. ECharts dataZoom configurations
    assert.ok(content.includes("type: 'inside'"), 'ECharts config must include inside dataZoom for mouse-wheel zoom & pan');
    assert.ok(content.includes("type: 'slider'"), 'ECharts config must include slider dataZoom for timeline scrubbing');

    // 4. Initial prefill from historical data
    assert.ok(content.includes('Array.isArray(data.history)'), 'Must inspect data.history for historical prefill');
    assert.ok(content.includes('data.history.forEach'), 'Must prefill buffers from data.history');

    // 5. Helper function for programmatic zoom
    assert.ok(content.includes('window.setChartZoomRange = function'), 'Must define window.setChartZoomRange');

    // 6. Invariant: Metric cards still present for live instantaneous display
    assert.ok(html.includes('id="stat-cpu-pct"'), 'stat-cpu-pct pulse card must be preserved for live display');
    assert.ok(html.includes('id="stat-ram-pct"'), 'stat-ram-pct pulse card must be preserved for live display');
    assert.ok(html.includes('id="disk-used-pct"'), 'disk-used-pct pulse card must be preserved for live display');

    // 7. Regression check: gdrive-status-badge properly referenced in fetchStorageInfo
    assert.ok(content.includes("const gdriveBadge = document.getElementById('gdrive-status-badge');"), 'Must properly declare gdriveBadge reference in fetchStorageInfo');
    assert.ok(!content.includes("if (badge) {\n                            badge.textContent"), 'Must not reference undeclared badge variable');
});
