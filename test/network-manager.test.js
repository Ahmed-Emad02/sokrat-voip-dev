const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
    EDITABLE_TYPES,
    METHODS,
    parseReport,
    parseConnectionList,
    parseProfile,
    parseDhcpInfo,
    parseDefaultRoutes,
    isValidIPv4,
    isValidPrefix,
    validateProfile,
    listConnections,
    configureConnection,
    snapshotConnection,
    applyProfile
} = require('../lib/network-manager');

const REPO = path.join(__dirname, '..');

/**
 * A fake exec that answers nmcli / ip calls from a script.
 */
function fakeExec(handlers) {
    const calls = [];
    const exec = async (file, args) => {
        calls.push({ file, args });
        const key = args.join(' ');
        for (const [pattern, answer] of Object.entries(handlers)) {
            if (key.includes(pattern)) {
                if (typeof answer === 'function') return { stdout: answer(args), stderr: '' };
                return { stdout: answer, stderr: '' };
            }
        }
        return { stdout: '', stderr: '' };
    };
    exec.calls = calls;
    return exec;
}

const CON_LIST = [
    '11111111-1111-1111-1111-1111111111:802-3-ethernet:enp7s0:activated:yes',
    '22222222-2222-2222-2222-2222222222:802-3-ethernet:enp1s0:activated:yes',
    '33333333-3333-3333-3333-3333333333:tun:tailscale0:activated:yes',
    '44444444-4444-4444-4444-4444444444:bridge:docker0:activated:yes'
].join('\n');

test('the nmcli report parser keeps the values', () => {
    const report = parseReport([
        'ipv4.method:                            manual',
        'ipv4.addresses:                         192.168.100.50/24',
        'ipv4.gateway:                           192.168.100.1',
        'ipv4.dns:                               8.8.8.8,1.1.1.1'
    ].join('\n'));
    assert.equal(report['ipv4.method'], 'manual');
    assert.equal(report['ipv4.addresses'], '192.168.100.50/24');
    assert.equal(report['ipv4.gateway'], '192.168.100.1');
    assert.equal(report['ipv4.dns'], '8.8.8.8,1.1.1.1');
});

test('the connection list parser reads the nmcli columns', () => {
    const connections = parseConnectionList(CON_LIST);
    assert.equal(connections.length, 4);
    assert.equal(connections[0].uuid, '11111111-1111-1111-1111-1111111111');
    assert.equal(connections[0].type, '802-3-ethernet');
    assert.equal(connections[0].device, 'enp7s0');
    assert.equal(connections[0].active, true);
    assert.equal(connections[2].type, 'tun');
});

test('the profile parser separates the addresses, the gateway and the DNS', () => {
    const profile = parseProfile({
        'ipv4.method': 'manual',
        'ipv4.addresses': '192.168.100.50/24',
        'ipv4.gateway': '192.168.100.1',
        'ipv4.dns': '8.8.8.8,1.1.1.1'
    });
    assert.equal(profile.method, 'manual');
    assert.deepEqual(profile.addresses, ['192.168.100.50/24']);
    assert.equal(profile.gateway, '192.168.100.1');
    assert.deepEqual(profile.dns, ['8.8.8.8', '1.1.1.1']);
});

test('the DHCP parser reads the lease, the server and the expiry', () => {
    const dhcp = parseDhcpInfo({
        'DHCP4.OPTION[1]': 'dhcp_server_identifier = 192.168.122.1',
        'DHCP4.OPTION[2]': 'dhcp_lease_time = 3600',
        'DHCP4.OPTION[3]': 'expiry = 1792675754',
        'DHCP4.OPTION[4]': 'broadcast_address = 192.168.122.255'
    });
    assert.equal(dhcp.server, '192.168.122.1');
    assert.equal(dhcp.leaseTime, 3600);
    assert.equal(dhcp.expiresAt, 1792675754);
});

test('the default route parser finds the management interface', () => {
    const routes = parseDefaultRoutes([
        'default via 192.168.122.1 dev enp1s0 proto dhcp src 192.168.122.167 metric 100',
        'default via 192.168.100.1 dev enp7s0 proto static metric 101'
    ].join('\n'));
    assert.equal(routes.length, 2);
    assert.equal(routes[0].device, 'enp1s0');
    assert.equal(routes[0].metric, 100);
});

test('only the physical interfaces are editable', () => {
    assert.ok(EDITABLE_TYPES.includes('802-3-ethernet'));
    assert.ok(EDITABLE_TYPES.includes('802-11-wireless'));
    assert.ok(!EDITABLE_TYPES.includes('tun'));
    assert.ok(!EDITABLE_TYPES.includes('bridge'));
    assert.ok(!EDITABLE_TYPES.includes('vlan'));
});

test('the interface list marks the tun and bridge connections as read only', async () => {
    const exec = fakeExec({
        '-f UUID,TYPE,DEVICE,STATE,ACTIVE con show': CON_LIST,
        'route show default': 'default via 192.168.100.1 dev enp7s0 proto static metric 101',
        'con show 11111111-1111-1111-1111-1111111111': [
            'connection.type:                          802-3-ethernet',
            'connection.interface-name:                enp7s0',
            'ipv4.method:                              manual',
            'ipv4.addresses:                           192.168.100.50/24',
            'ipv4.gateway:                             192.168.100.1',
            'ipv4.dns:                                 --',
            'ipv4.route-metric:                        -1',
            'connection.autoconnect:                   yes'
        ].join('\n'),
        'con show 22222222-2222-2222-2222-2222222222': [
            'connection.type:                          802-3-ethernet',
            'connection.interface-name:                enp1s0',
            'ipv4.method:                              auto',
            'ipv4.addresses:                           --',
            'ipv4.gateway:                             --',
            'ipv4.dns:                                 --',
            'ipv4.route-metric:                        -1',
            'connection.autoconnect:                   yes'
        ].join('\n')
    });

    const connections = await listConnections({ exec });
    const lan = connections.find((c) => c.device === 'enp7s0');
    const wan = connections.find((c) => c.device === 'enp1s0');
    const vpn = connections.find((c) => c.device === 'tailscale0');
    const docker = connections.find((c) => c.device === 'docker0');

    assert.equal(lan.editable, true);
    assert.equal(lan.method, 'manual');
    assert.equal(lan.addresses[0], '192.168.100.50/24');
    assert.equal(lan.protected, true, 'the interface with the default route is protected');
    assert.equal(wan.method, 'auto');
    assert.equal(wan.protected, false);
    assert.equal(vpn.editable, false, 'the overlay VPN tunnel is never editable');
    assert.equal(docker.editable, false, 'docker bridges are never editable');
});

test('a DHCP interface shows the address it leased', async () => {
    const exec = fakeExec({
        '-f UUID,TYPE,DEVICE,STATE,ACTIVE con show': CON_LIST,
        'route show default': 'default via 192.168.100.1 dev enp7s0 proto static metric 101',
        'con show 22222222-2222-2222-2222-2222222222': [
            'connection.type:                          802-3-ethernet',
            'connection.interface-name:                enp1s0',
            'ipv4.method:                              auto',
            'ipv4.addresses:                           --',
            'ipv4.gateway:                             --',
            'ipv4.dns:                                 --',
            'ipv4.route-metric:                        -1',
            'connection.autoconnect:                   yes'
        ].join('\n'),
        'dev show enp1s0': [
            'GENERAL.STATE:                            100 (connected)',
            'IP4.ADDRESS[1]:                           192.168.122.167/24',
            'IP4.GATEWAY:                               192.168.122.1',
            'IP4.DNS[1]:                                192.168.122.1',
            'DHCP4.OPTION[1]:                           dhcp_server_identifier = 192.168.122.1',
            'DHCP4.OPTION[2]:                           dhcp_lease_time = 3600'
        ].join('\n')
    });

    const connections = await listConnections({ exec });
    const wan = connections.find((c) => c.device === 'enp1s0');
    assert.equal(wan.method, 'auto');
    assert.deepEqual(wan.addresses, ['192.168.122.167/24'], 'the leased address is shown');
    assert.equal(wan.gateway, '192.168.122.1');
    assert.deepEqual(wan.dns, ['192.168.122.1']);
    assert.ok(wan.dhcp, 'the lease information is there');
    assert.equal(wan.dhcp.leaseTime, 3600);
});

test('the interface that carries the admin session is protected as well', async () => {
    const exec = fakeExec({
        '-f UUID,TYPE,DEVICE,STATE,ACTIVE con show': CON_LIST,
        'route show default': '',
        'con show 11111111-1111-1111-1111-1111111111': [
            'connection.type:                          802-3-ethernet',
            'connection.interface-name:                enp7s0',
            'ipv4.method:                              manual',
            'ipv4.addresses:                           192.168.100.50/24',
            'ipv4.gateway:                             192.168.100.1',
            'ipv4.dns:                                 --',
            'ipv4.route-metric:                        -1',
            'connection.autoconnect:                   yes'
        ].join('\n')
    });

    const withoutSession = await listConnections({ exec });
    assert.equal(withoutSession.find((c) => c.device === 'enp7s0').protected, false);

    const withSession = await listConnections({ exec, localAddress: '192.168.100.50' });
    assert.equal(withSession.find((c) => c.device === 'enp7s0').protected, true,
        'the interface the request came in on is protected');
});

test('the profile validation rejects the broken values', () => {
    assert.equal(isValidIPv4('192.168.100.50'), true);
    assert.equal(isValidIPv4('192.168.100.999'), false);
    assert.equal(isValidIPv4('192.168.100'), false);
    assert.equal(isValidPrefix(24), true);
    assert.equal(isValidPrefix(33), false);

    assert.ok(validateProfile({ method: 'nope' }).length, 'an unknown method is rejected');
    assert.ok(validateProfile({ method: 'manual' }).length, 'a manual profile needs an address');
    assert.ok(validateProfile({ method: 'manual', address: '10.0.0.1' }).length,
        'a manual profile needs a prefix');
    assert.ok(validateProfile({ method: 'manual', address: '10.0.0.1', prefix: 24, dns: ['nope'] }).length,
        'a broken DNS server is rejected');
    assert.equal(validateProfile({ method: 'manual', address: '10.0.0.1', prefix: 24, gateway: '10.0.0.254' }).length,
        0, 'a gateway inside the subnet is accepted');
});

test('the profile validation warns when the gateway is outside the subnet', () => {
    const errors = validateProfile({
        method: 'manual', address: '192.168.100.50', prefix: 24, gateway: '10.0.0.1'
    });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].startsWith('WARNING'));
});

test('a DHCP profile is written without any static value', async () => {
    const exec = fakeExec({});
    await applyProfile('uuid-1', { method: 'auto' }, exec);
    const args = exec.calls[0].args;
    assert.deepEqual(args.slice(0, 3), ['con', 'mod', 'uuid-1']);
    assert.ok(args.includes('ipv4.method'));
    assert.ok(args.includes('auto'));
    assert.ok(args.includes('ipv4.addresses'), 'the old static address is cleared');
    assert.ok(args.includes('ipv4.gateway'), 'the old gateway is cleared');
});

test('a static profile is written with the address, the prefix, the gateway and the DNS', async () => {
    const exec = fakeExec({});
    await applyProfile('uuid-2', {
        method: 'manual', address: '192.168.100.50', prefix: 24, gateway: '192.168.100.1', dns: ['8.8.8.8']
    }, exec);
    const args = exec.calls[0].args;
    assert.ok(args.includes('manual'));
    assert.ok(args.includes('192.168.100.50/24'));
    assert.ok(args.includes('192.168.100.1'));
    assert.ok(args.includes('8.8.8.8'));
});

test('a change that comes back without an address is rolled back', async () => {
    let upCount = 0;
    const exec = fakeExec({
        'con show': [
            'ipv4.method:                              manual',
            'ipv4.addresses:                           192.168.100.50/24',
            'ipv4.gateway:                             192.168.100.1',
            'ipv4.dns:                                 --'
        ].join('\n'),
        'connection.interface-name': 'enp7s0',
        'dev show': (args) => {
            // The interface never comes back with an address.
            return '100 (connected):';
        },
        'con up': () => {
            upCount++;
            return '';
        }
    });

    const result = await configureConnection('uuid-3', {
        method: 'manual', address: '10.0.0.5', prefix: 24, gateway: '10.0.0.1'
    }, { exec, timeoutMs: 50, pollMs: 5 });

    assert.equal(result.applied, false);
    assert.equal(result.rolledBack, true, 'the previous profile is restored');
    assert.ok(result.error, 'the caller is told what happened');
    assert.ok(upCount >= 2, 'the connection was activated twice: the change and the rollback');
    const lastMod = exec.calls.filter((c) => c.args[1] === 'mod').pop();
    assert.ok(lastMod.args.includes('192.168.100.50/24'), 'the old address is written back');
});

test('a change that comes back with an address is applied', async () => {
    const exec = fakeExec({
        'con show': [
            'ipv4.method:                              auto',
            'ipv4.addresses:                           --',
            'ipv4.gateway:                             --',
            'ipv4.dns:                                 --'
        ].join('\n'),
        'connection.interface-name': 'enp1s0',
        'dev show': '100 (connected):192.168.122.167/24'
    });

    const result = await configureConnection('uuid-4', {
        method: 'manual', address: '192.168.122.30', prefix: 24, gateway: '192.168.122.1'
    }, { exec, timeoutMs: 500, pollMs: 5 });

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
});

test('an invalid profile never reaches nmcli', async () => {
    const exec = fakeExec({});
    await assert.rejects(
        () => configureConnection('uuid-5', { method: 'manual', address: 'not-an-ip' }, { exec }),
        /not valid/i
    );
    assert.equal(exec.calls.length, 0, 'nothing was executed');
});

test('the snapshot keeps the profile of the connection', async () => {
    const exec = fakeExec({
        'con show': [
            'ipv4.method:                              manual',
            'ipv4.addresses:                           192.168.100.50/24',
            'ipv4.gateway:                             192.168.100.1',
            'ipv4.dns:                                 8.8.8.8'
        ].join('\n')
    });
    const snapshot = await snapshotConnection('uuid-6', exec);
    assert.equal(snapshot.method, 'manual');
    assert.deepEqual(snapshot.addresses, ['192.168.100.50/24']);
    assert.equal(snapshot.gateway, '192.168.100.1');
    assert.deepEqual(snapshot.dns, ['8.8.8.8']);
});

test('the methods are limited to DHCP, static and disabled', () => {
    assert.deepEqual(METHODS, ['auto', 'manual', 'disabled']);
});

test('the API is root only and the network manager is wired to it', () => {
    const serverCode = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    assert.ok(serverCode.includes("require('./lib/network-manager')"), 'the module is imported');
    assert.ok(serverCode.includes("app.get('/api/system/network/connections'"), 'the list endpoint exists');
    assert.ok(serverCode.includes("/api/system/network/connection/:uuid/configure"), 'the configure endpoint exists');
    assert.ok(serverCode.includes("/api/system/network/connection/:uuid/rollback"), 'the rollback endpoint exists');
    assert.ok(serverCode.includes('function requireRootForNetwork'), 'the endpoints are root gated');
});

test('the VPN modal has the network tab', () => {
    const sidebar = fs.readFileSync(path.join(REPO, 'views/sidebar.ejs'), 'utf8');
    assert.ok(sidebar.includes('id="overlayVpnTabs"'), 'the tab bar exists');
    assert.ok(sidebar.includes('id="networkManagerPanel"'), 'the network panel exists');
    assert.ok(sidebar.includes('switchOverlayVpnTab'), 'the tab switcher exists');
    assert.ok(sidebar.includes('/api/system/network/connections'), 'the panel reads the API');
});

test('the network cards use the same visual language', () => {
    const sidebar = fs.readFileSync(path.join(REPO, 'views/sidebar.ejs'), 'utf8');
    // One badge helper for every pill, so the method and the state look the same.
    assert.ok(sidebar.includes('function networkManagerBadge('), 'one badge helper');
    assert.ok(sidebar.includes('function networkManagerMethodBadge('), 'the method badge uses it');
    assert.ok(sidebar.includes('function networkManagerStateBadge('), 'the state badge uses it');
    // The DHCP / static toggle is painted by one function, so the active and
    // the inactive button always carry the same classes.
    assert.ok(sidebar.includes('netMethodBtn'), 'the toggle buttons share a class');
    assert.ok(sidebar.includes("classList.toggle('hover:text-[var(--text-primary)]', !active)"),
        'the inactive toggle button keeps the hover style');
    // Every card has the same order: header, address, form, actions.
    const card = sidebar.slice(sidebar.indexOf('function renderNetworkManager'));
    const order = ['networkManagerMethodBadge(c.method)', 'networkManagerStateBadge(c.active)',
        'networkManagerLeaseInfo(c.dhcp)', 'staticForm +', 'networkManagerApply'];
    let last = -1;
    for (const part of order) {
        const at = card.indexOf(part);
        assert.ok(at > last, `${part} keeps its place in the card`);
        last = at;
    }
});

test('the installers keep the NetworkManager step in sync', () => {
    for (const rel of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
        assert.ok(content.includes('[10y] Checking NetworkManager'), `${rel} checks NetworkManager`);
    }
});
