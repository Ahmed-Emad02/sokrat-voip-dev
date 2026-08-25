const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');
const moment = require('moment');

const dashboardPath = path.join(__dirname, '../views/dashboard.ejs');

const mockStats = {
    totalCalls: 100,
    answeredCalls: 80,
    inboundCount: 60,
    outboundCount: 30,
    internalCount: 10,
    externalCount: 90,
    inboundMin: 120,
    outboundMin: 60,
    internalMin: 15,
    externalMin: 165,
    noAnswerCalls: 12,
    busyCalls: 5,
    failedCalls: 3,
    totalTalkMin: 180,
    totalTalkSec: 10800,
    avgTalkSec: 135
};

const mockRoster = [
    { extension: '101', name: 'Alice Smith', online: true },
    { extension: '102', name: 'Bob Jones', online: false },
    { extension: '103', name: 'Charlie Brown', online: true }
];

const defaultData = {
    currentLang: 'en',
    currentPage: '/',
    user: { username: 'admin', role: 'admin' },
    isSuperAdmin: true,
    stats: mockStats,
    roster: mockRoster,
    filters: {
        startDate: '2026-08-24 00:00:00',
        endDate: '2026-08-24 23:59:59',
        targetExtension: 'ALL',
        statusFilter: 'ALL',
        searchSrc: '',
        searchDst: '',
        searchDid: '',
        searchUniqueId: '',
        directionFilter: 'ALL',
        callScopeFilter: 'ALL'
    },
    moment,
    trendData: JSON.stringify([]),
    dispositionData: JSON.stringify([]),
    hourlyData: JSON.stringify([]),
    topTalkers: JSON.stringify([]),
    durationData: JSON.stringify([]),
    scopeData: JSON.stringify([{ name: 'Internal', value: 10 }, { name: 'External', value: 90 }])
};

test('Dashboard renders with all 10 filter inputs in English (en)', async () => {
    const html = await ejs.renderFile(dashboardPath, defaultData);

    // Form element
    assert.ok(html.includes('id="dashFilterForm"'), 'Form dashFilterForm exists');

    // 10 Filter Inputs
    assert.ok(html.includes('id="dashStartDate"'), 'dashStartDate input exists');
    assert.ok(html.includes('id="dashEndDate"'), 'dashEndDate input exists');
    assert.ok(html.includes('id="dashTargetExtensionSelect"'), 'dashTargetExtensionSelect exists');
    assert.ok(html.includes('id="dashStatusFilterSelect"'), 'dashStatusFilterSelect exists');
    assert.ok(html.includes('id="dashDirectionFilter"'), 'dashDirectionFilter exists');
    assert.ok(html.includes('id="dashScopeFilter"'), 'dashScopeFilter exists');
    assert.ok(html.includes('id="dashSearchSrc"'), 'dashSearchSrc exists');
    assert.ok(html.includes('id="dashSearchDst"'), 'dashSearchDst exists');
    assert.ok(html.includes('id="dashSearchDid"'), 'dashSearchDid exists');
    assert.ok(html.includes('id="dashSearchUid"'), 'dashSearchUid exists');

    // Checklist menus
    assert.ok(html.includes('id="dashExtChecklistBtn"'), 'dashExtChecklistBtn exists');
    assert.ok(html.includes('id="dashExtChecklistMenu"'), 'dashExtChecklistMenu exists');
    assert.ok(html.includes('id="dash_ext_chk_all"'), 'dash_ext_chk_all exists');
    assert.ok(html.includes('id="dash_ext_chk_101"'), 'dash_ext_chk_101 exists');
    assert.ok(html.includes('id="dash_ext_chk_102"'), 'dash_ext_chk_102 exists');
    assert.ok(html.includes('id="dash_ext_chk_103"'), 'dash_ext_chk_103 exists');

    assert.ok(html.includes('id="dashStatusChecklistBtn"'), 'dashStatusChecklistBtn exists');
    assert.ok(html.includes('id="dashStatusChecklistMenu"'), 'dashStatusChecklistMenu exists');
    assert.ok(html.includes('id="dash_status_chk_all"'), 'dash_status_chk_all exists');
    assert.ok(html.includes('id="dash_status_chk_ans"'), 'dash_status_chk_ans exists');
    assert.ok(html.includes('id="dash_status_chk_noans"'), 'dash_status_chk_noans exists');
    assert.ok(html.includes('id="dash_status_chk_busy"'), 'dash_status_chk_busy exists');
    assert.ok(html.includes('id="dash_status_chk_failed"'), 'dash_status_chk_failed exists');

    // Secondary drawer collapsed by default when no secondary filters
    assert.ok(html.includes('id="dashSecondaryFilters" class="hidden'), 'dashSecondaryFilters is hidden when empty');
    assert.ok(html.includes('id="dashToggleMoreBtn"'), 'dashToggleMoreBtn exists');
    assert.ok(html.includes('More Filters'), 'More Filters label shown when collapsed');
});

test('Dashboard renders in Arabic (ar) with localized filter labels', async () => {
    const arData = {
        ...defaultData,
        currentLang: 'ar'
    };
    const html = await ejs.renderFile(dashboardPath, arData);

    assert.ok(html.includes('قائمة الموظفين'), 'Arabic roster label rendered');
    assert.ok(html.includes('حالة المكالمة'), 'Arabic status label rendered');
    assert.ok(html.includes('الاتجاه'), 'Arabic direction label rendered');
    assert.ok(html.includes('نطاق المكالمة'), 'Arabic scope label rendered');
    assert.ok(html.includes('المصدر'), 'Arabic src label rendered');
    assert.ok(html.includes('الوجهة'), 'Arabic dst label rendered');
    assert.ok(html.includes('رقم DID'), 'Arabic did label rendered');
    assert.ok(html.includes('المعرف الفريد'), 'Arabic uid label rendered');
    assert.ok(html.includes('المزيد من الفلاتر'), 'Arabic More Filters rendered');
    assert.ok(html.includes('إعادة ضبط'), 'Arabic Reset rendered');
});

test('Dashboard secondary filters drawer auto-expands and shows active badge when secondary filters are set', async () => {
    const activeSecondaryData = {
        ...defaultData,
        filters: {
            ...defaultData.filters,
            searchSrc: '101',
            searchDst: '01012345678',
            directionFilter: 'OUTBOUND'
        }
    };
    const html = await ejs.renderFile(dashboardPath, activeSecondaryData);

    // Should NOT have hidden class on dashSecondaryFilters
    assert.ok(!html.includes('id="dashSecondaryFilters" class="hidden'), 'dashSecondaryFilters is visible when active');
    // Active badge count should be 3 (searchSrc, searchDst, callScopeFilter)
    assert.ok(html.includes('3 Active'), 'Active secondary count badge displays 3 Active');
    assert.ok(html.includes('Fewer Filters'), 'Toggle button shows Fewer Filters when expanded');
});

test('Dashboard preserves multiple selected extensions and statuses accurately', async () => {
    const multiFilterData = {
        ...defaultData,
        filters: {
            ...defaultData.filters,
            targetExtension: ['101', '103'],
            statusFilter: ['ANSWERED', 'FAILED'],
            directionFilter: 'OUTBOUND',
            callScopeFilter: 'EXTERNAL',
            searchDid: '998877',
            searchUniqueId: 'unique-123'
        }
    };
    const html = await ejs.renderFile(dashboardPath, multiFilterData);

    // Extension options & checkboxes
    assert.ok(html.includes('<option value="101" selected>101 - Alice Smith</option>'), '101 is selected in select');
    assert.ok(html.includes('<option value="103" selected>103 - Charlie Brown</option>'), '103 is selected in select');
    assert.ok(html.includes('<input type="checkbox" id="dash_ext_chk_101" name="dash_ext_chk" value="101" checked'), '101 checkbox is checked');
    assert.ok(html.includes('<input type="checkbox" id="dash_ext_chk_103" name="dash_ext_chk" value="103" checked'), '103 checkbox is checked');
    assert.ok(!html.includes('<input type="checkbox" id="dash_ext_chk_102" name="dash_ext_chk" value="102" checked'), '102 checkbox is not checked');

    // Status options & checkboxes
    assert.ok(html.includes('<option value="ANSWERED" selected>ANSWERED</option>'), 'ANSWERED option is selected');
    assert.ok(html.includes('<option value="FAILED" selected>FAILED</option>'), 'FAILED option is selected');
    assert.ok(html.includes('<input type="checkbox" id="dash_status_chk_ans" name="dash_status_chk" value="ANSWERED" checked'), 'ANSWERED checkbox is checked');
    assert.ok(html.includes('<input type="checkbox" id="dash_status_chk_failed" name="dash_status_chk" value="FAILED" checked'), 'FAILED checkbox is checked');

    // Direction and Scope
    assert.ok(html.includes('<option value="OUTBOUND" selected>'), 'OUTBOUND direction selected');
    assert.ok(html.includes('<option value="EXTERNAL" selected>'), 'EXTERNAL scope selected');

    // Search inputs
    assert.ok(html.includes('value="998877"'), 'searchDid input has value');
    assert.ok(html.includes('value="unique-123"'), 'searchUniqueId input has value');

    // Metric card baseUrl drilldown includes search filters and target extensions
    assert.ok(html.includes('targetExtension=101'), 'baseUrl includes targetExtension 101');
    assert.ok(html.includes('targetExtension=103'), 'baseUrl includes targetExtension 103');
    assert.ok(html.includes('searchDid=998877'), 'baseUrl includes searchDid');
    assert.ok(html.includes('searchUniqueId=unique-123'), 'baseUrl includes searchUniqueId');
});

test('Inline script blocks in views/dashboard.ejs have valid JavaScript syntax', async () => {
    const html = await ejs.renderFile(dashboardPath, defaultData);
    const scriptMatches = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi));

    assert.ok(scriptMatches.length > 0, 'Found inline script blocks');
    for (const match of scriptMatches) {
        const jsCode = match[1];
        // Test parsing via Function constructor
        assert.doesNotThrow(() => {
            new Function(jsCode);
        }, `Inline script threw syntax error:\n${jsCode.substring(0, 200)}...`);
    }
});
