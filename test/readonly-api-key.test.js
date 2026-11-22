'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mysql = require('mysql2/promise');
const { createApiKey, deleteApiKey } = require('../lib/api-key-manager');

const BASE_URL = 'http://127.0.0.1:8080';
let pool;
let key;
let keyId;

function request(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const req = http.request(url, {
            method: options.method || 'GET',
            headers: { ...(options.headers || {}) }
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                let body = null;
                try { body = JSON.parse(raw.toString('utf8')); } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, body, raw });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

test.before(async () => {
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || 'admin',
        database: 'asterisk'
    });
    const created = await createApiKey(pool, {
        name: 'Read-only ERP integration test',
        scopes: 'calls:read,recordings:read,extensions:read,stats:read,cdr,cdr-export,live:read',
        allowed_ips: '127.0.0.1'
    });
    key = created.rawKey;
    keyId = created.id;
});

test.after(async () => {
    if (pool && keyId) {
        try { await deleteApiKey(pool, keyId); } catch (_) {}
        await pool.end();
    }
});

test('read-only key can read CDR and receives rate-limit headers', async () => {
    const res = await request('/api/cdr/1790496202.18', { headers: { 'X-API-Key': key } });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.headers['x-ratelimit-limit']);
    assert.ok(res.headers['x-ratelimit-remaining']);
});

test('read-only key can read employee stats and export Excel', async () => {
    const stats = await request('/api/ext-overview', { headers: { 'X-API-Key': key } });
    assert.equal(stats.status, 200);

    const exported = await request('/cdr/export?startDate=2026-11-01&endDate=2026-11-30', {
        headers: { 'X-API-Key': key }
    });
    assert.equal(exported.status, 200);
    assert.match(String(exported.headers['content-type'] || ''), /spreadsheetml|text\/csv/);
});

test('read-only key cannot reach extension configuration', async () => {
    const res = await request('/api/config/extensions', { headers: { 'X-API-Key': key } });
    assert.equal(res.status, 403);
});

test('read-only key cannot perform write operations', async () => {
    const res = await request('/api/cdr/delete', {
        method: 'POST',
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uniqueid: '1790496202.18' })
    });
    assert.equal(res.status, 403);
});

test('read-only key can use CRM read endpoints and open the live event stream', async () => {
    const extensions = await request('/api/integrations/v1/extensions', { headers: { 'X-API-Key': key } });
    assert.equal(extensions.status, 200);

    const transcript = await request('/api/integrations/v1/recordings/1790496202.18/transcript', {
        headers: { 'X-API-Key': key }
    });
    assert.ok([200, 404].includes(transcript.status));

    await new Promise((resolve, reject) => {
        const req = http.request(new URL('/api/integrations/v1/events', BASE_URL), {
            method: 'GET',
            headers: { 'X-API-Key': key, Accept: 'text/event-stream' }
        }, (res) => {
            assert.equal(res.statusCode, 200);
            let data = '';
            res.on('data', chunk => {
                data += chunk.toString('utf8');
                if (data.includes('event: snapshot')) {
                    req.destroy();
                    resolve();
                }
            });
            res.on('error', reject);
        });
        req.on('error', (err) => {
            if (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_DESTROYED') return;
            reject(err);
        });
        req.setTimeout(5000, () => { req.destroy(new Error('SSE timeout')); });
        req.end();
    });
});
