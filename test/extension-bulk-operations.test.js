'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

const { MAX_BULK_EXTENSIONS, buildExtensionRange } = require('../lib/extension-bulk');

test('builds sequential extension ranges', () => {
    const result = buildExtensionRange('200', 5);
    assert.equal(result.ok, true);
    assert.deepEqual(result.values, ['200', '201', '202', '203', '204']);
});

test('preserves leading zero-padded extension width', () => {
    const result = buildExtensionRange('099', 3);
    assert.equal(result.ok, true);
    assert.deepEqual(result.values, ['099', '100', '101']);
});

test('rejects invalid starts, counts, and oversized ranges', () => {
    assert.equal(buildExtensionRange('', 5).ok, false);
    assert.equal(buildExtensionRange('abc', 5).ok, false);
    assert.equal(buildExtensionRange('0', 5).ok, false);
    assert.equal(buildExtensionRange('100', 0).ok, false);
    assert.equal(buildExtensionRange('100', MAX_BULK_EXTENSIONS + 1).ok, false);
});

test('accepts the maximum allowed count', () => {
    const result = buildExtensionRange('100', MAX_BULK_EXTENSIONS);
    assert.equal(result.ok, true);
    assert.equal(result.values.length, MAX_BULK_EXTENSIONS);
    assert.equal(result.values[0], '100');
    assert.equal(result.values[result.values.length - 1], String(100 + MAX_BULK_EXTENSIONS - 1));
});

test('bulk extension route and UI are wired', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const configView = fs.readFileSync(path.join(__dirname, '../views/config.ejs'), 'utf8');
    const configJs = fs.readFileSync(path.join(__dirname, '../views/scripts/config-page.ejs'), 'utf8');

    assert.match(server, /app\.post\('\/api\/config\/extensions\/bulk'/);
    assert.match(server, /buildExtensionRange\(body\.start_extension, body\.count\)/);
    assert.match(server, /name: extNum/);
    assert.match(configView, /id="bulkExtensionModal"/);
    assert.match(configView, /id="bulkExtStart"/);
    assert.match(configView, /id="bulkExtCount"/);
    assert.match(configView, /openBulkExtensionModal\(\)/);
    assert.match(configJs, /function openBulkExtensionModal\(\)/);
    assert.match(configJs, /async function saveBulkExtensions\(event\)/);
    assert.match(configJs, /fetch\('\/api\/config\/extensions\/bulk'/);
    assert.match(configJs, /start_extension: startRaw/);

    // The inline bulk UI block must be valid JavaScript after EJS rendering.
    const start = configJs.indexOf('function buildBulkExtensionNumbers');
    const end = configJs.indexOf('async function openExtensionModal', start);
    assert.ok(start >= 0 && end > start, 'bulk extension JS block must exist');
    assert.doesNotThrow(() => new vm.Script(configJs.slice(start, end), { filename: 'bulk-extension-block.js' }));
});

test('config.ejs compiles with the bulk extension modal', () => {
    const file = path.join(__dirname, '../views/config.ejs');
    const template = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => ejs.compile(template, { filename: file }));
});
