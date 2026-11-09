'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
    TABLE_SQL,
    PJSIP_BEGIN,
    PJSIP_END,
    normalizeExtensions,
    normalizeOrigins,
    sanitizeCallerName,
    slugifyTenantName,
    renderGuestPjsipBlock,
    renderWebguestDialplan,
    replaceManagedBlock,
    callError
} = require('../lib/tenant-calls');
const createTenantCallsRouter = require('../routes/tenant-calls');

test('cloud tenant schema exists in install_db.sql', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'backend', 'install_db.sql'), 'utf8');
    for (const table of [
        'sokrat_tenants',
        'sokrat_tenant_links',
        'sokrat_tenant_agents',
        'sokrat_guest_endpoints',
        'sokrat_web_sessions'
    ]) {
        assert.match(sql, new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '`'), `${table} must exist`);
    }
    assert.match(sql, /UNIQUE KEY `uq_sokrat_guest_sip_username` \(`sip_username`\)/);
    assert.match(sql, /KEY `idx_sokrat_web_sessions_tenant` \(`tenant_id`, `status`, `started_at`\)/);
});

test('all deployment paths apply the cloud tenant schema', () => {
    for (const file of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const script = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.match(script, /backend\/install_db\.sql/, `${file} must apply backend/install_db.sql`);
    }
});

test('tenant extensions and origins are normalized and deduplicated', () => {
    assert.deepEqual(normalizeExtensions('101, 102;bad 101'), ['101', '102']);
    assert.deepEqual(normalizeExtensions(['103', ' 104 ', '', 'x']), ['103', '104']);
    assert.deepEqual(normalizeOrigins(['https://acme.example/page', 'bad', 'http://www.acme.example']), [
        'https://acme.example',
        'http://www.acme.example'
    ]);
    assert.equal(sanitizeCallerName('Acme, Inc. "Sales"'), 'Acme Inc. Sales');
    assert.equal(slugifyTenantName('Acme Test Ltd.'), 'acme-test-ltd');
    assert.equal(slugifyTenantName('شركة أكمي'), 'business');
});

test('guest PJSIP endpoints are isolated from from-internal and can only use the tenant context', () => {
    const block = renderGuestPjsipBlock([{
        id: 7,
        name: 'Acme',
        ring_group: '7007',
        endpoints: [{ sip_username: 'wg_7_ab12', secret: 'secret-123' }]
    }]);
    assert.match(block, /context=from-webguest-7/);
    assert.match(block, /accountcode=WEB7/);
    assert.match(block, /max_contacts=1/);
    assert.match(block, /auth=wg_7_ab12_auth/);
    assert.match(block, /aors=wg_7_ab12\n/);
    assert.match(block, /\[wg_7_ab12\]\ntype=aor/);
    assert.match(block, /password=secret-123/);
    assert.doesNotMatch(block, /context=from-internal/);
});

test('web guest dialplan only routes to the tenant ring group and hangs up everything else', () => {
    const dialplan = renderWebguestDialplan([{
        id: 7,
        name: 'Acme, Inc.',
        ring_group: '7007'
    }]);
    assert.match(dialplan, /\[from-webguest-7\]/);
    assert.match(dialplan, /Goto\(ext-group,7007,1\)/);
    assert.match(dialplan, /CDR\(accountcode\)=WEB7/);
    assert.match(dialplan, /exten => _\.,1,Hangup\(21\)/);
    assert.match(dialplan, /CALLERID\(name\)=Acme Inc\. Web Visitor/);
    assert.doesNotMatch(dialplan, /from-internal/);
});

test('managed PJSIP block replacement preserves unrelated configuration', () => {
    const existing = [
        '[101](+)',
        'webrtc=yes',
        '',
        PJSIP_BEGIN,
        '[old]',
        PJSIP_END,
        '',
        '[102](+)',
        'webrtc=yes'
    ].join('\n');
    const next = replaceManagedBlock(existing, PJSIP_BEGIN, PJSIP_END, `${PJSIP_BEGIN}\n[new]\n${PJSIP_END}`);
    assert.match(next, /\[101\]\(\+\)/);
    assert.match(next, /\[102\]\(\+\)/);
    assert.match(next, /\[new\]/);
    assert.doesNotMatch(next, /\[old\]/);
});

function makeFakeService(overrides = {}) {
    return {
        config: { publicBaseUrl: 'https://pbx.example', wssUrl: '', sipDomain: '' },
        allocateSession: async () => ({
            id: 'a'.repeat(32),
            tenant_id: 1,
            tenant_name: 'Acme',
            link_id: 2,
            link_slug: 'acme-link',
            caller_id: 'web123456',
            extension: 'wg_1_ab12',
            password: 'secret',
            target: 'call',
            sip_domain: '',
            wss_url: '',
            max_call_seconds: 1800,
            expires_at: new Date().toISOString(),
            ice_servers: []
        }),
        getSession: async () => ({ id: 'a'.repeat(32), status: 'pending' }),
        endSession: async () => ({ id: 'a'.repeat(32), status: 'ended' }),
        listTenants: async () => [{
            id: 1,
            public_id: 'acme',
            name: 'Acme',
            status: 'active',
            ring_group: '7001',
            pool_total: 5,
            pool_free: 5,
            active_sessions: 0,
            active_links: 1
        }],
        getTenant: async () => ({
            id: 1,
            public_id: 'acme',
            name: 'Acme',
            status: 'active',
            ring_group: '7001',
            links: [{ id: 2, slug: 'acme-link', active: true, allowed_origins: [] }],
            agents: ['101'],
            sessions: []
        }),
        createTenant: async () => ({
            tenant: { id: 1, public_id: 'acme', name: 'Acme', status: 'active', ring_group: '7001' },
            link: { id: 2, slug: 'acme-link', public_url: 'https://pbx.example/c/acme-link' }
        }),
        updateTenant: async () => ({ id: 1, status: 'suspended' }),
        deleteTenant: async () => ({ success: true }),
        createLink: async () => ({ id: 2, slug: 'acme-link' }),
        updateLink: async () => ({ id: 2, slug: 'acme-link' }),
        deleteLink: async () => ({ success: true }),
        getUsage: async () => ({ total_calls: 0 }),
        syncConfig: async () => ({ tenants: 1, endpoints: 5 }),
        ...overrides
    };
}

async function withServer(service, isRootRequest, fn) {
    const app = express();
    app.use(express.json());
    app.use('/api', createTenantCallsRouter(service, { isRootRequest }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address();
    try {
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('public session API returns short-lived credentials without a login', async () => {
    await withServer(makeFakeService(), () => false, async base => {
        const response = await fetch(`${base}/api/public/call-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'pbx.example' },
            body: JSON.stringify({ tenant: 'acme', link: 'acme-link' })
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.session.extension, 'wg_1_ab12');
        assert.equal(body.session.target, 'call');
        assert.equal(body.session.wss_url, 'wss://pbx.example/ws');
        assert.equal(body.session.sip_domain, 'pbx.example');
    });
});

test('public session API maps pool exhaustion to 503', async () => {
    const service = makeFakeService({
        allocateSession: async () => { throw callError('POOL_EXHAUSTED', 'All guest lines are busy.', 503); }
    });
    await withServer(service, () => false, async base => {
        const response = await fetch(`${base}/api/public/call-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenant: 'acme' })
        });
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.code, 'POOL_EXHAUSTED');
    });
});

test('tenant management API requires root', async () => {
    await withServer(makeFakeService(), () => false, async base => {
        const response = await fetch(`${base}/api/admin/tenants`);
        assert.equal(response.status, 403);
    });
});

test('root can create a tenant and receives its public link', async () => {
    await withServer(makeFakeService(), () => true, async base => {
        const response = await fetch(`${base}/api/admin/tenants`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Acme', agent_extensions: '101' })
        });
        assert.equal(response.status, 201);
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.link.public_url, 'https://pbx.example/c/acme-link');
    });
});

test('cloud tenants are managed through the combined B&C page for root users only', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /app\.get\('\/customers'[\s\S]{0,800}initialView/);
    assert.match(server, /app\.get\('\/tenants'[\s\S]{0,160}if \(!isRootSession\(req\)\)/);
    assert.match(server, /view=businesses/);
    assert.match(server, /isRootRequest: \(req\) => isRootSession\(req\)/);
    assert.doesNotMatch(server, /isRootRequest: \(req\) => hasRootAccess\(req\)/);
    const sidebar = fs.readFileSync(path.join(__dirname, '..', 'views', 'sidebar.ejs'), 'utf8');
    assert.match(sidebar, /href="\/customers[\s\S]{0,160}title="B&C"/);
    assert.doesNotMatch(sidebar, /Cloud Tenants/);
});

test('dashboard users can be bound to a cloud tenant and are data-scoped', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'backend', 'install_db.sql'), 'utf8');
    assert.match(sql, /`tenant_id` INT UNSIGNED DEFAULT NULL/);
    assert.match(sql, /ADD `tenant_id` INT UNSIGNED DEFAULT NULL/);
    for (const file of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const script = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.match(script, /ensure_db_column "dashboard_users" "tenant_id" "INT UNSIGNED DEFAULT NULL"/);
    }
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /req\.session\.tenantId = tenantId/);
    assert.match(server, /tenantAccountcode: getTenantAccountcode\(req\)/);
    assert.match(server, /filters\.tenantAccountcode \? ' AND c\.accountcode = \?'/);
    assert.match(server, /AND accountcode = \?/);
    assert.match(server, /Business accounts cannot export the full server archive/);
    const usersView = fs.readFileSync(path.join(__dirname, '..', 'views', 'users.ejs'), 'utf8');
    assert.match(usersView, /id="createTenantId"/);
    assert.match(usersView, /id="editUserTenantId"/);
    assert.match(usersView, /data-tenantid=/);
});
