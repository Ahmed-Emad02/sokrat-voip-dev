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

const tempDir = sqliteAvailable ? fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-contacts-import-')) : '';
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
            VALUES ('Existing', 'Contact', '01011112222', 'isPublic', 'external');
            INSERT INTO contact (name, last_name, telefono, status, directory)
            VALUES ('Saudi', 'Client', '0501234567', 'isPublic', 'external');
        `
    });
}

const contacts = sqliteAvailable ? require('../lib/contacts') : null;
const phoneNorm = require('../lib/phone-normalization');

test.after(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Phone normalization translates Eastern Arabic numerals', () => {
    assert.equal(phoneNorm.translateArabicIndicDigits('٠١٠١٢٣٤٥٦٧٨'), '01012345678');
    assert.equal(phoneNorm.cleanPhoneString('٠١٠١٢٣٤٥٦٧٨'), '01012345678');
    assert.equal(phoneNorm.normalizePhoneNumber('٠١٠١٢٣٤٥٦٧٨'), '01012345678');
});

test('Phone normalization restores stripped leading zero for 10-digit Egyptian mobiles', () => {
    assert.equal(phoneNorm.restoreLeadingZero('1012345678'), '01012345678');
    assert.equal(phoneNorm.normalizePhoneNumber('1012345678'), '01012345678');
    assert.equal(phoneNorm.restoreLeadingZero('1112345678'), '01112345678');
    assert.equal(phoneNorm.restoreLeadingZero('1212345678'), '01212345678');
    assert.equal(phoneNorm.restoreLeadingZero('1512345678'), '01512345678');
});

test('Phone normalization restores stripped leading zero for 9-digit Saudi mobiles', () => {
    assert.equal(phoneNorm.restoreLeadingZero('501234567'), '0501234567');
    assert.equal(phoneNorm.normalizePhoneNumber('501234567'), '0501234567');
});

test('Rejects anonymous and dummy numbers', () => {
    assert.equal(phoneNorm.isAnonymousOrDummyPhone('anonymous'), true);
    assert.equal(phoneNorm.isAnonymousOrDummyPhone('unknown'), true);
    assert.equal(phoneNorm.isAnonymousOrDummyPhone('00000000'), true);
    assert.equal(phoneNorm.isAnonymousOrDummyPhone('11111111'), true);
    assert.equal(phoneNorm.isAnonymousOrDummyPhone('12345678'), true);
    assert.equal(phoneNorm.isAnonymousOrDummyPhone('01012345678'), false);
});

test('Rejects phone numbers shorter than 7 digits', () => {
    assert.equal(phoneNorm.isValidPhoneNumber('123456'), false);
    assert.equal(phoneNorm.isValidPhoneNumber('0101234'), true);
});

test('Finds existing contact by multi-format variants', { skip: !sqliteAvailable }, async () => {
    // Existing contact is '01011112222'
    const match1 = await contacts.findContactByPhone('+201011112222');
    assert.ok(match1, 'Should find contact via +20 international format');
    assert.equal(match1.first_name, 'Existing');

    const match2 = await contacts.findContactByPhone('201011112222');
    assert.ok(match2, 'Should find contact via 20 prefix');

    const match3 = await contacts.findContactByPhone('1011112222');
    assert.ok(match3, 'Should find contact via stripped zero format');

    const match4 = await contacts.findContactByPhone('٠١٠١١١١٢٢٢٢');
    assert.ok(match4, 'Should find contact via Arabic numerals');
});

test('createContact rejects multi-format duplicate with 409', { skip: !sqliteAvailable }, async () => {
    await assert.rejects(
        () => contacts.createContact({ firstName: 'Test', phone: '+201011112222' }),
        (err) => err.statusCode === 409 && err.code === 'contact_exists'
    );

    await assert.rejects(
        () => contacts.createContact({ firstName: 'Test', phone: '+966501234567' }),
        (err) => err.statusCode === 409 && err.code === 'contact_exists'
    );
});

test('importContactsBatch suppresses in-file and database duplicates', { skip: !sqliteAvailable }, async () => {
    const rawBatch = [
        // 1. Valid new contact
        { firstName: 'Mahmoud', lastName: 'Adel', phone: '01098765432' },
        // 2. Duplicate against database (existing is 01011112222, imported as +201011112222)
        { firstName: 'DupeDB', lastName: 'One', phone: '+201011112222' },
        // 3. Duplicate against database in Arabic numerals
        { firstName: 'DupeDB', lastName: 'Two', phone: '٠١٠١١١١٢٢٢٢' },
        // 4. Valid new contact with Eastern Arabic numerals
        { firstName: 'Kareem', lastName: 'Fouad', phone: '٠١٠٥٥٥٥٦٦٦٦' },
        // 5. Duplicate of row 4 within the same file (in-file dupe)
        { firstName: 'KareemDupe', lastName: 'SameFile', phone: '01055556666' },
        // 6. Invalid: missing first name
        { firstName: '', lastName: 'Nameless', phone: '01044443333' },
        // 7. Invalid: short phone (< 7 digits)
        { firstName: 'ShortPhone', lastName: 'Invalid', phone: '12345' },
        // 8. Invalid: dummy phone
        { firstName: 'Dummy', lastName: 'Invalid', phone: '0000000000' }
    ];

    const result = await contacts.importContactsBatch(rawBatch);

    assert.equal(result.total, 8, 'Total rows should be 8');
    assert.equal(result.imported, 2, 'Should import exactly 2 unique valid contacts (Mahmoud and Kareem)');
    assert.equal(result.duplicatesCount, 3, 'Should flag 3 duplicates (2 DB dupes, 1 in-file dupe)');
    assert.equal(result.errorsCount, 3, 'Should flag 3 errors (missing name, short phone, dummy phone)');

    // Verify imported contacts in DB
    const list = await contacts.listContacts({ search: 'Mahmoud' });
    assert.equal(list.length, 1);
    assert.equal(list[0].phone, '01098765432');

    const kareemList = await contacts.listContacts({ search: 'Kareem' });
    assert.equal(kareemList.length, 1);
    assert.equal(kareemList[0].phone, '01055556666');
});
