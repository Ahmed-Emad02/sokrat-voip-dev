'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('ring groups accept empty and mixed extension lists without injecting defaults', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const create = server.match(/app\.post\('\/api\/config\/ringgroups',[\s\S]*?\n\}\);/);
    assert.ok(create, 'ring group create endpoint must exist');
    const body = create[0];
    assert.doesNotMatch(body, /Extension List is required/);
    assert.match(body, /String\(grplist \|\| ''\)/);
    assert.doesNotMatch(body, /grplist.*\|\|.*['"]101['"]/, 'must not inject a hardcoded member');
    assert.match(body, /reloadPbxConfigPromise\(\)/);
    const ui = fs.readFileSync(path.join(root, 'views/scripts/config-page.ejs'), 'utf8');
    assert.doesNotMatch(ui, /Please enter or select at least one Extension/);
    const markup = fs.readFileSync(path.join(root, 'views/config.ejs'), 'utf8');
    assert.match(markup, /Numbers \(comma-separated, optional\)/);
});
