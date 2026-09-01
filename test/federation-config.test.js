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

test('Format Helpers: formatRemoteDestination formats external dial destination correctly', () => {
    assert.equal(formatRemoteDestination('20101'), '20101#', 'Numeric alias must be suffixed with # for FreePBX dial string');
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
