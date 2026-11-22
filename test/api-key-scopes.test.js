'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    hasScope,
    hasAnyScope,
    isReadOnlyScopes,
    enforceReadOnlyApiKey
} = require('../lib/api-key-scopes');

test('canonical read scopes are recognized', () => {
    const scopes = ['calls:read', 'recordings:read', 'extensions:read', 'stats:read', 'cdr', 'cdr-export'];
    assert.equal(hasScope(scopes, 'calls:read'), true);
    assert.equal(hasScope(scopes, 'stats:read'), true);
    assert.equal(hasAnyScope(scopes, ['operator-hangup', 'cdr-export']), true);
});

test('legacy aliases map to canonical read permissions', () => {
    assert.equal(hasScope(['cdr:read'], 'calls:read'), true);
    assert.equal(hasScope(['cdr:read'], 'cdr'), true);
    assert.equal(hasScope(['cdr:audio'], 'recordings:read'), true);
});

test('read-only scope detection excludes full access and write scopes', () => {
    assert.equal(isReadOnlyScopes(['calls:read', 'recordings:read', 'cdr-export']), true);
    assert.equal(isReadOnlyScopes(['cdr:read', 'cdr:audio']), true);
    assert.equal(isReadOnlyScopes(['*']), false);
    assert.equal(isReadOnlyScopes(['calls:read', 'operator']), false);
    assert.equal(isReadOnlyScopes(['config']), false);
});

test('read-only API keys are denied non-GET requests', () => {
    const middleware = enforceReadOnlyApiKey;
    let nextCalled = false;
    const req = {
        isApiKeyAuthenticated: true,
        apiKey: { scopes: 'calls:read,cdr-export' },
        method: 'POST',
        path: '/api/cdr/delete'
    };
    const res = {
        statusCode: 0,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
});

test('read-only API keys may read and may mint an embed ticket', () => {
    for (const [method, path] of [['GET', '/api/cdr'], ['POST', '/api/integrations/v1/embed-tickets']]) {
        let nextCalled = false;
        enforceReadOnlyApiKey({
            isApiKeyAuthenticated: true,
            apiKey: { scopes: 'calls:read,live:read' },
            method,
            path
        }, { status() { throw new Error('should not reject'); }, json() {} }, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
    }
});

test('full-access keys are not constrained by the read-only guard', () => {
    let nextCalled = false;
    enforceReadOnlyApiKey({
        isApiKeyAuthenticated: true,
        apiKey: { scopes: '*' },
        method: 'DELETE',
        path: '/api/cdr/delete'
    }, { status() { throw new Error('should not reject'); }, json() {} }, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
});

test('async allowlist accepts localhost and rejects an unresolvable hostname', async () => {
    const { ipMatchesAsync } = require('../lib/api-key-manager');
    assert.equal(await ipMatchesAsync('127.0.0.1', 'localhost'), true);
    assert.equal(await ipMatchesAsync('127.0.0.1', 'no-such-host.invalid'), false);
});
