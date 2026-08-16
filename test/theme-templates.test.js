const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

test('views/users.ejs uses theme-aware CSS custom properties for tab permission labels', async () => {
    const usersEjsPath = path.join(__dirname, '../views/users.ejs');
    const content = fs.readFileSync(usersEjsPath, 'utf8');

    // Ensure no hardcoded dark bg-[#09090b] on tab permission label wrappers
    assert.equal(content.includes('bg-[#09090b]'), false, 'users.ejs should not contain hardcoded bg-[#09090b]');
    assert.ok(content.includes('bg-[var(--bg-primary)]'), 'users.ejs tab permission labels should use bg-[var(--bg-primary)]');
    assert.ok(content.includes('bg-[var(--bg-card)]'), 'users.ejs locked tab permission labels should use bg-[var(--bg-card)]');

    // Test EJS rendering
    const html = await ejs.renderFile(usersEjsPath, {
        currentLang: 'en',
        currentPage: '/users',
        isRtl: false,
        user: { username: 'admin', role: 'admin' },
        users: [],
        groups: [
            { id: 1, name: 'super admins', permissions: ['dashboard', 'users', 'cdr'] },
            { id: 2, name: 'operators', permissions: ['cdr'] }
        ],
        allTabs: ['dashboard', 'users', 'cdr', 'queues'],
        crmConfig: {},
        crmClients: []
    });

    assert.ok(html.includes('bg-[var(--bg-card)]'), 'Rendered locked tab labels should contain bg-[var(--bg-card)]');
    assert.ok(html.includes('bg-[var(--bg-primary)]'), 'Rendered tab labels should contain bg-[var(--bg-primary)]');
    assert.ok(html.includes('text-[var(--text-primary)]'), 'Rendered tab labels should contain text-[var(--text-primary)]');
});

test('views/groups.ejs uses theme-aware CSS custom properties for tab permission labels', async () => {
    const groupsEjsPath = path.join(__dirname, '../views/groups.ejs');
    const content = fs.readFileSync(groupsEjsPath, 'utf8');

    assert.ok(content.includes('bg-[var(--bg-primary)]'), 'groups.ejs tab permission labels should use bg-[var(--bg-primary)]');
    assert.ok(content.includes('text-[var(--text-primary)]'), 'groups.ejs tab permission labels should use text-[var(--text-primary)]');

    const html = await ejs.renderFile(groupsEjsPath, {
        currentLang: 'en',
        isRtl: false,
        groups: [{ id: 2, name: 'operators', permissions: ['cdr'] }],
        allTabs: ['dashboard', 'users', 'cdr', 'queues']
    });

    assert.ok(html.includes('bg-[var(--bg-primary)]'), 'Rendered groups tab labels should contain bg-[var(--bg-primary)]');
    assert.ok(html.includes('text-[var(--text-primary)]'), 'Rendered groups tab labels should contain text-[var(--text-primary)]');
});

test('views/sidebar.ejs includes light theme overrides for fallback classes', () => {
    const sidebarEjsPath = path.join(__dirname, '../views/sidebar.ejs');
    const content = fs.readFileSync(sidebarEjsPath, 'utf8');

    assert.ok(content.includes('.light-theme .text-zinc-200'), 'sidebar.ejs should define .light-theme .text-zinc-200 override');
    assert.ok(content.includes('.light-theme .bg-\\[\\#09090b\\]'), 'sidebar.ejs should define .light-theme .bg-[#09090b] override');
    assert.ok(content.includes('.light-theme .bg-black\\/40'), 'sidebar.ejs should define .light-theme .bg-black/40 override');
    assert.ok(content.includes('v1.0.2'), 'sidebar.ejs should display version v1.0.2');
});
