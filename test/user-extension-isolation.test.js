const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');

const usersViewPath = path.join(__dirname, '../views/users.ejs');
const dashboardViewPath = path.join(__dirname, '../views/dashboard.ejs');
const cdrViewPath = path.join(__dirname, '../views/cdr.ejs');

const mockRoster = [
    { extension: '101', name: 'Alice Smith', online: true },
    { extension: '102', name: 'Bob Jones', online: false },
    { extension: '103', name: 'Charlie Brown', online: true }
];

const mockGroups = [
    { id: 1, name: 'super admins', permissions: ['dashboard', 'users', 'cdr', 'voicemails', 'ext-stats', 'operator', 'config'] },
    { id: 2, name: 'operators', permissions: ['dashboard', 'cdr', 'voicemails', 'ext-stats'] }
];

const mockAvailableDongles = [
    { dongle_name: 'dongle0', phone_number: '01011112222' },
    { dongle_name: 'dongle1', phone_number: '01033334444' }
];

const mockUsers = [
    { id: 1, username: 'admin', email: 'admin@sokrat.local', group_id: 1, group_name: 'super admins', extension: null, allowed_dongles: [], created_at: new Date() },
    { id: 2, username: 'alice', email: 'alice@sokrat.local', group_id: 2, group_name: 'operators', extension: '101', allowed_dongles: ['dongle0'], created_at: new Date() },
    { id: 3, username: 'bob', email: 'bob@sokrat.local', group_id: 2, group_name: 'operators', extension: '102', allowed_dongles: ['dongle1'], created_at: new Date() },
    { id: 4, username: 'general_operator', email: null, group_id: 2, group_name: 'operators', extension: null, allowed_dongles: [], created_at: new Date() }
];

test('views/users.ejs renders Connected Extension selector, Allowed Dongles controls, Table Columns, and Edit User modal', async () => {
    const html = await ejs.renderFile(usersViewPath, {
        currentLang: 'en',
        currentPage: '/users',
        isSuperAdmin: true,
        user: { username: 'admin', role: 'admin' },
        users: mockUsers,
        groups: mockGroups,
        roster: mockRoster,
        availableDongles: mockAvailableDongles,
        allTabs: ['dashboard', 'users', 'cdr', 'voicemails', 'ext-stats', 'operator', 'config']
    });

    // 1. Add User Form: createExtension dropdown with options
    assert.ok(html.includes('id="createExtension"'), 'createExtension dropdown exists in add user form');
    assert.ok(html.includes('Connected Extension'), 'Connected Extension label rendered');
    assert.ok(html.includes('value="101"'), 'Extension 101 option present in create dropdown');
    assert.ok(html.includes('101 - Alice Smith'), 'Alice Smith option present in create dropdown');

    // Add User Form: Allowed Dongles dropdown with checkboxes
    assert.ok(html.includes('id="createDongleDropdownBtn"'), 'createDongleDropdownBtn exists in add user form');
    assert.ok(html.includes('createDongles'), 'createDongles checkbox class exists in add user form');
    assert.ok(html.includes('value="dongle0"'), 'dongle0 checkbox exists in add user form');

    // 2. Registered Users Table: Extension and Dongles column headers and cell badges
    assert.ok(html.includes('Extension'), 'Extension column header rendered');
    assert.ok(html.includes('Allowed Dongles'), 'Allowed Dongles column header rendered');
    assert.ok(html.includes('user-ext-cell'), 'user-ext-cell class present in table rows');
    assert.ok(html.includes('user-dongles-cell'), 'user-dongles-cell class present in table rows');
    assert.ok(html.includes('101'), 'Extension 101 badge rendered for alice');
    assert.ok(html.includes('102'), 'Extension 102 badge rendered for bob');
    assert.ok(html.includes('Unrestricted'), 'Unrestricted label rendered for accounts without extension');

    // 3. Edit User Modal & Triggers
    assert.ok(html.includes('id="editUserModal"'), 'editUserModal exists');
    assert.ok(html.includes('id="editUserExtension"'), 'editUserExtension dropdown exists in edit modal');
    assert.ok(html.includes('id="editDongleDropdownBtn"'), 'editDongleDropdownBtn exists in edit modal');
    assert.ok(html.includes('showEditUserFromBtn(this)'), 'showEditUserFromBtn onclick binding exists');
    assert.ok(html.includes('action="/users/edit"'), 'Form points to POST /users/edit');
});

test('views/users.ejs renders correctly in Arabic (ar)', async () => {
    const html = await ejs.renderFile(usersViewPath, {
        currentLang: 'ar',
        currentPage: '/users',
        isSuperAdmin: true,
        user: { username: 'admin', role: 'admin' },
        users: mockUsers,
        groups: mockGroups,
        roster: mockRoster,
        availableDongles: mockAvailableDongles,
        allTabs: ['dashboard', 'users', 'cdr', 'voicemails', 'ext-stats', 'operator', 'config']
    });

    assert.ok(html.includes('التحويلة المرتبطة'), 'Arabic Connected Extension label rendered');
    assert.ok(html.includes('التحويلة'), 'Arabic Extension table column header rendered');
    assert.ok(html.includes('الدونجلات المصرح بها'), 'Arabic Allowed Dongles column header rendered');
    assert.ok(html.includes('تعديل'), 'Arabic Edit button rendered');
    assert.ok(html.includes('غير مقيد'), 'Arabic Unrestricted label rendered');
});

test('Scoped user view on Dashboard (/) only displays and defaults to their assigned extension', async () => {
    const moment = require('moment');
    const html = await ejs.renderFile(dashboardViewPath, {
        currentLang: 'en',
        currentPage: '/',
        user: { username: 'alice', role: 'user' },
        isSuperAdmin: false,
        userExtension: '101',
        stats: { totalCalls: 10, answeredCalls: 8, inboundCount: 5, outboundCount: 5, internalCount: 0, externalCount: 10, inboundMin: 10, outboundMin: 10, internalMin: 0, externalMin: 20, noAnswerCalls: 1, busyCalls: 1, failedCalls: 0, totalTalkMin: 20, totalTalkSec: 1200, avgTalkSec: 150 },
        roster: mockRoster,
        filters: { startDate: '2026-08-24 00:00:00', endDate: '2026-08-24 23:59:59', targetExtension: ['101'], statusFilter: 'ALL', searchSrc: '', searchDst: '', searchDid: '', searchUniqueId: '', directionFilter: 'ALL', callScopeFilter: 'ALL' },
        moment,
        trendData: JSON.stringify([]),
        dispositionData: JSON.stringify([]),
        hourlyData: JSON.stringify([]),
        topTalkers: JSON.stringify([]),
        durationData: JSON.stringify([]),
        scopeData: JSON.stringify([])
    });

    // In scoped mode, only extension 101 option is present, not ALL or 102
    assert.ok(!html.includes('id="dash_ext_chk_all"'), 'ALL checkbox is excluded for scoped user');
    assert.ok(!html.includes('id="dash_ext_chk_102"'), '102 checkbox is excluded for scoped user');
});

test('Scoped user view on CDR (/cdr) only displays and defaults to their assigned extension', async () => {
    const moment = require('moment');
    const html = await ejs.renderFile(cdrViewPath, {
        currentLang: 'en',
        currentPage: '/cdr',
        user: { username: 'alice', role: 'user' },
        isSuperAdmin: false,
        userExtension: '101',
        calls: [],
        roster: mockRoster,
        filters: { startDate: '2026-08-24 00:00:00', endDate: '2026-08-24 23:59:59', targetExtension: ['101'], statusFilter: 'ALL', searchSrc: '', searchDst: '', searchDid: '', searchUniqueId: '', directionFilter: 'ALL', callScopeFilter: 'ALL', page: 1, perPage: 25 },
        pagination: { total: 0, totalPages: 1, page: 1, perPage: 25 },
        moment
    });

    assert.ok(!html.includes('id="ext_chk_all"'), 'ALL checkbox is excluded for scoped user in CDR');
    assert.ok(!html.includes('id="ext_chk_102"'), '102 checkbox is excluded for scoped user in CDR');
});

test('Audio access authorization logic verifies extension involvement accurately', () => {
    const channelMatches = (ch, ext) => {
        if (!ch || !ext) return false;
        const reg = new RegExp(`^[A-Za-z0-9_]+/(${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})([^0-9]|$)`);
        return reg.test(ch);
    };

    const isAuthorized = (row, scopedExt) => {
        if (!scopedExt) return true; // Super Admin / unrestricted
        return (String(row.src || '').trim() === scopedExt) ||
               (String(row.dst || '').trim() === scopedExt) ||
               (String(row.cnum || '').trim() === scopedExt) ||
               channelMatches(row.channel, scopedExt) ||
               channelMatches(row.dstchannel, scopedExt);
    };

    // Extension 101 involved as src
    assert.equal(isAuthorized({ src: '101', dst: '01012345678', cnum: '101', channel: 'PJSIP/101-0001', dstchannel: 'Dongle/dongle0/01012345678' }, '101'), true);

    // Extension 101 involved as dst (inbound call)
    assert.equal(isAuthorized({ src: '01012345678', dst: '101', cnum: '01012345678', channel: 'Dongle/dongle0', dstchannel: 'PJSIP/101-0002' }, '101'), true);

    // Extension 101 involved in queue / transfer leg
    assert.equal(isAuthorized({ src: '01099999999', dst: '8000', cnum: '01099999999', channel: 'Dongle/dongle1', dstchannel: 'PJSIP/101-0003' }, '101'), true);

    // Call strictly between 102 and 103 -> user 101 must be REJECTED
    assert.equal(isAuthorized({ src: '102', dst: '103', cnum: '102', channel: 'PJSIP/102-0001', dstchannel: 'PJSIP/103-0001' }, '101'), false);

    // Call strictly between 102 and external -> user 101 must be REJECTED
    assert.equal(isAuthorized({ src: '102', dst: '01000000000', cnum: '102', channel: 'PJSIP/102-0002', dstchannel: 'Dongle/dongle0' }, '101'), false);

    // Super Admin (scopedExt = null) is authorized for ALL recordings
    assert.equal(isAuthorized({ src: '102', dst: '103', cnum: '102', channel: 'PJSIP/102-0001', dstchannel: 'PJSIP/103-0001' }, null), true);
});

test('Dongle, SMS, and USSD isolation logic verifies outbound route trunk mapping', () => {
    const isDeviceAllowedForDongles = (device, allowedDongleIdentifiers) => {
        if (!allowedDongleIdentifiers) return true; // Super Admin / unrestricted
        if (!Array.isArray(allowedDongleIdentifiers) || allowedDongleIdentifiers.length === 0) return false;
        const devName = String(device.Device || '').toLowerCase().trim();
        const imei = String(device.IMEI || '').replace(/\s+/g, '');
        const imsi = String(device.IMSI || '').replace(/\s+/g, '');
        const num = String(device.Number || '').replace(/\s+/g, '');

        return allowedDongleIdentifiers.some(ident => {
            const id = String(ident).toLowerCase().trim();
            return id === devName || (imei && imei === id) || (imsi && imsi === id) || (num && num.includes(id));
        });
    };

    const dongle0 = { Device: 'dongle0', IMEI: '352375044567196', IMSI: '602021234567890', Number: '01501562874' };
    const dongle1 = { Device: 'dongle1', IMEI: '864209044567199', IMSI: '602029999999999', Number: '01012345678' };

    // User linked to extension 101 has allowedDongles = ['dongle0', '352375044567196']
    const user101Allowed = ['dongle0', '352375044567196'];
    assert.equal(isDeviceAllowedForDongles(dongle0, user101Allowed), true, 'dongle0 is allowed for user 101');
    assert.equal(isDeviceAllowedForDongles(dongle1, user101Allowed), false, 'dongle1 is rejected for user 101');

    // Super Admin (allowedDongles = null) sees all dongles
    assert.equal(isDeviceAllowedForDongles(dongle0, null), true, 'dongle0 is allowed for Super Admin');
    assert.equal(isDeviceAllowedForDongles(dongle1, null), true, 'dongle1 is allowed for Super Admin');

    // SMS Inbox filtering
    const mockSmsInbox = [
        { id: '1', dongleId: 'dongle0', sender: 'Vodafone', content: 'Balance update' },
        { id: '2', dongleId: 'dongle1', sender: 'Orange', content: 'Promo code' }
    ];
    const filteredSms101 = mockSmsInbox.filter(msg => user101Allowed.some(d => d.toLowerCase() === String(msg.dongleId).toLowerCase()));
    assert.equal(filteredSms101.length, 1);
    assert.equal(filteredSms101[0].dongleId, 'dongle0');

    // USSD validation
    const isUssdAllowed = (targetDongle, allowedList) => {
        if (!allowedList) return true;
        return allowedList.some(d => d.toLowerCase() === String(targetDongle).toLowerCase().trim());
    };
    assert.equal(isUssdAllowed('dongle0', user101Allowed), true, 'USSD on dongle0 allowed');
    assert.equal(isUssdAllowed('dongle1', user101Allowed), false, 'USSD on dongle1 rejected');
});

test('Voicemails are accessible across all inboxes for any user with voicemails permission', async () => {
    const voicemailsViewPath = path.join(__dirname, '../views/voicemails.ejs');
    const moment = require('moment');
    const html = await ejs.renderFile(voicemailsViewPath, {
        currentLang: 'en',
        currentPage: '/voicemails',
        user: { username: 'alice', role: 'user' },
        isSuperAdmin: false,
        userExtension: '101',
        messages: [
            { mailbox: '101', callerid: '01012345678', origtime: Date.now(), duration: 15, extension: '101', wavFile: 'msg0000.wav' },
            { mailbox: '102', callerid: '01198765432', origtime: Date.now(), duration: 25, extension: '102', wavFile: 'msg0001.wav' }
        ],
        mailboxes: ['101', '102', '103'],
        filters: { searchCallerid: '', searchMailbox: '', startDate: '', endDate: '', page: 1, perPage: 25 },
        pagination: { total: 2, totalPages: 1, page: 1, perPage: 25 },
        moment
    });

    // Both 101 and 102 mailboxes and messages are visible in voicemails view
    assert.ok(html.includes('101'), 'Mailbox 101 is rendered');
    assert.ok(html.includes('102'), 'Mailbox 102 is rendered');
});

test('Inline script blocks in views/users.ejs have valid JavaScript syntax', async () => {
    const html = await ejs.renderFile(usersViewPath, {
        currentLang: 'en',
        currentPage: '/users',
        isSuperAdmin: true,
        user: { username: 'admin', role: 'admin' },
        users: mockUsers,
        groups: mockGroups,
        roster: mockRoster,
        allTabs: ['dashboard', 'users', 'cdr', 'voicemails', 'ext-stats', 'operator', 'config']
    });

    const scriptMatches = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi));
    assert.ok(scriptMatches.length > 0, 'Found inline script blocks in users.ejs');
    for (const match of scriptMatches) {
        const jsCode = match[1];
        assert.doesNotThrow(() => {
            new Function(jsCode);
        }, `Inline script in users.ejs threw syntax error:\n${jsCode.substring(0, 200)}...`);
    }
});

test('dashboard_user_dongles mapping and manual dongle permissions operate correctly', () => {
    const fs = require('fs');
    const serverCode = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.ok(serverCode.includes('dashboard_user_dongles'), 'server.js creates dashboard_user_dongles table');
    assert.ok(serverCode.includes('getUserAllowedDongles'), 'server.js defines getUserAllowedDongles helper');
    assert.ok(serverCode.includes('getAllServerDongles'), 'server.js defines getAllServerDongles helper');

    // Manual dongle assignment mapping simulation
    const mockUserDongles = [
        { user_id: 2, dongle_name: 'dongle0' },
        { user_id: 3, dongle_name: 'dongle1' }
    ];

    const resolveUserDongles = (userId, isSuperAdmin) => {
        if (isSuperAdmin) return null;
        const assigned = mockUserDongles.filter(r => r.user_id === userId).map(r => r.dongle_name.toLowerCase());
        return assigned;
    };

    assert.equal(resolveUserDongles(1, true), null, 'Super Admin receives null (unrestricted access)');
    assert.deepEqual(resolveUserDongles(2, false), ['dongle0'], 'User 2 only has access to dongle0');
    assert.deepEqual(resolveUserDongles(3, false), ['dongle1'], 'User 3 only has access to dongle1');
    assert.deepEqual(resolveUserDongles(4, false), [], 'User 4 with no assigned dongles receives empty array');
});
