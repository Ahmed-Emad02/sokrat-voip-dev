const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mysql = require('mysql2/promise');
const {
    encryptKey,
    decryptKey,
    createApiKey,
    listApiKeys,
    revealApiKey,
    setApiKeyStatus,
    deleteApiKey,
    validateApiKey,
    ipMatches
} = require('../lib/api-key-manager');

const BASE_URL = 'http://127.0.0.1:8080';

let pool = null;
let rootCookie = null;
let nonRootCookie = null;

test.before(async () => {
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || 'admin',
        database: 'asterisk'
    });

    // Root login
    const rootRes = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=root&password=Admin@123',
        redirect: 'manual'
    });
    rootCookie = rootRes.headers.get('set-cookie');

    // Non-root admin login
    const adminRes = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
        redirect: 'manual'
    });
    nonRootCookie = adminRes.headers.get('set-cookie');
});

test.after(async () => {
    if (pool) {
        await pool.end();
    }
});

// --- UNIT TESTS: ENGINE & CRYPTOGRAPHY ---

test('API Key Manager: encryptKey and decryptKey roundtrip AES-256-GCM accurately', () => {
    const rawKey = 'sokrat_live_a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const encrypted = encryptKey(rawKey);
    assert.notEqual(encrypted, rawKey);
    assert.equal(encrypted.split(':').length, 3, 'Packed ciphertext must have IV, authTag, and ciphertext');

    const decrypted = decryptKey(encrypted);
    assert.equal(decrypted, rawKey, 'Decrypted key must match original raw key');
});

test('API Key Manager: decryptKey returns null on tampered ciphertext or bad tag', () => {
    const rawKey = 'sokrat_live_1234567890abcdef';
    const encrypted = encryptKey(rawKey);
    const parts = encrypted.split(':');
    // Tamper with tag
    const tampered = `${parts[0]}:00000000000000000000000000000000:${parts[2]}`;
    const result = decryptKey(tampered);
    assert.equal(result, null, 'Tampered tag must fail decryption cleanly');
});

test('API Key Manager: ipMatches validates exact IP, wildcards, CIDR blocks, and loopback aliases', () => {
    // Wildcard
    assert.equal(ipMatches('192.168.1.5', '*'), true);
    assert.equal(ipMatches('192.168.1.5', null), true);

    // Exact
    assert.equal(ipMatches('192.168.1.100', '192.168.1.100, 10.0.0.1'), true);
    assert.equal(ipMatches('192.168.1.101', '192.168.1.100, 10.0.0.1'), false);

    // Subnet wildcard
    assert.equal(ipMatches('192.168.1.45', '192.168.1.*'), true);
    assert.equal(ipMatches('192.168.2.45', '192.168.1.*'), false);

    // CIDR
    assert.equal(ipMatches('10.0.5.23', '10.0.0.0/16'), true);
    assert.equal(ipMatches('10.1.5.23', '10.0.0.0/16'), false);

    // Loopback
    assert.equal(ipMatches('::1', '127.0.0.1'), true);
    assert.equal(ipMatches('127.0.0.1', '::1'), true);
    assert.equal(ipMatches('127.0.0.1', 'localhost'), true);
});

// --- REST ENDPOINT & ROOT AUTHORIZATION TESTS ---

test('Root Access Control: Unauthenticated user is redirected on /admin/api-keys and 401 on /api/admin/api-keys', async () => {
    const pageRes = await fetch(`${BASE_URL}/admin/api-keys`, { redirect: 'manual' });
    assert.equal(pageRes.status, 302, 'Unauthenticated browser request must redirect to login');

    const apiRes = await fetch(`${BASE_URL}/api/admin/api-keys`);
    assert.equal(apiRes.status, 401, 'Unauthenticated API request must return 401');
    const apiData = await apiRes.json();
    assert.equal(apiData.success, false);
});

test('Root Access Control: Non-root user (admin) receives HTTP 403 Forbidden', async () => {
    const pageRes = await fetch(`${BASE_URL}/admin/api-keys`, {
        headers: { Cookie: nonRootCookie },
        redirect: 'manual'
    });
    assert.equal(pageRes.status, 403, 'Non-root account must be rejected with 403 Forbidden on GUI page');

    const apiRes = await fetch(`${BASE_URL}/api/admin/api-keys`, {
        headers: { Cookie: nonRootCookie }
    });
    assert.equal(apiRes.status, 403, 'Non-root account must be rejected with 403 Forbidden on API route');
    const apiData = await apiRes.json();
    assert.equal(apiData.success, false);
    assert.ok(apiData.error.includes('Only the root user'));
});

test('Root Access Control: Root user receives HTTP 200 on GUI and API routes', async () => {
    const pageRes = await fetch(`${BASE_URL}/admin/api-keys`, {
        headers: { Cookie: rootCookie }
    });
    assert.equal(pageRes.status, 200, 'Root account must access GUI page successfully');
    const pageHtml = await pageRes.text();
    assert.ok(pageHtml.includes('API Key Manager') || pageHtml.includes('إدارة مفاتيح API'));

    const apiRes = await fetch(`${BASE_URL}/api/admin/api-keys`, {
        headers: { Cookie: rootCookie }
    });
    assert.equal(apiRes.status, 200, 'Root account must access API key list');
    const apiData = await apiRes.json();
    assert.equal(apiData.success, true);
    assert.ok(Array.isArray(apiData.keys));
});

test('API Key Lifecycle: Create, List, Reveal, Validate, Revoke, and Delete Key', async () => {
    // 1. Create Key
    const createRes = await fetch(`${BASE_URL}/api/admin/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: rootCookie },
        body: JSON.stringify({
            name: 'Production CRM Integration Test',
            scopes: 'cdr:read,cdr:audio',
            allowed_ips: '127.0.0.1, 10.0.0.0/8',
            expires_in_days: 90
        })
    });
    assert.equal(createRes.status, 200);
    const createData = await createRes.json();
    assert.equal(createData.success, true);
    assert.ok(createData.key.rawKey.startsWith('sokrat_live_'));
    const keyId = createData.key.id;
    const rawKey = createData.key.rawKey;

    try {
        // 2. List Keys
        const listRes = await fetch(`${BASE_URL}/api/admin/api-keys`, {
            headers: { Cookie: rootCookie }
        });
        const listData = await listRes.json();
        const found = listData.keys.find(k => k.id === keyId);
        assert.ok(found, 'Created key must appear in API key list');
        assert.equal(found.name, 'Production CRM Integration Test');
        assert.equal(found.status, 'active');

        // 3. Reveal Key
        const revealRes = await fetch(`${BASE_URL}/api/admin/api-keys/${keyId}/reveal`, {
            headers: { Cookie: rootCookie }
        });
        const revealData = await revealRes.json();
        assert.equal(revealData.success, true);
        assert.equal(revealData.rawKey, rawKey, 'Decrypted key from reveal must match generated key');

        // 4. Authenticate CDR endpoint via X-API-Key
        const cdrRes = await fetch(`${BASE_URL}/api/cdr/1790496202.18`, {
            headers: { 'X-API-Key': rawKey }
        });
        assert.equal(cdrRes.status, 200, 'CDR query must succeed with valid API key');
        const cdrData = await cdrRes.json();
        assert.equal(cdrData.success, true);

        // 5. Authenticate via Authorization: Bearer
        const cdrBearerRes = await fetch(`${BASE_URL}/api/cdr/phone/01011719380?limit=1`, {
            headers: { 'Authorization': `Bearer ${rawKey}` }
        });
        assert.equal(cdrBearerRes.status, 200, 'CDR query must succeed with Bearer API key');

        // 6. Authenticate Audio Stream via ?api_key=
        const audioRes = await fetch(`${BASE_URL}/api/cdr/audio/1790496202.18?api_key=${rawKey}`, {
            headers: { Range: 'bytes=0-10' }
        });
        assert.equal(audioRes.status, 206, 'Audio stream query must succeed with ?api_key= parameter');

        // 7. Revoke Key
        const revokeRes = await fetch(`${BASE_URL}/api/admin/api-keys/${keyId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: rootCookie },
            body: JSON.stringify({ status: 'revoked' })
        });
        const revokeData = await revokeRes.json();
        assert.equal(revokeData.success, true);

        // 8. Re-test endpoint with revoked key -> Must return 401
        const revokedAttempt = await fetch(`${BASE_URL}/api/cdr/1790496202.18`, {
            headers: { 'X-API-Key': rawKey }
        });
        assert.equal(revokedAttempt.status, 401, 'Revoked API key must be rejected');
        const revokedData = await revokedAttempt.json();
        assert.ok(revokedData.error.includes('revoked'));

    } finally {
        // 9. Delete Key
        const deleteRes = await fetch(`${BASE_URL}/api/admin/api-keys/${keyId}`, {
            method: 'DELETE',
            headers: { Cookie: rootCookie }
        });
        const deleteData = await deleteRes.json();
        assert.equal(deleteData.success, true, 'Delete API key must succeed');
    }
});

test('API Key Security: Disallowed client IP is rejected with HTTP 401', async () => {
    // Create key strictly bound to 192.0.2.1
    const createRes = await fetch(`${BASE_URL}/api/admin/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: rootCookie },
        body: JSON.stringify({
            name: 'Strict IP Key',
            scopes: '*',
            allowed_ips: '192.0.2.1'
        })
    });
    const createData = await createRes.json();
    const keyId = createData.key.id;
    const rawKey = createData.key.rawKey;

    try {
        const res = await fetch(`${BASE_URL}/api/cdr/1790496202.18`, {
            headers: { 'X-API-Key': rawKey }
        });
        assert.equal(res.status, 401);
        const data = await res.json();
        assert.ok(data.error.includes('not in the allowed IP list'));
    } finally {
        await fetch(`${BASE_URL}/api/admin/api-keys/${keyId}`, {
            method: 'DELETE',
            headers: { Cookie: rootCookie }
        });
    }
});
