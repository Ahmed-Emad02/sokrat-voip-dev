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
