const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(ROOT, 'views', 'dashboard.ejs'), 'utf8');
const report = fs.readFileSync(path.join(ROOT, 'views', 'dashboard-report.ejs'), 'utf8');

test('dashboard exposes Excel and PDF export controls', () => {
    assert.match(dashboard, /id="dashExportBtn"/, 'dashboard must render the export button');
    assert.match(dashboard, /id="dashExportMenu"/, 'dashboard must render the export menu');
    assert.match(dashboard, /exportExcel/, 'dashboard must offer an Excel option');
    assert.match(dashboard, /exportPdf/, 'dashboard must offer a PDF option');
    assert.match(dashboard, /function buildDashboardExportUrl\(format\)/, 'dashboard must build export URLs');
    assert.match(dashboard, /dashboard\/export\?/, 'dashboard must target the Excel route');
    assert.match(dashboard, /dashboard\/report\?/, 'dashboard must target the PDF report route');
    assert.match(dashboard, /allowedTabs\.includes\('cdr-export'\)/, 'export control must respect the CDR export permission');
});

test('server defines the dashboard export and report routes with shared report helpers', () => {
    assert.match(server, /app\.get\('\/dashboard\/export'/, 'server must define the Excel export route');
    assert.match(server, /app\.get\('\/dashboard\/report'/, 'server must define the PDF report route');
    assert.match(server, /requireActionPermission\('cdr-export'\)/, 'export routes must require cdr-export');
    assert.match(server, /async function parseDashboardFilters\(req\)/, 'dashboard filter parser must be shared');
    assert.match(server, /function buildDashboardCdrQuery\(filters, res\)/, 'dashboard aggregate query must be shared');
    assert.match(server, /function buildDetailedCdrQuery\(filters, res\)/, 'detailed CDR query must be shared');
    assert.match(server, /function computeDashboardReport\(rows, effectiveRoster/, 'dashboard computation must be shared');
    assert.match(server, /function buildDashboardExcelBuffer\(/, 'Excel workbook builder must exist');
});

test('PDF report view is print-ready and renders the dashboard sections', () => {
    for (const id of ['trendChart', 'hourlyChart', 'topTalkersChart', 'dispositionChart', 'durationChart', 'scopeChart']) {
        assert.match(report, new RegExp(`id="${id}"`), `report must contain ${id}`);
    }
    assert.match(report, /@media print/, 'report must define print CSS');
    assert.match(report, /window\.print\(\)/, 'report must offer print / Save as PDF');
    assert.match(report, /autoPrint/, 'report must honor the autoprint flag');
});

test('dashboard report template compiles', () => {
    assert.doesNotThrow(() => {
        ejs.compile(report, { filename: path.join(ROOT, 'views', 'dashboard-report.ejs') });
    });
});
