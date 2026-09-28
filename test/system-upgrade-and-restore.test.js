const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const sidebarEjsPath = path.join(__dirname, '../views/sidebar.ejs');
const BASE_URL = 'http://127.0.0.1:8080';

test('1. Sidebar CSS: Settings popup box-shadow is explicitly removed', () => {
    const sidebarContent = fs.readFileSync(sidebarEjsPath, 'utf8');
    assert.match(
        sidebarContent,
        /\.settings-menu\s*\{[^}]*box-shadow:\s*none\s*!important;/,
        '.settings-menu must have box-shadow: none !important'
    );
    assert.doesNotMatch(
        sidebarContent,
        /\.settings-menu\s*\{[^}]*box-shadow:\s*0\s+24px/,
        '.settings-menu must not contain previous 24px drop shadow'
    );
});

test('2. Sidebar UI: Update Sokrat and Restore Backup buttons are strictly root-only', async () => {
    // Case A: Non-root super admin (isSuperAdmin = true, isRootUser = false)
    const superAdminHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['dashboard', 'users']
    });

    assert.equal(
        superAdminHtml.includes('id="updateDashboardBtn"'),
        false,
        'updateDashboardBtn must NOT be visible to non-root super admin'
    );
    assert.equal(
        superAdminHtml.includes('id="restoreBackupBtn"'),
        false,
        'restoreBackupBtn must NOT be visible to non-root super admin'
    );

    // Case B: Standard employee user (isSuperAdmin = false, isRootUser = false)
    const standardUserHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'agent101',
        allowedTabs: ['dashboard']
    });

    assert.equal(
        standardUserHtml.includes('id="updateDashboardBtn"'),
        false,
        'updateDashboardBtn must NOT be visible to standard user'
    );
    assert.equal(
        standardUserHtml.includes('id="restoreBackupBtn"'),
        false,
        'restoreBackupBtn must NOT be visible to standard user'
    );

    // Case C: Root user (isRootUser = true)
    const rootUserHtml = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: true,
        currentUser: 'root',
        allowedTabs: []
    });

    assert.ok(
        rootUserHtml.includes('id="updateDashboardBtn"'),
        'updateDashboardBtn MUST be rendered for root user'
    );
    assert.ok(
        rootUserHtml.includes('id="restoreBackupBtn"'),
        'restoreBackupBtn MUST be rendered for root user'
    );
    assert.ok(
        rootUserHtml.includes('triggerDashboardUpdate()'),
        'Root update button must trigger triggerDashboardUpdate()'
    );
    assert.ok(
        rootUserHtml.includes('triggerRestoreBackup()'),
        'Root restore button must trigger triggerRestoreBackup()'
    );
});

test('3. API Security: POST /api/system/update and POST /api/system/restore-backup reject non-root users', async () => {
    // 1. Unauthenticated request
    const unauthUpdateRes = await fetch(`${BASE_URL}/api/system/update`, {
        method: 'POST',
        headers: { 'Accept': 'application/json' }
    });
    assert.equal(unauthUpdateRes.status, 401, 'Unauthenticated /api/system/update must return 401');

    const unauthRestoreRes = await fetch(`${BASE_URL}/api/system/restore-backup`, {
        method: 'POST',
        headers: { 'Accept': 'application/json' }
    });
    assert.equal(unauthRestoreRes.status, 401, 'Unauthenticated /api/system/restore-backup must return 401');

    // 2. Non-root user login (admin)
    const adminLoginRes = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin&lang=en',
        redirect: 'manual'
    });
    const adminCookie = adminLoginRes.headers.get('set-cookie');
    if (adminCookie) {
        const forbiddenUpdateRes = await fetch(`${BASE_URL}/api/system/update`, {
            method: 'POST',
            headers: { Cookie: adminCookie, 'Accept': 'application/json' }
        });
        assert.equal(forbiddenUpdateRes.status, 403, 'Non-root user must be forbidden 403 on /api/system/update');
        const updateData = await forbiddenUpdateRes.json();
        assert.match(updateData.error, /Root user authorization required/);

        const forbiddenRestoreRes = await fetch(`${BASE_URL}/api/system/restore-backup`, {
            method: 'POST',
            headers: { Cookie: adminCookie, 'Accept': 'application/json' }
        });
        assert.equal(forbiddenRestoreRes.status, 403, 'Non-root user must be forbidden 403 on /api/system/restore-backup');
        const restoreData = await forbiddenRestoreRes.json();
        assert.match(restoreData.error, /Root user authorization required/);
    }
});

test('4. Scripts: safe-upgrade.sh and restore-backup.sh syntax and executable permissions', () => {
    const safeUpgradePath = path.join(__dirname, '../scripts/safe-upgrade.sh');
    const restoreBackupPath = path.join(__dirname, '../scripts/restore-backup.sh');

    assert.ok(fs.existsSync(safeUpgradePath), 'scripts/safe-upgrade.sh must exist');
    assert.ok(fs.existsSync(restoreBackupPath), 'scripts/restore-backup.sh must exist');

    const safeUpgradeStat = fs.statSync(safeUpgradePath);
    const restoreBackupStat = fs.statSync(restoreBackupPath);

    // Verify executable permissions
    assert.ok(safeUpgradeStat.mode & 0o111, 'scripts/safe-upgrade.sh must be executable');
    assert.ok(restoreBackupStat.mode & 0o111, 'scripts/restore-backup.sh must be executable');

    const safeUpgradeContent = fs.readFileSync(safeUpgradePath, 'utf8');
    assert.match(safeUpgradeContent, /\.last_preupgrade_backup/, 'safe-upgrade.sh must track .last_preupgrade_backup');

    const restoreBackupContent = fs.readFileSync(restoreBackupPath, 'utf8');
    assert.match(restoreBackupContent, /\.last_preupgrade_backup/, 'restore-backup.sh must read .last_preupgrade_backup');
});
