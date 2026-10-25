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

const tempDir = sqliteAvailable ? fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-csv-test-')) : '';
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
            VALUES ('Hassan', 'Salem', '01012345671', 'isPublic', 'external');
        `
    });
}

const contacts = sqliteAvailable ? require('../lib/contacts') : null;

test.after(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('handles Arabic headers and Excel formula phone formats', { skip: !sqliteAvailable }, async () => {
    const records = [
        { name: 'طارق', last_name: 'عمر', phone: '01012345672' },
        { name: 'ياسمين', last_name: 'علي', phone: '="01012345673"' },
        // Duplicate in database (matches 01012345671)
        { name: 'حسن', last_name: 'سالم', phone: '+201012345671' },
        // Duplicate inside file (duplicate of 01012345672)
        { name: 'طارق مكرر', last_name: 'عمر', phone: '201012345672' },
        // Missing name
        { name: '', last_name: 'بدون اسم', phone: '01099998888' },
        // Short phone
        { name: 'رقم قصير', last_name: 'خطأ', phone: '010' }
    ];

    const result = await contacts.importContactsBatch(records);

    assert.equal(result.total, 6);
    assert.equal(result.imported, 2);
    assert.equal(result.duplicatesCount, 2);
    assert.equal(result.errorsCount, 2);

    const list = await contacts.listContacts({ search: 'طارق' });
    assert.equal(list.length, 1);
    assert.equal(list[0].phone, '01012345672');

    const list2 = await contacts.listContacts({ search: 'ياسمين' });
    assert.equal(list2.length, 1);
    assert.equal(list2[0].phone, '01012345673');
});
