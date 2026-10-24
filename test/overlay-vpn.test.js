const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverJsPath = path.join(__dirname, '../server.js');
const sidebarPath = path.join(__dirname, '../views/sidebar.ejs');
const libPath = path.join(__dirname, '../lib/overlay-vpn.js');

const {
    PROVIDER_IDS,
    SERVICE_ACTIONS,
    parseZeroTierNetworks,
    parseTailscaleStatus,
    classifyTailscaleAuthKey,
    describeTailscaleJoinError,
    joinNetwork
} = require('../lib/overlay-vpn');

const serverSrc = fs.readFileSync(serverJsPath, 'utf8');
const sidebarSrc = fs.readFileSync(sidebarPath, 'utf8');

test('overlay VPN exposes exactly ZeroTier and Tailscale', () => {
    assert.deepEqual(PROVIDER_IDS.sort(), ['tailscale', 'zerotier']);
    assert.ok(SERVICE_ACTIONS.includes('start'));
    assert.ok(SERVICE_ACTIONS.includes('stop'));
    assert.ok(SERVICE_ACTIONS.includes('restart'));
    assert.ok(SERVICE_ACTIONS.includes('enable --now'));
});

test('ZeroTier network list is parsed', () => {
    const output = [
        '200 listnetworks <nwid> <name> <mac> <status> <type> <dev> <ZT assigned ips>',
        '200 listnetworks 08752e18b1faa61e drm 1e:d4:bb:0b:8b:ce OK PRIVATE ztcdcnjpvp 10.252.63.47/24',
        '200 listnetworks b103a835d2cd2996 kheerelsnas-upgrade 96:5b:8c:68:a6:48 OK PRIVATE ztqtiwkhce 10.200.227.47/24'
    ].join('\n');
    const networks = parseZeroTierNetworks(output);
    assert.equal(networks.length, 2);
    assert.equal(networks[0].id, '08752e18b1faa61e');
    assert.equal(networks[0].name, 'drm');
    assert.equal(networks[0].status, 'OK');
    assert.equal(networks[0].type, 'PRIVATE');
    assert.deepEqual(networks[0].ips, ['10.252.63.47/24']);
    assert.equal(networks[1].name, 'kheerelsnas-upgrade');
    assert.deepEqual(networks[1].ips, ['10.200.227.47/24']);
});

test('ZeroTier parser ignores noise and empty output', () => {
    assert.deepEqual(parseZeroTierNetworks(''), []);
    assert.deepEqual(parseZeroTierNetworks('some unrelated output\n200 listnetworks broken\n'), []);
});

test('Tailscale status json is parsed', () => {
    const json = JSON.stringify({
        Version: '1.102.4',
        BackendState: 'Running',
        TailscaleIPs: ['100.98.185.86', 'fd7a:115c:a1e0::7930:b957'],
        Self: { HostName: 'sokrat-demo' }
    });
    const parsed = parseTailscaleStatus(json);
    assert.equal(parsed.backendState, 'Running');
    assert.deepEqual(parsed.ips, ['100.98.185.86', 'fd7a:115c:a1e0::7930:b957']);
    assert.equal(parsed.hostName, 'sokrat-demo');
    assert.equal(parsed.version, '1.102.4');
    // a broken payload must not throw
    const broken = parseTailscaleStatus('not json');
    assert.equal(broken.backendState, 'unknown');
    assert.deepEqual(broken.ips, []);
});

test('the overlay API is root only and allow-listed', () => {
    assert.ok(serverSrc.includes("app.get('/api/system/overlay/status'"), 'status endpoint must exist');
    assert.ok(serverSrc.includes("app.post('/api/system/overlay/:provider/action'"), 'action endpoint must exist');
    assert.ok(serverSrc.includes("app.post('/api/system/overlay/:provider/join'"), 'join endpoint must exist');
    assert.ok(serverSrc.includes("app.post('/api/system/overlay/:provider/leave'"), 'leave endpoint must exist');

    // every overlay endpoint must be behind the root check
    const endpoints = serverSrc.split(/\n/).reduce((acc, line, idx, arr) => {
        if (/app\.(get|post)\('\/api\/system\/overlay/.test(line)) {
            acc.push(arr.slice(idx, idx + 6).join('\n'));
        }
        return acc;
    }, []);
    assert.ok(endpoints.length >= 4, 'all four overlay endpoints must be found');
    for (const block of endpoints) {
        assert.ok(block.includes('requireRootForOverlay'), 'each overlay endpoint must call requireRootForOverlay');
    }
    assert.ok(serverSrc.includes("if (!isSuperAdmin(req))"), 'requireRootForOverlay must reject non-root users');
    assert.ok(serverSrc.includes("!OVERLAY_PROVIDER_IDS.includes(provider)"), 'providers must be allow-listed');
});

test('the Tailscale auth key is never written to the logs', () => {
    assert.ok(serverSrc.includes("'authkey', 'auth_key'"), 'the auth key must be in the sensitive key set');
    assert.ok(fs.readFileSync(libPath, 'utf8').includes('--accept-routes=false'), 'the lib must keep the overlay off the default route');
});

test('the settings menu exposes the overlay VPN entry to root only', () => {
    assert.ok(sidebarSrc.includes('openOverlayVpnModal()'), 'the settings entry must open the modal');
    assert.ok(sidebarSrc.includes('id="overlayVpnModal"'), 'the modal must exist');
    // the entry must live inside the sidebar's root-only branch
    const rootBranch = sidebarSrc.indexOf('<% if (isRoot) { %>', sidebarSrc.indexOf('id="settingsMenu"'));
    const elseBranch = sidebarSrc.indexOf('<% } else { %>', rootBranch);
    const btnPos = sidebarSrc.indexOf('id="overlayVpnBtn"');
    assert.ok(rootBranch !== -1 && elseBranch !== -1, 'the sidebar must have a root-only settings branch');
    assert.ok(btnPos > rootBranch && btnPos < elseBranch, 'the overlay VPN entry must be inside the root-only branch');
    assert.ok(sidebarSrc.includes('/api/system/overlay/status'), 'the client must read the status endpoint');
    assert.ok(sidebarSrc.includes('/join'), 'the client must be able to join a network');
});

test('Tailscale credential types are classified before exec', () => {
    const authKey = 'tskey-auth-k123456CNTRL-abcdefghijklmnopqrstuvwxyz';
    const accepted = classifyTailscaleAuthKey(authKey);
    assert.equal(accepted.valid, true);
    assert.equal(accepted.kind, 'auth-key');

    const apiToken = classifyTailscaleAuthKey('tskey-api-k123456CNTRL-abcdefghijklmnopqrstuvwxyz');
    assert.equal(apiToken.valid, false);
    assert.equal(apiToken.kind, 'api-token');
    assert.match(apiToken.error, /API access token/);
    assert.match(apiToken.error, /tskey-auth-/);

    const clientSecret = classifyTailscaleAuthKey('tskey-client-k123456CNTRL-abcdefghijklmnopqrstuvwxyz');
    assert.equal(clientSecret.valid, false);
    assert.equal(clientSecret.kind, 'client-secret');

    assert.equal(classifyTailscaleAuthKey('').kind, 'empty');
    assert.equal(classifyTailscaleAuthKey('hello').kind, 'unknown');
    assert.equal(classifyTailscaleAuthKey('tskey-auth-short').kind, 'malformed');
    assert.equal(classifyTailscaleAuthKey('tskey-auth-k123456CNTRL-abc def').kind, 'malformed');
});

test('Tailscale join errors are mapped to actionable messages', () => {
    const invalid = describeTailscaleJoinError({ stderr: 'invalid key: unable to validate API key\n' });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.message, /node auth key/);
    assert.match(invalid.message, /tskey-auth-/);

    assert.match(describeTailscaleJoinError({ stderr: 'auth key expired' }).message, /expired/);
    assert.match(describeTailscaleJoinError({ stderr: 'key revoked by admin' }).message, /revoked/);
    assert.match(describeTailscaleJoinError({ stderr: 'authkey already used' }).message, /single-use/);
    assert.equal(describeTailscaleJoinError({ stderr: 'failed to connect to local tailscaled' }).statusCode, 503);
    assert.equal(describeTailscaleJoinError({ stderr: 'permission denied' }).statusCode, 403);
});

test('joinNetwork refuses an API token without running tailscale', async () => {
    let called = false;
    await assert.rejects(
        joinNetwork('tailscale', { authKey: 'tskey-api-k123456CNTRL-abcdefghijklmnopqrstuvwxyz' }, async () => {
            called = true;
        }),
        (error) => {
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /API access token/);
            return true;
        }
    );
    assert.equal(called, false, 'tailscale must not be executed for a rejected credential');
});

test('joinNetwork maps tailscaled invalid-key stderr to HTTP 400 and redacts the key', async () => {
    const authKey = 'tskey-auth-k123456CNTRL-abcdefghijklmnopqrstuvwxyz';
    const fakeExec = async () => {
        const error = new Error('Command failed: tailscale up');
        error.stderr = `invalid key: unable to validate API key (${authKey})\n`;
        throw error;
    };
    await assert.rejects(joinNetwork('tailscale', { authKey }, fakeExec), (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /node auth key/);
        assert.ok(!error.message.includes(authKey), 'the auth key must not leak into the message');
        assert.ok(!String(error.detail).includes(authKey), 'the auth key must not leak into the detail');
        return true;
    });
});

test('joinNetwork passes a valid auth key with accept-routes disabled', async () => {
    const authKey = 'tskey-auth-k123456CNTRL-abcdefghijklmnopqrstuvwxyz';
    let seen = null;
    const fakeExec = async (file, args) => {
        seen = { file, args };
        return { stdout: 'Success.\n', stderr: '' };
    };
    const result = await joinNetwork('tailscale', { authKey }, fakeExec);
    assert.equal(seen.file, 'tailscale');
    assert.deepEqual(seen.args, ['up', `--authkey=${authKey}`, '--accept-routes=false']);
    assert.match(result.message, /Tailscale is up/);
});

test('the join route honors the mapped status code and logs the detail', () => {
    const joinRoute = serverSrc.slice(
        serverSrc.indexOf("app.post('/api/system/overlay/:provider/join'"),
        serverSrc.indexOf("app.post('/api/system/overlay/:provider/leave'")
    );
    assert.ok(joinRoute.includes('Number(error.statusCode) || 500'), 'the route must use the mapped status code');
    assert.ok(joinRoute.includes('console.error'), 'the route must log the failure detail');
    assert.ok(joinRoute.includes('error.detail'), 'the route must log the sanitized tailscaled detail');
});

test('the join UI rejects API tokens before calling the API', () => {
    assert.ok(sidebarSrc.includes('tskey-api-'), 'the client must detect API access tokens');
    assert.ok(sidebarSrc.includes('tskey-client-'), 'the client must detect OAuth client secrets');
    assert.ok(sidebarSrc.includes('tskey-auth-'), 'the client must require a node auth key');
    assert.ok(sidebarSrc.includes('Tailscale Admin'), 'the client must point at the admin console');
});
