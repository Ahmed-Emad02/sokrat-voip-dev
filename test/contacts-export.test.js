const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const rootDir = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');

test('contacts export endpoint returns an xlsx attachment', () => {
    const server = read('server.js');
    const route = server.match(/app\.get\('\/api\/contacts\/export'[\s\S]*?\n\}\);/);
    assert.ok(route, 'GET /api/contacts/export must exist');
    const handler = route[0];

    // Same access rule as viewing the address book.
    assert.match(handler, /requireAuth, requireTabPermission\('contacts'\)/);

    // Real workbook, not a CSV with an xlsx name.
    assert.match(handler, /XLSX\.utils\.book_new\(\)/);
    assert.match(handler, /XLSX\.utils\.aoa_to_sheet\(dataRows\)/);
    assert.match(handler, /bookType: 'xlsx'/);
    assert.match(handler, /XLSX\.utils\.book_append_sheet\(wb, ws, 'Contacts'\)/);

    // Headers must match what the importer understands so the file round-trips.
    assert.match(handler, /\[\['First Name', 'Last Name', 'Phone'\]\]/);

    assert.match(handler, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
    assert.match(handler, /Content-Disposition/);
    assert.match(handler, /const filename = `contacts_\$\{moment\(\)\.format\('YYYYMMDD_HHmmss'\)\}\.xlsx`/);
    assert.match(handler, /Cache-Control', 'no-store'|Cache-Control', 'no-store"/);

    // Every contact, not the paginated list view.
    assert.match(handler, /await loadContactsCached\(\)/);
});

test('the contacts toolbar offers a bilingual export button', async () => {
    const view = read('views/contacts.ejs');
    assert.match(view, /<button onclick="exportContactsXlsx\(\)" id="contactsExportBtn"/);
    assert.match(view, /Export all contacts \(Excel\)/);
    assert.match(view, /تصدير كل جهات الاتصال \(Excel\)/);
    assert.match(view, /window\.exportContactsXlsx = exportContactsXlsx;/);
    assert.match(view, /const url = '\/api\/contacts\/export';/);

    // The button sits outside the super-admin-only block so any contacts viewer
    // can export.
    const superAdminBlock = view.indexOf('<% if (isSuperAdmin) { %>');
    const exportBtn = view.indexOf('contactsExportBtn');
    assert.ok(exportBtn > 0 && exportBtn < superAdminBlock, 'export button must render for all contacts viewers');

    for (const lang of ['en', 'ar']) {
        const html = await ejs.renderFile(path.join(rootDir, 'views', 'contacts.ejs'), {
            currentPage: '/contacts', currentLang: lang, lang, isRtl: lang === 'ar', theme: 'dark',
            currentUser: 'root', isRoot: true, isSuperAdmin: false, userGroup: 'agents',
            userPermissions: ['contacts'], allowedTabs: ['contacts'], isTabAllowed: () => true,
            contacts: [], moment: require('moment'), t: {}
        });
        assert.ok(html.includes('contactsExportBtn'), `${lang} page must render the export button`);
    }
});
