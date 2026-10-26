const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
const contacts = fs.readFileSync(path.join(rootDir, 'lib', 'contacts.js'), 'utf8');
const { MAX_IMPORT_ROWS, importContactsBatch } = require('../lib/contacts');

// Slice the whole route: `});` alone is ambiguous because the multer wrapper
// closes inside the handler.
function importRoute() {
    const start = server.indexOf("app.post('/api/contacts/csv-import'");
    assert.ok(start > 0, 'import route must exist');
    const end = server.indexOf('\napp.post(', start + 10);
    return server.slice(start, end > 0 ? end : start + 15000);
}

test('contact import only accepts spreadsheet and text files', () => {
    const upload = server.match(/const contactsUpload = multer\(\{[\s\S]*?\n\}\);/);
    assert.ok(upload, 'contactsUpload must exist');
    assert.match(upload[0], /fileFilter:/);
    assert.match(upload[0], /CONTACT_IMPORT_EXTENSIONS\.has\(ext\)/);
    assert.match(upload[0], /error\.statusCode = 400/);

    const exts = server.match(/const CONTACT_IMPORT_EXTENSIONS = new Set\(\[([^\]]*)\]\)/);
    assert.ok(exts, 'extension whitelist must exist');
    for (const ext of ['.csv', '.txt', '.xlsx', '.xls']) {
        assert.ok(exts[1].includes(`'${ext}'`), `whitelist must contain ${ext}`);
    }

    // The endpoint must use the guarded uploader, not the shared csvUpload.
    const route = importRoute();
    assert.match(route, /contactsUpload\.single\('file'\)/);
    assert.ok(!/csvUpload\.single\('file'\), async \(req, res\)/.test(route), 'endpoint must not use csvUpload directly');
    // Multer errors become JSON 400/413 instead of a default HTML 500.
    assert.match(route, /'LIMIT_FILE_SIZE' \? 413 : 400/);
});

test('xlsx/xls uploads are verified by magic bytes', () => {
    const helper = server.match(/function assertSpreadsheetMagic\(filePath, originalName\)[\s\S]*?\n\}/);
    assert.ok(helper, 'assertSpreadsheetMagic must exist');
    assert.match(helper[0], /0x50 && head\[1\] === 0x4b/, 'xlsx zip signature');
    assert.match(helper[0], /0xd0 && head\[1\] === 0xcf/, 'xls OLE signature');
    assert.match(helper[0], /not a valid \.xlsx workbook/);
    assert.match(helper[0], /not a valid \.xls workbook/);

    const route = importRoute();
    assert.match(route, /const magicError = assertSpreadsheetMagic\(filePath, req\.file\.originalname\)/);
    assert.match(route, /if \(magicError\)[\s\S]{0,160}status\(400\)/);
});

test('storage failures are logged, never echoed to the client', () => {
    const handler = importRoute();

    assert.match(handler, /console\.error\('\[Contacts Import\] failed:'/);
    assert.match(handler, /Import failed while writing contacts\. Nothing was imported\./);
    // The raw error must not be returned for 5xx.
    assert.ok(
        !/res\.status\(500\)\.json\(\{ success: false, error: err\.message \}\)/.test(handler),
        'must not return the raw error message on 500'
    );
    // Validation-style errors keep their message.
    assert.match(handler, /status >= 400 && status < 500/);
});

test('import batch is capped', async () => {
    assert.equal(MAX_IMPORT_ROWS, 20000);
    assert.match(contacts, /const MAX_IMPORT_ROWS = 20000;/);
    assert.match(contacts, /if \(rawRows\.length > MAX_IMPORT_ROWS\)/);
    assert.match(contacts, /'import_too_large'/);

    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
        rowNumber: i + 2, firstName: 'Probe', lastName: '', phone: '01012345678'
    }));
    await assert.rejects(
        () => importContactsBatch(rows),
        (err) => {
            assert.equal(err.statusCode, 422);
            assert.equal(err.code, 'import_too_large');
            assert.match(err.message, /Split the file into batches of 20000/);
            return true;
        }
    );

    // The endpoint rejects before touching the writer too.
    const route = importRoute();
    assert.match(route, /rawRecords\.length > MAX_IMPORT_ROWS/);
    assert.match(route, /status\(400\)[\s\S]{0,200}Too many rows/);
});
