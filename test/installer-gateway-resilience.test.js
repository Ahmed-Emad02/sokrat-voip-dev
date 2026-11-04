const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

test('installers never copy the gateway helper onto itself', () => {
    for (const rel of ['install.sh', 'installer-bundle/install-sokrat.sh']) {
        const content = read(rel);
        assert.ok(content.includes('GATEWAY_HELPER_SRC'), `${rel} names the helper source`);
        assert.ok(
            content.includes('[ "$GATEWAY_HELPER_SRC" != "$LOCAL_GATEWAY_SCRIPT" ]'),
            `${rel} guards against a same-file install`
        );
    }
});

test('the optional Docker gateway cannot abort the install', () => {
    for (const rel of ['install.sh', 'installer-bundle/install-sokrat.sh']) {
        const content = read(rel);
        assert.ok(
            !content.includes('Docker is required for the local fallback gateway; install Docker and re-run'),
            `${rel} must not exit when Docker is missing`
        );
        assert.ok(
            content.includes('local fallback gateway skipped'),
            `${rel} warns and continues without the gateway`
        );
        assert.ok(
            content.includes('keeping the native push service'),
            `${rel} restores the native push service when the helper fails`
        );
    }
});

test('the local gateway helper checks the image before disabling native push', () => {
    const content = read('scripts/install-local-gateway.sh');
    const preflightAt = content.indexOf('GATEWAY_IMAGE_READY');
    const disableAt = content.indexOf('systemctl disable --now sokrat-push-gateway.service');
    assert.ok(preflightAt > 0, 'the image preflight exists');
    assert.ok(disableAt > 0, 'the native service is disabled by the helper');
    assert.ok(
        preflightAt < disableAt,
        'the helper must verify an image is available before taking push offline'
    );
});
