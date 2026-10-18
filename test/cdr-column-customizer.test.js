const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const cdrEjsPath = path.join(__dirname, '../views/cdr.ejs');
const serverPath = path.join(__dirname, '../server.js');

test('CDR Column Customizer: views/cdr.ejs tags all 13 columns in thead and tbody with data-col', () => {
    const content = fs.readFileSync(cdrEjsPath, 'utf8');

    const expectedCols = [
        'time', 'uniqueid', 'src', 'dst', 'did', 'trunk',
        'name', 'airtime', 'state', 'dir', 'scope',
        'rec', 'actions'
    ];

    expectedCols.forEach(col => {
        assert.ok(content.includes(`data-col="${col}"`), `Must contain data-col="${col}" in views/cdr.ejs`);
    });
});

test('CDR Column Customizer: views/cdr.ejs renders columns button and customization modal', () => {
    const content = fs.readFileSync(cdrEjsPath, 'utf8');

    // 1. Toolbar customize button
    assert.match(content, /id="cdrColCountBadge"/, 'Must contain column counter badge in toolbar');
    assert.match(content, /openCdrColumnsModal\(\)/, 'Must contain openCdrColumnsModal trigger button');

    // 2. Customization modal markup
    assert.match(content, /id="cdrColumnsModal"/, 'Must contain cdrColumnsModal');
    assert.match(content, /id="cdrColumnsOrderList"/, 'Must contain cdrColumnsOrderList container');
    assert.match(content, /saveCdrColumnsPreference\(\)/, 'Must contain saveCdrColumnsPreference button');
    assert.match(content, /resetCdrColumnsToDefault\(\)/, 'Must contain resetCdrColumnsToDefault button');
});

test('CDR Column Customizer: Client JS defines CDR_COLUMNS_CATALOG and DOM reordering functions', () => {
    const content = fs.readFileSync(cdrEjsPath, 'utf8');

    assert.match(content, /const CDR_COLUMNS_CATALOG =/, 'Must define CDR_COLUMNS_CATALOG');
    assert.match(content, /function applyCdrColumnsToTable/, 'Must define applyCdrColumnsToTable');
    assert.match(content, /function toggleCdrModalColumn/, 'Must define toggleCdrModalColumn');
    assert.match(content, /function moveCdrModalColumn/, 'Must define moveCdrModalColumn');
    assert.match(content, /sokrat_cdr_columns_v1/, 'Must store preferences under sokrat_cdr_columns_v1 key');
});

test('CDR Column Customizer: server.js wires GET and POST /api/user/column-preferences endpoints', () => {
    const serverContent = fs.readFileSync(serverPath, 'utf8');

    assert.match(serverContent, /app\.get\('\/api\/user\/column-preferences'/, 'server.js must expose GET /api/user/column-preferences');
    assert.match(serverContent, /app\.post\('\/api\/user\/column-preferences'/, 'server.js must expose POST /api/user/column-preferences');
});
