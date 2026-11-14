'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('dongle receive conditioning preserves loud speech after quiet without disabling bounded answer protection', t => {
    const root = path.resolve(__dirname, '..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-rx-conditioning-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const executable = path.join(directory, 'rx-conditioning');
    const compiled = spawnSync(process.env.CC || 'cc', [
        '-std=c99', '-O2', '-Wall', '-Wextra', '-Werror',
        '-I', path.join(root, 'asterisk'),
        path.join(root, 'test', 'fixtures', 'dongle-rx-conditioning.c'),
        '-o', executable,
    ], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
    const checked = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.error?.message || checked.stderr);
});
