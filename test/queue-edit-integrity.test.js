const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(rootDir, relative), 'utf8');

test('queue edit preserves settings the modal does not own', () => {
    const server = read('server.js');
    const put = server.match(/app\.put\('\/api\/config\/queues\/:extension',[\s\S]*?\n\}\);/);
    assert.ok(put, 'PUT /api/config/queues/:extension must exist');
    const handler = put[0];

    // A full wipe destroyed Issabel-owned keys (weight, servicelevel, ...).
    assert.ok(
        !/DELETE FROM `asterisk`\.`queues_details` WHERE id = \?`/.test(handler),
        'queue edit must not delete every queues_details row'
    );
    assert.match(handler, /const managedKeywords = \[/, 'queue edit must declare the keywords it owns');
    assert.match(handler, /keyword IN \(\$\{managedKeywords\.map\(\(\) => '\?'\)\.join\(','\)\}\)/,
        'queue edit must only delete its own keywords');

    // The modal does not expose these, so they must never be rewritten.
    for (const keyword of ['maxlen', 'wrapuptime', 'announce-frequency', 'weight', 'servicelevel']) {
        assert.ok(
            !new RegExp(`\\[num, '${keyword}'`).test(handler),
            `queue edit must not overwrite ${keyword}`
        );
    }

    // Empty-queue defaults are seeded only when missing.
    assert.match(handler, /INSERT IGNORE INTO `asterisk`\.`queues_details`/);
});

test('queue join announcement survives the modal repopulation', () => {
    const view = read('views/config.ejs');

    const populate = view.match(/function populateQueueAnnouncementsDropdown\(([^)]*)\)\s*\{[\s\S]*?\n        \}/);
    assert.ok(populate, 'populateQueueAnnouncementsDropdown must exist');
    assert.match(populate[0], /desiredValue/, 'it must accept the value to preserve');
    assert.match(populate[0], /const keep =/, 'it must capture the value before rebuilding options');
    assert.match(populate[0], /sel\.value = keep/, 'it must restore the value after rebuilding options');
    assert.match(populate[0], /Missing recording/, 'a deleted recording must stay visible, not silently reset');
    assert.match(populate[0], /syncConfigDropdownTrigger/, 'the custom dropdown label must be refreshed');

    // Edit must pass the saved id to every repopulation (sync and async).
    const edit = view.match(/function editQueue\(extNum\)\s*\{[\s\S]*?\n        \}/);
    assert.ok(edit, 'editQueue must exist');
    const editBody = edit[0];
    assert.match(editBody, /const annMsgId = parseInt\(q\.joinannounce_id, 10\) \|\| 0;/);
    const populateCalls = editBody.match(/populateQueueAnnouncementsDropdown\(([^)]*)\)/g) || [];
    assert.equal(populateCalls.length, 2, 'edit must repopulate the dropdown twice (immediate + after async load)');
    for (const call of populateCalls) {
        assert.match(call, /populateQueueAnnouncementsDropdown\(annMsgId\)/,
            'every repopulation during edit must keep the saved announcement');
    }

    // Enhanced selects need an explicit label refresh after programmatic .value.
    assert.match(view, /function syncQueueModalSelects\(\)/);
    assert.match(editBody, /syncQueueModalSelects\(\)/);

    // Skip Busy must accept Issabel's 2/3 values, not just 1.
    assert.match(editBody, /Number\(q\.cwignore\) > 0/);
});
