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
    parseTailscaleStatus
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
