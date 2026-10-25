'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    executePeerAction,
    isDeniedActionPath,
    normalizeActionPath,
    peerAllowsPolicy,
    redactPayload,
    requiredPolicyForAction
} = require('../lib/federation-control');

function makePool() {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (/INSERT INTO .*sokrat_federation_action_log/i.test(sql)) {
                return [{ insertId: 42 }];
            }
            return [{ affectedRows: 1 }];
        }
    };
}

function peer(overrides = {}) {
    return {
        id: 7,
        site_code: '20',
        api_key_enc: 'enc',
        allow_internal_dialing: 1,
        allow_contact_write: 0,
        allow_dongle_control: 1,
        allow_campaign_control: 0,
        allow_config_write: 0,
        ...overrides
    };
}

test('Federation control: only /api/* paths can be relayed', () => {
    assert.equal(normalizeActionPath('/api/gsm-dongles/reload/dongle0'), '/api/gsm-dongles/reload/dongle0');
    assert.equal(normalizeActionPath('api/contacts'), '/api/contacts');
    assert.equal(normalizeActionPath('/api/cdr?limit=5'), '/api/cdr?limit=5');
    assert.equal(normalizeActionPath('/api/cdr#frag'), '/api/cdr');

    assert.equal(normalizeActionPath('https://evil.example/api/x'), null);
    assert.equal(normalizeActionPath('//evil.example/api/x'), null);
    assert.equal(normalizeActionPath('/api/../../etc/passwd'), null);
    assert.equal(normalizeActionPath('/api\\..\\x'), null);
    assert.equal(normalizeActionPath('/login'), null);
    assert.equal(normalizeActionPath(''), null);
});

test('Federation control: management, auth and API-key endpoints stay local', () => {
    assert.equal(isDeniedActionPath('/api/federation/overview'), true);
    assert.equal(isDeniedActionPath('/api/federation'), true);
    assert.equal(isDeniedActionPath('/api/config/federation/peers'), true);
    assert.equal(isDeniedActionPath('/api/config/federation/peers/20'), true);
    assert.equal(isDeniedActionPath('/api/config/federation?x=1'), true);
    assert.equal(isDeniedActionPath('/api/federation?x=1'), true);
    assert.equal(isDeniedActionPath('/api/auth/login'), true);
    assert.equal(isDeniedActionPath('/api/admin/api-keys'), true);
    assert.equal(isDeniedActionPath('/api/peer/20/'), true);
    assert.equal(isDeniedActionPath('/api/gsm-dongles'), false);
    assert.equal(isDeniedActionPath('/api/config/modem/dongle-slot'), false);
});

test('Federation control: write policy follows the resource being changed', () => {
    assert.equal(requiredPolicyForAction('/api/gsm-dongles/reload/dongle0', 'POST'), 'allow_dongle_control');
    assert.equal(requiredPolicyForAction('/api/contacts/12', 'PUT'), 'allow_contact_write');
    assert.equal(requiredPolicyForAction('/api/campaigns/3/start', 'POST'), 'allow_campaign_control');
    assert.equal(requiredPolicyForAction('/api/operator/hangup', 'POST'), 'allow_internal_dialing');
    assert.equal(requiredPolicyForAction('/api/config/modem/dongle-slot', 'POST'), 'allow_config_write');
    assert.equal(requiredPolicyForAction('/api/gsm-dongles', 'GET'), null, 'reads never need a write policy');
});

test('Federation control: policy flags are opt-in', () => {
    assert.equal(peerAllowsPolicy(peer(), 'allow_dongle_control'), true);
    assert.equal(peerAllowsPolicy(peer(), 'allow_config_write'), false);
    assert.equal(peerAllowsPolicy(peer({ allow_config_write: 1 }), 'allow_config_write'), true);
    assert.equal(peerAllowsPolicy(peer(), null), true);
});

test('Federation control: payload secrets are redacted before auditing', () => {
    const redacted = redactPayload({
        username: 'root',
        password: 'hunter2',
        nested: { api_key: 'abc', note: 'keep' },
        list: [{ token: 't' }]
    });
    assert.equal(redacted.username, 'root');
    assert.equal(redacted.password, '[redacted]');
    assert.equal(redacted.nested.api_key, '[redacted]');
    assert.equal(redacted.nested.note, 'keep');
    assert.equal(redacted.list[0].token, '[redacted]');
});

test('Federation control: a blocked policy never reaches the peer', async () => {
    const pool = makePool();
    let called = 0;
    const result = await executePeerAction({
        pool,
        peer: peer({ allow_config_write: 0 }),
        localSiteCode: '10',
        actor: 'root',
        method: 'POST',
        path: '/api/config/modem/dongle-slot',
        body: { count: 1 },
        decryptFn: () => 'key',
        requestFn: async () => { called += 1; return { status: 200, data: {} }; }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.match(result.error, /allow_config_write|Configuration writes/);
    assert.equal(called, 0, 'a denied action must not touch the peer');
    const insert = pool.calls.find(c => /INSERT INTO .*action_log/i.test(c.sql));
    assert.ok(insert, 'a denied attempt must still be audited');
    const update = pool.calls.find(c => /UPDATE .*action_log/i.test(c.sql));
    assert.equal(update.params[0], 'error');
    assert.match(update.params[1], /policy-denied: allow_config_write/);
});

test('Federation control: an allowed action is signed, relayed and audited', async () => {
    const pool = makePool();
    let captured = null;
    const result = await executePeerAction({
        pool,
        peer: peer(),
        localSiteCode: '10',
        actor: 'root',
        method: 'POST',
        path: '/api/gsm-dongles/reload/dongle1',
        body: { reason: 'test' },
        decryptFn: () => 'key',
        requestFn: async (target, actionPath, options) => {
            captured = { target, actionPath, options };
            return { status: 200, data: { success: true } };
        }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(captured.actionPath, '/api/gsm-dongles/reload/dongle1');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.withMeta, true);
    assert.equal(captured.options.localSiteCode, '10');

    const insert = pool.calls.find(c => /INSERT INTO .*action_log/i.test(c.sql));
    const update = pool.calls.find(c => /UPDATE .*action_log/i.test(c.sql));
    assert.ok(insert, 'the action must be logged before execution');
    assert.ok(update, 'the outcome must be logged after execution');
    assert.equal(insert.params[1], 'root');
    assert.match(insert.params[2], /^POST \/api\/gsm-dongles\/reload\/dongle1$/);
    assert.equal(update.params[0], 'ok');
});

test('Federation control: peer error status is preserved and logged', async () => {
    const pool = makePool();
    const result = await executePeerAction({
        pool,
        peer: peer(),
        localSiteCode: '10',
        actor: 'root',
        method: 'POST',
        path: '/api/gsm-dongles/send-sms',
        body: { to: '01000000000' },
        decryptFn: () => 'key',
        requestFn: async () => ({ status: 422, data: { success: false, error: 'bad number' } })
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.deepEqual(result.data, { success: false, error: 'bad number' });
    const update = pool.calls.find(c => /UPDATE .*action_log/i.test(c.sql));
    assert.equal(update.params[0], 'error');
});

test('Federation control: transport failures are reported as 502', async () => {
    const pool = makePool();
    const err = new Error('connect ECONNREFUSED');
    err.status = 503;
    const result = await executePeerAction({
        pool,
        peer: peer(),
        localSiteCode: '10',
        actor: 'root',
        method: 'POST',
        path: '/api/gsm-dongles/reload/dongle0',
        body: {},
        decryptFn: () => 'key',
        requestFn: async () => { throw err; }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.match(result.error, /ECONNREFUSED/);
});

test('Federation control: the gateway is central-only and super-admin-only', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    assert.match(server, /app\.post\('\/api\/federation\/peers\/:siteCode\/action', federationActionBodyParser, requireAuth/);
    assert.match(server, /panel_role !== 'central'/, 'peers must not expose the control gateway');
    assert.match(server, /Remote PBX control requires a super administrator/);

    // Peer side: signed federation requests are accepted on the operational API.
    assert.match(server, /app\.use\('\/api', federationAuthMiddleware\(\{[\s\S]*?optional: true[\s\S]*?skipPrefixes: \['\/federation'\][\s\S]*?denyPrefixes: \['\/auth', '\/admin', '\/config\/federation'\]/);

    // Root-only handlers must honour the federation trust model.
    assert.match(server, /function hasRootAccess\(req\)[\s\S]*?isFederationTrusted\(req\)/);
    assert.match(server, /function isSuperAdmin\(req\)[\s\S]*?isFederationTrusted\(req\)/);

    // The control shim is rendered by the scope selector on the central node.
    const selector = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'node-scope-selector.ejs'), 'utf8');
    assert.match(selector, /window\.__sokratFedControl/);
    assert.match(selector, /gateway: '\/api\/federation\/peers\/' \+ encodeURIComponent/);
    assert.match(selector, /isDenied\(url\.pathname\)/, 'the shim must never relay federation endpoints');
    assert.match(selector, /\^\\\/api\\\/config\\\/federation/, 'the shim must keep federation config writes local');
});

test('Federation control: dongle page aggregates every PBX with per-node control', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'gsm-dongles.ejs'), 'utf8');
    const selector = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'node-scope-selector.ejs'), 'utf8');

    // Every device carries its owning node and a composite key.
    assert.match(view, /nodeSite/, 'devices must be tagged with the owning node');
    assert.match(view, /function devKey\(/, 'device keys must be namespaced per node');
    assert.match(view, /function fedDongleFetch\(/, 'actions must be routed to the owning node');
    assert.match(view, /function buildDongleNodeDivider\(/, 'the grid must split devices per server');
    assert.match(view, /smsThreadKey\(/, 'SMS threads must be namespaced per server and dongle');
    assert.match(view, /reportCompositeKey\(/, 'report filters must be namespaced per server');

    // The single-node takeover shim must stay off on the aggregated page.
    assert.match(selector, /fedMultiNodePage/, 'the selector must know about multi-node pages');
    assert.match(view, /fedMultiNodePage: true/, 'the dongle console must disable the single-node shim');
    assert.doesNotMatch(view, /renderFederationRemoteDongles/, 'the read-only remote mirror is replaced by the merged grid');
});

test('Federation control: auto-dial tab aggregates every PBX with target node and per-node control', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'dialer.ejs'), 'utf8');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    // Scope selector included
    assert.match(view, /include\('partials\/node-scope-selector',\s*\{\s*fedMultiNodePage:\s*true\s*\}\)/, 'dialer must render the scope selector');

    // Routing and node dividers
    assert.match(view, /function fedDialerFetch\(/, 'dialer must define fedDialerFetch for remote actions');
    assert.match(view, /function buildCampaignNodeDivider\(/, 'dialer must divide campaigns per server');
    assert.match(view, /id="campTargetNode"/, 'modal must include target PBX selector for campaign creation');
    assert.match(view, /updateTargetPbxDropdown\(/, 'dialer must support updating target PBX dropdown');

    // Server-side campaigns aggregation
    assert.match(server, /app\.get\('\/api\/dialer\/campaigns'[\s\S]*?getFederationNodeReadModel/, 'campaigns endpoint must aggregate across federation nodes');
    assert.match(server, /app\.get\('\/api\/dialer\/attempts\/recent'[\s\S]*?getFederationNodeReadModel/, 'attempts endpoint must aggregate across federation nodes');
    assert.match(server, /req\.body\.fileBase64/, 'lead import must support base64 uploads for remote relay');
});

test('Federation control: gsm dongles monitor aggregates USB hardware and serial ports across nodes', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'gsm-dongles.ejs'), 'utf8');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    // Server-side aggregation
    assert.match(server, /app\.get\('\/api\/gsm-dongles\/ttyusb-devices'[\s\S]*?getFederationNodeReadModel/, 'ttyusb-devices endpoint must aggregate across federation nodes');

    // View renders dividers and node tags
    assert.match(view, /function buildUsbNodeDivider\(/, 'view must define buildUsbNodeDivider for multi-server USB hardware');
    assert.match(view, /getUsbSignature[\s\S]*?nodeSite/, 'USB signature must track nodeSite');
});
