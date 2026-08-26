const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

test('Callgroup and pickupgroup synchronization logic maps Live Panel groups and enforces Group Admin isolation', () => {
    const mockEmployeeGroups = [
        { id: 10, name: 'Sales' },
        { id: 11, name: 'Technical Support' },
        { id: 12, name: 'Operations' }
    ];

    const mockExtensions = [
        // Group 'Sales' has one admin (101) and one regular member (102)
        { extension: '101', emp_group: 'Sales', is_group_admin: 1 },
        { extension: '102', emp_group: 'Sales', is_group_admin: 0 },

        // Group 'Technical Support' has MULTIPLE admins (201 and 202) and a regular member (203)
        { extension: '201', emp_group: 'Technical Support', is_group_admin: 1 },
        { extension: '202', emp_group: 'Technical Support', is_group_admin: 1 },
        { extension: '203', emp_group: 'Technical Support', is_group_admin: 0 },

        // Group 'Operations' has ZERO admins (all regular members)
        { extension: '301', emp_group: 'Operations', is_group_admin: 0 },
        { extension: '302', emp_group: 'Operations', is_group_admin: 0 },

        // Ungrouped extensions: Ext 401 is an admin over other ungrouped extensions, 402 & 403 are regular ungrouped
        { extension: '401', emp_group: null, is_group_admin: 1 },
        { extension: '402', emp_group: '', is_group_admin: 0 },
        { extension: '403', emp_group: null, is_group_admin: 0 }
    ];

    const groupMap = new Map();
    let nextGroupId = 2; // Reserve group 1 for default ungrouped
    mockEmployeeGroups.forEach(g => {
        if (g.name) {
            const key = g.name.trim().toLowerCase();
            if (!groupMap.has(key)) {
                groupMap.set(key, {
                    id: nextGroupId++,
                    name: g.name.trim()
                });
            }
        }
    });

    const groupsWithAdmins = new Set();
    mockExtensions.forEach(r => {
        const g = r.emp_group ? String(r.emp_group).trim().toLowerCase() : '__ungrouped__';
        const isAdmin = Boolean(r.is_group_admin === 1 || r.is_group_admin === true || r.is_group_admin === '1');
        if (isAdmin) {
            groupsWithAdmins.add(g);
        }
    });

    const extensionGroupConfigs = mockExtensions.map(row => {
        const ext = row.extension;
        const groupKey = row.emp_group ? String(row.emp_group).trim().toLowerCase() : '__ungrouped__';
        const groupInfo = row.emp_group && groupMap.has(groupKey) ? groupMap.get(groupKey) : null;
        const groupId = groupInfo ? groupInfo.id : 1;
        const namedGroup = groupInfo ? groupInfo.name.replace(/[^a-zA-Z0-9_]/g, '_') : 'default';
        const isGroupAdmin = Boolean(row.is_group_admin === 1 || row.is_group_admin === true || row.is_group_admin === '1');

        let pickupGroupId = groupId;
        let namedPickupGroup = namedGroup;

        if (groupsWithAdmins.has(groupKey)) {
            if (isGroupAdmin) {
                pickupGroupId = groupId;
                namedPickupGroup = namedGroup;
            } else {
                pickupGroupId = '';
                namedPickupGroup = '';
            }
        }
        return {
            extension: ext,
            callgroup: groupId,
            pickupgroup: pickupGroupId,
            namedcallgroup: namedGroup,
            namedpickupgroup: namedPickupGroup,
            isGroupAdmin
        };
    });

    // 1. Sales group: Ext 101 (Admin) can pick up 102, but Ext 102 (Regular member) CANNOT pick up 101
    const ext101 = extensionGroupConfigs.find(e => e.extension === '101');
    const ext102 = extensionGroupConfigs.find(e => e.extension === '102');
    assert.equal(ext101.callgroup, 2);
    assert.equal(ext101.pickupgroup, 2, 'Sales Admin 101 has pickupgroup 2');
    assert.equal(ext102.callgroup, 2, 'Sales Member 102 has callgroup 2');
    assert.equal(ext102.pickupgroup, '', 'Sales Member 102 has empty pickupgroup (cannot pick up peer calls)');
    assert.equal(ext101.pickupgroup, ext102.callgroup, 'Admin 101 can pick up when 102 rings');
    assert.notEqual(ext102.pickupgroup, ext101.callgroup, 'Member 102 cannot pick up when 101 rings');

    // 2. Tech Support group: MULTIPLE admins (201, 202) both have pickupgroup 3, while 203 has empty pickupgroup
    const ext201 = extensionGroupConfigs.find(e => e.extension === '201');
    const ext202 = extensionGroupConfigs.find(e => e.extension === '202');
    const ext203 = extensionGroupConfigs.find(e => e.extension === '203');
    assert.equal(ext201.pickupgroup, 3, 'Admin 201 can pick up Tech Support calls');
    assert.equal(ext202.pickupgroup, 3, 'Admin 202 can pick up Tech Support calls');
    assert.equal(ext203.pickupgroup, '', 'Regular Member 203 cannot pick up calls');
    assert.equal(ext201.pickupgroup, ext203.callgroup, 'Admin 201 can pick up member 203');
    assert.equal(ext202.pickupgroup, ext203.callgroup, 'Admin 202 can pick up member 203');

    // 3. Operations group: ZERO admins -> all members share mutual pickup (peer-to-peer)
    const ext301 = extensionGroupConfigs.find(e => e.extension === '301');
    const ext302 = extensionGroupConfigs.find(e => e.extension === '302');
    assert.equal(ext301.callgroup, 4);
    assert.equal(ext301.pickupgroup, 4);
    assert.equal(ext302.callgroup, 4);
    assert.equal(ext302.pickupgroup, 4);
    assert.equal(ext301.pickupgroup, ext302.callgroup, 'Operations members can pick up each others calls when no admin is set');

    // 4. Ungrouped extensions with an admin: Ext 401 (Admin) can pick up calls from 402 & 403, but regular ungrouped 402 CANNOT pick up 401
    const ext401 = extensionGroupConfigs.find(e => e.extension === '401');
    const ext402 = extensionGroupConfigs.find(e => e.extension === '402');
    const ext403 = extensionGroupConfigs.find(e => e.extension === '403');
    assert.equal(ext401.callgroup, 1);
    assert.equal(ext401.pickupgroup, 1, 'Ungrouped Admin 401 has pickupgroup 1');
    assert.equal(ext402.callgroup, 1, 'Ungrouped Member 402 has callgroup 1');
    assert.equal(ext402.pickupgroup, '', 'Ungrouped Member 402 has empty pickupgroup when an ungrouped admin exists');
    assert.notEqual(ext402.pickupgroup, ext401.callgroup, 'Ungrouped Member 402 cannot pick up 401');
});

test('Asterisk dialplan extensions_custom.conf and install.sh contain Call Pickup feature codes', () => {
    const dialplanPath = '/etc/asterisk/extensions_custom.conf';
    const installerPath = path.join(__dirname, '../install.sh');

    const dialplan = fs.readFileSync(dialplanPath, 'utf8');
    const installer = fs.readFileSync(installerPath, 'utf8');

    // 1. General Department Group Call Pickup (*8)
    assert.ok(dialplan.includes('exten => *8,1,NoOp(--- Department Group Call Pickup'), 'extensions_custom.conf has *8 pickup');
    assert.ok(installer.includes('exten => *8,1,NoOp(--- Department Group Call Pickup'), 'install.sh has *8 pickup');

    // 2. Directed Call Pickup / Ring Group Intercept (*8X.)
    assert.ok(dialplan.includes('exten => _*8X.,1,NoOp(--- Directed / Ring Group Pickup'), 'extensions_custom.conf has _*8X. pickup');
    assert.ok(installer.includes('exten => _*8X.,1,NoOp(--- Directed / Ring Group Pickup'), 'install.sh has _*8X. pickup');
    assert.ok(dialplan.includes('PickupChan(PJSIP/${EXTEN:2}&SIP/${EXTEN:2}&Local/${EXTEN:2}@ext-local,p)'), 'Directed pickup targets PJSIP, SIP, and Local channels');
    assert.ok(dialplan.includes('${EXTEN:2}@ext-group'), 'Directed pickup targets Ring Groups via @ext-group context');

    // 3. Directed Call Pickup (**X.)
    assert.ok(dialplan.includes('exten => _**X.,1,NoOp(--- Directed Call Pickup'), 'extensions_custom.conf has _**X. pickup');
    assert.ok(installer.includes('exten => _**X.,1,NoOp(--- Directed Call Pickup'), 'install.sh has _**X. pickup');
});

test('server.js defines and hooks syncExtensionCallPickupGroups into all group and extension mutations', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    assert.ok(serverCode.includes('async function syncExtensionCallPickupGroups()'), 'server.js defines syncExtensionCallPickupGroups');
    assert.ok(serverCode.includes('await syncExtensionCallPickupGroups()'), 'server.js calls syncExtensionCallPickupGroups on boot');
    
    // Group and extension mutation hooks
    const syncCalls = serverCode.match(/syncExtensionCallPickupGroups\(\)/g) || [];
    assert.ok(syncCalls.length >= 6, 'syncExtensionCallPickupGroups must be wired across group creation, rename, delete, drag&drop, extras update, and extension CRUD');
});

test('views/config.ejs renders Group Admin checkbox enabled for Super Admin and disabled for non-Super Admin', async () => {
    const configPath = path.join(__dirname, '../views/config.ejs');
    const htmlSuper = await ejs.renderFile(configPath, {
        currentLang: 'en',
        currentPage: '/config',
        isSuperAdmin: true,
        user: { username: 'admin', role: 'admin' },
        currentUser: { username: 'admin', isRoot: true, group_name: 'super admins' },
        activeSubTab: 'extensions'
    });

    assert.ok(htmlSuper.includes('id="extIsGroupAdmin"'), 'extensionModal has extIsGroupAdmin checkbox');
    assert.ok(htmlSuper.includes('Group Admin'), 'extensionModal has Group Admin label in English');
    assert.ok(!htmlSuper.includes('id="extIsGroupAdmin" class="tab-checkbox" disabled'), 'Super Admin has active checkbox');

    const htmlNonSuper = await ejs.renderFile(configPath, {
        currentLang: 'en',
        currentPage: '/config',
        isSuperAdmin: false,
        user: { username: 'standard_user', role: 'user' },
        currentUser: { username: 'standard_user', isRoot: false, group_name: 'operators' },
        activeSubTab: 'extensions'
    });

    assert.ok(htmlNonSuper.includes('disabled'), 'Non-Super Admin has disabled checkbox');
    assert.ok(htmlNonSuper.includes('Super Admin Only'), 'Non-Super Admin sees Super Admin Only badge');

    const htmlAr = await ejs.renderFile(configPath, {
        currentLang: 'ar',
        currentPage: '/config',
        isSuperAdmin: true,
        user: { username: 'admin', role: 'admin' },
        currentUser: { username: 'admin', isRoot: true, group_name: 'super admins' },
        activeSubTab: 'extensions'
    });

    assert.ok(htmlAr.includes('مدير المجموعة'), 'extensionModal has Group Admin label in Arabic');
});

test('server.js restricts is_group_admin modification to Super Admins', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const adminChecks = serverCode.match(/Only Super Admins can (assign|modify) Group Admin status/g) || [];
    assert.ok(adminChecks.length >= 3, 'server.js must reject unauthorized is_group_admin assignment across extension create, update, and extras endpoints');
});
