'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('all PBX installation paths ship additive reverse-TLS dependencies', () => {
    for (const name of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const file = path.join(root, name);
        const text = fs.readFileSync(file, 'utf8');
        assert.equal(spawnSync('bash', ['-n', file]).status, 0, name);
        assert.match(text, /scripts\/install-gateway-media-deps\.sh/);
        assert.match(text, /SOKRAT_PBX_BRANCH/);
    }
    for (const name of ['lib/gateway-tunnel.js', 'scripts/install-media-link.py',
        'scripts/tunnel_media.py', 'scripts/tunnel_media_material.py',
        'scripts/install-tenant-push-hook.py', 'scripts/pbx-tenant-push-hook.py']) {
        assert.equal(fs.existsSync(path.join(root, name)), true, name);
    }
});
test('top-level installer defines SCRIPT_DIR before any bundled asset lookup', () => {
    const text = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
    const definition = text.search(/^SCRIPT_DIR=.*$/m);
    const firstUse = text.indexOf('$SCRIPT_DIR');
    assert.ok(definition >= 0, 'SCRIPT_DIR must be defined');
    assert.ok(firstUse > definition, 'SCRIPT_DIR must be defined before it is used');
});

test('safe upgrade preserves the selected branch, credentials and dirty operator work', () => {
    const text = fs.readFileSync(path.join(root, 'scripts/safe-upgrade.sh'), 'utf8');
    assert.match(text, /git fetch origin "\$REPO_BRANCH"/);
    assert.match(text, /git merge --ff-only "origin\/\$REPO_BRANCH"/);
    assert.doesNotMatch(text, /git fetch origin main|git pull --ff-only origin main/);
    assert.ok(text.indexOf('Upgrade refused: preserve/review') < text.indexOf('detect_mysql_auth()'));
    assert.match(text, /for directory in \/etc\/sokrat \/etc\/frp/);
    assert.match(text, /install -d -m 0700 "\$GATEWAY_BACKUP"/);
    assert.match(text, /umask 077; tar/);
});

test('an unreachable remote keeps the local upgrade going; a refused fast-forward stays fatal', () => {
    const text = fs.readFileSync(path.join(root, 'scripts/safe-upgrade.sh'), 'utf8');
    // Air-gapped / offline-bundle PBXs must still get schema, driver and
    // dialplan work done instead of aborting at the fetch.
    assert.match(text, /else\n\s*CODE_UPDATED=0/);
    assert.match(text, /continuing with the on-disk codebase/);
    assert.match(text, /code was NOT updated - schema, driver and dialplan steps still run/);
    // A reachable remote that refuses the fast-forward is still a hard stop.
    assert.match(text, /git merge --ff-only "origin\/\$REPO_BRANCH" \|\| \{ echo 'PBX fast-forward refused; no working changes discarded' >&2; exit 1; \}/);
    assert.doesNotMatch(text, /git fetch origin "\$REPO_BRANCH" >\/dev\/null 2>&1 \|\| \{ echo 'PBX fetch failed; upgrade stopped before migrations' >&2; exit 1; \}/);
});

test('the dashboard pairs with a secure pairing code instead of the legacy token form', () => {
    const sidebar = fs.readFileSync(path.join(root, 'views/sidebar.ejs'), 'utf8');
    // The one-shot pairing field must exist and the dead legacy inputs must not.
    assert.match(sidebar, /id="gwPairingCode"/);
    assert.match(sidebar, /sk_pair_v2_/);
    for (const legacy of ['gwServerAddr', 'gwServerPort', 'gwRemoteWsPort', 'gwRemoteApiPort', 'gwToken']) {
        assert.doesNotMatch(sidebar, new RegExp('id="' + legacy + '"'), legacy + ' must be gone');
    }
    // Only the signed pairing code is posted; the server validates the identity.
    assert.match(sidebar, /const payload = \{ action: 'connect', token: pairingCode \}/);
    const tunnel = fs.readFileSync(path.join(root, 'lib/gateway-tunnel.js'), 'utf8');
    assert.match(tunnel, /if \(requested && requested !== code\.host\)/);
});

test('legacy migration is guarded and refuses ambiguity before readiness continues', () => {
    const text = fs.readFileSync(path.join(root, 'scripts/sokrat-gateway-readiness.sh'), 'utf8');
    assert.match(text, /migrate_legacy_wake_contexts\(\)/);
    for (const context of ['macro-dial-one', 'sokrat-wake-dial', 'macro-dial', 'sokrat-wake-group', 'sub-sokrat-push-hook']) {
        assert.ok(text.includes("'" + context + "'"), context + ' must be recognized');
    }
    // Never delete routing without the replacement context to migrate towards.
    assert.match(text, /names\.count\('sub-sokrat-push-send'\) != 1/);
    assert.match(text, /if ! migrate_legacy_wake_contexts; then[\s\S]*?exit 1/);
    // Private, immutable backup before rewriting the dialplan.
    assert.match(text, /wake-v1-/);
    assert.match(text, /os\.O_EXCL \| os\.O_NOFOLLOW, 0o600/);
});

const legacyWake = fs.readFileSync(path.join(root, 'test/fixtures/legacy-wake-v1.conf'), 'utf8');
const legacyStart = legacyWake.indexOf('[macro-dial-one]');
const legacyEnd = legacyWake.indexOf('[sub-sokrat-push-send]');
const legacyBody = legacyWake.slice(legacyStart, legacyEnd);

// Execute only the real migration function: never run a PBX installer or touch
// /etc, service state, network listeners or Asterisk from these regressions.
function withMigration(original, run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-wake-migration-'));
    const file = path.join(directory, 'extensions_sokrat.conf');
    const backups = path.join(directory, 'backups');
    fs.writeFileSync(file, original, { mode: 0o640 });
    const source = fs.readFileSync(path.join(root, 'scripts/sokrat-gateway-readiness.sh'), 'utf8');
    const start = source.indexOf('migrate_legacy_wake_contexts() {');
    const end = source.indexOf('\n}\n', start) + 2;
    assert.ok(start > 0 && end > start);
    const script = 'set -e\nchanged=0\nDIALPLAN_FILE="$1"\nBACKUP_DIR="$2"\n' + source.slice(start, end) + '\nmigrate_legacy_wake_contexts\nprintf "changed=%s\\n" "$changed"\n';
    const migrate = () => spawnSync('bash', ['-c', script, 'migration-test', file, backups], { encoding: 'utf8' });
    const backupFiles = () => fs.existsSync(backups) ? fs.readdirSync(backups) : [];
    try { run({ migrate, backupFiles, file, backups }); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

for (const newline of ['\n', '\r\n']) {
    test('exact historical v1 migration preserves all retained bytes and is idempotent (' + JSON.stringify(newline) + ')', () => {
        const prefix = '; operator preamble\n[operator-template](!) ; template\nexten => s,1,Return()\n';
        const suffix = '[operator-feature](+) ; add priorities\nexten => s,1,NoOp(KEEP)\n[inherited](operator-template) ; inherit\nexten => s,1,Return()';
        const original = (prefix + legacyWake + suffix).replace(/\n/g, newline);
        const expected = (prefix + legacyWake.replace(legacyBody, '') + suffix).replace(/\n/g, newline);
        withMigration(original, ({ migrate, backupFiles, file, backups }) => {
            const before = fs.statSync(file);
            const first = migrate();
            assert.equal(first.status, 0, first.stderr);
            assert.match(first.stdout, /Removed legacy blanket wake overrides/);
            assert.match(first.stdout, /changed=1/);
            assert.equal(fs.readFileSync(file, 'utf8'), expected);
            const after = fs.statSync(file);
            assert.equal(after.mode & 0o777, before.mode & 0o777);
            assert.equal(after.uid, before.uid);
            assert.equal(after.gid, before.gid);
            assert.equal(backupFiles().length, 1);
            const backup = path.join(backups, backupFiles()[0]);
            assert.equal(fs.readFileSync(backup, 'utf8'), original);
            assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
            assert.equal(fs.statSync(backups).mode & 0o777, 0o700);
            const second = migrate();
            assert.equal(second.status, 0);
            assert.match(second.stdout, /changed=0/);
            assert.equal(fs.readFileSync(file, 'utf8'), expected);
            assert.equal(fs.statSync(file).ino, after.ino, 'idempotent run must not rewrite');
            assert.equal(backupFiles().length, 1);
        });
    });
}

test('operator-owned macro names and header options are not proof of legacy ownership', () => {
    const original = '; Operator fixture\n[macro-dial-one]\nexten => s,1,NoOp(OPERATOR_OWNED_ROUTE)\n[sub-sokrat-push-send]\nexten => s,1,Return()\n[operator-feature](+) ; keep\nexten => s,1,Return()';
    withMigration(original, ({ migrate, backupFiles, file }) => {
        assert.equal(migrate().status, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), original);
        assert.deepEqual(backupFiles(), []);
    });
});

for (const [name, original] of [
    ['custom macro body', legacyWake.replace('exten => s,1,Gosub(sokrat-wake-dial,s,1(${ARG3}))', 'exten => s,1,NoOp(OPERATOR_OWNED_ROUTE)')],
    ['custom header suffix', legacyWake.replace('[macro-dial]', '[macro-dial](+) ; operator')],
    ['missing helper', legacyWake.replace('[sokrat-wake-dial]', '[operator-helper]')],
    ['missing sender', legacyWake.slice(0, legacyEnd)],
    ['comment mentioning sender is not a context', legacyWake.slice(0, legacyEnd) + '; [sub-sokrat-push-send]\n'],
    ['duplicate macro', legacyWake + '[macro-dial-one]\nexten => s,1,Return()\n'],
    ['duplicate macro with header whitespace', legacyWake + '[macro-dial-one ]\nexten => s,1,Return()\n'],
    ['template sender is not a replacement context', legacyWake.replace('[sub-sokrat-push-send]', '[sub-sokrat-push-send](!)')],
    ['duplicate sender', legacyWake + '[sub-sokrat-push-send](+)\nexten => s,1,Return()\n'],
    ['unrelated context inserted', legacyWake.replace('[sokrat-wake-group]', '[operator-feature](+)\nexten => s,1,Return()\n[sokrat-wake-group]')],
]) {
    test('ambiguous v1 migration refuses without modification or backup: ' + name, () => {
        withMigration(original, ({ migrate, backupFiles, file }) => {
            const result = migrate();
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Legacy wake migration refused/);
            assert.equal(fs.readFileSync(file, 'utf8'), original);
            assert.deepEqual(backupFiles(), []);
        });
    });
}

test('exact-looking contexts without the historical ownership marker are left alone', () => {
    const original = legacyWake.slice(legacyStart);
    withMigration(original, ({ migrate, backupFiles, file }) => {
        assert.equal(migrate().status, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), original);
        assert.deepEqual(backupFiles(), []);
    });
});

test('apply-config is not blocked by an optional wake-compiler refusal', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const start = server.indexOf('function reloadPbxConfig(callback)');
    assert.ok(start > 0);
    const body = server.slice(start, server.indexOf('function reloadPbxConfigPromise', start));
    // The wake compiler is attempted, but its failure is a warning only.
    assert.match(body, /wakeWarning = 'WebRTC wake routes were not recompiled/);
    assert.match(body, /callback\(wakeWarning \? \{ success: true, warning: wakeWarning \} : \{ success: true \}\)/);
    assert.doesNotMatch(body, /success: false, error: 'WebRTC wake route configuration requires operator review'/);
});
