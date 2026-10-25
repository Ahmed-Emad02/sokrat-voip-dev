const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(rootDir, relative), 'utf8');

test('queue agent roles: schema keeps static, dynamic and both states', () => {
    const sql = read('backend/install_db.sql');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS `asterisk`\.`sokrat_queue_agents`/);
    assert.match(sql, /`queue` VARCHAR\(45\) NOT NULL/);
    assert.match(sql, /`extension` VARCHAR\(45\) NOT NULL/);
    assert.match(sql, /`is_static` TINYINT\(1\) NOT NULL DEFAULT 0/);
    assert.match(sql, /`is_dynamic` TINYINT\(1\) NOT NULL DEFAULT 0/);
    assert.match(sql, /PRIMARY KEY \(`queue`, `extension`\)/);

    const upgrader = read('scripts/safe-upgrade.sh');
    assert.match(upgrader, /CREATE TABLE IF NOT EXISTS \\?`sokrat_queue_agents\\?`/, 'safe-upgrade.sh must create the role table');
});

test('queue agent roles: server persists the three states instead of collapsing to static', () => {
    const server = read('server.js');

    // Role split keeps both flags for an agent that is in both lists.
    const split = server.match(/function splitQueueAgentRoles\([\s\S]*?\n\}/);
    assert.ok(split, 'server.js must define splitQueueAgentRoles');
    assert.match(split[0], /is_static: statics\.includes\(ext\) \? 1 : 0/);
    assert.match(split[0], /is_dynamic: dynamics\.includes\(ext\) \? 1 : 0/);

    // Read/write helpers target the Sokrat-owned table only.
    assert.match(server, /async function readQueueAgentRoles\(\)/);
    assert.match(server, /async function replaceQueueAgentRoles\(conn, num, entries\)/);
    assert.match(server, /INSERT INTO `asterisk`\.`sokrat_queue_agents`/);
    assert.match(server, /DELETE FROM `asterisk`\.`sokrat_queue_agents` WHERE `queue` = \?/);

    // GET must prefer the remembered roles over the member rows.
    const getter = server.match(/app\.get\('\/api\/config\/queues'[\s\S]*?\n\}\);/);
    assert.ok(getter, 'server.js must define GET /api/config/queues');
    assert.match(getter[0], /const savedRoles = await readQueueAgentRoles\(\)/);
    assert.match(getter[0], /roleRows\.filter\(r => r\.is_static\)/);
    assert.match(getter[0], /roleRows\.filter\(r => r\.is_dynamic\)/);

    // Both write paths must store roles inside the transaction.
    const post = server.match(/app\.post\('\/api\/config\/queues',[\s\S]*?\n\}\);/);
    const put = server.match(/app\.put\('\/api\/config\/queues\/:extension',[\s\S]*?\n\}\);/);
    assert.ok(post && put, 'queue create and update endpoints must exist');
    for (const [name, handler] of [['POST', post[0]], ['PUT', put[0]]]) {
        assert.match(handler, /splitQueueAgentRoles\(static_members, dynmembers\)/, `${name} must split the roles`);
        assert.match(handler, /replaceQueueAgentRoles\(conn, num, roleEntries\)/, `${name} must persist the roles`);
        assert.match(handler, /beginTransaction\(\)/, `${name} must write atomically`);
    }

    // Deleting a queue must not leave orphaned role rows.
    const del = server.match(/app\.delete\('\/api\/config\/queues\/:extension',[\s\S]*?\n\}\);/);
    assert.ok(del, 'queue delete endpoint must exist');
    assert.match(del[0], /DELETE FROM `asterisk`\.`sokrat_queue_agents` WHERE `queue` = \?/);
});

test('queue agent roles: every assigned agent still becomes a real member', () => {
    const server = read('server.js');
    const builder = server.match(/function buildQueueMemberRows\([\s\S]*?\n\}/);
    assert.ok(builder, 'server.js must define buildQueueMemberRows');
    assert.match(builder[0], /cleanQueueAgentList\(staticMembers\)/);
    assert.match(builder[0], /cleanQueueAgentList\(dynamicMembers\)/);
    assert.match(builder[0], /Local\/\$\{ext\}@from-queue\/n,0/);

    // reload and boot repair stay wired
    assert.match(server, /reconcileQueueMembership\(\)/);
    assert.match(server, /seed the role table|Seed the role table/i);
});

test('queue agent roles: modal hydrates each field from its own value', () => {
    const view = read('views/config.ejs');
    assert.match(view, /function cleanQueueAgentsFromApi\(value\)/);
    assert.match(view, /const staticArr = cleanQueueAgentsFromApi\(q\.static_members\)/);
    assert.match(view, /const dynArr = cleanQueueAgentsFromApi\(q\.dynmembers\)/);
    assert.match(view, /getElementById\('queueStaticList'\)\.value = staticArr\.join\(', '\)/);
    assert.match(view, /getElementById\('queueDynList'\)\.value = dynArr\.join\(', '\)/);

    // The old code duplicated the union into both boxes, which collapsed the role.
    assert.ok(
        !/const allAgents = Array\.from\(new Set\(\[\.\.\.staticArr, \.\.\.dynArr\]/.test(view),
        'config.ejs must not merge static and dynamic agents into one list on edit'
    );
});
