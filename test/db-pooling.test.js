const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');
const server = read('server.js');
const contacts = read('lib/contacts.js');

test('two tuned pools: reporting (CDR) and PBX configuration', () => {
    assert.match(server, /const DB_BASE_CONFIG = \{[\s\S]*?connectionLimit: Number\(process\.env\.DB_POOL_LIMIT \|\| 20\)/);
    assert.match(server, /enableKeepAlive: true/);
    assert.match(server, /keepAliveInitialDelay: 10000/);
    assert.match(server, /idleTimeout: Number\(process\.env\.DB_POOL_IDLE_TIMEOUT \|\| 60000\)/);
    assert.match(server, /maxIdle: Number\(process\.env\.DB_POOL_MAX_IDLE \|\| 10\)/);

    assert.match(server, /const pool = mysql\.createPool\(\{ \.\.\.DB_BASE_CONFIG, database: CDR_DB \}\)/);
    assert.match(server, /const asteriskPool = mysql\.createPool\(\{ \.\.\.DB_BASE_CONFIG, database: ASTERISK_DB \}\)/);
});

test('request handlers no longer open a MySQL connection per request', () => {
    // Only the boot-time DDL and the dialer GET_LOCK keep a dedicated session.
    const createCalls = server.match(/mysql\.createConnection\(/g) || [];
    assert.equal(createCalls.length, 2, `expected 2 dedicated connections, found ${createCalls.length}`);

    const bootIdx = server.indexOf('async function initAuthDb()');
    const bootBlock = server.slice(bootIdx, bootIdx + 800);
    assert.match(bootBlock, /mysql\.createConnection\(/, 'initAuthDb keeps its boot connection');

    const dialerIdx = server.indexOf('async function acquireDialerLeaderLock()');
    const dialerBlock = server.slice(dialerIdx, dialerIdx + 600);
    assert.match(dialerBlock, /mysql\.createConnection\(/, 'GET_LOCK needs a session-scoped connection');

    // Pooled handles must never be closed.
    assert.match(server, /conn !== asteriskPool/, 'a pooled handle must be guarded before conn.end()');
});

test('slow queries are logged with their SQL', () => {
    assert.match(server, /const SLOW_QUERY_MS = Number\(process\.env\.SLOW_QUERY_MS \|\| 1500\)/);
    assert.match(server, /instrumentPool\(pool, 'cdr'\)/);
    assert.match(server, /instrumentPool\(asteriskPool, 'pbx'\)/);
    assert.match(server, /\[DB slow\]/);
});

test('hot list queries use prepared statements', () => {
    for (const marker of [
        /const \[configRows\] = await pool\.execute\(/,
        /const \[detailsRows\] = await pool\.execute\(/,
        /const \[ringgroups\] = await pool\.execute\(/,
        /const \[rows\] = await pool\.execute\(\s*`SELECT id, status_key/
    ]) {
        assert.match(server, marker);
    }
});

test('trunk dial patterns are fetched in one query instead of per trunk', () => {
    assert.match(server, /const dialPatternsByTrunk = new Map\(\)/);
    assert.match(server, /WHERE trunkid IN \(\$\{trunkIds\.map\(\(\) => '\?'\)\.join\(','\)\}\)/);
    assert.ok(
        !/for \(const trunk of trunks\) \{\s*const \[ruleRows\] = await pool\.query/.test(server),
        'the per-trunk query must be gone'
    );
});

test('address book is cached instead of spawning sqlite3 per lookup', () => {
    assert.match(contacts, /const CONTACTS_CACHE_TTL_MS = Number\(process\.env\.CONTACTS_CACHE_TTL_MS \|\| 30000\)/);
    assert.match(contacts, /async function loadContactsCached\(\)/);
    assert.match(contacts, /function invalidateContactsCache\(\)/);

    // Lookups must read the cache, not the CLI.
    const phoneLookup = contacts.match(/async function findContactByPhone\(phone\)\s*\{[\s\S]*?\n\}/);
    assert.ok(phoneLookup, 'findContactByPhone must exist');
    assert.match(phoneLookup[0], /await loadContactsCached\(\)/);
    assert.ok(!/runSqliteQuery\(/.test(phoneLookup[0]), 'phone lookup must not spawn sqlite3');

    // Writes invalidate.
    const create = contacts.match(/async function createContact\(input\)\s*\{[\s\S]*?\n\}/);
    assert.match(create[0], /invalidateContactsCache\(\)/);
    const remove = contacts.match(/async function deleteContact\(id\)\s*\{[\s\S]*?\n\}/);
    assert.match(remove[0], /invalidateContactsCache\(\)/);
});

test('dashboard/CDR indexes ship in both deployment paths', () => {
    const sql = read('backend/install_db.sql');
    assert.match(sql, /idx_calldate_disp/);
    assert.match(sql, /ALTER TABLE `asteriskcdrdb`\.`cdr` ADD INDEX `idx_calldate_disp` \(`calldate`, `disposition`\)/);
    assert.match(sql, /ADD INDEX `idx_keyword` \(`keyword`\)/);
    assert.match(sql, /ADD INDEX `idx_voicemail` \(`voicemail`\)/);

    const upgrader = read('scripts/safe-upgrade.sh');
    assert.match(upgrader, /idx_calldate_disp/);
    assert.match(upgrader, /idx_keyword/);
    assert.match(upgrader, /idx_voicemail/);
});

test('the upgrader re-executes itself when the pull replaces its own file', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'safe-upgrade.sh'), 'utf8');

    // Bash reads scripts incrementally: pulling a new version mid-run used to
    // leave the remaining steps executing the old body.
    assert.match(script, /SELF_PATH=\$\(readlink -f "\$0"/);
    assert.match(script, /SELF_HASH_BEFORE=\$\(sha256sum "\$SELF_PATH"/);
    assert.match(script, /SELF_HASH_AFTER=\$\(sha256sum "\$SELF_PATH"/);
    assert.match(script, /SOKRAT_UPGRADE_REEXEC/);
    assert.match(script, /exec env SOKRAT_UPGRADE_REEXEC=1 bash "\$SELF_PATH" "\$@"/);

    // The guard must be checked after the codebase update, not before.
    const pull = script.indexOf('git merge --ff-only origin/main');
    const reexec = script.indexOf('exec env SOKRAT_UPGRADE_REEXEC=1');
    assert.ok(pull > 0 && reexec > pull, 're-exec must happen after the pull');
});

test('schema seeds are idempotent so a re-run cannot abort mid-batch', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'backend', 'install_db.sql'), 'utf8');
    const lines = sql.split('\n');
    const offenders = [];

    lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!/^INSERT INTO /i.test(trimmed)) return;
        // Allow ON DUPLICATE KEY UPDATE further down the same statement.
        const tail = lines.slice(idx, idx + 40).join('\n');
        const statement = tail.split(';')[0] || '';
        if (/ON DUPLICATE KEY UPDATE/i.test(statement)) return;
        offenders.push(`${idx + 1}: ${trimmed.slice(0, 80)}`);
    });

    assert.deepEqual(offenders, [], 'seeds must use INSERT IGNORE or ON DUPLICATE KEY UPDATE');
    assert.match(sql, /INSERT IGNORE INTO `sokrat_call_codes`/);
});

test('the schema import retries once instead of skipping later migrations', () => {
    const script = read('scripts/safe-upgrade.sh');
    assert.ok(script.includes('SOKRAT_SCHEMA_LOG=$(mktemp'), 'schema import must capture its log');
    assert.ok(script.includes('retrying once so a transient lock cannot skip later migrations'),
        'a failed import must retry');
    assert.ok(script.includes('Applied database schema definitions on retry'),
        'a successful retry must be reported');
    assert.ok(script.includes('still failing after retry'), 'a second failure must stay visible');
});
