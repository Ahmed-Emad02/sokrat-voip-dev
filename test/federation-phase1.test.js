'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    normalizeActiveCalls,
    normalizeLivePayload,
    normalizeInventoryPayload,
    normalizeContactsPayload,
    parseSignalPct,
    markPeerOffline,
    upsertNodeStatus
} = require('../lib/federation-aggregator');
const {
    _getCircuitState,
    _resetCircuits,
    isCircuitOpen
} = require('../lib/federation-client');

test('Federation Aggregator: legacy array active calls become an extension-keyed map', () => {
    const map = normalizeActiveCalls([
        { extension: '101', state: 'In Call', partner: '20102' },
        { exten: '102', state: 'Ringing' },
        { src: '103' },
        null
    ]);
    assert.deepEqual(Object.keys(map).sort(), ['101', '102', '103']);
    assert.equal(map['101'].partner, '20102');
    assert.deepEqual(normalizeActiveCalls(null), {});
    assert.deepEqual(normalizeActiveCalls({ 101: { state: 'In Call' } }), { 101: { state: 'In Call' } });
});

test('Federation Aggregator: live payload accepts both the envelope and flat shapes', () => {
    const envelope = normalizeLivePayload({
        success: true,
        api_version: 1,
        data: {
            node: { site_code: '20', name: 'Test PBX' },
            extensions: [{ extension: '101', status: 'online' }],
            dongles: [{ dongle_name: 'dongle0', state: 'Free' }],
            activeCalls: [{ extension: '101', state: 'In Call' }],
            metrics: { extensions_total: 1, extensions_online: 1 }
        }
    });
    assert.equal(envelope.node.site_code, '20');
    assert.equal(envelope.extensions.length, 1);
    assert.equal(envelope.dongles.length, 1);
    assert.equal(envelope.activeCalls['101'].state, 'In Call');
    assert.equal(envelope.metrics.extensions_online, 1);

    const flat = normalizeLivePayload({
        success: true,
        node: { site_code: '10' },
        extensions: [],
        activeCalls: {}
    });
    assert.equal(flat.node.site_code, '10');
    assert.deepEqual(flat.activeCalls, {});
    assert.deepEqual(flat.extensions, []);
});

test('Federation Aggregator: inventory payload normalizes counts and defaults', () => {
    const payload = normalizeInventoryPayload({
        success: true,
        node: { uuid: 'abc', site_code: '20' },
        extensions: [{ extension: '101', name: 'One' }],
        dongles: [{ dongle_name: 'dongle0' }],
        counts: { queues: 2, ringgroups: 3, trunks: 4, ivr: 1 }
    });
    assert.equal(payload.counts.queues, 2);
    assert.equal(payload.counts.trunks, 4);
    assert.equal(payload.extensions.length, 1);

    const legacy = normalizeInventoryPayload({ success: true, queues: 1, trunks: 2 });
    assert.equal(legacy.counts.queues, 1);
    assert.equal(legacy.counts.trunks, 2);
    assert.equal(legacy.counts.ivr, 0);
});

test('Federation Aggregator: contact payload is normalized and invalid rows dropped', () => {
    const payload = normalizeContactsPayload({
        success: true,
        node: { uuid: 'abc', site_code: '20' },
        contacts: [
            { id: 7, name: 'Alice', last_name: 'Nassar', telefono: '01000000001' },
            { id: 8, name: 'Bob', last_name: '', telefono: '01000000002' },
            { id: 9, name: 'No Phone', last_name: 'X', telefono: '' },
            null
        ]
    });
    assert.equal(payload.node.site_code, '20');
    assert.equal(payload.contacts.length, 2);
    assert.deepEqual(payload.contacts[0], {
        sourceId: '7',
        name: 'Alice',
        lastName: 'Nassar',
        phone: '01000000001'
    });
    // legacy phone/phone alias
    const legacy = normalizeContactsPayload({ contacts: [{ phone: '0111', first_name: 'Legacy' }] });
    assert.equal(legacy.contacts.length, 1);
    assert.equal(legacy.contacts[0].phone, '0111');
    assert.equal(legacy.contacts[0].name, 'Legacy');
});

test('Federation Aggregator: RSSI is converted from the 0-31 modem scale to a percent', () => {
    assert.equal(parseSignalPct('31'), 100);
    assert.equal(parseSignalPct('16'), 52);
    assert.equal(parseSignalPct('75%'), 75);
    assert.equal(parseSignalPct('-70'), 69);
    assert.equal(parseSignalPct('n/a'), null);
    assert.equal(parseSignalPct(null), null);
});

test('Federation Aggregator: node status upsert writes health metrics and peer status', async () => {
    const calls = [];
    const pool = {
        query: async (sql, params) => {
            calls.push({ sql, params });
            return [[]];
        }
    };
    await upsertNodeStatus(pool, { id: 7 }, {
        status: 'online',
        latencyMs: 12,
        apiVersion: 1,
        node: { version: '1.1.0' },
        metrics: {
            asterisk_version: '18.19.0',
            uptime_sec: 1234,
            load1: 0.42,
            disk_pct: 61,
            extensions_total: 10,
            extensions_online: 4,
            dongles_total: 2,
            dongles_free: 1,
            active_calls: 3,
            calls_today: 99
        }
    });

    const insert = calls.find(c => c.sql.includes('sokrat_federation_node_status'));
    assert.ok(insert, 'node status insert must run');
    assert.equal(insert.params[0], 7);
    assert.equal(insert.params[1], 'online');
    assert.equal(insert.params[3], 12, 'latency must be persisted');
    assert.equal(insert.params[5], '1.1.0', 'node version must be persisted');
    assert.equal(insert.params[6], '18.19.0', 'asterisk version must be persisted');
    assert.equal(insert.params[10], 10, 'extensions total must be persisted');
    assert.equal(insert.params[12], 2, 'dongles total must be persisted');
    assert.equal(insert.params[14], 3, 'active calls must be persisted');
    assert.equal(insert.params[15], 99, 'calls today must be persisted');

    const peerUpdate = calls.find(c => c.sql.includes('sokrat_federation_peers'));
    assert.ok(peerUpdate, 'peer status update must run');
    assert.equal(peerUpdate.params[0], 'online');
    assert.equal(peerUpdate.params[1], 7);
});

test('Federation Aggregator: unreachable peer is marked offline without throwing', async () => {
    const calls = [];
    const pool = {
        query: async (sql, params) => {
            calls.push({ sql, params });
            return [[]];
        }
    };
    await markPeerOffline(pool, { id: 9 }, 'connect ECONNREFUSED');
    const status = calls.find(c => c.sql.includes('sokrat_federation_node_status'));
    assert.ok(status);
    assert.equal(status.params[0], 9);
    assert.match(status.params[1], /ECONNREFUSED/);
});

test('Federation Client: repeated failures open the per-peer circuit breaker', async () => {
    const http = require('http');
    const { federationGet, CIRCUIT_THRESHOLD } = require('../lib/federation-client');
    _resetCircuits();

    const previousAllowHttp = process.env.SOKRAT_FEDERATION_ALLOW_HTTP;
    process.env.SOKRAT_FEDERATION_ALLOW_HTTP = '1';

    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'boom' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const peer = {
        id: 4242,
        site_code: '42',
        api_base_url: `http://127.0.0.1:${port}`
    };
    const options = { localSiteCode: '10', decryptFn: () => 'test-key', timeout: 2000, retries: 1 };

    try {
        for (let i = 0; i < CIRCUIT_THRESHOLD; i += 1) {
            await assert.rejects(() => federationGet(peer, '/api/federation/v1/live', options));
        }
        assert.equal(isCircuitOpen(peer), true, 'circuit must open after repeated failures');
        assert.ok(hits >= CIRCUIT_THRESHOLD, 'each failed attempt must reach the peer');

        const hitsBefore = hits;
        await assert.rejects(
            () => federationGet(peer, '/api/federation/v1/live', options),
            /circuit open/i
        );
        assert.equal(hits, hitsBefore, 'an open circuit must not hit the network');
    } finally {
        _resetCircuits();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        if (previousAllowHttp === undefined) delete process.env.SOKRAT_FEDERATION_ALLOW_HTTP;
        else process.env.SOKRAT_FEDERATION_ALLOW_HTTP = previousAllowHttp;
    }
});

test('Federation Phase 1 schema: new tables and columns exist in every deployment path', () => {
    const root = path.join(__dirname, '..');
    const sql = fs.readFileSync(path.join(root, 'backend', 'install_db.sql'), 'utf8');
    const install = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
    const bundle = fs.readFileSync(path.join(root, 'installer-bundle', 'install-sokrat.sh'), 'utf8');
    const upgrade = fs.readFileSync(path.join(root, 'scripts', 'safe-upgrade.sh'), 'utf8');

    // The shell installers escape backticks (\`) inside heredocs; normalize them
    // so the same assertions work for SQL and shell sources.
    for (const [name, rawContent] of [
        ['install_db.sql', sql],
        ['install.sh', install],
        ['installer-bundle/install-sokrat.sh', bundle]
    ]) {
        const content = rawContent.replace(/\\`/g, '`');
        assert.match(content, /CREATE TABLE IF NOT EXISTS `sokrat_federation_node_status`/, `${name} must create node status`);
        assert.match(content, /CREATE TABLE IF NOT EXISTS `sokrat_federation_sync_state`/, `${name} must create sync state`);
        assert.match(content, /CREATE TABLE IF NOT EXISTS `sokrat_federation_action_log`/, `${name} must create action log`);
        assert.match(content, /CREATE TABLE IF NOT EXISTS `sokrat_federation_remote_contacts`/, `${name} must create the remote contact cache`);
        assert.match(content, /`asterisk_version`/, `${name} must include node metric columns`);
        assert.match(content, /`signal_pct`/, `${name} must include dongle live columns`);
    }

    assert.match(upgrade, /ensure_db_column "sokrat_federation_node_status" "asterisk_version"/);
    assert.match(upgrade, /ensure_db_column "sokrat_federation_node_status" "extensions_online"/);
    assert.match(upgrade, /ensure_db_column "sokrat_federation_remote_dongles" "signal_pct"/);
    assert.match(upgrade, /ensure_db_column "sokrat_federation_remote_dongles" "active_call"/);
    assert.match(upgrade.replace(/\\`/g, '`'), /CREATE TABLE IF NOT EXISTS `sokrat_federation_remote_contacts`/, 'safe-upgrade must create the remote contact cache');
});

test('Federation Phase 1 endpoints: agent and central routes are registered', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /app\.get\('\/api\/federation\/v1\/live'/);
    assert.match(server, /app\.get\('\/api\/federation\/v1\/inventory'/);
    assert.match(server, /app\.get\('\/api\/federation\/v1\/contacts'/);
    assert.match(server, /app\.get\('\/api\/federation\/overview', requireAuth/);
    assert.match(server, /app\.get\('\/api\/federation\/nodes', requireAuth/);
    assert.match(server, /app\.post\('\/api\/federation\/nodes\/:id\/sync', requireAuth/);

    const hub = fs.readFileSync(path.join(__dirname, '..', 'lib', 'federation-hub.js'), 'utf8');
    assert.match(hub, /federation:overview/, 'hub must emit the federation overview event');
});

test('Federation Phase 1 dashboard: node rail renders bilingual cards and listens for overview updates', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');
    assert.match(view, /id="federationNodeRail"/);
    assert.match(view, /id="fedRailNodes"/);
    assert.match(view, /\/api\/federation\/overview/);
    assert.match(view, /federation:overview/);
    assert.match(view, /isRtl \? 'السيرفرات المرتبطة' : 'Connected PBXs'/);
});

test('Federation contacts: the address book merges remote rows read-only', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'contacts.ejs'), 'utf8');
    assert.match(view, /contact\.is_remote/, 'remote contacts must be flagged');
    assert.match(view, /Site <%= contact\.site_code %>/, 'remote contacts must show their site');
    assert.match(view, /read-only/, 'remote contacts must be read-only');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /getFederationRemoteContacts\(scope\)/, 'the contacts page must merge remote rows');
    assert.match(server, /federationScopeIncludesLocal\(scope\)/, 'the contacts page must honor a remote-only scope');
});
