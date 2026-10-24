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
