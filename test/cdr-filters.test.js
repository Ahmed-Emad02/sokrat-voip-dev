const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');
const moment = require('moment');

const cdrEjsPath = path.join(__dirname, '../views/cdr.ejs');

const defaultData = {
    currentLang: 'en',
    currentPage: '/cdr',
    user: { username: 'admin', role: 'admin' },
    isSuperAdmin: true,
    calls: [
        {
            calldate: '2026-10-18 12:00:00',
            uniqueid: '1729283921.100',
            src: '101',
            dst: '01012345678',
            src_name: 'Ahmed',
            did: '123456',
            billsec: 120,
            disposition: 'ANSWERED',
            direction: 'OUTBOUND',
            call_scope: 'EXTERNAL',
            recordingfile: 'rec1.wav',
            trunk: { name: 'Dongle-0', type: 'dongle' }
        }
    ],
    filters: {
        startDate: '2026-10-18 00:00:00',
        endDate: '2026-10-18 23:59:59',
        targetExtension: 'ALL',
        statusFilter: 'ALL',
        directionFilter: 'ALL',
        callScopeFilter: 'ALL',
        durationMin: '',
        durationMax: '',
        trunkFilter: 'ALL',
        searchSrc: '',
        searchDst: '',
        searchDid: '',
        searchUniqueId: ''
    },
    pagination: { page: 1, perPage: 25, total: 1, totalPages: 1 },
    moment,
    roster: [{ extension: '101', name: 'Ahmed', online: true }],
    availableTrunks: [{ id: 'dongle:Dongle-0', label: 'Dongle-0 (01012345678)', type: 'dongle' }]
};

test('Call History renders visible Row 1 and expandable drawer with rows 2-3 and duration from-to in English', async () => {
    const html = await ejs.renderFile(cdrEjsPath, defaultData);

    // Form
    assert.ok(html.includes('id="cdrFilterForm"'), 'Must contain id="cdrFilterForm"');

    // Row 1 Primary Filters (always visible)
    assert.ok(html.includes('filter-grid-row1'), 'Row 1 grid renders');
    assert.ok(html.includes('id="cdrStartDate"'), 'Must contain cdrStartDate');
    assert.ok(html.includes('id="cdrEndDate"'), 'Must contain cdrEndDate');
    assert.ok(html.includes('id="targetExtensionSelect"'), 'Must contain targetExtensionSelect');
    assert.ok(html.includes('id="statusFilterSelect"'), 'Must contain statusFilterSelect');

    // Collapsible Drawer (hidden by default when secondary filters are empty)
    assert.ok(html.includes('id="cdrSecondaryFilters" class="hidden'), 'Secondary drawer must be hidden by default');
    assert.ok(html.includes('filter-grid-row2'), 'Row 2 grid is inside the drawer');
    assert.ok(html.includes('filter-grid-row3'), 'Row 3 grid is inside the drawer');

    // Row 2 Routing / Line / Duration (from - to)
    assert.ok(html.includes('id="cdrDirectionFilter"'), 'Must contain cdrDirectionFilter in drawer');
    assert.ok(html.includes('id="cdrScopeFilter"'), 'Must contain cdrScopeFilter in drawer');
    assert.ok(html.includes('id="cdrTrunkFilter"'), 'Must contain cdrTrunkFilter in drawer');
    assert.ok(html.includes('id="cdrDurationMin"'), 'Must contain cdrDurationMin');
    assert.ok(html.includes('id="cdrDurationMax"'), 'Must contain cdrDurationMax');
    assert.ok(html.includes('placeholder="From"'), 'Duration min input has From placeholder');
    assert.ok(html.includes('placeholder="To"'), 'Duration max input has To placeholder');

    // Row 3 Search filters
    assert.ok(html.includes('id="cdrSearchSrc"'), 'Must contain cdrSearchSrc in drawer');
    assert.ok(html.includes('id="cdrSearchDst"'), 'Must contain cdrSearchDst in drawer');
    assert.ok(html.includes('id="cdrSearchDid"'), 'Must contain cdrSearchDid in drawer');
    assert.ok(html.includes('id="cdrSearchUid"'), 'Must contain cdrSearchUid in drawer');

    // Action Bar toggle button
    assert.ok(html.includes('id="cdrToggleMoreBtn"'), 'Must contain cdrToggleMoreBtn');
    assert.ok(html.includes('More Filters'), 'Must display More Filters label when collapsed');
});

test('Call History renders filter panel in Arabic with localized labels and duration from-to', async () => {
    const arData = { ...defaultData, currentLang: 'ar' };
    const html = await ejs.renderFile(cdrEjsPath, arData);

    assert.ok(html.includes('وقت البدء'), 'Must render Arabic start date label');
    assert.ok(html.includes('قائمة الموظفين'), 'Must render Arabic roster label');
    assert.ok(html.includes('حالة المكالمة'), 'Must render Arabic status label');
    assert.ok(html.includes('خط الربط / الشريحة'), 'Must render Arabic trunk label');
    assert.ok(html.includes('مدة المكالمة (ثانية)'), 'Must render Arabic duration with seconds unit');
    assert.ok(html.includes('placeholder="من"'), 'Arabic placeholder for duration from');
    assert.ok(html.includes('placeholder="إلى"'), 'Arabic placeholder for duration to');
    assert.ok(html.includes('المزيد من الفلاتر'), 'Must render Arabic More Filters label');
    assert.ok(html.includes('إعادة ضبط'), 'Must render Arabic Reset label');
});

test('Call History drawer auto-expands with active badge when duration from-to or search filters are set', async () => {
    const activeData = {
        ...defaultData,
        filters: {
            ...defaultData.filters,
            durationMin: '45',
            searchSrc: '101'
        }
    };
    const html = await ejs.renderFile(cdrEjsPath, activeData);

    assert.ok(!html.includes('id="cdrSecondaryFilters" class="hidden'), 'Drawer must not be hidden when active filters are present');
    assert.ok(html.includes('2 Active'), 'Must show 2 Active badge');
    assert.ok(html.includes('Fewer Filters'), 'Must show Fewer Filters label');
    assert.ok(html.includes('value="45"'), 'Duration min input retains value 45');
    assert.ok(html.includes('value="101"'), 'Search input retains value 101');
});

test('Call History table columns render strictly in canonical order', async () => {
    const html = await ejs.renderFile(cdrEjsPath, defaultData);

    const theadCols = [...html.matchAll(/<th data-col="([^"]+)"/g)].map(m => m[1]);
    const tbodyCols = [...html.matchAll(/<td data-col="([^"]+)"/g)].map(m => m[1]);

    const expectedOrder = [
        'time', 'src', 'dst', 'name', 'trunk',
        'airtime', 'state', 'dir', 'scope', 'rec',
        'did', 'uniqueid', 'actions'
    ];

    assert.deepEqual(theadCols, expectedOrder, 'Thead columns must match canonical order');
    assert.deepEqual(tbodyCols, expectedOrder, 'Tbody columns must match canonical order');
});

test('Trunk filter dropdown renders clean select with zero emojis', async () => {
    const html = await ejs.renderFile(cdrEjsPath, {
        ...defaultData,
        availableTrunks: [
            { id: 'dongle:Dongle-0', label: 'Dongle-0 (01012345678)', type: 'dongle' },
            { id: 'trunk:1', label: 'Trunk-1 (sip)', type: 'sip' }
        ]
    });

    assert.ok(!html.includes('📱'), 'Must not contain mobile phone emoji');
    assert.ok(!html.includes('🌐'), 'Must not contain globe emoji');
    assert.ok(html.includes('id="cdrTrunkFilter"'), 'Must contain clean cdrTrunkFilter select');
});
