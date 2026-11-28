'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    generateIaxConfig,
    generateDialplanConfig,
    formatRemoteDestination
} = require('../lib/federation-engine');
const FederationHub = require('../lib/federation-hub');

test('Schema & Migration Parity: backend/install_db.sql and install.sh include federation tables and Asterisk hooks', () => {
    const sqlPath = path.join(__dirname, '..', 'backend', 'install_db.sql');
    assert.ok(fs.existsSync(sqlPath), 'install_db.sql must exist');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Canonical schema checks
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `sokrat_federation_settings`/, 'install_db.sql must create sokrat_federation_settings');
    assert.match(sql, /`local_site_code` VARCHAR\(10\) NOT NULL DEFAULT '10'/, 'sokrat_federation_settings must define local_site_code');
    assert.match(sql, /`panel_role` ENUM\('local', 'central'\)/, 'sokrat_federation_settings must define panel_role');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS `sokrat_federation_peers`/, 'install_db.sql must create sokrat_federation_peers');
    assert.match(sql, /`site_code` VARCHAR\(10\) NOT NULL UNIQUE/, 'sokrat_federation_peers must define unique site_code');
    assert.match(sql, /`iax_secret_enc` TEXT NOT NULL/, 'sokrat_federation_peers must define iax_secret_enc');
    assert.match(sql, /`allow_outbound_egress` TINYINT\(1\)/, 'sokrat_federation_peers must define allow_outbound_egress');
    assert.match(sql, /`local_node_uuid` VARCHAR\(36\)/, 'sokrat_federation_settings must define local_node_uuid');
    assert.match(sql, /`node_uuid` VARCHAR\(36\)/, 'sokrat_federation_peers must define node_uuid');
    assert.match(sql, /`api_version` SMALLINT UNSIGNED NOT NULL DEFAULT 1/, 'sokrat_federation_peers must define api_version');
    assert.match(sql, /`allow_report_read` TINYINT\(1\) NOT NULL DEFAULT 1/, 'sokrat_federation_peers must define allow_report_read');
    assert.match(sql, /`allow_contact_write` TINYINT\(1\) NOT NULL DEFAULT 0/, 'sokrat_federation_peers must define allow_contact_write');
    assert.match(sql, /`allow_dongle_control` TINYINT\(1\) NOT NULL DEFAULT 0/, 'sokrat_federation_peers must define allow_dongle_control');
    assert.match(sql, /`allow_campaign_control` TINYINT\(1\) NOT NULL DEFAULT 0/, 'sokrat_federation_peers must define allow_campaign_control');
    assert.match(sql, /`allow_config_write` TINYINT\(1\) NOT NULL DEFAULT 0/, 'sokrat_federation_peers must define allow_config_write');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `sokrat_federation_node_status`/, 'install_db.sql must create sokrat_federation_node_status');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS `sokrat_federation_remote_extensions`/, 'install_db.sql must create sokrat_federation_remote_extensions');
    assert.match(sql, /`dial_alias` VARCHAR\(30\) NOT NULL UNIQUE/, 'sokrat_federation_remote_extensions must define dial_alias');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS `sokrat_federation_remote_dongles`/, 'install_db.sql must create sokrat_federation_remote_dongles');
    assert.match(sql, /`peer_id` INT DEFAULT NULL/, 'dashboard_user_extensions must define peer_id column');

    // install.sh parity checks
    const installPath = path.join(__dirname, '..', 'install.sh');
    assert.ok(fs.existsSync(installPath), 'install.sh must exist');
    const script = fs.readFileSync(installPath, 'utf8');

    assert.match(script, /CREATE TABLE IF NOT EXISTS \\`sokrat_federation_settings\\`/, 'install.sh must create sokrat_federation_settings');
    assert.match(script, /CREATE TABLE IF NOT EXISTS \\`sokrat_federation_peers\\`/, 'install.sh must create sokrat_federation_peers');
    assert.match(script, /ensure_db_column "dashboard_user_extensions" "peer_id"/, 'install.sh must migrate peer_id column');
    assert.match(script, /include => sokrat-federation-out/, 'install.sh must hook sokrat-federation-out in from-internal-custom');
    assert.match(script, /#include sokrat_federation\.conf/, 'install.sh must include sokrat_federation.conf');
    assert.match(script, /#include sokrat_federation_iax\.conf/, 'install.sh must include sokrat_federation_iax.conf');
});

test('IAX2 Engine: generateIaxConfig produces valid bilateral user and peer configurations with encryption', () => {
    const peers = [
        {
            id: 1,
            node_name: 'Branch Office',
            host: '192.168.100.228',
            site_code: '20',
            iax_port: 4569,
            iax_user_inbound: 'fed_in_site20',
            iax_peer_outbound: 'fed_out_site20',
            iax_secret: 'supersecret1234567890abcdef',
            allow_internal_dialing: 1,
            allow_outbound_egress: 1
        }
    ];
    const localSettings = {
        local_site_code: '10',
        local_node_name: 'Main PBX',
        panel_role: 'local'
    };

    const config = generateIaxConfig(peers, localSettings);

    // Inbound User Checks
    assert.match(config, /\[fed_in_site20\]/, 'Config must declare inbound user section');
    assert.match(config, /type=user/, 'Inbound must be type=user');
    assert.match(config, /auth=md5/, 'Inbound must use auth=md5');
    assert.match(config, /secret=supersecret1234567890abcdef/, 'Inbound must use decrypted shared secret');
    assert.match(config, /context=from-federation-site20/, 'Inbound must isolate into site context');
    assert.match(config, /permit=192\.168\.100\.228\/255\.255\.255\.255/, 'Inbound must restrict IP');
    assert.match(config, /encryption=aes128/, 'Inbound must enforce AES128 encryption');
    assert.match(config, /forceencryption=yes/, 'Inbound must force encryption');

    // Outbound Peer Checks
    assert.match(config, /\[fed_out_site20\]/, 'Config must declare outbound peer section');
    assert.match(config, /type=peer/, 'Outbound must be type=peer');
    assert.match(config, /host=192\.168\.100\.228/, 'Outbound must target peer host');
    assert.match(config, /port=4569/, 'Outbound must target IAX port');
    assert.match(config, /username=fed_in_site10/, 'Outbound must identify as local inbound user name');
    assert.match(config, /qualify=yes/, 'Outbound must enable qualify');
});

test('Dialplan Engine: generateDialplanConfig implements hop limiter, direct dialing, and egress security', () => {
    const peers = [
        {
            id: 1,
            node_name: 'Branch Office',
            host: '192.168.100.228',
            site_code: '20',
            iax_peer_outbound: 'fed_out_site20',
            allow_internal_dialing: 1,
            allow_outbound_egress: 1
        }
    ];
    const localSettings = { local_site_code: '10', local_node_name: 'Main PBX' };

    const dialplan = generateDialplanConfig(peers, localSettings, []);

    // Loop Prevention
    assert.match(dialplan, /\[sokrat-federation-out\]/, 'Dialplan must define outbound dispatch context');
    assert.match(dialplan, /FED_HOPS/, 'Dialplan must inspect FED_HOPS');
    assert.match(dialplan, /GotoIf\(\$\[\$\{FED_HOPS\} >= 2\]\?loop_detected\)/, 'Dialplan must abort loops exceeding 2 hops');
    assert.match(dialplan, /IAXVAR\(FED_CALLER\)/, 'Dialplan must preserve original caller ID across hops');

    // Dynamic Routing
    assert.match(dialplan, /Goto\(peer_20,\$\{EXTEN:2\},1\)/, 'Dialplan must route site 20 prefix to peer_20 context');
    assert.match(dialplan, /Goto\(peer_20,OUT_\$\{EXTEN:3\},1\)/, 'Dialplan must route 920 prefix to peer_20 remote egress');

    // Per-Peer Contexts
    assert.match(dialplan, /\[peer_20\]/, 'Dialplan must define peer_20 context');
    assert.match(dialplan, /Dial\(IAX2\/fed_out_site20\/\$\{EXTEN\},45,Ttr\)/, 'peer_20 must dial outbound IAX2 peer');

    // Inbound Context & Egress Permission Check
    assert.match(dialplan, /\[from-federation-site20\]/, 'Dialplan must define inbound handling context');
    assert.match(dialplan, /GotoIf\(\$\["\$\{DB\(FEDERATION\/PEER_20_EGRESS_ALLOWED\)\}" != "1"\]\?reject_egress\)/, 'Inbound must gate remote egress with AstDB permission');
    assert.match(dialplan, /Goto\(outbound-allroutes,\$\{EXTEN:4\},1\)/, 'Inbound must dispatch authorized egress to outbound-allroutes');
    assert.match(dialplan, /Goto\(from-internal-additional,\$\{EXTEN\},1\)/, 'Inbound must dispatch normal extensions to from-internal-additional');
});

test('IAX2 Engine: three or more peers each get isolated users, peers and dialplan contexts', () => {
    const peers = ['20', '30', '40'].map((siteCode, index) => ({
        id: index + 1,
        node_name: `Branch ${siteCode}`,
        host: `192.168.100.${100 + index}`,
        site_code: siteCode,
        iax_port: 4569,
        iax_user_inbound: `fed_in_site${siteCode}`,
        iax_peer_outbound: `fed_out_site${siteCode}`,
        iax_secret: `secret-${siteCode}-1234567890abcdef`,
        allow_internal_dialing: 1,
        allow_outbound_egress: 1
    }));
    const localSettings = { local_site_code: '10', local_node_name: 'Main PBX' };

    const iax = generateIaxConfig(peers, localSettings);
    const dialplan = generateDialplanConfig(peers, localSettings, []);

    for (const peer of peers) {
        const code = peer.site_code;
        assert.match(iax, new RegExp(`\\[fed_in_site${code}\\]`), `peer ${code} needs an inbound user`);
        assert.match(iax, new RegExp(`\\[fed_out_site${code}\\]`), `peer ${code} needs an outbound peer`);
        assert.match(iax, new RegExp(`host=${peer.host.replace(/\./g, '\\.')}`), `peer ${code} needs its own host`);
        assert.match(dialplan, new RegExp(`\\[peer_${code}\\]`), `peer ${code} needs an outbound context`);
        assert.match(dialplan, new RegExp(`\\[from-federation-site${code}\\]`), `peer ${code} needs an inbound context`);
        assert.match(dialplan, new RegExp(`Goto\\(peer_${code},\\$\\{EXTEN:2\\},1\\)`), `peer ${code} needs a prefix route`);
        assert.match(dialplan, new RegExp(`Goto\\(peer_${code},OUT_\\$\\{EXTEN:3\\},1\\)`), `peer ${code} needs an egress route`);
    }

    // No peer may inherit another peer's outbound trunk.
    assert.match(dialplan, /Dial\(IAX2\/fed_out_site20\/\$\{EXTEN\},45,Ttr\)/);
    assert.match(dialplan, /Dial\(IAX2\/fed_out_site30\/\$\{EXTEN\},45,Ttr\)/);
    assert.match(dialplan, /Dial\(IAX2\/fed_out_site40\/\$\{EXTEN\},45,Ttr\)/);
});

test('Format Helpers: formatRemoteDestination formats external dial destination correctly', () => {    assert.equal(formatRemoteDestination('20101'), '20101#', 'Numeric alias must be suffixed with # for FreePBX dial string');
    assert.equal(formatRemoteDestination('20101#'), '20101#', 'Existing # suffix must not be duplicated');
    assert.equal(formatRemoteDestination(''), '', 'Empty input must return empty string');
});

test('Federation Hub: Multi-Node state engine partitions memory by composite keys to prevent extension collisions', async () => {
    let mockLocalExtensions = [
        { extension: '101', name: 'Alice (Local)', status: 'online' },
        { extension: '102', name: 'Bob (Local)', status: 'offline' }
    ];

    const hub = new FederationHub({
        pool: {
            query: async (sql, params) => {
                if (sql.includes('sokrat_federation_settings')) {
                    return [[{ local_site_code: '10', local_node_name: 'Main PBX', panel_role: 'central' }]];
                }
                if (sql.includes('sokrat_federation_peers')) {
                    return [[{ id: 1, site_code: '20', node_name: 'Branch PBX', host: '192.168.100.228', status: 'online' }]];
                }
                if (sql.includes('sokrat_federation_remote_extensions')) {
                    return [[
                        { native_extension: '101', dial_alias: '20101', display_name: 'Charlie (Remote)', status: 'online' }
                    ]];
                }
                return [[]];
            }
        },
        io: null,
        getLocalLiveStateFn: async () => ({ extensions: mockLocalExtensions, activeCalls: [] }),
        executeLocalActionFn: async () => ({ success: true })
    });

    await hub.init();
    hub.stopPolling(); // the test drives aggregateAllNodes manually
    await hub.aggregateAllNodes();

    const aggregated = hub.getAggregatedExtensions();
    assert.equal(aggregated.length, 3, 'Aggregated list must contain 2 local extensions and 1 remote extension');

    // Check conflict resolution between local 101 and remote 101
    const local101 = aggregated.find(e => e.compositeKey === '10:101');
    const remote101 = aggregated.find(e => e.compositeKey === '20:101');

    assert.ok(local101, 'Local extension 101 must exist under key 10:101');
    assert.equal(local101.name, 'Alice (Local)', 'Local 101 must retain local name');
    assert.equal(local101.isLocal, true, 'Local 101 must be flagged isLocal = true');

    assert.ok(remote101, 'Remote extension 101 must exist under key 20:101 without collision');
    assert.equal(remote101.name, 'Charlie (Remote)', 'Remote 101 must retain remote name');
    assert.equal(remote101.isLocal, false, 'Remote 101 must be flagged isLocal = false');
    assert.equal(remote101.dialAlias, '20101', 'Remote 101 must carry dialAlias 20101');

    hub.stopPolling();
});

test('a hung-up call clears on the next federation snapshot while CDR sync is pending', { timeout: 3000 }, async t => {
    const http = require('node:http');
    const previousAllowHttp = process.env.SOKRAT_FEDERATION_ALLOW_HTTP;
    process.env.SOKRAT_FEDERATION_ALLOW_HTTP = '1';
    const cdrStarted = Promise.withResolvers();
    const cdrFinished = Promise.withResolvers();
    const activeCall = { state: 'In Call', partner: '102', start: 1000 };
    let peerCalls = { 101: activeCall };
    let pendingCdrResponse;
    const peerApi = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/federation/v1/live') {
            res.end(JSON.stringify({ peerStatus: { 101: true }, activeCalls: peerCalls }));
        } else if (req.url.startsWith('/api/federation/v1/cdr?')) {
            pendingCdrResponse = res;
            cdrStarted.resolve();
        } else {
            res.writeHead(404).end('{}');
        }
    });
    t.after(async () => {
        peerApi.closeAllConnections();
        await new Promise(resolve => peerApi.close(resolve));
        if (previousAllowHttp === undefined) delete process.env.SOKRAT_FEDERATION_ALLOW_HTTP;
        else process.env.SOKRAT_FEDERATION_ALLOW_HTTP = previousAllowHttp;
    });
    await new Promise(resolve => peerApi.listen(0, '127.0.0.1', resolve));

    const snapshots = [];
    const hub = new FederationHub({
        pool: {
            async query(sql, params) {
                if (sql.includes('SELECT native_extension')) {
                    return [[{ native_extension: '101', display_name: 'Remote 101' }]];
                }
                if (sql.includes('INSERT INTO') && sql.includes('sokrat_federation_sync_state') &&
                    params?.[1] === 'cdr' && ['ok', 'error'].includes(params?.[2])) {
                    cdrFinished.resolve();
                }
                return [[]];
            }
        },
        io: { emit: (event, data) => { if (event === 'operator:federation_state') snapshots.push(data); } },
        decryptFn: () => 'test-key',
        getLocalLiveStateFn: async () => ({ extensions: [{ extension: '101', status: 'online' }], activeCalls: { 101: activeCall } })
    });
    hub.peersMap.set(8242, { id: 8242, site_code: '20', api_base_url: `http://127.0.0.1:${peerApi.address().port}` });
    hub.lastInventorySync.set(8242, Date.now());

    try {
        await hub.aggregateAllNodes();
        await cdrStarted.promise;
        assert.deepEqual(snapshots[0].extensions.find(ext => ext.compositeKey === '20:101').activeCall, activeCall);
        peerCalls = {};
        await hub.aggregateAllNodes();
        const calls = new Map(snapshots[1].extensions.map(ext => [ext.compositeKey, ext.activeCall]));
        assert.equal(calls.get('20:101'), null);
        assert.deepEqual(calls.get('10:101'), activeCall);
    } finally {
        if (pendingCdrResponse) {
            pendingCdrResponse.end('{"rows":[]}');
            await cdrFinished.promise;
        }
    }
});

test('Federation Bootstrap: lib/federation-bootstrap.js exports core functions and resolves system binaries', () => {
    const bootstrap = require('../lib/federation-bootstrap');
    assert.equal(typeof bootstrap.bootstrapPeer, 'function', 'bootstrapPeer must be exported');
    assert.equal(typeof bootstrap.qualifyIaxPeer, 'function', 'qualifyIaxPeer must be exported');
    assert.equal(typeof bootstrap.syncRemotePeerEntities, 'function', 'syncRemotePeerEntities must be exported');
    assert.equal(typeof bootstrap.removeRemoteFederationSetup, 'function', 'removeRemoteFederationSetup must be exported');
    assert.equal(typeof bootstrap.getLocalIpAddress, 'function', 'getLocalIpAddress must be exported');
    assert.equal(typeof bootstrap.inspectRemoteCode, 'function', 'inspectRemoteCode must be exported');
    assert.equal(typeof bootstrap.decideCodeSync, 'function', 'decideCodeSync must be exported');
});

test('Federation Bootstrap: every federation lib ships in the peer code-sync manifest', () => {
    const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'lib', 'federation-bootstrap.js'), 'utf8');
    const libDir = path.join(__dirname, '..', 'lib');
    const federationLibs = fs.readdirSync(libDir).filter(f => /^federation-.*\.js$/.test(f));
    assert.ok(federationLibs.length >= 6, 'federation libs must be discoverable');
    for (const lib of federationLibs) {
        assert.ok(
            bootstrap.includes(`'lib/${lib}'`),
            `${lib} must be listed in CODE_SYNC_FILES or a promoted peer will miss it`
        );
    }
});

test('Federation deployers: fresh install, offline bundle and upgrade all verify the peer proxy', () => {
    for (const file of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const script = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.match(script, /lib\/federation-proxy\.js/, `${file} must check the peer proxy module`);
        assert.match(script, /\/peer\/__probe__/, `${file} must probe the /peer route after install/upgrade`);
    }
});

test('Federation SSH bootstrap dependency is installed by all deployers', () => {
    for (const file of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const script = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.match(script, /sshpass/, `${file} must install or verify sshpass`);
        assert.match(script, /openssh-clients/, `${file} must ensure ssh/scp clients are available`);
    }
});

test('Federation Bootstrap: code sync only runs when remote checksums differ', () => {
    const { decideCodeSync } = require('../lib/federation-bootstrap');
    const local = { 'server.js': 'aaa', 'lib/federation-auth.js': 'bbb' };

    const upToDate = decideCodeSync(local, { hashes: { ...local }, version: '1.1.0' }, 'auto');
    assert.equal(upToDate.sync, false);
    assert.equal(upToDate.reason, 'up-to-date');

    const drifted = decideCodeSync(local, { hashes: { 'server.js': 'ccc', 'lib/federation-auth.js': 'bbb' }, version: '1.1.0' }, 'auto');
    assert.equal(drifted.sync, true);
    assert.equal(drifted.reason, 'checksum-mismatch');
    assert.deepEqual(drifted.changed, ['server.js']);

    const missing = decideCodeSync(local, { hashes: { 'server.js': 'aaa' }, version: '1.1.0' }, 'auto');
    assert.equal(missing.sync, true);
    assert.equal(missing.reason, 'missing-files');
    assert.deepEqual(missing.missing, ['lib/federation-auth.js']);

    assert.equal(decideCodeSync(local, { hashes: local }, true).reason, 'forced');
    assert.equal(decideCodeSync(local, { hashes: local }, false).sync, false);
});

test('Federation Bootstrap: peer API URLs never use the softphone :8443 vhost', () => {
    const bootstrapSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'federation-bootstrap.js'), 'utf8');
    assert.doesNotMatch(bootstrapSrc, /https:\/\/\$\{host\}:8443/, 'bootstrap must not write :8443 peer URLs');
    assert.doesNotMatch(bootstrapSrc, /https:\/\/\$\{resolvedLocalIp\}:8443/, 'bootstrap must not advertise :8443 to peers');
    assert.match(bootstrapSrc, /normalizeFederationBaseUrl/, 'bootstrap must normalize peer API URLs');
});

test('Dialplan Engine: a peer reusing the local site code is never routed', () => {
    const peers = [
        { id: 1, node_name: 'Self', host: '10.0.0.10', site_code: '10', iax_peer_outbound: 'fed_out_site10', allow_internal_dialing: 1, allow_outbound_egress: 1 },
        { id: 2, node_name: 'Branch', host: '10.0.0.20', site_code: '20', iax_peer_outbound: 'fed_out_site20', allow_internal_dialing: 1, allow_outbound_egress: 1 }
    ];
    const dialplan = generateDialplanConfig(peers, { local_site_code: '10' }, []);
    const iax = generateIaxConfig(peers, { local_site_code: '10' });

    assert.doesNotMatch(dialplan, /_10X/, 'local site prefix must not be routed to a peer');
    assert.doesNotMatch(dialplan, /\[peer_10\]/, 'no outbound context may be generated for the local site code');
    assert.doesNotMatch(iax, /\[fed_in_site10\]/, 'local site code must not create a peer identity');
    assert.match(dialplan, /_20XX\./, 'other peers keep their prefix route');
});

test('Dialplan Engine: local extensions colliding with a site prefix stay local', () => {
    const peers = [
        { id: 1, node_name: 'Branch', host: '10.0.0.20', site_code: '20', iax_peer_outbound: 'fed_out_site20', allow_internal_dialing: 1, allow_outbound_egress: 1 }
    ];
    const dialplan = generateDialplanConfig(peers, { local_site_code: '10' }, [], ['101', '2001', '2002', '92001234']);

    // Exact extensions beat patterns in Asterisk, so pinning them keeps the
    // original server's own internal dialing working.
    assert.match(dialplan, /exten => 2001,1,Goto\(from-internal-additional,2001,1\)/, 'colliding extension 2001 must stay local');
    assert.match(dialplan, /exten => 2002,1,Goto\(from-internal-additional,2002,1\)/, 'colliding extension 2002 must stay local');
    assert.doesNotMatch(dialplan, /exten => 101,1,Goto/, 'non-colliding extension must not be pinned');
    // 92001234 is a local number that looks like remote egress for site 20.
    assert.match(dialplan, /exten => 92001234,1,Goto\(from-internal-additional,92001234,1\)/, 'egress-shaped local extension must stay local');
    assert.match(dialplan, /_20XX\./, 'the site prefix route still exists');
});

test('Federation API: peer mutations invalidate the server-rendered shell cache', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /function invalidateFederationShellCache\(\)/, 'server must expose a cache invalidation helper');
    const calls = src.match(/invalidateFederationShellCache\(\);/g) || [];
    assert.ok(calls.length >= 6, `expected every federation mutation route to invalidate the shell cache (found ${calls.length})`);
    assert.doesNotMatch(src, /req\.body\.sshPassword \|\| 'Admin@123'/, 'federation routes must never fall back to a hard-coded SSH password');
    assert.match(src, /app\.post\('\/api\/federation\/v1\/depart'/, 'peers need a signed unlink endpoint');
    assert.match(src, /syncPeerInventoryFromApi/, 're-sync must work over the signed federation API');
});

test('Federation Bootstrap: remote cleanup is scoped to one site, never destructive', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'federation-bootstrap.js'), 'utf8');
    assert.doesNotMatch(src, /TRUNCATE TABLE sokrat_federation_peers/, 'cleanup must not truncate the remote peer table');
    assert.match(src, /WHERE site_code='\$\{safeSite\}'/, 'cleanup must target only the departing site');
    assert.match(src, /syncPeerInventoryFromApi/, 'signed-API inventory sync must be exported');
});

test('Dialplan Engine: federated legs carry a shared call id for history dedup', () => {
    const peers = [{ id: 1, node_name: 'Branch', host: '10.0.0.20', site_code: '20', iax_peer_outbound: 'fed_out_site20', allow_internal_dialing: 1, allow_outbound_egress: 1 }];
    const dialplan = generateDialplanConfig(peers, { local_site_code: '10' }, []);

    assert.ok(dialplan.includes('Set(FED_GID=${IF($["${IAXVAR(FED_GID)}" = ""]?${UNIQUEID}:${IAXVAR(FED_GID)})})'), 'Dispatch must derive the id locally or adopt the peer id');
    assert.ok(dialplan.includes('Set(CDR(userfield)=SOKRAT_FED:${FED_GID})'), 'Originating leg must persist the shared id');
    assert.ok(dialplan.includes('Set(CDR(userfield)=SOKRAT_FED:${FED_GID}:leg)'), 'Receiving leg must mark itself as the mirrored leg');
    assert.ok(dialplan.includes('Set(IAXVAR(FED_GID)=${FED_GID})'), 'Id must travel with the IAX2 call');
});

test('Federation CDR: union view exposes the shared id and leg marker', () => {
    const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'federation-engine.js'), 'utf8');
    assert.match(engine, /AS \\`global_call_id\\`/, 'Union view must expose global_call_id');
    assert.match(engine, /AS \\`fed_leg\\`/, 'Union view must expose fed_leg');
    assert.ok(engine.includes('SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX'), 'View must strip the appended Q.850 cause before parsing the id');
    assert.ok(engine.includes("'|', 1)"), 'View must strip the appended Q.850 cause before parsing the id');
});

test('Federation CDR: fleet-wide history drops the mirrored leg when the origin leg exists', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(src.includes('dedupFederationLegs'), 'Union source must enable leg dedup');
    assert.ok(src.includes('c.fed_leg = 1'), 'Dedup must target the mirrored leg');
    assert.ok(src.includes('v.global_call_id = c.global_call_id'), 'Dedup must match on the shared call id');
    assert.ok(src.includes('AND v.fed_leg = 0'), 'Dedup must keep the originating leg');
});

test('Federation presence: a single failed poll does not mark a PBX offline', async () => {
    const aggregator = require('../lib/federation-aggregator');
    const makePool = (lastSeenAt) => {
        const calls = [];
        return {
            calls,
            async query(sql, params) {
                calls.push({ sql, params });
                if (/SELECT status, last_seen_at/.test(sql)) {
                    return [[{ status: 'online', last_seen_at: lastSeenAt }]];
                }
                return [{ affectedRows: 1 }];
            }
        };
    };

    const fresh = makePool(new Date());
    await aggregator.markPeerOffline(fresh, { id: 7 }, 'timeout');
    assert.equal(fresh.calls.some(c => /sokrat_federation_peers` SET status = 'offline'/.test(c.sql)), false,
        'A fresh last_seen must keep the peer online');
    assert.ok(fresh.calls.some(c => /SET last_error/.test(c.sql)), 'The failure is still recorded');

    const stale = makePool(new Date(Date.now() - 5 * 60 * 1000));
    await aggregator.markPeerOffline(stale, { id: 7 }, 'timeout');
    assert.ok(stale.calls.some(c => /sokrat_federation_peers` SET status = 'offline'/.test(c.sql)),
        'A stale peer must be marked offline');
});

test('Live panel: remote cards render call details and never borrow a local extension', () => {
    const operator = fs.readFileSync(path.join(__dirname, '..', 'views', 'operator.ejs'), 'utf8');
    assert.ok(operator.includes('activeCalls[emp.cardId] || null'), 'Remote cards must read their site-scoped key');
    assert.ok(operator.includes('applyCardCallState(cardKey, ext.activeCall'), 'Federation feed must render partner/status/timer, not only the class');
    assert.ok(operator.includes('card.dataset.siteCode !== FED_LOCAL_SITE'), 'Local initial state must skip remote cards');
});

test('Live panel: every connected PBX is rendered regardless of the report scope', () => {
    const operator = fs.readFileSync(path.join(__dirname, '..', 'views', 'operator.ejs'), 'utf8');
    assert.doesNotMatch(operator, /fedScopeSites/, 'The live panel must not filter its roster with the report scope cookie');
    assert.match(operator, /The Live Panel has its own per-node filter buttons/, 'The decoupling must stay documented');
    assert.match(operator, /var includeLocalSite = true;/, 'Local extensions always render');
    assert.match(operator, /federationRemoteExtensions[^\n]*: \[\]/, 'Remote extensions always render on a central node');
});

test('Federated dongle reads return local inventory only and collapse duplicates', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /function federationReadScope\(scope, isFederationRequest\)/,
        'federation-authenticated read scope helper must exist');
    assert.match(src, /includeRemote: false/, 'federated reads must not recurse into peer aggregation');
    assert.match(src, /const scope = federationReadScope\(res\.locals\.federationScope, req\.isFederationAuthenticated\)/,
        'GSM device reads must be local-only when called by a peer');
    assert.match(src, /const canReadPeers = !req\.isFederationAuthenticated/,
        'a peer read must never trigger another peer read');
    assert.match(src, /federationReadScope\(res\.locals\.federationScope, req\.isFederationAuthenticated\), inbox/,
        'SMS reads must use the same local-only scope');
    assert.match(src, /seen\.has\(device\.fedKey\)/, 'duplicate dongle rows must collapse by site-scoped key');
});
