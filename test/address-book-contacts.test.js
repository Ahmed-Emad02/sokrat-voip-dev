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

const tempDir = sqliteAvailable ? fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-contacts-')) : '';
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
            INSERT INTO contact (name, last_name, telefono, status, directory)
            VALUES ('Existing', 'Person', '01011112222', 'isPublic', 'external');
        `
    });
}

const contacts = sqliteAvailable ? require('../lib/contacts') : null;

test.after(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('normalizes bare national numbers with the local trunk prefix', { skip: !sqliteAvailable }, () => {
    assert.equal(contacts.normalizePhoneNumber('1012345678'), '01012345678');
    assert.equal(contacts.normalizePhoneNumber('010 1234 5678'), '01012345678');
});

test('creates a contact and returns it in the directory list', { skip: !sqliteAvailable }, async () => {
    const created = await contacts.createContact({
        firstName: 'Mona',
        lastName: 'Hassan',
        phone: '+201012345678'
    });

    assert.equal(created.first_name, 'Mona');
    assert.equal(created.last_name, 'Hassan');
    assert.equal(created.phone, '+201012345678');

    const list = await contacts.listContacts({ search: 'Mona' });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
});

test('rejects a duplicate phone number with a 409 conflict', { skip: !sqliteAvailable }, async () => {
    await assert.rejects(
        () => contacts.createContact({ firstName: 'Duplicate', phone: '01011112222' }),
        (err) => err.statusCode === 409 && err.code === 'contact_exists'
    );
});

test('updates a contact while keeping the same id', { skip: !sqliteAvailable }, async () => {
    const created = await contacts.createContact({ firstName: 'Omar', phone: '01099990000' });
    const updated = await contacts.updateContact(created.id, {
        firstName: 'Omar',
        lastName: 'Ali',
        phone: '01099990001'
    });

    assert.equal(updated.id, created.id);
    assert.equal(updated.last_name, 'Ali');
    assert.equal(updated.phone, '01099990001');
});

test('deletes a contact and removes it from lookups', { skip: !sqliteAvailable }, async () => {
    const created = await contacts.createContact({ firstName: 'Temporary', phone: '01077778888' });
    const deleted = await contacts.deleteContact(created.id);

    assert.equal(deleted.id, created.id);
    assert.equal(await contacts.findContactById(created.id), null);
});
