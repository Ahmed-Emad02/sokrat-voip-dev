'use strict';

/**
 * Shared SQLite address-book store.
 *
 * The dashboard, the installer dialplan and the CRM integration API all read
 * the same `address_book.db` file. Keeping every query here guarantees that a
 * contact created from the Chrome extension is immediately visible to the
 * dashboard and to inbound caller-ID lookups.
 */

const { spawn } = require('child_process');
const {
    translateArabicIndicDigits,
    cleanPhoneString,
    restoreLeadingZero,
    isValidPhoneNumber,
    isAnonymousOrDummyPhone,
    getPhoneVariants
} = require('./phone-normalization');

const ADDRESS_BOOK_DB = process.env.ADDRESS_BOOK_DB || '/var/www/db/address_book.db';

function runSqlite(sql, dbPath = ADDRESS_BOOK_DB) {
    return new Promise((resolve, reject) => {
        const proc = spawn('sqlite3', [dbPath]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });
        proc.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || `sqlite3 exited with code ${code}`));
        });
        proc.stdin.write(sql);
        proc.stdin.end();
    });
}

function runSqliteQuery(sql, dbPath = ADDRESS_BOOK_DB) {
    return new Promise((resolve, reject) => {
        const proc = spawn('sqlite3', ['-separator', '~~~', dbPath]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });
        proc.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || `sqlite3 exited with code ${code}`));
        });
        proc.stdin.write(sql);
        proc.stdin.end();
    });
}

function parseSqliteRows(stdout) {
    const lines = String(stdout || '').split('\n');
    const rows = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('~~~');
        if (parts.length >= 4) {
            rows.push({
                id: parts[0],
                name: parts[1],
                last_name: parts[2],
                telefono: parts[3]
            });
        }
    }
    return rows;
}

function escapeSql(str) {
    return String(str || '').replace(/'/g, "''").trim();
}

function validationError(message, code = 'validation_error') {
    const err = new Error(message);
    err.statusCode = 422;
    err.code = code;
    return err;
}

/**
 * Normalize a phone number: translate Eastern Arabic digits, strip non-dialable separators,
 * and auto-recover leading zero for bare national numbers.
 */
function normalizePhoneNumber(phone) {
    if (phone == null) return '';
    const cleaned = cleanPhoneString(phone);
    if (!cleaned) return '';
    return restoreLeadingZero(cleaned);
}

function normalizeContactPayload(input) {
    const payload = input || {};
    const firstName = String(payload.firstName ?? payload.first_name ?? payload.name ?? '').trim();
    const lastName = String(payload.lastName ?? payload.last_name ?? '').trim();
    const phone = normalizePhoneNumber(payload.phone ?? payload.telefono ?? '');

    if (firstName === '') throw validationError('First name is required.');
    if (phone === '') throw validationError('Phone number is required.');
    if (!isValidPhoneNumber(phone)) {
        if (isAnonymousOrDummyPhone(phone)) throw validationError('Invalid or anonymous phone number.');
        throw validationError('Phone number must contain at least 7 valid digits.');
    }
    if (firstName.length > 35) throw validationError('First name must be 35 characters or fewer.');
    if (lastName.length > 35) throw validationError('Last name must be 35 characters or fewer.');
    if (phone.length > 32) throw validationError('Phone number must be 32 characters or fewer.');

    return { firstName, lastName, phone };
}

function mapContactRow(row) {
    return {
        id: Number(row.id),
        first_name: row.name || '',
        last_name: row.last_name || '',
        phone: row.telefono || ''
    };
}

async function listContacts(options = {}) {
    const stdout = await runSqliteQuery(
        'SELECT id, name, last_name, telefono FROM contact ORDER BY name COLLATE NOCASE ASC, last_name COLLATE NOCASE ASC;'
    );

    let contacts = parseSqliteRows(stdout).map(mapContactRow);
    const search = String(options.search || '').trim();
    if (search !== '') {
        const needle = search.toLowerCase();
        const digits = search.replace(/\D/g, '');
        contacts = contacts.filter((contact) => {
            const name = `${contact.first_name} ${contact.last_name}`.toLowerCase();
            const phone = String(contact.phone || '').replace(/\D/g, '');
            return name.includes(needle) || (digits !== '' && phone.includes(digits));
        });
    }

    const parsedLimit = Number.parseInt(options.limit, 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 5000) : 1000;
    return contacts.slice(0, limit);
}

async function findContactByPhone(phone) {
    const rawClean = translateArabicIndicDigits(phone);
    const normalized = normalizePhoneNumber(rawClean);
    if (!normalized) return null;

    const variants = getPhoneVariants(phone);
    if (!variants.includes(normalized)) variants.push(normalized);

    const inClause = variants.map(v => `'${escapeSql(v)}'`).join(',');
    const stdout = await runSqliteQuery(
        `SELECT id, name, last_name, telefono FROM contact WHERE telefono IN (${inClause}) ORDER BY id ASC LIMIT 1;`
    );
    const rows = parseSqliteRows(stdout);
    return rows.length > 0 ? mapContactRow(rows[0]) : null;
}

async function findContactById(id) {
    const contactId = Number.parseInt(id, 10);
    if (!Number.isInteger(contactId) || contactId <= 0) return null;

    const stdout = await runSqliteQuery(
        `SELECT id, name, last_name, telefono FROM contact WHERE id = ${contactId} ORDER BY id ASC LIMIT 1;`
    );
    const rows = parseSqliteRows(stdout);
    return rows.length > 0 ? mapContactRow(rows[0]) : null;
}

async function createContact(input) {
    const payload = normalizeContactPayload(input);

    const existing = await findContactByPhone(payload.phone);
    if (existing) {
        const err = new Error('A contact with this phone number already exists.');
        err.statusCode = 409;
        err.code = 'contact_exists';
        err.contact = existing;
        throw err;
    }

    await runSqlite(
        `INSERT INTO contact (name, last_name, telefono, iduser, status, directory) ` +
        `VALUES ('${escapeSql(payload.firstName)}', '${escapeSql(payload.lastName)}', '${escapeSql(payload.phone)}', 1, 'isPublic', 'external');`
    );

    return findContactByPhone(payload.phone);
}

async function updateContact(id, input) {
    const existing = await findContactById(id);
    if (!existing) {
        const err = new Error('Contact not found.');
        err.statusCode = 404;
        err.code = 'contact_not_found';
        throw err;
    }

    const payload = normalizeContactPayload(input);

    if (payload.phone !== existing.phone) {
        const duplicate = await findContactByPhone(payload.phone);
        if (duplicate && duplicate.id !== existing.id) {
            const err = new Error('A contact with this phone number already exists.');
            err.statusCode = 409;
            err.code = 'contact_exists';
            err.contact = duplicate;
            throw err;
        }
    }

    await runSqlite(
        `UPDATE contact SET name = '${escapeSql(payload.firstName)}', last_name = '${escapeSql(payload.lastName)}', ` +
        `telefono = '${escapeSql(payload.phone)}' WHERE id = ${existing.id};`
    );

    return findContactById(existing.id);
}

async function deleteContact(id) {
    const existing = await findContactById(id);
    if (!existing) {
        const err = new Error('Contact not found.');
        err.statusCode = 404;
        err.code = 'contact_not_found';
        throw err;
    }

    await runSqlite(`DELETE FROM contact WHERE id = ${existing.id};`);
    return existing;
}

/**
 * Bulk import contacts with two-tier duplicate detection:
 *  1. In-file duplicate checking (skips repeating rows within uploaded file)
 *  2. Database multi-format duplicate checking (Egypt/Saudi/international candidates)
 *  3. Input sanitization (Arabic-Indic digits, name/phone lengths, minimum 7 digits)
 * @param {Array<Object>} rawRows
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function importContactsBatch(rawRows, options = {}) {
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
        return {
            total: 0,
            imported: 0,
            duplicatesCount: 0,
            errorsCount: 0,
            duplicates: [],
            errors: [],
            message: 'No records provided for import.'
        };
    }

    // 1. Preload all existing contacts from SQLite into an in-memory variant lookup map
    const existingStdout = await runSqliteQuery('SELECT id, name, last_name, telefono FROM contact;');
    const existingRows = parseSqliteRows(existingStdout);
    const existingVariantMap = new Map();

    for (const row of existingRows) {
        const rowPhone = String(row.telefono || '').trim();
        if (!rowPhone) continue;
        const variants = getPhoneVariants(rowPhone);
        const contactInfo = {
            id: Number(row.id),
            name: `${row.name || ''} ${row.last_name || ''}`.trim(),
            telefono: rowPhone
        };
        for (const v of variants) {
            if (!existingVariantMap.has(v)) {
                existingVariantMap.set(v, contactInfo);
            }
        }
    }

    const fileSeenVariants = new Set();
    const validRows = [];
    const duplicates = [];
    const errors = [];

    for (let i = 0; i < rawRows.length; i++) {
        const item = rawRows[i] || {};
        const rowNum = item.rowNumber || (i + 1);

        const rawFirst = String(item.firstName ?? item.first_name ?? item.name ?? '').trim();
        const rawLast = String(item.lastName ?? item.last_name ?? '').trim();
        const rawPhone = item.phone ?? item.telefono ?? item.number ?? '';

        if (!rawFirst) {
            errors.push({
                row: rowNum,
                name: '',
                phone: String(rawPhone || ''),
                reason: 'First name is required'
            });
            continue;
        }

        const normalized = normalizePhoneNumber(rawPhone);
        const digits = normalized.replace(/\D/g, '');

        if (!normalized || digits.length === 0) {
            errors.push({
                row: rowNum,
                name: rawFirst,
                phone: '',
                reason: 'Phone number is required'
            });
            continue;
        }

        if (digits.length < 7) {
            errors.push({
                row: rowNum,
                name: rawFirst,
                phone: String(rawPhone),
                reason: 'Phone number must contain at least 7 digits'
            });
            continue;
        }

        if (isAnonymousOrDummyPhone(normalized)) {
            errors.push({
                row: rowNum,
                name: rawFirst,
                phone: String(rawPhone),
                reason: 'Invalid or anonymous phone number'
            });
            continue;
        }

        if (normalized.length > 32) {
            errors.push({
                row: rowNum,
                name: rawFirst,
                phone: String(rawPhone),
                reason: 'Phone number exceeds 32 characters'
            });
            continue;
        }

        const firstName = rawFirst.slice(0, 35).trim();
        const lastName = rawLast.slice(0, 35).trim();

        // Generate all variants for the phone
        const variants = getPhoneVariants(normalized);
        if (!variants.includes(normalized)) variants.push(normalized);

        // Check in-file duplicate
        let isDupeInFile = false;
        for (const v of variants) {
            if (fileSeenVariants.has(v)) {
                isDupeInFile = true;
                break;
            }
        }

        if (isDupeInFile) {
            duplicates.push({
                row: rowNum,
                name: `${firstName} ${lastName}`.trim(),
                phone: normalized,
                reason: 'Duplicate inside uploaded file'
            });
            continue;
        }

        // Check database duplicate
        let existingMatch = null;
        for (const v of variants) {
            if (existingVariantMap.has(v)) {
                existingMatch = existingVariantMap.get(v);
                break;
            }
        }

        if (existingMatch) {
            duplicates.push({
                row: rowNum,
                name: `${firstName} ${lastName}`.trim(),
                phone: normalized,
                reason: `Already exists in address book (${existingMatch.name || existingMatch.telefono})`
            });
            continue;
        }

        // Mark as seen in file and in DB map for subsequent rows in the same batch
        for (const v of variants) {
            fileSeenVariants.add(v);
            existingVariantMap.set(v, { id: null, name: `${firstName} ${lastName}`.trim(), telefono: normalized });
        }

        validRows.push({
            firstName,
            lastName,
            phone: normalized
        });
    }

    // Execute SQLite batch insert
    if (validRows.length > 0) {
        const statements = ['BEGIN TRANSACTION;'];
        for (const r of validRows) {
            statements.push(
                `INSERT INTO contact (name, last_name, telefono, iduser, status, directory) ` +
                `VALUES ('${escapeSql(r.firstName)}', '${escapeSql(r.lastName)}', '${escapeSql(r.phone)}', 1, 'isPublic', 'external');`
            );
        }
        statements.push('COMMIT;');
        await runSqlite(statements.join('\n'));
    }

    const message = `${validRows.length} contacts imported successfully.` +
        (duplicates.length > 0 ? ` ${duplicates.length} duplicates skipped.` : '') +
        (errors.length > 0 ? ` ${errors.length} invalid rows ignored.` : '');

    return {
        total: rawRows.length,
        imported: validRows.length,
        duplicatesCount: duplicates.length,
        errorsCount: errors.length,
        duplicates,
        errors,
        message
    };
}

module.exports = {
    ADDRESS_BOOK_DB,
    runSqlite,
    runSqliteQuery,
    parseSqliteRows,
    escapeSql,
    normalizePhoneNumber,
    normalizeContactPayload,
    listContacts,
    findContactByPhone,
    findContactById,
    createContact,
    updateContact,
    deleteContact,
    importContactsBatch
};
