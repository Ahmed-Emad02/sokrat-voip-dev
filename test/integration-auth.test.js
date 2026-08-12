const test = require('node:test');
const assert = require('node:assert/strict');
const {
    hashSecret,
    timingSafeCompare,
    calculateEffectiveScopes,
    validateOriginUrl,
    SUPPORTED_SCOPES
} = require('../lib/integration-auth');

test('hashSecret computes consistent SHA-256 hex strings', () => {
    const h1 = hashSecret('my-secret-key');
    const h2 = hashSecret('my-secret-key');
    assert.equal(h1, h2);
    assert.equal(typeof h1, 'string');
    assert.equal(h1.length, 64);
});

test('timingSafeCompare correctly validates matching hashes and rejects non-matching', () => {
    const h1 = hashSecret('secret-123');
    const h2 = hashSecret('secret-123');
    const h3 = hashSecret('secret-456');

    assert.equal(timingSafeCompare(h1, h2), true);
    assert.equal(timingSafeCompare(h1, h3), false);
    assert.equal(timingSafeCompare(h1, 'invalid'), false);
});

test('calculateEffectiveScopes produces strict intersection of allowed, requested and supported scopes', () => {
    const clientScopes = ['extensions:read', 'calls:read', 'live:read', 'live:listen'];
    const requestedScopes = ['calls:read', 'live:listen', 'live:whisper', 'invalid:scope'];

    const effective = calculateEffectiveScopes(clientScopes, requestedScopes);
    
    assert.deepEqual(effective.sort(), ['calls:read', 'live:listen'].sort());
});

test('validateOriginUrl strictly enforces http/https origins without path, query or wildcards', () => {
    assert.equal(validateOriginUrl('http://192.168.100.216'), 'http://192.168.100.216');
    assert.equal(validateOriginUrl('https://crm.example.com:8443'), 'https://crm.example.com:8443');
    assert.equal(validateOriginUrl('http://crm.example.com/path'), null);
    assert.equal(validateOriginUrl('*'), null);
    assert.equal(validateOriginUrl('null'), null);
    assert.equal(validateOriginUrl('javascript:alert(1)'), null);
});
