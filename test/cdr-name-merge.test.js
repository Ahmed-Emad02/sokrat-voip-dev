const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const moment = require('moment');

const cdrEjsPath = path.join(__dirname, '../views/cdr.ejs');
const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function loadServerHelpers() {
    const f1_start = serverSrc.indexOf('function getExtensionFromChannel(');
    const f1_end = serverSrc.indexOf('\nfunction getEndpointExtensionFromChannel(');
    const f1 = serverSrc.slice(f1_start, f1_end);

    const f2_start = serverSrc.indexOf('function formatSource(');
    const f2_end = serverSrc.indexOf('\n// --- ROUTE 2: CDR DETAILS VIEW');
    const f2 = serverSrc.slice(f2_start, f2_end);

    const factory = new Function(f1 + '\n' + f2 + '\nreturn { getExtensionFromChannel, formatSource, formatDestination };');
    return factory();
}

const { formatSource, formatDestination } = loadServerHelpers();

test('formatSource merges source name into source(name) format', () => {
    const extMap = new Map([
        ['101', 'Ahmed'],
        ['102', 'Sarah'],
        ['103', '103'],
        ['104', 'No Name']
    ]);

    // Has explicit src_name
    assert.equal(formatSource({ src: '101', src_name: 'Ahmed' }, extMap), '101 (Ahmed)');

    // Resolved from extension map when src_name is empty
    assert.equal(formatSource({ src: '102', src_name: '' }, extMap), '102 (Sarah)');

    // No distinct name (same as extension or 'No Name')
    assert.equal(formatSource({ src: '103', src_name: '103' }, extMap), '103');
    assert.equal(formatSource({ src: '104', src_name: 'No Name' }, extMap), '104');

    // External number without name
    assert.equal(formatSource({ src: '01012345678', src_name: '' }, extMap), '01012345678');
});

test('formatDestination formats regular destination with name', () => {
    const ringGroupSet = new Set(['600']);
    const extMap = new Map([
        ['102', 'Sarah'],
        ['105', 'John']
    ]);

    // Direct extension call
    assert.equal(
        formatDestination({ dst: '102', dst_name: 'Sarah' }, ringGroupSet, false, extMap),
        '102 (Sarah)'
    );

    // Resolved via extension map
    assert.equal(
        formatDestination({ dst: '105' }, ringGroupSet, false, extMap),
        '105 (John)'
    );

    // Number without name
    assert.equal(
        formatDestination({ dst: '01012345678' }, ringGroupSet, false, extMap),
        '01012345678'
    );
});

test('formatDestination formats Ring Group calls answered by extension with id and display name', () => {
    const ringGroupSet = new Set(['600', '601']);
    const extMap = new Map([
        ['102', 'WebRTC 102'],
        ['105', 'Agent 105'],
        ['109', '109']
    ]);

    // Ring group 600 answered by 102 via dstchannel
    const rowAnswered = {
        dst: '600',
        dcontext: 'ext-group',
        dstchannel: 'SIP/102-00000014',
        lastdata: 'SIP/101&SIP/102'
    };
    assert.equal(
        formatDestination(rowAnswered, ringGroupSet, false, extMap),
        '600 (102 - WebRTC 102)'
    );

    // Ring group answered by extension whose name has no distinct display text
    const rowNoName = {
        dst: '601',
        dcontext: 'ext-group',
        dstchannel: 'PJSIP/109-00000020',
        lastdata: 'SIP/109'
    };
    assert.equal(
        formatDestination(rowNoName, ringGroupSet, false, extMap),
        '601 (109)'
    );

    // Ring group call with no answer (unanswered)
    const rowMissed = {
        dst: '600',
        dcontext: 'ext-group',
        dstchannel: '',
        lastdata: ''
    };
    assert.equal(
        formatDestination(rowMissed, ringGroupSet, false, extMap),
        '600'
    );
});

test('Call History view renders source(name) and destination(name) without standalone Name column', async () => {
    const mockData = {
        currentLang: 'en',
        currentPage: '/cdr',
        user: { username: 'admin', role: 'admin' },
        isSuperAdmin: true,
        calls: [
            {
                calldate: '2026-10-28 12:00:00',
                uniqueid: '1001.1',
                src: '101',
                src_name: 'Ahmed',
                dst: '600 (102 - WebRTC 102)',
                billsec: 90,
                disposition: 'ANSWERED',
                direction: 'INBOUND',
                call_scope: 'INTERNAL',
                recordingfile: '',
                trunk: { name: '-', type: 'sip' }
            }
        ],
        filters: {
            startDate: '2026-10-28 00:00:00',
            endDate: '2026-10-28 23:59:59',
            targetExtension: 'ALL',
            statusFilter: 'ALL',
            directionFilter: 'ALL',
            callScopeFilter: 'ALL',
            durationMin: '',
            durationMax: '',
            durationUnit: 's',
            trunkFilter: 'ALL',
            searchSrc: '',
            searchDst: '',
            searchDid: '',
            searchUniqueId: ''
        },
        pagination: { page: 1, perPage: 25, total: 1, totalPages: 1 },
        moment,
        roster: [{ extension: '101', name: 'Ahmed' }],
        availableTrunks: []
    };

    const html = await ejs.renderFile(cdrEjsPath, mockData);

    // 1. Name column is NOT present in thead
    assert.ok(!html.includes('data-col="name"'), 'Standalone data-col="name" must not exist in table');

    // 2. Source renders 101 (Ahmed)
    assert.ok(html.includes('101 (Ahmed)'), 'Source column must merge name into source(name)');

    // 3. Destination renders Ring Group + answered extension + display name
    assert.ok(html.includes('600 (102 - WebRTC 102)'), 'Destination must render ring group, extension id and display name');
});

test('CDR Export headers remove separate Source Name column', () => {
    // Both XLSX and CSV headers must have Source and Destination without separate Source Name
    assert.ok(!serverSrc.includes('"Source", "Source Name", "Destination"'), 'Export headers must not contain separate Source Name column');
    assert.ok(serverSrc.includes('"Source", "Destination"'), 'Export headers must contain Source and Destination directly adjacent');
});
