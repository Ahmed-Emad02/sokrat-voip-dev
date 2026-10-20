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
 * Normalize a phone number exactly like the dashboard always has: strip
 * separators, then add the local trunk prefix to bare national numbers.
 */
function normalizePhoneNumber(phone) {
    const cleaned = String(phone == null ? '' : phone).replace(/[\s\-().]/g, '').trim();
    let finalPhone = cleaned;
    if (/^\d+$/.test(cleaned) && !cleaned.startsWith('0') && cleaned.length >= 7) {
        finalPhone = '0' + cleaned;
    }
    return finalPhone;
}

function normalizeContactPayload(input) {
    const payload = input || {};
    const firstName = String(payload.firstName ?? payload.first_name ?? payload.name ?? '').trim();
    const lastName = String(payload.lastName ?? payload.last_name ?? '').trim();
    const phone = normalizePhoneNumber(payload.phone ?? payload.telefono ?? '');

    if (firstName === '') throw validationError('First name is required.');
    if (phone === '') throw validationError('Phone number is required.');
    if (!/^\+?[0-9*#]+$/.test(phone)) throw validationError('Phone number contains invalid characters.');
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
    const normalized = normalizePhoneNumber(phone);
    if (normalized === '') return null;

    const stdout = await runSqliteQuery(
        `SELECT id, name, last_name, telefono FROM contact WHERE telefono = '${escapeSql(normalized)}' ORDER BY id ASC LIMIT 1;`
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
    deleteContact
};
