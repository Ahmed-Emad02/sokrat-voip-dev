'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sqliteAvailable = (() => {
    try {
        execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

const tempDir = sqliteAvailable ? fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-contacts-bulk-')) : '';
const dbPath = tempDir ? path.join(tempDir, 'address_book.db') : '';

if (sqliteAvailable) {
    process.env.ADDRESS_BOOK_DB = dbPath;
    execFileSync('sqlite3', [dbPath], {
        input: `
            CREATE TABLE contact (
                id integer PRIMARY KEY AUTOINCREMENT,
                name varchar(35),
                last_name varchar(35),
                telefono varchar(32),
                iduser integer default 1,
                status varchar(30) default 'isPrivate',
                directory varchar(8) default 'external'
            );
        `
    });
}

const contacts = sqliteAvailable ? require('../lib/contacts') : null;

test.after(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

async function createContact(firstName, phone) {
    return contacts.createContact({ firstName, lastName: 'Bulk', phone });
}

test('bulk delete removes only existing selected contacts', { skip: !sqliteAvailable }, async () => {
    const first = await createContact('Bulk One', '01090000001');
    const second = await createContact('Bulk Two', '01090000002');
    const third = await createContact('Bulk Three', '01090000003');

    const result = await contacts.deleteContacts([first.id, second.id, 99999999]);

    assert.equal(result.requested, 3);
    assert.equal(result.deleted, 2);
    assert.deepEqual(result.deletedIds, [first.id, second.id]);
    assert.deepEqual(result.missing, [99999999]);

    const list = await contacts.listContacts({ search: 'Bulk' });
    assert.deepEqual(list.map(contact => contact.id), [third.id]);
});

test('bulk delete deduplicates IDs and handles an empty result', { skip: !sqliteAvailable }, async () => {
    const created = await createContact('Bulk Duplicate', '01090000004');

    const result = await contacts.deleteContacts([created.id, created.id]);
    assert.equal(result.requested, 1);
    assert.equal(result.deleted, 1);
    assert.deepEqual(result.deletedIds, [created.id]);
    assert.deepEqual(result.missing, []);

    const empty = await contacts.deleteContacts([99999998]);
    assert.equal(empty.deleted, 0);
    assert.deepEqual(empty.missing, [99999998]);
});

test('bulk ID validation rejects malformed or oversized selections', { skip: !sqliteAvailable }, async () => {
    await assert.rejects(
        () => contacts.deleteContacts([]),
        (err) => err.statusCode === 400 && err.code === 'bulk_ids_required'
    );
    await assert.rejects(
        () => contacts.deleteContacts(['1']),
        (err) => err.statusCode === 400 && err.code === 'bulk_invalid_id'
    );
    await assert.rejects(
        () => contacts.deleteContacts([1.5]),
        (err) => err.statusCode === 400 && err.code === 'bulk_invalid_id'
    );
    await assert.rejects(
        () => contacts.deleteContacts(Array.from({ length: contacts.MAX_BULK_CONTACT_IDS + 1 }, (_, index) => index + 1)),
        (err) => err.statusCode === 400 && err.code === 'bulk_too_many'
    );
});

test('selected export fetch returns only requested local contacts', { skip: !sqliteAvailable }, async () => {
    const first = await createContact('Bulk Export A', '01090000005');
    const second = await createContact('Bulk Export B', '01090000006');
    const third = await createContact('Bulk Export C', '01090000007');

    const selected = await contacts.getContactsByIds([third.id, first.id]);
    assert.deepEqual(selected.map(contact => contact.id).sort((a, b) => a - b), [first.id, third.id]);
    assert.equal(selected.some(contact => contact.id === second.id), false);

    const missing = await contacts.getContactsByIds([99999997]);
    assert.deepEqual(missing, []);
});

test('bulk delete invalidates the cached contact list', { skip: !sqliteAvailable }, async () => {
    const created = await createContact('Bulk Cache', '01090000008');
    await contacts.loadContactsCached();
    assert.ok((await contacts.loadContactsCached()).some(contact => contact.id === created.id));

    await contacts.deleteContacts([created.id]);
    assert.equal((await contacts.loadContactsCached()).some(contact => contact.id === created.id), false);
});

test('bulk routes are permission-gated and the contacts view exposes selection', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const view = fs.readFileSync(path.join(__dirname, '../views/contacts.ejs'), 'utf8');

    assert.match(server, /app\.post\('\/api\/contacts\/bulk-delete'[\s\S]*?contacts-delete/);
    assert.match(server, /app\.post\('\/api\/contacts\/bulk-export'[\s\S]*?requireTabPermission\('contacts'\)/);
    assert.match(view, /id="contactsSelectAll"/);
    assert.match(view, /id="contactsBulkBar"/);
    assert.match(view, /data-contact-id=/);
    assert.match(view, /bulkDeleteContacts/);
    assert.match(view, /bulkExportSelected/);
    assert.match(view, /canDeleteContact/);
});
