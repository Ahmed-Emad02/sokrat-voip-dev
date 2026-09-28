const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

// Import permissions structure from server.js
const serverJsContent = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

// Extract PERMISSION_CATEGORIES and ALL_TABS directly from server.js
const categoriesMatch = serverJsContent.match(/const PERMISSION_CATEGORIES = (\[[\s\S]*?\]);\s*const ALL_TABS/);
assert.ok(categoriesMatch, 'PERMISSION_CATEGORIES must be declared in server.js');
const PERMISSION_CATEGORIES = eval(categoriesMatch[1]);

const allTabsMatch = serverJsContent.match(/const ALL_TABS = Array\.from\(new Set\(\[([\s\S]*?)\]\)\);/);
assert.ok(allTabsMatch, 'ALL_TABS must be declared in server.js');
const ALL_TABS = Array.from(new Set([
    ...PERMISSION_CATEGORIES.flatMap(c => c.permissions.map(p => p.key)),
    'cdr', 'dialer', 'softphone', 'users'
]));

// Helpers mirroring server.js middleware
function isSuperAdmin(req) {
    if (!req || !req.session) return false;
    if (req.session.isRoot || req.session.username === 'root') return true;
    const g = String(req.session.userGroup || '').toLowerCase().trim();
    return g === 'super admins' || g === 'super admin' || g === 'administrator' || g === 'administrators';
}

function requireActionPermission(actionPermission) {
    return (req, res, next) => {
        if (isSuperAdmin(req)) return next();
        const perms = req.session.userPermissions || [];
        if (perms.includes(actionPermission)) {
            return next();
        }
        return res.status(403).json({ success: false, error: `Forbidden. Missing permission: ${actionPermission}` });
    };
}

function requireConfigPermission(subTab) {
    return (req, res, next) => {
        if (isSuperAdmin(req)) return next();
        const perms = req.session.userPermissions || [];
        if (perms.includes('config') || perms.includes('config-' + subTab)) {
            return next();
        }
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    };
}

function resolveGroupPermissions(tabs) {
    const selectedTabs = Array.isArray(tabs) ? tabs : (tabs ? [tabs] : []);
    const hasParent = (parentKey) => selectedTabs.includes(parentKey);
    const filteredTabs = selectedTabs.filter(tab => {
        if (!ALL_TABS.includes(tab)) return false;
        if (tab.startsWith('operator-')) return hasParent('operator');
        if (tab.startsWith('cdr-')) return hasParent('call_history') || hasParent('cdr');
        if (tab.startsWith('gsm-')) return hasParent('gsm-dongles');
        if (tab.startsWith('campaigns-')) return hasParent('campaigns') || hasParent('dialer');
        if (tab.startsWith('contacts-')) return hasParent('contacts');
        if (tab.startsWith('voicemail-')) return hasParent('voicemails');
        if (tab.startsWith('storage-') || tab.startsWith('system-')) return hasParent('storage');
        if (tab.startsWith('config-')) return hasParent('config');
        return true;
    });

    if (filteredTabs.includes('call_history') && !filteredTabs.includes('cdr')) {
        filteredTabs.push('cdr');
    }
    if (filteredTabs.includes('campaigns') && !filteredTabs.includes('dialer')) {
        filteredTabs.push('dialer');
    }
    return filteredTabs;
}

function mockResponse() {
    return {
        statusCode: 200,
        _json: null,
        _redirect: null,
        status(code) { this.statusCode = code; return this; },
        json(data) { this._json = data; return this; },
        redirect(url) { this._redirect = url; return this; }
    };
}

// -------------------------------------------------------------
// TEST SUITE: Complete Permissions Catalog and Verification
// -------------------------------------------------------------

test('1. PERMISSION_CATEGORIES covers all 9 categories and 55 unique permissions', () => {
    const expectedCategories = ['pages', 'operator', 'call_history', 'gsm', 'campaigns', 'contacts', 'voicemails', 'storage', 'config'];
    assert.deepEqual(PERMISSION_CATEGORIES.map(c => c.id), expectedCategories, 'All 9 permission categories must exist');

    const totalPermissions = PERMISSION_CATEGORIES.reduce((acc, cat) => acc + cat.permissions.length, 0);
    assert.equal(totalPermissions, 55, 'There must be exactly 55 granular permissions defined');

    // Every permission key in every category must be present in ALL_TABS
    for (const cat of PERMISSION_CATEGORIES) {
        for (const p of cat.permissions) {
            assert.ok(ALL_TABS.includes(p.key), `ALL_TABS must include permission key: ${p.key}`);
            assert.ok(p.label && p.label.length > 0, `Permission ${p.key} must have English label`);
            assert.ok(p.labelAr && p.labelAr.length > 0, `Permission ${p.key} must have Arabic label`);
        }
    }
});

test('2. Verification of all action permissions with requireActionPermission', () => {
    const actionCategories = ['operator', 'call_history', 'gsm', 'campaigns', 'contacts', 'voicemails', 'storage'];
    const actionKeys = PERMISSION_CATEGORIES
        .filter(c => actionCategories.includes(c.id))
        .flatMap(c => c.permissions.map(p => p.key));

    assert.equal(actionKeys.length, 29, 'There must be 29 action permission keys across 7 categories');

    for (const key of actionKeys) {
        const middleware = requireActionPermission(key);

        // Case A: User with the exact permission -> Allowed
        let nextCalled = false;
        const resAllowed = mockResponse();
        middleware({ session: { userPermissions: [key] } }, resAllowed, () => { nextCalled = true; });
        assert.equal(nextCalled, true, `Action permission ${key} must call next() when granted`);
        assert.equal(resAllowed.statusCode, 200);

        // Case B: User lacking the permission -> 403 Forbidden
        let nextDenied = false;
        const resDenied = mockResponse();
        middleware({ session: { userPermissions: ['other_perm'] } }, resDenied, () => { nextDenied = true; });
        assert.equal(nextDenied, false, `Action permission ${key} must NOT call next() when missing`);
        assert.equal(resDenied.statusCode, 403, `Action permission ${key} must return HTTP 403`);
        assert.equal(resDenied._json?.success, false);
        assert.match(resDenied._json?.error, new RegExp(key), `Error message must reference missing permission ${key}`);

        // Case C: Super admin / root -> Always allowed regardless of permissions
        let rootNextCalled = false;
        const resRoot = mockResponse();
        middleware({ session: { isRoot: true, userPermissions: [] } }, resRoot, () => { rootNextCalled = true; });
        assert.equal(rootNextCalled, true, `Super admin must bypass permission check for ${key}`);
    }
});

test('3. Verification of all 16 PBX configuration sub-tab permissions with requireConfigPermission', () => {
    const configCategory = PERMISSION_CATEGORIES.find(c => c.id === 'config');
    assert.ok(configCategory, 'Config category must exist');
    assert.equal(configCategory.permissions.length, 16, 'Config category must have 16 sub-tab permissions');

    for (const p of configCategory.permissions) {
        const subTab = p.key.replace(/^config-/, '');
        const middleware = requireConfigPermission(subTab);

        // Case A: User has the specific subtab permission (e.g., config-extensions) -> Allowed
        let nextAllowedSpecific = false;
        const resSpecific = mockResponse();
        middleware({ session: { userPermissions: [p.key] } }, resSpecific, () => { nextAllowedSpecific = true; });
        assert.equal(nextAllowedSpecific, true, `User with ${p.key} must be allowed access to ${subTab}`);

        // Case B: User has the master 'config' permission -> Allowed (inherits all subtabs)
        let nextAllowedMaster = false;
        const resMaster = mockResponse();
        middleware({ session: { userPermissions: ['config'] } }, resMaster, () => { nextAllowedMaster = true; });
        assert.equal(nextAllowedMaster, true, `User with master 'config' must be allowed access to ${subTab}`);

        // Case C: User has unrelated permission -> 403 Forbidden
        let nextDenied = false;
        const resDenied = mockResponse();
        middleware({ session: { userPermissions: ['dashboard'] } }, resDenied, () => { nextDenied = true; });
        assert.equal(nextDenied, false, `User lacking ${p.key} and 'config' must be rejected from ${subTab}`);
        assert.equal(resDenied.statusCode, 403);

        // Case D: Root / Super admin -> Always allowed
        let nextAllowedRoot = false;
        const resRoot = mockResponse();
        middleware({ session: { isRoot: true, userPermissions: [] } }, resRoot, () => { nextAllowedRoot = true; });
        assert.equal(nextAllowedRoot, true, `Root must bypass config permission for ${subTab}`);
    }
});

test('4. Verification of group permission resolution and parent-child hierarchy across all categories', () => {
    // Check every category with sub-actions
    const hierarchyPairs = [
        { parent: 'operator', sub: 'operator-barge' },
        { parent: 'call_history', sub: 'cdr-export' },
        { parent: 'gsm-dongles', sub: 'gsm-sms-send' },
        { parent: 'campaigns', sub: 'campaigns-manage' },
        { parent: 'contacts', sub: 'contacts-create' },
        { parent: 'voicemails', sub: 'voicemail-listen' },
        { parent: 'storage', sub: 'storage-export' },
        { parent: 'config', sub: 'config-trunks' }
    ];

    for (const pair of hierarchyPairs) {
        // Without parent: sub-action is stripped
        const stripped = resolveGroupPermissions([pair.sub]);
        assert.equal(stripped.includes(pair.sub), false, `Sub-action ${pair.sub} must be stripped when parent ${pair.parent} is omitted`);

        // With parent: sub-action is retained
        const retained = resolveGroupPermissions([pair.parent, pair.sub]);
        assert.ok(retained.includes(pair.parent), `Parent ${pair.parent} must be retained`);
        assert.ok(retained.includes(pair.sub), `Sub-action ${pair.sub} must be retained when parent ${pair.parent} is present`);
    }

    // Full catalog grant: all 55 permissions granted with parents
    const allKeys = PERMISSION_CATEGORIES.flatMap(c => c.permissions.map(p => p.key));
    const allResolved = resolveGroupPermissions(allKeys);
    for (const key of allKeys) {
        assert.ok(allResolved.includes(key), `Full grant must include ${key}`);
    }
    // Aliases must be auto-injected
    assert.ok(allResolved.includes('cdr'), 'cdr alias must be present when call_history is granted');
    assert.ok(allResolved.includes('dialer'), 'dialer alias must be present when campaigns is granted');
});

test('5. Verification of Sidebar navigation visibility for all 10 main pages', async () => {
    const sidebarEjsPath = path.join(__dirname, '../views/sidebar.ejs');
    const pageKeys = [
        { key: 'dashboard', url: '/?lang=' },
        { key: 'call_history', url: '/cdr?lang=' },
        { key: 'operator', url: '/operator?lang=' },
        { key: 'ext-stats', url: '/ext-stats?lang=' },
        { key: 'contacts', url: '/contacts?lang=' },
        { key: 'voicemails', url: '/voicemails?lang=' },
        { key: 'gsm-dongles', url: '/gsm-dongles?lang=' },
        { key: 'campaigns', url: '/dialer?lang=' },
        { key: 'storage', url: '/storage?lang=' },
        { key: 'config', url: '/config?lang=' }
    ];

    for (const page of pageKeys) {
        // When allowedTabs contains ONLY this page
        const allowedHtml = await ejs.renderFile(sidebarEjsPath, {
            currentLang: 'en',
            currentPage: '/',
            isRtl: false,
            isSuperAdmin: false,
            isRootUser: false,
            currentUser: 'test_user',
            allowedTabs: [page.key]
        });

        assert.ok(allowedHtml.includes(page.url), `Sidebar must render link for ${page.key} (${page.url})`);

        // Check that other pages are NOT rendered
        for (const other of pageKeys) {
            if (other.key !== page.key) {
                assert.equal(
                    allowedHtml.includes(other.url),
                    false,
                    `Sidebar must NOT render unpermitted page ${other.key} when only ${page.key} is granted`
                );
            }
        }
    }
});

test('6. Verification of requireTabPermission across all tabs and backward-compatibility aliases', () => {
    function requireTabPermission(tabName) {
        return (req, res, next) => {
            if (isSuperAdmin(req)) return next();
            const perms = req.session.userPermissions || [];
            if (perms.includes(tabName)) return next();
            if (tabName === 'call_history' && perms.includes('cdr')) return next();
            if (tabName === 'cdr' && perms.includes('call_history')) return next();
            if (tabName === 'campaigns' && perms.includes('dialer')) return next();
            if (tabName === 'dialer' && perms.includes('campaigns')) return next();
            return res.status(403).json({ success: false, error: `Forbidden: Missing ${tabName} permission` });
        };
    }

    const testTabs = [
        'dashboard', 'call_history', 'cdr', 'operator', 'ext-stats',
        'contacts', 'voicemails', 'gsm-dongles', 'campaigns', 'dialer',
        'storage', 'config'
    ];

    for (const tab of testTabs) {
        const middleware = requireTabPermission(tab);

        // Case A: User has exact permission
        let nextAllowed = false;
        const resAllowed = mockResponse();
        middleware({ session: { userPermissions: [tab] } }, resAllowed, () => { nextAllowed = true; });
        assert.equal(nextAllowed, true, `requireTabPermission(${tab}) must allow user with permission`);

        // Case B: User has alias (cdr <-> call_history, campaigns <-> dialer)
        if (tab === 'call_history' || tab === 'cdr') {
            const alias = (tab === 'call_history' ? 'cdr' : 'call_history');
            let aliasNext = false;
            const resAlias = mockResponse();
            middleware({ session: { userPermissions: [alias] } }, resAlias, () => { aliasNext = true; });
            assert.equal(aliasNext, true, `requireTabPermission(${tab}) must accept alias ${alias}`);
        }
        if (tab === 'campaigns' || tab === 'dialer') {
            const alias = (tab === 'campaigns' ? 'dialer' : 'campaigns');
            let aliasNext = false;
            const resAlias = mockResponse();
            middleware({ session: { userPermissions: [alias] } }, resAlias, () => { aliasNext = true; });
            assert.equal(aliasNext, true, `requireTabPermission(${tab}) must accept alias ${alias}`);
        }

        // Case C: User lacks permission
        let nextDenied = false;
        const resDenied = mockResponse();
        middleware({ session: { userPermissions: ['unrelated_tab'] } }, resDenied, () => { nextDenied = true; });
        assert.equal(nextDenied, false, `requireTabPermission(${tab}) must deny user without permission`);
        assert.equal(resDenied.statusCode, 403);
        assert.match(resDenied._json?.error, new RegExp(`Missing ${tab} permission`));

        // Case D: Super admin bypass
        let nextAdmin = false;
        const resAdmin = mockResponse();
        middleware({ session: { isRoot: true, userPermissions: [] } }, resAdmin, () => { nextAdmin = true; });
        assert.equal(nextAdmin, true, `requireTabPermission(${tab}) must allow super admin bypass`);
    }
});

test('7. Verification of getFirstAllowedRoute across tabs and hierarchical sub-action prefixes', () => {
    function getFirstAllowedRoute(perms) {
        if (!perms || !Array.isArray(perms) || perms.length === 0) return null;
        const tabToRoute = {
            dashboard: '/',
            call_history: '/cdr',
            cdr: '/cdr',
            operator: '/operator',
            'ext-stats': '/ext-stats',
            contacts: '/contacts',
            voicemails: '/voicemails',
            'gsm-dongles': '/gsm-dongles',
            campaigns: '/dialer',
            dialer: '/dialer',
            storage: '/storage',
            config: '/config'
        };
        for (const p of perms) {
            if (tabToRoute[p]) return tabToRoute[p];
            if (p.startsWith('config-')) return '/config';
            if (p.startsWith('operator-')) return '/operator';
            if (p.startsWith('cdr-')) return '/cdr';
            if (p.startsWith('gsm-')) return '/gsm-dongles';
            if (p.startsWith('campaigns-')) return '/dialer';
            if (p.startsWith('contacts-')) return '/contacts';
            if (p.startsWith('voicemail-')) return '/voicemails';
            if (p.startsWith('storage-') || p.startsWith('system-')) return '/storage';
        }
        return null;
    }

    assert.equal(getFirstAllowedRoute(null), null);
    assert.equal(getFirstAllowedRoute([]), null);
    assert.equal(getFirstAllowedRoute(['dashboard']), '/');
    assert.equal(getFirstAllowedRoute(['call_history']), '/cdr');
    assert.equal(getFirstAllowedRoute(['cdr']), '/cdr');
    assert.equal(getFirstAllowedRoute(['operator']), '/operator');
    assert.equal(getFirstAllowedRoute(['ext-stats']), '/ext-stats');
    assert.equal(getFirstAllowedRoute(['contacts']), '/contacts');
    assert.equal(getFirstAllowedRoute(['voicemails']), '/voicemails');
    assert.equal(getFirstAllowedRoute(['gsm-dongles']), '/gsm-dongles');
    assert.equal(getFirstAllowedRoute(['campaigns']), '/dialer');
    assert.equal(getFirstAllowedRoute(['dialer']), '/dialer');
    assert.equal(getFirstAllowedRoute(['storage']), '/storage');
    assert.equal(getFirstAllowedRoute(['config']), '/config');

    // Hierarchical prefixes
    assert.equal(getFirstAllowedRoute(['config-extensions']), '/config');
    assert.equal(getFirstAllowedRoute(['operator-barge']), '/operator');
    assert.equal(getFirstAllowedRoute(['cdr-audio-listen']), '/cdr');
    assert.equal(getFirstAllowedRoute(['gsm-sms-send']), '/gsm-dongles');
    assert.equal(getFirstAllowedRoute(['campaigns-manage']), '/dialer');
    assert.equal(getFirstAllowedRoute(['contacts-create']), '/contacts');
    assert.equal(getFirstAllowedRoute(['voicemail-listen']), '/voicemails');
    assert.equal(getFirstAllowedRoute(['storage-export']), '/storage');
    assert.equal(getFirstAllowedRoute(['system-metrics']), '/storage');
});

test('8. Verification of TAB_ROUTE_MAP middleware route gating and hierarchical access', async () => {
    const TAB_ROUTE_MAP = {
        '/': 'dashboard',
        '/cdr': 'call_history',
        '/voicemails': 'voicemails',
        '/ext-stats': 'ext-stats',
        '/operator': 'operator',
        '/gsm-dongles': 'gsm-dongles',
        '/contacts': 'contacts',
        '/users': 'users',
        '/config': 'config',
        '/dialer': 'campaigns',
        '/storage': 'storage'
    };

    function tabRouteMiddleware(req, res, next) {
        res.locals = res.locals || {};
        res.locals.isSuperAdmin = isSuperAdmin(req);
        res.locals.isRootUser = Boolean(req.session && (req.session.isRoot || req.session.username === 'root'));
        const tab = TAB_ROUTE_MAP[req.path];
        if (!tab) return next();

        if (tab === 'users') {
            if (!res.locals.isSuperAdmin) {
                const first = ['/'].includes(req.session?.userPermissions?.[0]) ? '/' : '/no-access';
                return res.redirect(first);
            }
            res.locals.allowedTabs = ALL_TABS;
            return next();
        }

        if (res.locals.isSuperAdmin) {
            res.locals.allowedTabs = ALL_TABS;
            return next();
        }

        const userPerms = req.session.userPermissions || [];
        res.locals.allowedTabs = userPerms;
        if (userPerms.includes(tab) || (tab === 'call_history' && userPerms.includes('cdr')) || (tab === 'campaigns' && userPerms.includes('dialer'))) return next();
        if (tab === 'operator' && userPerms.some(p => p.startsWith('operator-'))) return next();
        if ((tab === 'call_history' || tab === 'cdr') && userPerms.some(p => p.startsWith('cdr-'))) return next();
        if (tab === 'gsm-dongles' && userPerms.some(p => p.startsWith('gsm-'))) return next();
        if (tab === 'config' && userPerms.some(p => p.startsWith('config-'))) return next();

        return res.status(403).json({ success: false, error: 'Access Denied', tab });
    }

    // 1. Super admin has access to every single route including /users
    for (const route of Object.keys(TAB_ROUTE_MAP)) {
        let nextAllowed = false;
        const res = mockResponse();
        tabRouteMiddleware({ path: route, session: { isRoot: true } }, res, () => { nextAllowed = true; });
        assert.equal(nextAllowed, true, `Super admin must be allowed access to ${route}`);
    }

    // 2. Non-super admin is strictly blocked from /users
    let usersNext = false;
    const usersRes = mockResponse();
    tabRouteMiddleware({ path: '/users', session: { userPermissions: ['dashboard', 'contacts'] } }, usersRes, () => { usersNext = true; });
    assert.equal(usersNext, false, 'Non-super admin must be blocked from /users');
    assert.ok(usersRes._redirect, 'Non-super admin must be redirected when trying to access /users');

    // 3. User with specific tab permission is granted access
    for (const [route, tab] of Object.entries(TAB_ROUTE_MAP)) {
        if (tab === 'users') continue;
        let nextAllowed = false;
        const res = mockResponse();
        tabRouteMiddleware({ path: route, session: { userPermissions: [tab] } }, res, () => { nextAllowed = true; });
        assert.equal(nextAllowed, true, `User with tab permission ${tab} must be allowed to access ${route}`);
    }

    // 4. Hierarchical sub-action access
    const hierarchicalChecks = [
        { path: '/operator', perm: 'operator-hijack' },
        { path: '/cdr', perm: 'cdr-audio-listen' },
        { path: '/gsm-dongles', perm: 'gsm-control' },
        { path: '/config', perm: 'config-announcements' }
    ];

    for (const check of hierarchicalChecks) {
        let nextAllowed = false;
        const res = mockResponse();
        tabRouteMiddleware({ path: check.path, session: { userPermissions: [check.perm] } }, res, () => { nextAllowed = true; });
        assert.equal(nextAllowed, true, `Sub-action ${check.perm} must grant hierarchical access to view ${check.path}`);
    }
});

test('9. Live Database & User-Group Lifecycle Verification for Permissions', async () => {
    require('dotenv').config({ path: path.join(__dirname, '../.env') });
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || 'admin',
        database: process.env.ASTERISK_DB || 'asterisk'
    });

    try {
        // Clean up any stale artifacts
        await conn.execute("DELETE FROM dashboard_users WHERE username = '__perm_verify_user__'");
        await conn.execute("DELETE FROM dashboard_groups WHERE name = '__perm_verify_group__'");

        // 1. Create test group
        const [grpRes] = await conn.execute("INSERT INTO dashboard_groups (name) VALUES ('__perm_verify_group__')");
        const groupId = grpRes.insertId;
        assert.ok(groupId > 0, 'Group ID must be a positive integer');

        // 2. Simulate POST /groups/permissions with full permission set
        const fullPerms = PERMISSION_CATEGORIES.flatMap(c => c.permissions.map(p => p.key));
        const resolved1 = resolveGroupPermissions(fullPerms);

        await conn.execute('DELETE FROM dashboard_group_permissions WHERE group_id = ?', [groupId]);
        for (const tab of resolved1) {
            await conn.execute('INSERT INTO dashboard_group_permissions (group_id, tab) VALUES (?, ?)', [groupId, tab]);
        }

        const [rows1] = await conn.execute('SELECT tab FROM dashboard_group_permissions WHERE group_id = ? ORDER BY tab ASC', [groupId]);
        const savedTabs1 = rows1.map(r => r.tab);
        assert.ok(savedTabs1.length >= 55, 'All permissions should be stored in database');
        assert.ok(savedTabs1.includes('cdr'), 'cdr alias must be present');
        assert.ok(savedTabs1.includes('dialer'), 'dialer alias must be present');

        // 3. Create test user and verify getUserPermissions SQL query
        const [userRes] = await conn.execute(
            "INSERT INTO dashboard_users (username, password_hash, group_id) VALUES ('__perm_verify_user__', 'hash', ?)",
            [groupId]
        );
        const userId = userRes.insertId;

        const [userPermRows] = await conn.execute(`
            SELECT p.tab FROM dashboard_group_permissions p
            JOIN dashboard_users u ON u.group_id = p.group_id
            WHERE u.id = ?
        `, [userId]);
        const userPerms = userPermRows.map(r => r.tab);
        assert.deepEqual(userPerms.sort(), savedTabs1.sort(), 'User must inherit all group permissions from database');

        // 4. Update group permissions: test parent-child filtering live
        const orphanPerms = ['operator-listen', 'cdr-delete', 'campaigns-manage', 'gsm-ussd'];
        const resolved2 = resolveGroupPermissions(orphanPerms);
        assert.deepEqual(resolved2, [], 'Orphan sub-actions must be completely filtered out');

        await conn.execute('DELETE FROM dashboard_group_permissions WHERE group_id = ?', [groupId]);
        for (const tab of resolved2) {
            await conn.execute('INSERT INTO dashboard_group_permissions (group_id, tab) VALUES (?, ?)', [groupId, tab]);
        }
        const [rows2] = await conn.execute('SELECT tab FROM dashboard_group_permissions WHERE group_id = ?', [groupId]);
        assert.equal(rows2.length, 0, 'No permissions should be in DB when sub-actions lack parent');

        // 5. Submit valid subset: operator + operator-listen
        const subset = ['operator', 'operator-listen', 'operator-barge'];
        const resolved3 = resolveGroupPermissions(subset);
        await conn.execute('DELETE FROM dashboard_group_permissions WHERE group_id = ?', [groupId]);
        for (const tab of resolved3) {
            await conn.execute('INSERT INTO dashboard_group_permissions (group_id, tab) VALUES (?, ?)', [groupId, tab]);
        }
        const [rows3] = await conn.execute('SELECT tab FROM dashboard_group_permissions WHERE group_id = ? ORDER BY tab ASC', [groupId]);
        assert.deepEqual(rows3.map(r => r.tab).sort(), subset.sort(), 'Subset permissions must be accurately persisted');

        // 6. Test Single string input (simulating single checkbox checked in form body)
        const resolvedSingle = resolveGroupPermissions('contacts');
        assert.deepEqual(resolvedSingle, ['contacts']);
        await conn.execute('DELETE FROM dashboard_group_permissions WHERE group_id = ?', [groupId]);
        for (const tab of resolvedSingle) {
            await conn.execute('INSERT INTO dashboard_group_permissions (group_id, tab) VALUES (?, ?)', [groupId, tab]);
        }
        const [rowsSingle] = await conn.execute('SELECT tab FROM dashboard_group_permissions WHERE group_id = ?', [groupId]);
        assert.deepEqual(rowsSingle.map(r => r.tab), ['contacts']);

        // 7. Cleanup test user and group
        await conn.execute('DELETE FROM dashboard_users WHERE id = ?', [userId]);
        await conn.execute('DELETE FROM dashboard_group_permissions WHERE group_id = ?', [groupId]);
        await conn.execute('DELETE FROM dashboard_groups WHERE id = ?', [groupId]);

        const [leftoverPerms] = await conn.execute('SELECT * FROM dashboard_group_permissions WHERE group_id = ?', [groupId]);
        assert.equal(leftoverPerms.length, 0, 'No leftover permissions should remain');
    } finally {
        await conn.end();
    }
});
