const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('trust proxy is falsy by default when TRUST_PROXY env var is not set', () => {
    delete process.env.TRUST_PROXY;
    const app = express();
    const TRUST_PROXY = process.env.TRUST_PROXY || false;
    app.set('trust proxy', TRUST_PROXY === 'true' ? 1 : (TRUST_PROXY || false));

    assert.equal(Boolean(app.get('trust proxy')), false);
});

test('trust proxy returns 1 (trust 1 hop) when TRUST_PROXY=true is set', () => {
    process.env.TRUST_PROXY = 'true';
    const app = express();
    const TRUST_PROXY = process.env.TRUST_PROXY || false;
    app.set('trust proxy', TRUST_PROXY === 'true' ? 1 : (TRUST_PROXY || false));

    assert.equal(app.get('trust proxy'), 1);
    delete process.env.TRUST_PROXY;
});
