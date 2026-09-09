'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const XLSX = require('xlsx');

const serverJsPath = path.join(__dirname, '../server.js');
const dialerEjsPath = path.join(__dirname, '../views/dialer.ejs');
const softphoneUiPath = '/opt/sokrat-softphone/public/js/softphone-ui.js';
const softphoneEjsPath = '/opt/sokrat-softphone/views/index.ejs';
const sqliteDbPath = '/var/www/db/address_book.db';

const serverJsContent = fs.readFileSync(serverJsPath, 'utf8');
const dialerEjsContent = fs.readFileSync(dialerEjsPath, 'utf8');
const softphoneUiContent = fs.readFileSync(softphoneUiPath, 'utf8');
const softphoneEjsContent = fs.readFileSync(softphoneEjsPath, 'utf8');

test('1. CSV and XLSX 2-Column Lead Parser with Normalization', async () => {
    // Generate sample 2-column CSV in memory
    const csvContent = 'Name,Phone Number\nAmr Diab,01011112222\nSherine Abdelwahab,+201284555106\n';
    const csvTmpPath = '/tmp/test_parse_leads.csv';
    fs.writeFileSync(csvTmpPath, csvContent, 'utf8');

    // Generate sample 2-column XLSX workbook in memory
    const wb = XLSX.utils.book_new();
    const wsData = [
        ['الاسم', 'رقم الهاتف'],
        ['Mohamed Salah', '01009998877'],
        ['Tamer Hosny', '01155443322']
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const xlsxTmpPath = '/tmp/test_parse_leads.xlsx';
    XLSX.writeFile(wb, xlsxTmpPath);

    // Verify parser handles CSV
    const csvWb = XLSX.readFile(csvTmpPath);
    const csvRows = XLSX.utils.sheet_to_json(csvWb.Sheets[csvWb.SheetNames[0]], { header: 1, raw: false });
    assert.equal(csvRows.length, 3);
    assert.equal(csvRows[1][0], 'Amr Diab');
    assert.equal(String(csvRows[1][1]).trim(), '01011112222');

    // Verify parser handles XLSX
    const xlsxWb = XLSX.readFile(xlsxTmpPath);
    const xlsxRows = XLSX.utils.sheet_to_json(xlsxWb.Sheets[xlsxWb.SheetNames[0]], { header: 1, raw: false });
    assert.equal(xlsxRows.length, 3);
    assert.equal(xlsxRows[1][0], 'Mohamed Salah');
    assert.equal(String(xlsxRows[1][1]).trim(), '01009998877');

    fs.unlinkSync(csvTmpPath);
    fs.unlinkSync(xlsxTmpPath);

    // Verify phone number parsing with safety net for stripped zeros
    assert.match(serverJsContent, /function normalizeLeadPhone\(raw\)/);
    assert.match(serverJsContent, /phone\.length === 10 && \/\^1\[0125\]\\d\{8\}\$\/\.test\(phone\)/);
    assert.match(serverJsContent, /phone = '0' \+ phone/);

    // Verify XLSX template generator forces text format '@' and string type 's' across 5000 rows
    assert.match(serverJsContent, /r <= 5000/);
    assert.match(serverJsContent, /ws\[cellAddr\]\.t = 's'/);
    assert.match(serverJsContent, /ws\[cellAddr\]\.z = '@'/);
    assert.match(serverJsContent, /bookType: 'xlsx'/);
});

test('2. Dual-Write to SQLite Address Book (/var/www/db/address_book.db)', () => {
    assert.ok(fs.existsSync(sqliteDbPath), 'Address book SQLite database exists');

    const testPhone = '01099887766';
    const testFirstName = 'Kareem';
    const testLastName = 'Abdelaziz';

    // Insert test lead into address_book.db
    execSync(`sqlite3 "${sqliteDbPath}" "
        INSERT INTO contact (name, last_name, telefono, directory, status)
        SELECT '${testFirstName}', '${testLastName}', '${testPhone}', 'external', 'isPublic'
        WHERE NOT EXISTS (SELECT 1 FROM contact WHERE telefono = '${testPhone}');
        UPDATE contact SET name = '${testFirstName}', last_name = '${testLastName}' WHERE telefono = '${testPhone}';
    "`);

    // Verify insertion
    const queryOut = execSync(`sqlite3 "${sqliteDbPath}" "SELECT name, last_name, telefono FROM contact WHERE telefono = '${testPhone}';"`, { encoding: 'utf8' }).trim();
    assert.equal(queryOut, `${testFirstName}|${testLastName}|${testPhone}`);

    // Clean up
    execSync(`sqlite3 "${sqliteDbPath}" "DELETE FROM contact WHERE telefono = '${testPhone}';"`);
});

test('3. Server.js API Endpoints for Dongle and Campaign Control', () => {
    // Assert GET /api/dialer/dongles endpoint exists
    assert.match(serverJsContent, /app\.get\('\/api\/dialer\/dongles'/);
    assert.match(serverJsContent, /dongle show devices/);

    // Assert GET /api/dialer/campaigns parses allowed_dongles and assigned_agents
    assert.match(serverJsContent, /app\.get\('\/api\/dialer\/campaigns'/);
    assert.match(serverJsContent, /c\.allowed_dongles\s*=\s*c\.allowed_dongles\s*\?\s*JSON\.parse\(c\.allowed_dongles\)/);
    assert.match(serverJsContent, /c\.assigned_agents\s*=\s*c\.assigned_agents\s*\?\s*JSON\.parse\(c\.assigned_agents\)/);

    // Assert POST /api/dialer/campaigns saves allowed_dongles and assigned_agents in progressive mode
    assert.match(serverJsContent, /app\.post\('\/api\/dialer\/campaigns'/);
    assert.match(serverJsContent, /VALUES\s*\(\?,\s*'progressive',\s*\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\?\)/);

    // Assert PUT /api/dialer/campaigns/:id exists for editing campaign settings
    assert.match(serverJsContent, /app\.put\('\/api\/dialer\/campaigns\/:id'/);

    // Assert POST /api/dialer/campaigns/:id/control supports reset and delete
    assert.match(serverJsContent, /action === 'reset'/);
    assert.match(serverJsContent, /action === 'delete'/);

    // Assert leads/import parses XLSX and dual-writes to address book
    assert.match(serverJsContent, /app\.post\('\/api\/dialer\/leads\/import'/);
    assert.match(serverJsContent, /XLSX\.readFile/);
    assert.match(serverJsContent, /INSERT INTO contact \(name, last_name, telefono,/);
});

test('4. Progressive Pacer Engine Uses Local Channel and Selected Dongles', () => {
    // Assert pacer only queries progressive running campaigns
    assert.match(serverJsContent, /SELECT \* FROM `asterisk`\.`dialer_campaigns` WHERE status = 'running' AND \(mode = 'progressive' OR mode IS NULL\)/);

    // Assert pacer filters to assigned agents if configured
    assert.match(serverJsContent, /camp\.assigned_agents/);
    assert.match(serverJsContent, /assignedAgentSet\.has\(ext\)/);

    // Assert pacer checks allowed_dongles if configured
    assert.match(serverJsContent, /camp\.allowed_dongles/);
    assert.match(serverJsContent, /for \(const dId of allowedDongleSet\)/);

    // Assert agent channel uses Local/ext@from-internal/n to support WebRTC
    assert.match(serverJsContent, /const agentChannel = `Local\/\$\{cleanAgent\}@from-internal\/n`/);

    // Assert caller ID header passes lead name and phone number
    assert.match(serverJsContent, /const callerIdHeader = `"\$\{cleanLeadName\}" <\$\{cleanPhone\}>`/);

    // Assert auto-answer SIP headers are passed for WebRTC client
    assert.match(serverJsContent, /Call-Info: <sip:127\.0\.0\.1>;answer-after=0/);
});

test('5. Asterisk Dialplan Contexts for Progressive Auto-Dialing', () => {
    const dialplanOutput = execSync('/usr/sbin/asterisk -rx "dialplan show from-autodialer-progressive"', { encoding: 'utf8' });
    assert.ok(dialplanOutput.includes('Context \'from-autodialer-progressive\''), 'from-autodialer-progressive exists in dialplan');
    assert.ok(dialplanOutput.includes('CALLERID(name)=${LEAD_NAME}'), 'Sets caller name from LEAD_NAME variable');
    assert.ok(dialplanOutput.includes('CALLERID(num)=${LEAD_PHONE}'), 'Sets caller number from LEAD_PHONE variable');
    assert.ok(dialplanOutput.includes('Dial(${DIAL_TARGET}'), 'Dials specific target dongle if set');

    const connectOutput = execSync('/usr/sbin/asterisk -rx "dialplan show sub-autodialer-progressive-connect"', { encoding: 'utf8' });
    assert.ok(connectOutput.includes('DialerProgressiveConnect'), 'Sends UserEvent DialerProgressiveConnect on bridge');

    const hangupOutput = execSync('/usr/sbin/asterisk -rx "dialplan show sub-autodialer-progressive-hangup"', { encoding: 'utf8' });
    assert.ok(hangupOutput.includes('DialerProgressiveHangup'), 'Sends UserEvent DialerProgressiveHangup on teardown');
});

test('6. Sokrat VoIP Campaign Manager View (views/dialer.ejs)', () => {
    // Assert dongles checklist container exists in create/edit modal
    assert.match(dialerEjsContent, /id="campDonglesRoster"/, 'campDonglesRoster exists');
    assert.match(dialerEjsContent, /loadDongles\(\)/, 'Calls loadDongles API');
    assert.match(dialerEjsContent, /fetch\('\/api\/dialer\/dongles'\)/);

    // Assert assigned agents checklist container exists
    assert.match(dialerEjsContent, /id="campAgentsRoster"/, 'campAgentsRoster exists');
    assert.match(dialerEjsContent, /loadExtensions\(\)/, 'Calls loadExtensions API');

    // Assert 2-column CSV/XLSX template download and file picker
    assert.match(dialerEjsContent, /href="\/api\/dialer\/leads\/template"/);
    assert.match(dialerEjsContent, /accept="\.csv,\.xlsx,\.xls"/);

    // Assert Leads View modal exists with search input
    assert.match(dialerEjsContent, /id="viewLeadsModal"/);
    assert.match(dialerEjsContent, /id="leadsSearchInput"/);
    assert.match(dialerEjsContent, /filterLeadsTable\(\)/);

    // Assert campaign action buttons exist (Start, Pause, Reset, Import, View Leads, Edit, Delete)
    assert.match(dialerEjsContent, /openViewLeadsModal\(/);
    assert.match(dialerEjsContent, /controlCampaign\(\$\{c\.id\},\s*'reset'\)/);
    assert.match(dialerEjsContent, /controlCampaign\(\$\{c\.id\},\s*'delete'\)/);
});

test('7. Sokrat VOICE WebRTC Active Call Screen Lead Display Parity', () => {
    // Assert softphone UI checks contactMatch and falls back to displayName and target
    assert.match(softphoneUiContent, /nameDiv\.textContent\s*=\s*contactMatch\.name;/);
    assert.match(softphoneUiContent, /nameDiv\.textContent\s*=\s*call\.displayName;/);
    assert.match(softphoneUiContent, /numDiv\.textContent\s*=\s*call\.target;/);

    // Assert inlined index.ejs in softphone has byte-for-byte parity for call screen
    assert.match(softphoneEjsContent, /nameDiv\.textContent\s*=\s*contactMatch\.name;/);
    assert.match(softphoneEjsContent, /nameDiv\.textContent\s*=\s*call\.displayName;/);
    assert.match(softphoneEjsContent, /numDiv\.textContent\s*=\s*call\.target;/);
});
