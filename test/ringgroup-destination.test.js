'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const view = fs.readFileSync(path.join(root, 'views/scripts/config-page.ejs'), 'utf8');
const markup = fs.readFileSync(path.join(root, 'views/config.ejs'), 'utf8');

test('ring group create honors the selected no-answer destination', () => {
    const save = view.match(/function saveRingGroup\(e\)\s*\{[\s\S]*?\n        \}/);
    assert.ok(save, 'saveRingGroup must exist');
    const body = save[0];

    // Create and edit both submit the value held by the DestinationSelect.
    assert.match(body, /const postdest = document\.getElementById\('rgPostDestination'\)\.value\.trim\(\) \|\| 'app-blackhole,hangup,1';/);
    assert.doesNotMatch(body, /isEdit \? document\.getElementById\('rgPostDestination'\)/,
        'create mode must not ignore the selected destination');
    assert.doesNotMatch(body, /`ext-group,\$\{grpnum\},1`/,
        'create mode must not force the ring group itself as destination');
});

test('ring group create defaults to Terminate Call instead of a self-loop', () => {
    const open = view.match(/function openRingGroupModal\(\)\s*\{[\s\S]*?\n        \}/);
    assert.ok(open, 'openRingGroupModal must exist');
    assert.match(open[0], /const destVal = 'app-blackhole,hangup,1';/);
    assert.doesNotMatch(open[0], /ext-group,\$\{num\},1/,
        'the create modal must not preselect a self-referential destination');
});

test('changing the ring group number never overwrites the chosen destination', () => {
    assert.doesNotMatch(view, /rgPostDestCreateNoticeNum/,
        'the stale auto-destination notice must be gone');
    assert.doesNotMatch(view, /rgNumEl\.addEventListener\('input'/,
        'the group-number input must not reset rgPostDestination');
    assert.doesNotMatch(markup, /id="rgPostDestCreateNotice"/,
        'the misleading create-mode banner must be removed');
});

test('async list refresh keeps the destination selected by the user', () => {
    const open = view.match(/function openRingGroupModal\(\)\s*\{[\s\S]*?\n        \}/);
    const edit = view.match(/function editRingGroup\(grpnum\)\s*\{[\s\S]*?\n        \}/);
    assert.ok(open && edit, 'ring group modal functions must exist');
    for (const [name, body] of [['create', open[0]], ['edit', edit[0]]]) {
        assert.match(body, /setDialplan\(rgPostDestSelectInstance\.dialplanString \|\| destVal\)/,
            `${name} refresh must preserve the current DestinationSelect value`);
    }
});
