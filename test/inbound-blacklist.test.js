const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const { getPhoneVariants, cleanPhoneString } = require(path.join(rootDir, 'lib', 'phone-normalization.js'));

test('Inbound Blacklist: Schema in backend/install_db.sql defines dashboard_inbound_blacklist table', () => {
    const schemaSql = fs.readFileSync(path.join(rootDir, 'backend', 'install_db.sql'), 'utf8');
    assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS `dashboard_inbound_blacklist`/i, 'install_db.sql must define dashboard_inbound_blacklist');
    assert.match(schemaSql, /`phone_number`\s+VARCHAR/i, 'table must contain phone_number column');
    assert.match(schemaSql, /`action`\s+VARCHAR/i, 'table must contain action column');
    assert.match(schemaSql, /`enabled`\s+TINYINT/i, 'table must contain enabled column');
});

test('Inbound Blacklist: Dialplan in extensions_custom.conf checks AstDB blacklist and terminates caller', () => {
    const dialplanPath = '/etc/asterisk/extensions_custom.conf';
    assert.ok(fs.existsSync(dialplanPath), 'extensions_custom.conf must exist');
    const dialplan = fs.readFileSync(dialplanPath, 'utf8');

    // 1. Context and lookup
    assert.match(dialplan, /\[from-dongle-custom\]/, 'must have [from-dongle-custom] context');
    assert.match(dialplan, /DB\(blacklist\/\$\{CALLER_NUMBER\}\)/, 'dialplan must check DB(blacklist/${CALLER_NUMBER})');
    assert.match(dialplan, /DB\(blacklist\/\$\{CLEAN_CALLER\}\)/, 'dialplan must check DB(blacklist/${CLEAN_CALLER})');
    assert.match(dialplan, /Goto\(blacklisted\)/, 'dialplan must jump to blacklisted on match');

    // 2. Blacklisted termination block
    assert.match(dialplan, /\(blacklisted\)/, 'dialplan must contain blacklisted target label');
    assert.match(dialplan, /Zapateller\(\)/, 'blacklisted call must receive SIT tone via Zapateller()');
    assert.match(dialplan, /Playback\(ss-noservice\)/, 'blacklisted call must play ss-noservice recording');
    assert.match(dialplan, /Hangup\(\)/, 'blacklisted call must be hung up');
});

test('Inbound Blacklist: Phone number variants generation matches international & local cellular formats', () => {
    // Egyptian mobile standard 01280695454 -> variants: +201280695454, 201280695454, 1280695454, 01280695454
    const phone = '01280695454';
    const variants = getPhoneVariants(phone);

    assert.ok(Array.isArray(variants), 'variants must be an array');
    assert.ok(variants.includes('+201280695454') || variants.includes('201280695454'), 'must contain country code variant');
    assert.ok(variants.includes('1280695454') || variants.includes('01280695454'), 'must contain local dial variants');

    // International format with +2
    const intlPhone = '+201156804841';
    const intlVariants = getPhoneVariants(intlPhone);
    assert.ok(intlVariants.includes('01156804841') || intlVariants.includes('1156804841'), 'must generate local zero prefix for +20 numbers');

    // Clean phone string helper
    assert.strictEqual(cleanPhoneString(' +20-128 (069) 5454 '), '+201280695454', 'cleanPhoneString must strip dashes, spaces, and parens');
});

test('Inbound Blacklist: server.js wires API endpoints and AstDB synchronization routines', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');

    // 1. AstDB Sync routine
    assert.match(serverCode, /async function syncBlacklistEntryToAstDB/, 'must define syncBlacklistEntryToAstDB helper');
    assert.match(serverCode, /database put blacklist/, 'sync routine must execute Asterisk database put');
    assert.match(serverCode, /database del blacklist/, 'sync routine must execute Asterisk database del on disable');

    // 2. REST Endpoints
    assert.match(serverCode, /app\.get\('\/api\/blacklist'/, 'must define GET /api/blacklist');
    assert.match(serverCode, /app\.post\('\/api\/blacklist'/, 'must define POST /api/blacklist');
    assert.match(serverCode, /app\.delete\('\/api\/blacklist\/:id'/, 'must define DELETE /api/blacklist/:id');
    assert.match(serverCode, /app\.post\('\/api\/blacklist\/import'/, 'must define POST /api/blacklist/import for CSV import');

    // 3. Supported blacklist rejection actions
    assert.match(serverCode, /'zapateller',\s*'hangup',\s*'congestion'/, 'must support zapateller, hangup, and congestion actions');
});

test('Inbound Blacklist: CSV parsing handles various column layouts and sanitizes phone numbers', () => {
    const sampleCsv = `Phone Number,Description,Action\n"01280695454","Spam Robocaller","zapateller"\n+201156804841,Telemarketer,hangup\n  0100 123 4567 ,Debt Collection,congestion\n`;
    const lines = sampleCsv.split(/\r?\n/).filter(Boolean);

    const parsedEntries = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
        const firstCell = parts[0] || '';
        if (i === 0 && (firstCell.toLowerCase().includes('phone') || firstCell.toLowerCase().includes('number'))) {
            continue; // Header row
        }
        const phone = firstCell.replace(/[\s\-\(\)\.]/g, '');
        const desc = parts[1] || 'CSV Import';
        const action = parts[2] || 'zapateller';
        parsedEntries.push({ phone, desc, action });
    }

    assert.strictEqual(parsedEntries.length, 3, 'Must parse exactly 3 blacklist records');
    assert.strictEqual(parsedEntries[0].phone, '01280695454');
    assert.strictEqual(parsedEntries[0].action, 'zapateller');
    assert.strictEqual(parsedEntries[1].phone, '+201156804841');
    assert.strictEqual(parsedEntries[1].action, 'hangup');
    assert.strictEqual(parsedEntries[2].phone, '01001234567');
    assert.strictEqual(parsedEntries[2].action, 'congestion');
});
