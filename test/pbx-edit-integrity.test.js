const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(rootDir, relative), 'utf8');
const server = read('server.js');
const view = read('views/config.ejs') + read('views/scripts/config-page.ejs');

test('ring group edit keeps unsent fields and the announcement', () => {
    const put = server.match(/app\.put\('\/api\/config\/ringgroups\/:grpnum',[\s\S]*?\n\}\);/);
    assert.ok(put, 'PUT ringgroups must exist');
    const handler = put[0];

    // Reads the stored row so a partial payload cannot blank it out.
    assert.match(handler, /SELECT grpnum, description, grplist, strategy, grptime, annmsg_id, ringing, postdest/);
    assert.match(handler, /const annMsgId = \(annmsg_id !== undefined/);
    assert.match(handler, /parseInt\(current\.annmsg_id, 10\) \|\| 0/);
    assert.match(handler, /String\(current\.postdest/);
    assert.match(handler, /parseInt\(current\.grptime, 10\) \|\| 20/);

    // Universal recording stays enforced (product policy).
    assert.match(handler, /cwignore = 'CHECKED', recording = 'always'/);

    // UI: the announcement dropdown must survive its own async repopulation.
    const pop = view.match(/function populateAnnouncementsDropdown\(([^)]*)\)\s*\{[\s\S]*?\n        \}/);
    assert.ok(pop, 'populateAnnouncementsDropdown must exist');
    assert.match(pop[0], /desiredValue/);
    assert.match(pop[0], /sel\.value = keep/);

    const edit = view.match(/function editRingGroup\(grpnum\)\s*\{[\s\S]*?\n        \}/);
    assert.ok(edit, 'editRingGroup must exist');
    assert.match(edit[0], /const rgAnnMsgId = parseInt\(rg\.annmsg_id, 10\) \|\| 0/);
    const calls = edit[0].match(/populateAnnouncementsDropdown\(([^)]*)\)/g) || [];
    assert.equal(calls.length, 2, 'editRingGroup must repopulate twice and keep the saved id');
    for (const call of calls) assert.match(call, /populateAnnouncementsDropdown\(rgAnnMsgId\)/);
    assert.match(edit[0], /syncRingGroupModalSelects\(\)/);
});

test('inbound route edit keeps MOH, delay and existing recording mode', () => {
    const put = server.match(/app\.put\('\/api\/config\/routes\/inbound',[\s\S]*?\n\}\);/);
    assert.ok(put, 'PUT inbound must exist');
    const handler = put[0];

    assert.ok(!/mohclass = 'default'/.test(handler), 'inbound edit must not reset mohclass');
    assert.match(handler, /delay_answer = COALESCE\(\?, delay_answer\)/);
    // Deleting the NEW key before inserting raced with the row it was creating.
    assert.ok(
        !/WHERE \(extension = \? OR extension = \? OR extension = \?\) AND \(cidnum = \? OR cidnum = \? OR cidnum = \?\)/.test(handler),
        'key-change cleanup must not include the new key'
    );
    // Recording enforcement is intentional and must stay.
    assert.match(handler, /VALUES \(\?, \?, 'force', 'did'\)/);
});

test('extension edit never disables voicemail it was not asked to change', () => {
    const put = server.match(/app\.put\('\/api\/config\/extensions\/:extension',[\s\S]*?\n\}\);/);
    assert.ok(put, 'PUT extensions must exist');
    const handler = put[0];

    assert.match(handler, /SELECT voicemail, recording FROM `asterisk`\.`users`/);
    assert.match(handler, /let effectiveVm = currentUser\.voicemail \|\| 'novm'/);
    assert.match(handler, /applyVoicemailState\(extNum, displayName \|\| extNum, effectiveVm\)/);
    // Universal recording stays enforced (product policy).
    assert.match(handler, /recording = "out=always\|in=always"/);
});

test('child-row replacements are transactional', () => {
    for (const [name, pattern] of [
        ['IVR entries', /app\.put\('\/api\/config\/ivrs\/:id',[\s\S]*?\n\}\);/],
        ['outbound patterns/trunks', /app\.put\('\/api\/config\/routes\/outbound\/:route_id',[\s\S]*?\n\}\);/],
        ['time group rules', /app\.put\('\/api\/config\/timegroups\/:id',[\s\S]*?\n\}\);/]
    ]) {
        const handler = server.match(pattern);
        assert.ok(handler, `${name} handler must exist`);
        assert.match(handler[0], /beginTransaction\(\)/, `${name} must be transactional`);
        assert.match(handler[0], /rollback\(\)/, `${name} must roll back on failure`);
        assert.match(handler[0], /conn\.commit\(\)/, `${name} must commit`);
    }
});

test('outbound reorder cannot drop routes missing from the payload', () => {
    const reorder = server.match(/app\.post\('\/api\/config\/routes\/outbound\/reorder',[\s\S]*?\n\}\);/);
    assert.ok(reorder, 'reorder endpoint must exist');
    assert.ok(
        !/DELETE FROM `asterisk`\.`outbound_route_sequence` WHERE 1/.test(reorder[0]),
        'reorder must not wipe the whole sequence table'
    );
    assert.match(reorder[0], /DELETE FROM `asterisk`\.`outbound_route_sequence` WHERE route_id = \?/);
    assert.match(reorder[0], /beginTransaction\(\)/);
});

test('IVR edit keeps Issabel return-to-IVR flags', () => {
    const put = server.match(/app\.put\('\/api\/config\/ivrs\/:id',[\s\S]*?\n\}\);/);
    assert.ok(put, 'PUT ivr must exist');
    assert.match(put[0], /SELECT selection, ivr_ret FROM `asterisk`\.`ivr_entries`/);
    assert.match(put[0], /priorRet\[selection\] \|\| 0/);
});

test('announcement booleans are not coerced from the string "0"', () => {
    assert.ok(!/return_ivr \? 1 : 0/.test(server), 'return_ivr must not use truthiness');
    assert.ok(!/noanswer \? 1 : 0/.test(server), 'noanswer must not use truthiness');
    assert.match(server, /const truthy = \(v\) => v === true \|\| v === 1 \|\| v === '1' \|\| v === 'true' \|\| v === 'on';/);
});

test('custom dropdown labels are refreshed after programmatic value changes', () => {
    assert.match(view, /function syncModalSelects\(root\)/);
    assert.match(view, /window\.syncModalSelects = syncModalSelects/);
    assert.match(view, /syncModalSelects\(document\.getElementById\('ivrModal'\)\)/);
});
