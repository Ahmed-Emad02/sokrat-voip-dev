'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cellular-opt-in-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = { ...process.env };
    delete env.SOKRAT_LIVE_TESTS;
    delete env.NODE_TEST_CONTEXT; // child is a standalone TAP run, not a V8 worker stream
    return { dir, env };
}

test('normal Node test discovery skips cellular tests before executing any command', t => {
    const { dir, env } = fixture(t);
    const attempted = path.join(dir, 'attempted');
    const preload = path.join(dir, 'no-commands.cjs');
    fs.writeFileSync(preload, `const cp = require('node:child_process');
const fs = require('node:fs');
for (const method of ['exec','execSync','execFile','execFileSync','spawn','spawnSync']) {
  cp[method] = () => { fs.writeFileSync(${JSON.stringify(attempted)}, method); throw new Error('blocked cellular subprocess'); };
}
`);
    // Run node:test in-process so the preload guards commands inside the suite,
    // not the test runner's own worker startup. Even a broken gate cannot dial.
    const result = spawnSync(process.execPath, ['--require', preload,
        path.join(root, 'test/cross-dongle-call-scenarios.test.js')], {
        encoding: 'utf8', env, timeout: 5000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(attempted), false, 'cellular suite attempted a subprocess without authorization');
    assert.match(result.stdout, /# skipped 6\b/);
});

test('standalone cellular harness refuses before invoking Asterisk without opt-in', t => {
    const { dir, env } = fixture(t);
    const attempted = path.join(dir, 'attempted');
    fs.writeFileSync(path.join(dir, 'asterisk'), '#!/bin/sh\nprintf called > "$ATTEMPTED"\nexit 1\n', { mode: 0o755 });
    const result = spawnSync('bash', [path.join(root, 'scripts/test-cross-dongle-scenarios.sh')], {
        encoding: 'utf8', timeout: 5000,
        env: { ...env, PATH: `${dir}:${process.env.PATH}`, ATTEMPTED: attempted },
    });
    assert.equal(result.status, 2);
    assert.equal(fs.existsSync(attempted), false, 'live harness invoked Asterisk without explicit opt-in');
});
