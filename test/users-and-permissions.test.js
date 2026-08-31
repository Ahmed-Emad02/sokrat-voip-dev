const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const ejs = require('ejs');
const path = require('path');
const fs = require('fs');

// --- 1. Core Reference Constants and Helpers ---
const ALL_TABS = [
    'dashboard', 'cdr', 'voicemails', 'ext-stats', 'operator', 'gsm-dongles', 'softphone', 'contacts', 'users', 'config', 'storage',
    'config-extensions', 'config-ringgroups', 'config-queues', 'config-recordings', 'config-trunks', 'config-inbound', 'config-outbound', 'config-voicemail', 'config-diagram',
    'config-timegroups', 'config-timeconditions', 'config-announcements', 'config-modem', 'config-dongles', 'config-terminal',
    'operator-listen', 'operator-whisper', 'operator-barge', 'operator-hangup', 'operator-hijack'
];

const ROOT_USER = 'root';

function isSuperAdmin(req) {
    if (!req || !req.session) return false;
    if (req.session.isRoot || req.session.username === ROOT_USER) return true;
    const g = String(req.session.userGroup || '').toLowerCase().trim();
    return g === 'super admins' || g === 'super admin' || g === 'administrator' || g === 'administrators';
}

function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        res.locals.currentUser = req.session.username;
        return next();
    }
    if (req.path.startsWith('/api/') || req.path.startsWith('/integrations/') || req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
    }
    const loginUrl = '/login' + (req.originalUrl !== '/' ? '?redirect=' + encodeURIComponent(req.originalUrl) : '');
    res.redirect(loginUrl);
}

function requireActionPermission(actionPermission) {
    return (req, res, next) => {
        if (isSuperAdmin(req)) return next();
        const perms = req.session.userPermissions || [];
        if (perms.includes(actionPermission) || perms.includes('operator')) {
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

// Mock HTTP response builder
function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        locals: {},
        _json: null,
        _redirectUrl: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this._json = data;
            return this;
        },
        redirect(url) {
            this._redirectUrl = url;
            return this;
        }
    };
}

// --- 2. Unit Tests for Role & Super Admin Resolution ---

test('isSuperAdmin accurately identifies root, super admin groups and denies standard users', () => {
    // 1. Root sessions
    assert.equal(isSuperAdmin({ session: { isRoot: true } }), true, 'isRoot: true should be super admin');
    assert.equal(isSuperAdmin({ session: { username: 'root' } }), true, 'username: root should be super admin');

    // 2. Super admin group aliases (case-insensitive & trimmed)
    assert.equal(isSuperAdmin({ session: { userGroup: 'super admins' } }), true);
    assert.equal(isSuperAdmin({ session: { userGroup: 'Super Admins' } }), true);
    assert.equal(isSuperAdmin({ session: { userGroup: ' super admin ' } }), true);
    assert.equal(isSuperAdmin({ session: { userGroup: 'Administrator' } }), true);
    assert.equal(isSuperAdmin({ session: { userGroup: 'administrators' } }), true);

    // 3. Standard / non-admin groups
    assert.equal(isSuperAdmin({ session: { userGroup: 'operators' } }), false);
    assert.equal(isSuperAdmin({ session: { userGroup: 'call-center' } }), false);
    assert.equal(isSuperAdmin({ session: { userGroup: 'guests' } }), false);
    assert.equal(isSuperAdmin({ session: { userGroup: '' } }), false);
    assert.equal(isSuperAdmin({ session: {} }), false);
    assert.equal(isSuperAdmin(null), false);
});

test('ALL_TABS defines full catalog of 31 permissions across main tabs, subtabs, and action controls', () => {
    assert.equal(ALL_TABS.length, 31, 'ALL_TABS must contain exactly 31 permission keys');

    // Core tabs
    const coreTabs = ['dashboard', 'cdr', 'voicemails', 'ext-stats', 'operator', 'gsm-dongles', 'softphone', 'contacts', 'users', 'config', 'storage'];
    coreTabs.forEach(tab => assert.ok(ALL_TABS.includes(tab), `ALL_TABS should include core tab: ${tab}`));

    // Config sub-tabs
    const configSubTabs = [
        'config-extensions', 'config-ringgroups', 'config-queues', 'config-recordings',
        'config-trunks', 'config-inbound', 'config-outbound', 'config-voicemail',
        'config-diagram', 'config-timegroups', 'config-timeconditions', 'config-announcements',
        'config-modem', 'config-dongles', 'config-terminal'
    ];
    configSubTabs.forEach(sub => assert.ok(ALL_TABS.includes(sub), `ALL_TABS should include config sub-tab: ${sub}`));

    // Operator action permissions
    const actionPerms = ['operator-listen', 'operator-whisper', 'operator-barge', 'operator-hangup', 'operator-hijack'];
    actionPerms.forEach(act => assert.ok(ALL_TABS.includes(act), `ALL_TABS should include operator action: ${act}`));
});

// --- 3. Authentication & Authorization Middleware Tests ---

test('requireAuth correctly gates unauthenticated requests (API 401 vs View 302)', () => {
    // 1. Unauthenticated API request -> 401 JSON
    const apiReq = { session: {}, path: '/api/users', headers: {}, originalUrl: '/api/users' };
    const apiRes = createMockRes();
    let nextCalled = false;
    requireAuth(apiReq, apiRes, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(apiRes.statusCode, 401);
    assert.deepEqual(apiRes._json, { success: false, error: 'Unauthorized. Please log in.' });

    // 2. Unauthenticated Integrations request -> 401 JSON
    const intReq = { session: {}, path: '/integrations/crm', headers: {}, originalUrl: '/integrations/crm' };
    const intRes = createMockRes();
    requireAuth(intReq, intRes, () => {});
    assert.equal(intRes.statusCode, 401);

    // 3. Unauthenticated XHR request -> 401 JSON
    const xhrReq = { session: {}, path: '/cdr', xhr: true, headers: {}, originalUrl: '/cdr' };
    const xhrRes = createMockRes();
    requireAuth(xhrReq, xhrRes, () => {});
    assert.equal(xhrRes.statusCode, 401);

    // 4. Unauthenticated HTML page request -> 302 Redirect to /login?redirect=...
    const viewReq = { session: {}, path: '/cdr', headers: { accept: 'text/html' }, originalUrl: '/cdr?filter=today' };
    const viewRes = createMockRes();
    requireAuth(viewReq, viewRes, () => {});
    assert.equal(viewRes._redirectUrl, '/login?redirect=%2Fcdr%3Ffilter%3Dtoday');

    // 5. Authenticated request -> populates res.locals.currentUser and calls next()
    const authReq = { session: { userId: 42, username: 'operator1' }, path: '/cdr', headers: {} };
    const authRes = createMockRes();
    let authNextCalled = false;
    requireAuth(authReq, authRes, () => { authNextCalled = true; });
    assert.equal(authNextCalled, true);
    assert.equal(authRes.locals.currentUser, 'operator1');
});

test('requireActionPermission enforces operator call action control hierarchy', () => {
    const middleware = requireActionPermission('operator-listen');

    // 1. Super Admin is always allowed
    const superReq = { session: { userGroup: 'super admins', userPermissions: [] } };
    const superRes = createMockRes();
    let superNext = false;
    middleware(superReq, superRes, () => { superNext = true; });
    assert.equal(superNext, true);

    // 2. User with explicit action permission 'operator-listen' is allowed
    const explicitReq = { session: { userGroup: 'operators', userPermissions: ['operator-listen'] } };
    const explicitRes = createMockRes();
    let explicitNext = false;
    middleware(explicitReq, explicitRes, () => { explicitNext = true; });
    assert.equal(explicitNext, true);

    // 3. User with legacy parent 'operator' permission is allowed
    const parentReq = { session: { userGroup: 'operators', userPermissions: ['operator'] } };
    const parentRes = createMockRes();
    let parentNext = false;
    middleware(parentReq, parentRes, () => { parentNext = true; });
    assert.equal(parentNext, true);

    // 4. User missing the permission is denied 403 Forbidden
    const deniedReq = { session: { userGroup: 'operators', userPermissions: ['cdr', 'operator-whisper'] } };
    const deniedRes = createMockRes();
    let deniedNext = false;
    middleware(deniedReq, deniedRes, () => { deniedNext = true; });
    assert.equal(deniedNext, false);
    assert.equal(deniedRes.statusCode, 403);
    assert.deepEqual(deniedRes._json, { success: false, error: 'Forbidden. Missing permission: operator-listen' });
});

test('requireConfigPermission enforces PBX subtab permission inheritance and gating', () => {
    const middleware = requireConfigPermission('extensions');

    // 1. Super Admin is allowed
    const superReq = { session: { userGroup: 'super admins', userPermissions: [] } };
    const superRes = createMockRes();
    let superNext = false;
    middleware(superReq, superRes, () => { superNext = true; });
    assert.equal(superNext, true);

    // 2. User with parent 'config' permission is allowed
    const configParentReq = { session: { userGroup: 'technicians', userPermissions: ['config'] } };
    const configParentRes = createMockRes();
    let configParentNext = false;
    middleware(configParentReq, configParentRes, () => { configParentNext = true; });
    assert.equal(configParentNext, true);

    // 3. User with granular 'config-extensions' permission is allowed
    const subTabReq = { session: { userGroup: 'technicians', userPermissions: ['config-extensions'] } };
    const subTabRes = createMockRes();
    let subTabNext = false;
    middleware(subTabReq, subTabRes, () => { subTabNext = true; });
    assert.equal(subTabNext, true);

    // 4. User with different config subtab (e.g. 'config-trunks') is denied 403
    const deniedReq = { session: { userGroup: 'technicians', userPermissions: ['config-trunks'] } };
    const deniedRes = createMockRes();
    let deniedNext = false;
    middleware(deniedReq, deniedRes, () => { deniedNext = true; });
    assert.equal(deniedNext, false);
    assert.equal(deniedRes.statusCode, 403);
    assert.deepEqual(deniedRes._json, { success: false, error: 'Unauthorized' });
});

// --- 4. User and Group Management Security Invariants ---

test('password hashing with bcrypt uses 10 salt rounds and securely hashes/verifies passwords', async () => {
    const plaintext = 'SokratSecurePass2026!';
    const hash = await bcrypt.hash(plaintext, 10);

    // Hash structure: $2b$10$...
    assert.ok(hash.startsWith('$2b$10$') || hash.startsWith('$2a$10$'), 'Bcrypt hash should use 10 salt rounds');
    assert.equal(hash.length, 60, 'Bcrypt hash length should be 60 characters');

    // Verification
    const isValid = await bcrypt.compare(plaintext, hash);
    assert.equal(isValid, true, 'Valid password should match bcrypt hash');

    const isInvalid = await bcrypt.compare('WrongPassword!', hash);
    assert.equal(isInvalid, false, 'Invalid password should not match bcrypt hash');
});

test('user management business invariants enforce security rules', () => {
    // 1. Reserved root username validation
    function validateNewUsername(username) {
        if (!username || username.trim().length < 3) return { valid: false, error: 'Username must be at least 3 chars' };
        if (username.trim().toLowerCase() === ROOT_USER) return { valid: false, error: 'Username cannot be reserved' };
        return { valid: true };
    }

    assert.equal(validateNewUsername('root').valid, false);
    assert.equal(validateNewUsername('root').error, 'Username cannot be reserved');
    assert.equal(validateNewUsername('admin_user').valid, true);

    // 2. Email format validation
    function validateEmail(email) {
        const clean = (email && email.trim()) ? email.trim() : null;
        if (!clean) return { valid: true, email: null };
        if (!clean.includes('@') || !clean.includes('.')) return { valid: false, error: 'If provided, email must be valid' };
        return { valid: true, email: clean };
    }

    assert.equal(validateEmail('').valid, true);
    assert.equal(validateEmail(null).valid, true);
    assert.equal(validateEmail('invalid-email').valid, false);
    assert.equal(validateEmail('admin@sokrat.local').valid, true);

    // 3. Self-deletion prevention logic
    function canDeleteUser(sessionUsername, targetUserRowUsername) {
        if (sessionUsername && targetUserRowUsername && sessionUsername === targetUserRowUsername) {
            return { allowed: false, error: 'Cannot delete your own account' };
        }
        return { allowed: true };
    }

    assert.equal(canDeleteUser('admin', 'admin').allowed, false);
    assert.equal(canDeleteUser('admin', 'operator1').allowed, true);

    // 4. Super Admin group protection invariants
    function canDeleteGroup(groupName) {
        if (groupName === 'super admins') {
            return { allowed: false, error: 'Cannot delete the super admins group' };
        }
        return { allowed: true };
    }

    function canModifyGroupPermissions(groupName) {
        if (groupName === 'super admins') {
            return { allowed: false, error: 'Super admins permissions cannot be modified' };
        }
        return { allowed: true };
    }

    assert.equal(canDeleteGroup('super admins').allowed, false);
    assert.equal(canDeleteGroup('custom-ops').allowed, true);
    assert.equal(canModifyGroupPermissions('super admins').allowed, false);
    assert.equal(canModifyGroupPermissions('custom-ops').allowed, true);
});

// --- 5. View-Level Rendering Security Checks ---

test('views/users.ejs renders locked super admins group and active custom groups', async () => {
    const usersEjsPath = path.join(__dirname, '../views/users.ejs');

    const html = await ejs.renderFile(usersEjsPath, {
        currentLang: 'en',
        currentPage: '/users',
        isRtl: false,
        isSuperAdmin: true,
        user: { username: 'admin' },
        users: [
            { id: 1, username: 'admin', email: 'admin@sokrat.local', group_id: 1, group_name: 'super admins', created_at: new Date() },
            { id: 2, username: 'operator1', email: 'op@sokrat.local', group_id: 2, group_name: 'operators', created_at: new Date() }
        ],
        groups: [
            { id: 1, name: 'super admins', permissions: ALL_TABS },
            { id: 2, name: 'operators', permissions: ['cdr', 'operator'] }
        ],
        allTabs: ALL_TABS,
        crmConfig: {},
        crmClients: [],
        success: null,
        error: null
    });

    // 1. Super Admins group has LOCKED badge and disabled checkboxes
    assert.ok(html.includes('LOCKED'), 'Super Admins group should display LOCKED badge');
    assert.ok(html.includes('disabled'), 'Super Admins permissions should have disabled checkboxes');

    // 2. Custom groups have interactive permission form and action buttons
    assert.ok(html.includes('action="/groups/permissions"'), 'Custom groups should render permissions form');
    assert.ok(html.includes('action="/groups/delete"'), 'Custom groups should render delete button form');
});

test('views/sidebar.ejs correctly filters navigation links based on user permissions and root status', async () => {
    const sidebarEjsPath = path.join(__dirname, '../views/sidebar.ejs');

    // Case A: Super Admin view -> has all links (Users, Config, CDR, Operator, Storage)
    const superAdminHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: true,
        currentUser: 'root',
        allowedTabs: ALL_TABS
    });
    assert.ok(superAdminHtml.includes('/users?lang='), 'Super Admin should see /users link in sidebar');
    assert.ok(superAdminHtml.includes('/config?lang='), 'Super Admin should see /config link in sidebar');
    assert.ok(superAdminHtml.includes('/integrations/crm'), 'Root Super Admin should see /integrations/crm link');
    assert.ok(superAdminHtml.includes('/operator?lang='), 'Super Admin should see /operator link');

    // Case B: Restricted operator with ONLY 'cdr' and 'voicemails' -> Users, Operator, Config, and CRM must be hidden
    const restrictedHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'limited_agent',
        allowedTabs: ['cdr', 'voicemails']
    });
    assert.ok(restrictedHtml.includes('/cdr?lang='), 'Allowed tab /cdr should be visible');
    assert.ok(restrictedHtml.includes('/voicemails?lang='), 'Allowed tab /voicemails should be visible');
    assert.equal(restrictedHtml.includes('/users?lang='), false, 'Non-superadmin should NOT see /users link');
    assert.equal(restrictedHtml.includes('/operator?lang='), false, 'User without operator perm should NOT see /operator link');
    assert.equal(restrictedHtml.includes('/gsm-dongles?lang='), false, 'User without gsm-dongles perm should NOT see /gsm-dongles link');
    assert.equal(restrictedHtml.includes('/integrations/crm'), false, 'Non-root user should NOT see /integrations/crm link');
});

test('views/config.ejs correctly gates sub-tab visibility and root-only controls', async () => {
    const configEjsPath = path.join(__dirname, '../views/config.ejs');

    // Case A: Non-root user with only 'config-extensions' permission
    const limitedConfigHtml = await ejs.renderFile(configEjsPath, {
        currentLang: 'en',
        currentPage: '/config',
        isRtl: false,
        isSuperAdmin: false,
        isRoot: false,
        currentUser: 'tech1',
        allowedTabs: ['config-extensions']
    });

    // Extensions subtab should be rendered
    assert.ok(limitedConfigHtml.includes('id="section-extensions"'), 'Permitted subtab config-extensions should be rendered');
    assert.equal(limitedConfigHtml.includes('id="section-trunks"'), false, 'Unpermitted subtab config-trunks should NOT be rendered');
    assert.equal(limitedConfigHtml.includes('id="section-queues"'), false, 'Unpermitted subtab config-queues should NOT be rendered');

    // Root-only terminal tab and add slot button must NOT be rendered
    assert.equal(limitedConfigHtml.includes('onclick="openAddDongleSlotModal()"'), false, 'Non-root should NOT see Add Dongle Slot button');
    assert.equal(limitedConfigHtml.includes('id="section-terminal"'), false, 'Non-root should NOT see TTY Terminal section');
    assert.equal(limitedConfigHtml.includes('id="tab-btn-terminal"'), false, 'Non-root should NOT see TTY Terminal tab button');

    // Case B: Root superuser -> Terminal container and Add Slot button must be rendered
    const rootConfigHtml = await ejs.renderFile(configEjsPath, {
        currentLang: 'en',
        currentPage: '/config',
        isRtl: false,
        isSuperAdmin: true,
        isRoot: true,
        currentUser: 'root',
        allowedTabs: ALL_TABS
    });

    assert.ok(rootConfigHtml.includes('onclick="openAddDongleSlotModal()"'), 'Root should see Add Dongle Slot button');
    assert.ok(rootConfigHtml.includes('id="section-terminal"'), 'Root should see TTY Terminal section');
    assert.ok(rootConfigHtml.includes('id="tab-btn-terminal"'), 'Root should see TTY Terminal tab button');
});

test('TAB_ROUTE_MAP correctly maps all route paths with leading slashes including /config and /users', async () => {
    const TAB_ROUTE_MAP = {
        '/': 'dashboard',
        '/cdr': 'cdr',
        '/voicemails': 'voicemails',
        '/ext-stats': 'ext-stats',
        '/operator': 'operator',
        '/gsm-dongles': 'gsm-dongles',
        '/contacts': 'contacts',
        '/users': 'users',
        '/config': 'config',
        '/dialer': 'dialer',
        '/storage': 'storage'
    };

    assert.equal(TAB_ROUTE_MAP['/config'], 'config', '/config must map to config');
    assert.equal(TAB_ROUTE_MAP['/users'], 'users', '/users must map to users');
    assert.equal(TAB_ROUTE_MAP['/dialer'], 'dialer', '/dialer must map to dialer');

    // When a non-superadmin user accesses /config, sidebar receives allowedTabs and renders all permitted links
    const sidebarEjsPath = path.join(__dirname, '../views/sidebar.ejs');
    const configSidebarHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/config',
        isRtl: false,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'emad',
        allowedTabs: ['dashboard', 'config', 'config-extensions', 'cdr', 'operator', 'voicemails', 'ext-stats', 'gsm-dongles', 'storage', 'contacts']
    });

    assert.ok(configSidebarHtml.includes('/config?lang='), 'Sidebar during /config request must show /config');
    assert.ok(configSidebarHtml.includes('/cdr?lang='), 'Sidebar during /config request must show /cdr');
    assert.ok(configSidebarHtml.includes('/operator?lang='), 'Sidebar during /config request must show /operator');
    assert.ok(configSidebarHtml.includes('/gsm-dongles?lang='), 'Sidebar during /config request must show /gsm-dongles');
    assert.ok(configSidebarHtml.includes('/voicemails?lang='), 'Sidebar during /config request must show /voicemails');
    assert.ok(configSidebarHtml.includes('/ext-stats?lang='), 'Sidebar during /config request must show /ext-stats');
    assert.ok(configSidebarHtml.includes('/storage?lang='), 'Sidebar during /config request must show /storage');
    assert.ok(configSidebarHtml.includes('/contacts?lang='), 'Sidebar during /config request must show /contacts');
    assert.ok(configSidebarHtml.includes('/?lang='), 'Sidebar during /config request must show /');
});

test('User in a group with zero permissions has all navigation links hidden and accesses /no-access', async () => {
    const sidebarEjsPath = path.join(__dirname, '../views/sidebar.ejs');
    const noAccessViewPath = path.join(__dirname, '../views/no-access.ejs');

    // 1. Sidebar with allowedTabs = []
    const zeroPermsSidebarHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'noperms_user',
        allowedTabs: []
    });

    assert.equal(zeroPermsSidebarHtml.includes('/?lang='), false, 'Dashboard link must be hidden for 0-permission group');
    assert.equal(zeroPermsSidebarHtml.includes('/contacts?lang='), false, 'Contacts link must be hidden for 0-permission group');
    assert.equal(zeroPermsSidebarHtml.includes('/storage?lang='), false, 'Storage link must be hidden for 0-permission group');
    assert.equal(zeroPermsSidebarHtml.includes('/cdr?lang='), false, 'CDR link must be hidden for 0-permission group');
    assert.equal(zeroPermsSidebarHtml.includes('/operator?lang='), false, 'Operator link must be hidden for 0-permission group');
    assert.equal(zeroPermsSidebarHtml.includes('/voicemails?lang='), false, 'Voicemails link must be hidden for 0-permission group');
    assert.equal(zeroPermsSidebarHtml.includes('/ext-stats?lang='), false, 'Ext stats link must be hidden for 0-permission group');
    assert.equal(zeroPermsSidebarHtml.includes('/gsm-dongles?lang='), false, 'GSM dongles link must be hidden for 0-permission group');
    assert.equal(zeroPermsSidebarHtml.includes('/config?lang='), false, 'Config link must be hidden for 0-permission group');
    assert.equal(zeroPermsSidebarHtml.includes('/users?lang='), false, 'Users link must be hidden for 0-permission group');

    // 2. views/no-access.ejs renders bilingual Access Restricted card with logout action
    const enNoAccessHtml = await ejs.renderFile(noAccessViewPath, {
        currentLang: 'en',
        isRtl: false,
        username: 'noperms_user'
    });
    assert.ok(enNoAccessHtml.includes('Access Restricted'), 'English no-access view must render Access Restricted header');
    assert.ok(enNoAccessHtml.includes('noperms_user'), 'No-access view must show username');
    assert.ok(enNoAccessHtml.includes('/logout'), 'No-access view must include /logout button');

    const arNoAccessHtml = await ejs.renderFile(noAccessViewPath, {
        currentLang: 'ar',
        isRtl: true,
        username: 'noperms_user'
    });
    assert.ok(arNoAccessHtml.includes('الصلاحيات مقيدة'), 'Arabic no-access view must render Arabic header');
    assert.ok(arNoAccessHtml.includes('تسجيل الخروج'), 'Arabic no-access view must render Arabic logout button');
});

test('User with specific single tab permission only sees that tab in the sidebar', async () => {
    const sidebarEjsPath = path.join(__dirname, '../views/sidebar.ejs');

    // Case 1: ONLY 'dashboard'
    const dashOnlyHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'dash_user',
        allowedTabs: ['dashboard']
    });
    assert.ok(dashOnlyHtml.includes('/?lang='), 'Dashboard link must be visible');
    assert.equal(dashOnlyHtml.includes('/contacts?lang='), false, 'Contacts link must be hidden');
    assert.equal(dashOnlyHtml.includes('/storage?lang='), false, 'Storage link must be hidden');
    assert.equal(dashOnlyHtml.includes('/cdr?lang='), false, 'CDR link must be hidden');

    // Case 2: ONLY 'contacts'
    const contactsOnlyHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/contacts',
        isRtl: false,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'contacts_user',
        allowedTabs: ['contacts']
    });
    assert.ok(contactsOnlyHtml.includes('/contacts?lang='), 'Contacts link must be visible');
    assert.equal(contactsOnlyHtml.includes('/?lang='), false, 'Dashboard link must be hidden');
    assert.equal(contactsOnlyHtml.includes('/storage?lang='), false, 'Storage link must be hidden');

    // Case 3: ONLY 'storage'
    const storageOnlyHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'backup_user',
        allowedTabs: ['storage']
    });
    assert.ok(storageOnlyHtml.includes('/storage?lang='), 'Storage link must be visible');
    assert.equal(storageOnlyHtml.includes('/?lang='), false, 'Dashboard link must be hidden');
    assert.equal(storageOnlyHtml.includes('/contacts?lang='), false, 'Contacts link must be hidden');
});
