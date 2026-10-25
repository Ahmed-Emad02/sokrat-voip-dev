'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildSignatureHeaders,
    verifyFederationSignature,
    normalizeFederationBaseUrl,
    checkRateLimit,
    canonicalRequest,
    MAX_CLOCK_SKEW_MS
} = require('../lib/federation-auth');

const API_KEY = 'test-peer-api-key-0123456789abcdef';
const SITE = '77';

function signed(overrides = {}) {
    const headers = buildSignatureHeaders({
        apiKey: API_KEY,
        siteCode: SITE,
        method: overrides.method || 'GET',
        url: overrides.url || '/api/federation/v1/live-state',
        body: overrides.body == null ? null : overrides.body,
        timestamp: overrides.timestamp,
        nonce: overrides.nonce
    });
    return {
        ...headers,
        timestamp: headers['X-Sokrat-Timestamp'],
        nonce: headers['X-Sokrat-Nonce'],
        signature: headers['X-Sokrat-Signature']
    };
}

test('Federation Auth: valid signature verifies and preserves canonical URL with query string', () => {
    const url = '/api/federation/v1/repairs?status=open&limit=10';
    const sig = signed({ url });
    const verdict = verifyFederationSignature({
        apiKey: API_KEY,
        siteCode: SITE,
        method: 'GET',
        url,
        bodyText: '',
        timestamp: sig.timestamp,
        nonce: sig.nonce,
        signature: sig.signature
    });
    assert.equal(verdict.ok, true);

    const canonical = canonicalRequest('GET', url, sig.timestamp, sig.nonce,
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.match(canonical, /^GET\n\/api\/federation\/v1\/repairs\?status=open&limit=10\n/);
});

test('Federation Auth: tampered body, URL, or signature is rejected', () => {
    const body = JSON.stringify({ hello: 'world' });
    const sig = signed({ method: 'POST', url: '/api/federation/v1/action', body });

    const ok = verifyFederationSignature({
        apiKey: API_KEY,
        siteCode: SITE,
        method: 'POST',
        url: '/api/federation/v1/action',
        bodyText: body,
        timestamp: sig.timestamp,
        nonce: sig.nonce,
        signature: sig.signature
    });
    assert.equal(ok.ok, true);

    const tamperedBody = verifyFederationSignature({
        apiKey: API_KEY,
        siteCode: SITE,
        method: 'POST',
        url: '/api/federation/v1/action',
        bodyText: JSON.stringify({ hello: 'tampered' }),
        timestamp: sig.timestamp,
        nonce: 'tampered-body-nonce-1',
        signature: sig.signature
    });
    assert.equal(tamperedBody.ok, false);
    assert.equal(tamperedBody.error, 'signature mismatch');

    const tamperedUrl = verifyFederationSignature({
        apiKey: API_KEY,
        siteCode: SITE,
        method: 'POST',
        url: '/api/federation/v1/other',
        bodyText: body,
        timestamp: sig.timestamp,
        nonce: 'tampered-url-nonce-1',
        signature: sig.signature
    });
    assert.equal(tamperedUrl.ok, false);

    const wrongKey = verifyFederationSignature({
        apiKey: 'wrong-key',
        siteCode: SITE,
        method: 'POST',
        url: '/api/federation/v1/action',
        bodyText: body,
        timestamp: sig.timestamp,
        nonce: 'wrong-key-nonce-1',
        signature: sig.signature
    });
    assert.equal(wrongKey.ok, false);
});

test('Federation Auth: old timestamp and replayed nonce are rejected', () => {
    const oldTimestamp = Date.now() - MAX_CLOCK_SKEW_MS - 5000;
    const old = signed({ timestamp: oldTimestamp, nonce: 'old-timestamp-nonce-1' });
    const oldVerdict = verifyFederationSignature({
        apiKey: API_KEY,
        siteCode: SITE,
        method: 'GET',
        url: '/api/federation/v1/live-state',
        bodyText: '',
        timestamp: old.timestamp,
        nonce: old.nonce,
        signature: old.signature
    });
    assert.equal(oldVerdict.ok, false);
    assert.equal(oldVerdict.error, 'clock skew too large');

    const sig = signed({ nonce: 'replay-nonce-123456' });
    const first = verifyFederationSignature({
        apiKey: API_KEY,
        siteCode: SITE,
        method: 'GET',
        url: '/api/federation/v1/live-state',
        bodyText: '',
        timestamp: sig.timestamp,
        nonce: sig.nonce,
        signature: sig.signature
    });
    assert.equal(first.ok, true);

    const replay = verifyFederationSignature({
        apiKey: API_KEY,
        siteCode: SITE,
        method: 'GET',
        url: '/api/federation/v1/live-state',
        bodyText: '',
        timestamp: sig.timestamp,
        nonce: sig.nonce,
        signature: sig.signature
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.error, 'replayed request');
});

test('Federation Auth: base URL normalization strips the softphone :8443 vhost', () => {
    assert.equal(normalizeFederationBaseUrl('https://192.168.100.92:8443'), 'https://192.168.100.92');
    assert.equal(normalizeFederationBaseUrl('192.168.100.92:8443'), 'https://192.168.100.92');
    assert.equal(normalizeFederationBaseUrl('http://192.168.100.92:8080/'), 'https://192.168.100.92:8080');
    assert.equal(
        normalizeFederationBaseUrl('http://192.168.100.92:8080', { allowHttp: true }),
        'http://192.168.100.92:8080'
    );
    assert.equal(normalizeFederationBaseUrl(''), '');
});

test('Federation Auth: write rate limit is lower than read rate limit', () => {
    const site = 'rate-test-site';
    const now = Date.now();
    for (let i = 0; i < 120; i += 1) {
        const verdict = checkRateLimit(site, 'GET', now + i);
        assert.equal(verdict.allowed, true, `read request ${i + 1} must be allowed`);
    }
    const readOverflow = checkRateLimit(site, 'GET', now + 121);
    assert.equal(readOverflow.allowed, false);

    const writeSite = 'rate-test-writes';
    for (let i = 0; i < 20; i += 1) {
        assert.equal(checkRateLimit(writeSite, 'POST', now + i).allowed, true);
    }
    const writeOverflow = checkRateLimit(writeSite, 'POST', now + 21);
    assert.equal(writeOverflow.allowed, false);
    assert.ok(writeOverflow.retryAfterSec >= 1);
});

function mockFederationRequest(headers, path = '/gsm-dongles', method = 'GET') {
    const normalized = {};
    for (const [key, value] of Object.entries(headers || {})) {
        normalized[String(key).toLowerCase()] = value;
    }
    return {
        path,
        originalUrl: `/api${path}`,
        method,
        ip: '127.0.0.1',
        headers: normalized,
        rawBody: Buffer.from(''),
        isFederationAuthenticated: false
    };
}

function mockResponse() {
    const res = {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        set(name, value) { this.headers[name] = value; return this; }
    };
    return res;
}

test('Federation Auth: optional mount elevates signed peer requests and ignores browser traffic', async () => {
    const { federationAuthMiddleware } = require('../lib/federation-auth');
    const pool = {
        async query(sql) {
            if (/FROM .*sokrat_federation_peers/i.test(sql)) {
                return [[{ id: 3, site_code: SITE, api_key_enc: 'enc' }]];
            }
            return [{}];
        }
    };
    const middleware = federationAuthMiddleware({
        pool,
        decryptFn: () => API_KEY,
        optional: true,
        skipPrefixes: ['/federation'],
        denyPrefixes: ['/auth', '/admin', '/config/federation'],
        logger: { warn() {}, error() {} }
    });

    // Browser traffic without federation proof must fall through untouched.
    const plainReq = mockFederationRequest({});
    let plainNext = 0;
    await middleware(plainReq, mockResponse(), () => { plainNext += 1; });
    assert.equal(plainNext, 1);
    assert.equal(plainReq.isFederationAuthenticated, false);

    // A valid signature on an ordinary API path is elevated to a trusted peer.
    const signedReq = mockFederationRequest(signed({ method: 'GET', url: `/api${'/gsm-dongles'}` }));
    signedReq.originalUrl = '/api/gsm-dongles';
    let signedNext = 0;
    await middleware(signedReq, mockResponse(), () => { signedNext += 1; });
    assert.equal(signedNext, 1);
    assert.equal(signedReq.isFederationAuthenticated, true);
    assert.equal(signedReq.federationSiteCode, SITE);

    // Signed peers must not reach API-key administration.
    const deniedReq = mockFederationRequest(signed({ method: 'GET', url: '/api/admin/api-keys' }), '/admin/api-keys');
    deniedReq.originalUrl = '/api/admin/api-keys';
    const deniedRes = mockResponse();
    let deniedNext = 0;
    await middleware(deniedReq, deniedRes, () => { deniedNext += 1; });
    assert.equal(deniedNext, 0);
    assert.equal(deniedRes.statusCode, 403);

    // ...nor federation management: a spoke must never rewire the hub.
    const fedReq = mockFederationRequest(signed({ method: 'POST', url: '/api/config/federation/peers' }), '/config/federation/peers', 'POST');
    fedReq.originalUrl = '/api/config/federation/peers';
    const fedRes = mockResponse();
    let fedNext = 0;
    await middleware(fedReq, fedRes, () => { fedNext += 1; });
    assert.equal(fedNext, 0);
    assert.equal(fedRes.statusCode, 403);

    // Federation management has its own strict mount; the optional mount must
    // skip it entirely so a signed ping is not rejected as a replayed nonce.
    const skippedReq = mockFederationRequest(signed({ method: 'GET', url: '/api/federation/v1/ping' }), '/federation/v1/ping');
    skippedReq.originalUrl = '/api/federation/v1/ping';
    let skippedNext = 0;
    await middleware(skippedReq, mockResponse(), () => { skippedNext += 1; });
    assert.equal(skippedNext, 1);
    assert.equal(skippedReq.isFederationAuthenticated, false);
});

test('Federation Auth: strict mode still rejects unsigned requests', async () => {
    const { federationAuthMiddleware } = require('../lib/federation-auth');
    const middleware = federationAuthMiddleware({
        pool: { async query() { return [[]]; } },
        decryptFn: () => API_KEY,
        logger: { warn() {}, error() {} }
    });
    const res = mockResponse();
    let next = 0;
    await middleware(mockFederationRequest({}), res, () => { next += 1; });
    assert.equal(next, 0);
    assert.equal(res.statusCode, 401);
});
