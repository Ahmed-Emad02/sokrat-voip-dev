const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const operatorEjsPath = path.join(__dirname, '../views/operator.ejs');

function renderLocals() {
    return {
        currentLang: 'en',
        isRtl: false,
        currentPage: '/operator',
        isSuperAdmin: true,
        user: { username: 'admin' },
        activeCalls: {},
        roster: [
            { extension: '101', name: 'Ahmed Emad', title: 'Tech Lead', emp_group: 'Engineering', online: true, ip: null, photo: null },
            { extension: '102', name: 'Sara Mohamed', title: 'Support Agent', emp_group: 'Support', online: false, ip: null, photo: null },
            { extension: '103', name: 'Omar Ali', title: '', emp_group: null, online: false, ip: null, photo: null }
        ],
        employeeGroups: ['Engineering', 'Support', 'Sales']
    };
}

test('views/operator.ejs tags every group section with a stable data-group key', async () => {
    const html = await ejs.renderFile(operatorEjsPath, renderLocals());

    assert.ok(html.includes('data-group="Engineering"'), 'Should tag Engineering group section');
    assert.ok(html.includes('data-group="Support"'), 'Should tag Support group section');
    assert.ok(html.includes('data-group="Sales"'), 'Should tag empty Sales group section');
    assert.ok(html.includes('data-group="___ungrouped___"'), 'Should tag ungrouped section');
    const articleCount = (html.match(/<article id="card-\d+"/g) || []).length;
    assert.equal(articleCount, 3, 'Should render one draggable card per roster entry');
});

test('views/operator.ejs renders drop hints inside group grids shown only while empty', async () => {
    const html = await ejs.renderFile(operatorEjsPath, renderLocals());
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    const hintCount = (html.match(/class="drop-hint col-span-full select-none"/g) || []).length;
    assert.ok(hintCount >= 4, 'Every group grid should contain a drop hint element');

    // Hint is hidden by default and revealed only when the grid holds no cards
    assert.ok(content.includes('.extension-group-grid > .drop-hint { display: none; }'), 'Hint must be hidden by default');
    assert.ok(content.includes('.extension-group-grid:not(:has(> article[id^="card-"])) > .drop-hint'), 'Hint must show only for empty grids');
});

test('views/operator.ejs wires native drag & drop with localStorage persistence', () => {
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    // Drag lifecycle listeners
    assert.ok(content.includes("gridRoot.addEventListener('dragstart'"), 'Should handle dragstart on cards');
    assert.ok(content.includes("gridRoot.addEventListener('dragend'"), 'Should handle dragend to finalize moves');
    assert.ok(content.includes("grid.addEventListener('dragover'"), 'Should allow dropping onto group grids');

    // Interactive controls inside a card must not start drags
    assert.ok(content.includes("'select, option, button, input, textarea, a, label'"), 'Should exclude interactive controls from drag start');

    // Local-only persistence
    assert.ok(content.includes("localStorage.setItem(LAYOUT_KEY"), 'Should persist arrangement in localStorage');
    assert.ok(content.includes("localStorage.getItem(LAYOUT_KEY)"), 'Should restore arrangement from localStorage');
    assert.ok(content.includes('applySavedLayout()'), 'Should apply saved layout on page load');
    assert.ok(content.includes('operator_panel_layout_v1'), 'Should use a versioned storage key');

    // Anti-flicker: batch insertions per frame and suppress boundary flip-flopping
    assert.ok(content.includes('requestAnimationFrame(applyDropJob)'), 'Should coalesce insertion jobs per animation frame');
    assert.ok(content.includes('FLIP_SUPPRESS_MS'), 'Should define a flip suppression window');
    assert.ok(content.includes('transition: none !important'), 'Should snap card transitions while dragging');
});

test('views/operator.ejs syncs cross-group drops to the server-side employee group', async () => {
    const html = await ejs.renderFile(operatorEjsPath, renderLocals());
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    // Cards carry their server-rendered group so drops can be diffed against it
    assert.ok(html.includes('data-emp-group="Engineering"'), 'Card 101 should be stamped with its server group');
    assert.ok(html.match(/id="card-103"[^>]*data-emp-group=""/), 'Ungrouped card 103 should have an empty data-emp-group');
    assert.ok(content.includes("'/api/employee/group-assignment'"), 'Cross-group moves should call the assignment API');
    assert.ok(content.includes('syncGroupAssignments()'), 'dragend should trigger the group sync');
    // Layout storage keeps order only; membership stays server-authoritative
    assert.ok(content.includes('card.dataset.empGroup === section.dataset.group'), 'Local layout should only store same-group ordering');
});

test('views/operator.ejs updates group count badges after drops and defines drop-zone styling', () => {
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    assert.ok(content.includes('.employee-group-count').valueOf && content.includes("el.textContent = count"), 'Should refresh group count badges');
    assert.ok(content.includes('.dnd-dragging'), 'Should style the card being dragged');
    assert.ok(content.includes('.dnd-active .extension-group-grid'), 'Should highlight all grids as drop zones while dragging');
    assert.ok(content.includes('.dnd-drop-hover'), 'Should style the hovered target grid');
});

test('views/operator.ejs closes its <style> block before </head>', () => {
    const content = fs.readFileSync(operatorEjsPath, 'utf8');
    const styleEnd = content.indexOf('</style>');
    const headEnd = content.indexOf('</head>');

    assert.notEqual(styleEnd, -1, 'Should contain a closing </style> tag');
    assert.notEqual(headEnd, -1, 'Should contain a closing </head> tag');
    assert.ok(styleEnd < headEnd, '</style> must appear before </head>');
});

test('views/operator.ejs renders actual employee groups per server on central Live Panel', async () => {
    const locals = {
        currentLang: 'en',
        isRtl: false,
        currentPage: '/operator',
        isSuperAdmin: true,
        user: { username: 'admin' },
        activeCalls: {},
        federationCentral: true,
        federationSettings: { local_site_code: '10', local_node_name: 'Main PBX' },
        federationPeers: [
            { id: 1, node_name: 'Branch PBX', site_code: '20', host: '192.168.100.92' }
        ],
        federationRemoteExtensions: [
            { peer_id: 1, native_extension: '201', dial_alias: '20201', display_name: 'Kareem Tarek', emp_group: 'Support', status: 'online' },
            { peer_id: 1, native_extension: '202', dial_alias: '20202', display_name: 'Mona Ali', emp_group: null, status: 'offline' }
        ],
        roster: [
            { extension: '101', name: 'Ahmed Emad', title: 'Tech Lead', emp_group: 'Engineering', online: true, ip: null, photo: null }
        ],
        employeeGroups: ['Engineering', 'Support', 'Sales']
    };

    const html = await ejs.renderFile(operatorEjsPath, locals);

    // Multi-server dividers
    assert.ok(html.includes('data-site-code="10"'), 'Should render Main PBX site code tag');
    assert.ok(html.includes('data-site-code="20"'), 'Should render Branch PBX site code tag');
    assert.ok(html.includes('Branch PBX'), 'Should display Branch PBX header');

    // Remote extensions retain their native employee groups instead of being lumped into a node group
    assert.ok(html.includes('data-group="Support" data-site-code="20"'), 'Branch PBX should have its own Support group section');
    assert.ok(html.includes('id="card-20_201"'), 'Remote card 20_201 should exist');
    assert.ok(html.includes('data-native-ext="201"'), 'Remote card should carry data-native-ext="201"');
    assert.ok(html.includes('data-site-code="20"'), 'Remote card should carry data-site-code="20"');
    assert.ok(html.includes('data-group="___ungrouped___" data-site-code="20"'), 'Branch PBX should have its own ungrouped section');
});

test('views/operator.ejs prevents dragging extensions between servers while allowing moves between groups on same server', () => {
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    // Server-boundary check helper
    assert.ok(content.includes('function isSameServer(grid, card)'), 'Should define same-server check helper');
    assert.ok(content.includes('targetSite === cardSite'), 'Same-server helper should compare target and card site codes');

    // Block cross-server dragover & drops
    assert.ok(content.includes("e.dataTransfer.dropEffect = 'none'"), 'Should set dropEffect none when dragging over different server');
    assert.ok(content.includes('!isSameServer(job.grid, draggedCard)'), 'applyDropJob must reject drops across servers');

    // Visual cue for same server
    assert.ok(content.includes('.dnd-active-site'), 'Should highlight target groups on same server');
    assert.ok(content.includes("sec.classList.add('dnd-active-site')"), 'Should mark same-server sections on dragstart');

    // Cross-group assignments within same server routed appropriately
    assert.ok(content.includes('fedRelayAction'), 'Should support relaying remote group assignments via federation');
    assert.ok(content.includes("cardSite !== sectionSite"), 'syncGroupAssignments must ignore accidental cross-site cards');
});
