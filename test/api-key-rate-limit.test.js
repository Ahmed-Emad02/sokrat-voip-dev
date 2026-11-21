'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkApiKeyRateLimit, resetApiKeyRateLimits } = require('../lib/api-key-rate-limit');

test('API key rate limit allows requests up to the configured limit', () => {
    resetApiKeyRateLimits();
    const first = checkApiKeyRateLimit('key-1', '203.0.113.10', { limit: 2, windowMs: 60000 });
    const second = checkApiKeyRateLimit('key-1', '203.0.113.10', { limit: 2, windowMs: 60000 });
    const third = checkApiKeyRateLimit('key-1', '203.0.113.10', { limit: 2, windowMs: 60000 });
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
});

test('rate limits are isolated by key and client IP', () => {
    resetApiKeyRateLimits();
    assert.equal(checkApiKeyRateLimit('key-1', '203.0.113.10', { limit: 1 }).allowed, true);
    assert.equal(checkApiKeyRateLimit('key-2', '203.0.113.10', { limit: 1 }).allowed, true);
    assert.equal(checkApiKeyRateLimit('key-1', '203.0.113.11', { limit: 1 }).allowed, true);
    assert.equal(checkApiKeyRateLimit('key-1', '203.0.113.10', { limit: 1 }).allowed, false);
});
