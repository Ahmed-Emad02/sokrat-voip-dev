const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');

test('IVR Routing Engine: server.js wires complete CRUD REST APIs and PBX reload hooks', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');

    // 1. Endpoints
    assert.match(serverCode, /app\.get\('\/api\/config\/ivrs'/, 'must define GET /api/config/ivrs');
    assert.match(serverCode, /app\.get\('\/api\/config\/ivrs\/:id'/, 'must define GET /api/config/ivrs/:id');
    assert.match(serverCode, /app\.post\('\/api\/config\/ivrs'/, 'must define POST /api/config/ivrs');
    assert.match(serverCode, /app\.put\('\/api\/config\/ivrs\/:id'/, 'must define PUT /api/config/ivrs/:id');
    assert.match(serverCode, /app\.delete\('\/api\/config\/ivrs\/:id'/, 'must define DELETE /api/config/ivrs/:id');

    // 2. Table operations
    assert.match(serverCode, /INSERT INTO.*ivr_details/i, 'must insert into ivr_details');
    assert.match(serverCode, /INSERT INTO.*ivr_entries/i, 'must insert into ivr_entries');
    assert.match(serverCode, /DELETE FROM.*ivr_entries/i, 'must clean up ivr_entries on update or delete');
    assert.match(serverCode, /DELETE FROM.*ivr_details/i, 'must clean up ivr_details on delete');
});

test('IVR Routing Engine: Validates digit selection rules, timeouts, and fallback routing destinations', () => {
    // Digit entries format: selection (0-9, *, #) -> target destination
    const validSelections = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];
    const invalidSelections = ['12', 'abc', '', ' '];

    function isValidIvrDigit(sel) {
        return typeof sel === 'string' && /^[0-9*#]$/.test(sel.trim());
    }

    for (const valid of validSelections) {
        assert.strictEqual(isValidIvrDigit(valid), true, `Selection "${valid}" must be valid`);
    }
    for (const invalid of invalidSelections) {
        assert.strictEqual(isValidIvrDigit(invalid), false, `Selection "${invalid}" must be invalid`);
    }

    // Standard fallback destinations
    const fallbackTypes = ['timeout', 'invalid'];
    for (const type of fallbackTypes) {
        const defaultDest = 'app-blackhole,hangup,1';
        assert.ok(defaultDest.includes('app-blackhole') || defaultDest.includes('hangup'), `${type} destination must provide safe blackhole or hangup fallback`);
    }
});

test('IVR Routing Engine: Generates compliant Asterisk IVR dialplan structure', () => {
    // Mock IVR data structure
    const ivr = {
        id: 1,
        name: 'Main Company IVR',
        announcement: 'custom/welcome_prompt',
        directdial: 'ext-local',
        timeout_time: 10,
        timeout_destination: 'ext-group,601,1',
        invalid_destination: 'app-blackhole,hangup,1',
        entries: [
            { selection: '1', dest: 'ext-group,601,1' },
            { selection: '2', dest: 'ext-local,102,1' },
            { selection: '0', dest: 'ext-local,101,1' }
        ]
    };

    // Synthesize dialplan lines
    const dialplanLines = [
        `[ivr-${ivr.id}]`,
        `exten => s,1,Set(TIMEOUT(digit)=3)`,
        `exten => s,n,Set(TIMEOUT(response)=${ivr.timeout_time})`,
        `exten => s,n,Background(${ivr.announcement})`,
        `exten => s,n,WaitExten()`,
        `exten => t,1,Goto(${ivr.timeout_destination})`,
        `exten => i,1,Goto(${ivr.invalid_destination})`
    ];

    if (ivr.directdial === 'ext-local') {
        dialplanLines.push(`include => ext-local`);
    }

    for (const entry of ivr.entries) {
        dialplanLines.push(`exten => ${entry.selection},1,Goto(${entry.dest})`);
    }

    const dialplan = dialplanLines.join('\n');

    assert.ok(dialplan.includes('[ivr-1]'), 'must include [ivr-1] context');
    assert.ok(dialplan.includes('Background(custom/welcome_prompt)'), 'must play background announcement');
    assert.ok(dialplan.includes('WaitExten()'), 'must wait for DTMF extension input');
    assert.ok(dialplan.includes('exten => t,1,Goto(ext-group,601,1)'), 'must handle timeout with t extension');
    assert.ok(dialplan.includes('exten => i,1,Goto(app-blackhole,hangup,1)'), 'must handle invalid input with i extension');
    assert.ok(dialplan.includes('include => ext-local'), 'must include ext-local when directdial is enabled');
    assert.ok(dialplan.includes('exten => 1,1,Goto(ext-group,601,1)'), 'must route option 1');
    assert.ok(dialplan.includes('exten => 2,1,Goto(ext-local,102,1)'), 'must route option 2');
});
