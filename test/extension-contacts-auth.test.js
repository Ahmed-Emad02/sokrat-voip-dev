'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
    buildCanonical,
    signRequest,
    requireExtensionSignature
} = require('../lib/extension-auth');

const PASSWORD = 'secret';
const pool = { query: async () => [[{ password: PASSWORD }]] };

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

function makeReq({ extension = '101', timestamp, signature, method = 'GET', url = '/api/extension/v1/contacts?limit=1' } = {}) {
    const headers = {
        'X-Sokrat-Extension': extension,
        'X-Sokrat-Timestamp': timestamp,
        'X-Sokrat-Signature': signature
    };
    return {
        ip: '127.0.0.1',
        method,
        originalUrl: url,
        get: (name) => headers[name] || ''
    };
}

test('canonical string binds extension, timestamp, method and full path', () => {
    const canonical = buildCanonical('101', '1700000000000', 'GET', '/api/extension/v1/contacts?limit=1');
    assert.equal(canonical, '101\n1700000000000\nGET\n/api/extension/v1/contacts?limit=1');
    assert.equal(
        signRequest(PASSWORD, canonical),
        crypto.createHmac('sha256', PASSWORD).update(canonical).digest('hex')
    );
});

test('accepts a correctly signed request', async () => {
    const timestamp = String(Date.now());
    const url = '/api/extension/v1/contacts?limit=1';
    const signature = signRequest(PASSWORD, buildCanonical('101', timestamp, 'GET', url));
    const req = makeReq({ timestamp, signature, url });
    const res = makeRes();
    let nextCalled = false;

    await requireExtensionSignature(pool)(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(req.sokratExtension, '101');
});

test('rejects a request with no credentials', async () => {
    const req = makeReq({});
    const res = makeRes();
    let nextCalled = false;

    await requireExtensionSignature(pool)(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'extension_auth_required');
});

test('rejects an expired timestamp even with a valid signature', async () => {
    const timestamp = String(Date.now() - 10 * 60 * 1000);
    const url = '/api/extension/v1/contacts?limit=1';
    const signature = signRequest(PASSWORD, buildCanonical('101', timestamp, 'GET', url));
    const req = makeReq({ timestamp, signature, url });
    const res = makeRes();
    let nextCalled = false;

    await requireExtensionSignature(pool)(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'extension_signature_expired');
});

test('rejects a bad signature', async () => {
    const timestamp = String(Date.now());
    const req = makeReq({ timestamp, signature: '00'.repeat(32) });
    const res = makeRes();
    let nextCalled = false;

    await requireExtensionSignature(pool)(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'extension_signature_invalid');
});
