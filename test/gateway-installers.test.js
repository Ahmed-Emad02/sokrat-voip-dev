'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('legacy blanket wake overrides are migrated away on upgrade, once, with a backup', () => {
    const text = fs.readFileSync(path.join(root, 'scripts/sokrat-gateway-readiness.sh'), 'utf8');
    assert.match(text, /migrate_legacy_wake_contexts\(\)/);
    for (const context of ['macro-dial-one', 'sokrat-wake-dial', 'macro-dial', 'sokrat-wake-group', 'sub-sokrat-push-hook']) {
        assert.ok(text.includes("'" + context + "'"), context + ' must be stripped');
    }
    // Never delete routing without the replacement context to migrate towards.
    assert.match(text, /if '\[sub-sokrat-push-send\]' not in original:/);
    // Private, immutable backup before rewriting the dialplan.
    assert.match(text, /wake-v1-/);
    assert.match(text, /os\.O_EXCL \| os\.O_NOFOLLOW, 0o600/);
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
