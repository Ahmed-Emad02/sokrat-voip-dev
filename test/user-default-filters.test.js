const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const moment = require('moment');

const sidebarViewPath = path.join(__dirname, '../views/sidebar.ejs');

test('views/sidebar.ejs renders Default Filters launcher button and defaultFiltersModal in settings menu', async () => {
    const html = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'ahmed',
        allowedTabs: ['dashboard', 'cdr', 'voicemails', 'config']
    });

    // 1. Settings menu launcher button
    assert.ok(html.includes('onclick="openDefaultFiltersModal()"'), 'Sidebar must render openDefaultFiltersModal() button');
    assert.ok(html.includes('Default Filters'), 'Sidebar must render Default Filters label');

    // 2. Default Filters Modal markup
    assert.ok(html.includes('id="defaultFiltersModal"'), 'Sidebar must render defaultFiltersModal element');
    assert.ok(html.includes('id="defaultFiltersForm"'), 'Sidebar must render defaultFiltersForm');
    assert.ok(html.includes('id="defDashDatePreset"'), 'Modal must render defDashDatePreset select');
    assert.ok(html.includes('id="defDashTargetExt"'), 'Modal must render defDashTargetExt select');
    assert.ok(html.includes('id="defDashStatus"'), 'Modal must render defDashStatus select');
    assert.ok(html.includes('id="defDashDirection"'), 'Modal must render defDashDirection select');
    assert.ok(html.includes('id="defDashScope"'), 'Modal must render defDashScope select');

    assert.ok(html.includes('id="defCdrDatePreset"'), 'Modal must render defCdrDatePreset select');
    assert.ok(html.includes('id="defCdrTargetExt"'), 'Modal must render defCdrTargetExt select');
    assert.ok(html.includes('id="defCdrPerPage"'), 'Modal must render defCdrPerPage select');
    assert.ok(html.includes('id="defCdrStatus"'), 'Modal must render defCdrStatus select');
    assert.ok(html.includes('id="defCdrDirection"'), 'Modal must render defCdrDirection select');
    assert.ok(html.includes('id="defCdrScope"'), 'Modal must render defCdrScope select');

    // 3. Client JS handlers
    assert.ok(html.includes('function openDefaultFiltersModal()'), 'Sidebar must define openDefaultFiltersModal handler');
    assert.ok(html.includes('function closeDefaultFiltersModal()'), 'Sidebar must define closeDefaultFiltersModal handler');
    assert.ok(html.includes('async function loadDefaultFiltersSettings()'), 'Sidebar must define loadDefaultFiltersSettings handler');
    assert.ok(html.includes('async function executeSaveDefaultFilters'), 'Sidebar must define executeSaveDefaultFilters handler');
});

test('views/sidebar.ejs renders Default Filters modal correctly in Arabic (ar)', async () => {
    const html = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'ar',
        currentPage: '/',
        isRtl: true,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'ahmed',
        allowedTabs: ['dashboard', 'cdr']
    });

    assert.ok(html.includes('الفلاتر الافتراضية'), 'Sidebar must render Arabic Default Filters label');
    assert.ok(html.includes('افتراضيات لوحة التحكم'), 'Sidebar must render Arabic Dashboard Defaults section');
    assert.ok(html.includes('افتراضيات سجل المكالمات'), 'Sidebar must render Arabic Call History Defaults section');
    assert.ok(html.includes('الفترة الزمنية الافتراضية'), 'Sidebar must render Arabic Date Range label');
    assert.ok(html.includes('حفظ الفلاتر الافتراضية'), 'Sidebar must render Arabic Save button');
});

test('server.js defines dashboard_user_preferences table, user preferences helpers, and API endpoints', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.ok(serverCode.includes('dashboard_user_preferences'), 'server.js must create dashboard_user_preferences table');
    assert.ok(serverCode.includes('getUserPreferences'), 'server.js must define getUserPreferences helper');
    assert.ok(serverCode.includes('computePresetDateRange'), 'server.js must define computePresetDateRange helper');
    assert.ok(serverCode.includes("app.get('/api/user/default-filters'"), 'GET /api/user/default-filters route must exist');
    assert.ok(serverCode.includes("app.post('/api/user/default-filters'"), 'POST /api/user/default-filters route must exist');
});

test('computePresetDateRange calculates correct start and end date boundaries for all presets', () => {
    const computePresetDateRange = (preset) => {
        switch (String(preset || '').toLowerCase()) {
            case 'yesterday':
                return {
                    startDate: moment().subtract(1, 'day').startOf('day').format('YYYY-MM-DD HH:mm:ss'),
                    endDate: moment().subtract(1, 'day').endOf('day').format('YYYY-MM-DD HH:mm:ss')
                };
            case 'this_week':
                return {
                    startDate: moment().startOf('week').format('YYYY-MM-DD HH:mm:ss'),
                    endDate: moment().endOf('week').format('YYYY-MM-DD HH:mm:ss')
                };
            case 'last_7_days':
                return {
                    startDate: moment().subtract(7, 'days').startOf('day').format('YYYY-MM-DD HH:mm:ss'),
                    endDate: moment().endOf('day').format('YYYY-MM-DD HH:mm:ss')
                };
            case 'this_month':
                return {
                    startDate: moment().startOf('month').format('YYYY-MM-DD HH:mm:ss'),
                    endDate: moment().endOf('month').format('YYYY-MM-DD HH:mm:ss')
                };
            case 'last_30_days':
                return {
                    startDate: moment().subtract(30, 'days').startOf('day').format('YYYY-MM-DD HH:mm:ss'),
                    endDate: moment().endOf('day').format('YYYY-MM-DD HH:mm:ss')
                };
            case 'today':
            default:
                return {
                    startDate: moment().startOf('day').format('YYYY-MM-DD HH:mm:ss'),
                    endDate: moment().endOf('day').format('YYYY-MM-DD HH:mm:ss')
                };
        }
    };

    const todayRange = computePresetDateRange('today');
    assert.equal(todayRange.startDate, moment().startOf('day').format('YYYY-MM-DD HH:mm:ss'));
    assert.equal(todayRange.endDate, moment().endOf('day').format('YYYY-MM-DD HH:mm:ss'));

    const yesterdayRange = computePresetDateRange('yesterday');
    assert.equal(yesterdayRange.startDate, moment().subtract(1, 'day').startOf('day').format('YYYY-MM-DD HH:mm:ss'));
    assert.equal(yesterdayRange.endDate, moment().subtract(1, 'day').endOf('day').format('YYYY-MM-DD HH:mm:ss'));

    const last7Range = computePresetDateRange('last_7_days');
    assert.equal(last7Range.startDate, moment().subtract(7, 'days').startOf('day').format('YYYY-MM-DD HH:mm:ss'));
    assert.equal(last7Range.endDate, moment().endOf('day').format('YYYY-MM-DD HH:mm:ss'));

    const monthRange = computePresetDateRange('this_month');
    assert.equal(monthRange.startDate, moment().startOf('month').format('YYYY-MM-DD HH:mm:ss'));
    assert.equal(monthRange.endDate, moment().endOf('month').format('YYYY-MM-DD HH:mm:ss'));
});

test('Default filter resolution logic applies user defaults on landing and honors explicit query overrides', () => {
    const userDefaults = {
        dashboard: {
            datePreset: 'last_7_days',
            targetExtension: ['101'],
            statusFilter: ['ANSWERED'],
            directionFilter: 'INBOUND',
            callScopeFilter: 'EXTERNAL'
        }
    };

    const resolveFilters = (query, defaults) => {
        const hasExplicit = Boolean(query.startDate || query.endDate || query.targetExtension || query.statusFilter || query.directionFilter || query.callScopeFilter);
        const dashDefaults = defaults?.dashboard;

        let datePreset = hasExplicit ? 'custom' : (dashDefaults?.datePreset || 'today');
        let targetExt = hasExplicit ? (query.targetExtension || 'ALL') : (dashDefaults?.targetExtension || 'ALL');
        let status = hasExplicit ? (query.statusFilter || 'ALL') : (dashDefaults?.statusFilter || 'ALL');
        let direction = hasExplicit ? (query.directionFilter || 'ALL') : (dashDefaults?.directionFilter || 'ALL');

        return { hasExplicit, datePreset, targetExt, status, direction };
    };

    // 1. Landing on / with no query params -> applies userDefaults
    const landing = resolveFilters({}, userDefaults);
    assert.equal(landing.hasExplicit, false);
    assert.equal(landing.datePreset, 'last_7_days');
    assert.deepEqual(landing.targetExt, ['101']);
    assert.deepEqual(landing.status, ['ANSWERED']);
    assert.equal(landing.direction, 'INBOUND');

    // 2. Navigating with explicit query parameters -> honors explicit query overrides
    const explicit = resolveFilters({ startDate: '2026-08-01 00:00:00', targetExtension: '102', statusFilter: 'BUSY', directionFilter: 'OUTBOUND' }, userDefaults);
    assert.equal(explicit.hasExplicit, true);
    assert.equal(explicit.datePreset, 'custom');
    assert.equal(explicit.targetExt, '102');
    assert.equal(explicit.status, 'BUSY');
    assert.equal(explicit.direction, 'OUTBOUND');
});
