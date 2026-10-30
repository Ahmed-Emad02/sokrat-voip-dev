'use strict';

/**
 * Tenant gateway readiness (scripts/sokrat-gateway-readiness.sh).
 *
 * The tenant gateway admits a device only when the PBX can be reached and can
 * wake it. The readiness script prepares that contract on install and on every
 * upgrade, so it must be:
 *
 *   * idempotent  — running it twice never duplicates the shared push context,
 *   * additive    — it never rewrites an existing dialplan and never touches
 *                   [from-internal-custom], trunk macros or extension records,
 *   * verifiable  — it reports the endpoints the gateway will dial and writes a
 *                   valid readiness manifest with no secrets,
 *   * contained   — a sandboxed run must not touch /etc/asterisk at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'sokrat-gateway-readiness.sh');

function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-gateway-readiness-'));
    const dialplan = path.join(dir, 'extensions_sokrat.conf');
    const state = path.join(dir, 'state');
    fs.mkdirSync(state);
    // The script is run against temporary paths: a sandboxed run must never
    // be able to touch the real Asterisk configuration.
    const text = fs.readFileSync(SCRIPT, 'utf8')
        .replace(/^DIALPLAN_FILE=.*$/m, `DIALPLAN_FILE=${dialplan}`)
        .replace(/^STATE_DIR=.*$/m, `STATE_DIR=${state}`)
        // Endpoint availability belongs to the integration preflight. This
        // filesystem test must not depend on a real PBX or VPN on the runner.
        .replace(/^ts_ip=.*$/m, 'ts_ip="100.64.0.1"')
        .replace(/^ws_plain=.*$/m, 'ws_plain="yes"')
        .replace(/^ws_tls=.*$/m, 'ws_tls="yes"')
        .replace(/^api=.*$/m, 'api="yes"');
    const script = path.join(dir, 'readiness.sh');
    fs.writeFileSync(script, text, { mode: 0o755 });
    return { dir, dialplan, state, script };
}

function run(box, args = []) {
    return spawnSync('bash', [box.script, '--no-reload', ...args], { encoding: 'utf8' });
}

test('the readiness script is valid shell and stays inside its sandbox', () => {
    const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);

    const box = sandbox();
    const result = run(box, ['--apply']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync('/etc/asterisk/extensions_sokrat.conf.gateway-readiness-test'));
});

test('the shared tenant push context is created once and stays idempotent', () => {
    const box = sandbox();
    assert.equal(run(box, ['--apply']).status, 0);
    const first = fs.readFileSync(box.dialplan, 'utf8');
    assert.match(first, /^\[sub-sokrat-push-send\]$/m);
    assert.doesNotMatch(first, /^\[macro-dial(?:-one)?\]$/m);
    assert.match(first, /exten => s,1,Set\(TARGET_EXT=/);
    assert.match(first, /SOKRAT_CALLER_NUM=/);
    assert.match(first, /SOKRAT_CALLER_NAME=/);
    assert.match(first, /same => n\(done\),Return\(\)/);
    // The legacy local push dispatch stays, so both paths coexist.
    assert.match(first, /\/api\/push\/incoming-call\?callee=/);

    assert.equal(run(box, ['--apply']).status, 0);
    const second = fs.readFileSync(box.dialplan, 'utf8');
    assert.equal(second, first, 'a second run must not change the dialplan');
    assert.equal((second.match(/^\[sub-sokrat-push-send\]$/gm) || []).length, 1);
});

test('an existing context is preserved instead of being rewritten', () => {
    const box = sandbox();
    fs.writeFileSync(box.dialplan, [
        '; operator owned',
        '[sub-sokrat-push-send]',
        'exten => s,1,NoOp(custom)',
        ' same => n(done),Return()',
        '',
    ].join('\n'));
    const before = fs.readFileSync(box.dialplan, 'utf8');
    assert.equal(run(box, ['--apply']).status, 0);
    assert.equal(fs.readFileSync(box.dialplan, 'utf8'), before);
});

test('the readiness manifest is valid JSON and carries no secrets', () => {
    const box = sandbox();
    assert.equal(run(box, ['--apply']).status, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(box.state, 'pbx-gateway.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.pushContextPresent, true);
    assert.match(manifest.installationId, /^[0-9a-f-]{36}$/);
    assert.ok(Array.isArray(manifest.mediaIps));
    assert.ok(!JSON.stringify(manifest).match(/password|secret|token/i));

    // The installation id is stable across runs.
    assert.equal(run(box, ['--apply']).status, 0);
    const again = JSON.parse(fs.readFileSync(path.join(box.state, 'pbx-gateway.json'), 'utf8'));
    assert.equal(again.installationId, manifest.installationId);
});

test('check mode reports readiness and never writes', () => {
    const box = sandbox();
    const missing = run(box, ['--check']);
    assert.equal(missing.status, 1, 'a missing push context is not ready');
    assert.ok(!fs.existsSync(path.join(box.state, 'pbx-gateway.json')));

    assert.equal(run(box, ['--apply']).status, 0);
    const ready = run(box, ['--check']);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.match(ready.stdout, /READY/);
});

test('install and upgrade scripts run the readiness step', () => {
    for (const file of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.match(text, /sokrat-gateway-readiness\.sh/, `${file} must prepare gateway readiness`);
    }
    const upgrade = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'safe-upgrade.sh'), 'utf8');
    assert.match(upgrade, /sokrat-gateway-readiness\.sh" --apply --no-reload/);
});
