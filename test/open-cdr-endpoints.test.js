const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const mysql = require('mysql2/promise');
const { createApiKey, deleteApiKey } = require('../lib/api-key-manager');

const BASE_URL = 'http://127.0.0.1:8080';

let testApiKey = null;
let testKeyId = null;
let pool = null;

test.before(async () => {
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || 'admin',
        database: 'asterisk'
    });
    const keyData = await createApiKey(pool, {
        name: 'Automated Test Key',
        scopes: '*',
        allowed_ips: null
    });
    testApiKey = keyData.rawKey;
    testKeyId = keyData.id;
});

test.after(async () => {
    if (pool && testKeyId) {
        try {
            await deleteApiKey(pool, testKeyId);
        } catch (_) {}
        await pool.end();
    }
});

function makeRequest(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const reqOptions = {
            method: options.method || 'GET',
            headers: options.headers || {}
        };
        const req = http.request(url, reqOptions, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const bodyRaw = Buffer.concat(chunks).toString('utf8');
                let bodyJson = null;
                try {
                    bodyJson = JSON.parse(bodyRaw);
                } catch (_) {}
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: bodyJson || bodyRaw,
                    rawBuffer: Buffer.concat(chunks)
                });
            });
        });
        req.on('error', reject);
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

test('CDR Security: Unauthenticated request without API key returns HTTP 401', async () => {
    const res = await makeRequest('/api/cdr/1790496202.18');
    assert.strictEqual(res.status, 401, 'Should return HTTP 401 without API key');
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.error.includes('Unauthorized'));
});

test('CDR API with X-API-Key: GET /api/cdr/:uniqueid fetches single call record', async () => {
    // 1790496202.18 is a real answered call with recording
    const res = await makeRequest('/api/cdr/1790496202.18', {
        headers: { 'X-API-Key': testApiKey }
    });
    assert.strictEqual(res.status, 200, 'Should return HTTP 200 with X-API-Key');
    assert.strictEqual(res.body.success, true, 'Response success should be true');
    assert.ok(res.body.data, 'Should return call data');
    assert.strictEqual(res.body.data.uniqueid, '1790496202.18');
    assert.strictEqual(res.body.data.src, '103');
    assert.strictEqual(res.body.data.dst, '01011719380');
    assert.strictEqual(res.body.data.disposition, 'ANSWERED');
    assert.strictEqual(res.body.data.direction, 'OUTBOUND');

    // Recording metadata verification
    assert.ok(res.body.data.recording, 'Recording metadata should be present');
    assert.strictEqual(res.body.data.recording.available, true, 'Audio file should be available');
    assert.ok(res.body.data.recording.file_size > 0, 'Audio file size should be > 0');
    assert.strictEqual(res.body.data.recording.format, 'wav', 'Format should be wav');
    assert.strictEqual(res.body.data.recording.stream_url, '/api/cdr/audio/1790496202.18');
    assert.strictEqual(res.body.data.recording.download_url, '/api/cdr/audio/1790496202.18?download=1');

    // Transcription block verification
    assert.ok(res.body.data.transcription, 'Transcription block should be present');
});

test('CDR API with X-API-Key: GET /api/cdr/:uniqueid returns 404 for unknown record', async () => {
    const res = await makeRequest('/api/cdr/unknown-unique-id-999', {
        headers: { 'X-API-Key': testApiKey }
    });
    assert.strictEqual(res.status, 404, 'Should return HTTP 404 for missing call');
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.error.includes('not found'));
});

test('CDR API with Authorization: Bearer: GET /api/cdr/phone/:phone fetches calls', async () => {
    const res = await makeRequest('/api/cdr/phone/01011719380', {
        headers: { 'Authorization': `Bearer ${testApiKey}` }
    });
    assert.strictEqual(res.status, 200, 'Should return HTTP 200 with Bearer auth');
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.phone, '01011719380');
    assert.ok(Array.isArray(res.body.matched_variants), 'Should include normalized phone variants');
    assert.ok(res.body.total >= 10, 'Should find all calls involving this phone');
    assert.ok(Array.isArray(res.body.calls), 'Calls should be an array');

    // Verify first call object structure
    const firstCall = res.body.calls[0];
    assert.ok(firstCall.uniqueid, 'Call should have uniqueid');
    assert.ok(firstCall.calldate, 'Call should have calldate');
    assert.ok(firstCall.direction, 'Call should have direction');
    assert.ok(firstCall.recording, 'Call should have recording details');
});

test('CDR API with X-API-Key: GET /api/cdr/phone/:phone returns empty list for number without calls', async () => {
    const res = await makeRequest('/api/cdr/phone/01999999999', {
        headers: { 'X-API-Key': testApiKey }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.total, 0);
    assert.deepStrictEqual(res.body.calls, []);
});

test('CDR Audio API with ?api_key=: GET /api/cdr/audio/:uniqueid streams recording with Byte-Range support', async () => {
    const res = await makeRequest(`/api/cdr/audio/1790496202.18?api_key=${testApiKey}`, {
        headers: {
            Range: 'bytes=0-99'
        }
    });
    assert.strictEqual(res.status, 206, 'Should respond with 206 Partial Content');
    assert.ok(res.headers['content-range'].includes('bytes 0-99/'), 'Content-Range should match requested byte window');
    assert.strictEqual(res.headers['content-type'], 'audio/wav');
    assert.strictEqual(res.rawBuffer.length, 100);
});

test('CDR Audio API with ?api_key=: GET /api/cdr/audio/:uniqueid?download=1 sets attachment disposition', async () => {
    const res = await makeRequest(`/api/cdr/audio/1790496202.18?download=1&api_key=${testApiKey}`, {
        headers: {
            Range: 'bytes=0-9'
        }
    });
    assert.strictEqual(res.status, 206);
    assert.ok(res.headers['content-disposition'].startsWith('attachment;'), 'Should set attachment disposition');
});

test('CDR API with X-API-Key: Query parameter and /api/calls aliases work seamlessly', async () => {
    const resQueryUnique = await makeRequest('/api/cdr?uniqueid=1790496202.18', {
        headers: { 'X-API-Key': testApiKey }
    });
    assert.strictEqual(resQueryUnique.status, 200);
    assert.strictEqual(resQueryUnique.body.data.uniqueid, '1790496202.18');

    const resCallAlias = await makeRequest('/api/calls/1790496202.18', {
        headers: { 'X-API-Key': testApiKey }
    });
    assert.strictEqual(resCallAlias.status, 200);
    assert.strictEqual(resCallAlias.body.data.uniqueid, '1790496202.18');

    const resQueryPhone = await makeRequest('/api/cdr?phone=01011719380', {
        headers: { 'X-API-Key': testApiKey }
    });
    assert.strictEqual(resQueryPhone.status, 200);
    assert.ok(resQueryPhone.body.total >= 10);

    const resCallPhone = await makeRequest('/api/calls/phone/01011719380', {
        headers: { 'X-API-Key': testApiKey }
    });
    assert.strictEqual(resCallPhone.status, 200);
    assert.ok(resCallPhone.body.total >= 10);
});

test('Security check: POST /api/cdr/delete remains protected and rejects unauthenticated callers', async () => {
    const res = await makeRequest('/api/cdr/delete', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ uniqueid: '1790496202.18' })
    });
    assert.strictEqual(res.status, 401, 'Should return HTTP 401 Unauthorized for delete without auth');
    assert.strictEqual(res.body.success, false);
});
