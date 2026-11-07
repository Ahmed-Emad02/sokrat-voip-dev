'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const {
    DEFAULT_OUTBOUND_DIAL_PATTERNS,
    resolveOutboundDialPatterns
} = require('../lib/outbound-routes');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const pageEjs = fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8');

test('new outbound routes default to local and Egyptian international patterns', () => {
    assert.deepEqual(DEFAULT_OUTBOUND_DIAL_PATTERNS, [
        { prefix: '', pattern: 'X.', cid: '', prepend: '' },
        { prefix: '+2', pattern: 'X.', cid: '', prepend: '+2' }
    ]);
});

test('explicit patterns are preserved; missing or empty patterns fall back to defaults', () => {
    assert.strictEqual(resolveOutboundDialPatterns(undefined), DEFAULT_OUTBOUND_DIAL_PATTERNS);
    assert.strictEqual(resolveOutboundDialPatterns([]), DEFAULT_OUTBOUND_DIAL_PATTERNS);
    assert.strictEqual(resolveOutboundDialPatterns([{}]), DEFAULT_OUTBOUND_DIAL_PATTERNS);
    assert.strictEqual(resolveOutboundDialPatterns([{ pattern: '   ' }]), DEFAULT_OUTBOUND_DIAL_PATTERNS);

    const custom = [{ prefix: '0', pattern: '1XXXXXXXXX', cid: '', prepend: '' }];
    assert.deepEqual(resolveOutboundDialPatterns(custom), custom);
    assert.notStrictEqual(resolveOutboundDialPatterns(custom), DEFAULT_OUTBOUND_DIAL_PATTERNS);
});

test('POST outbound route resolves defaults instead of rejecting empty patterns', () => {
    const handler = serverJs.match(/app\.post\('\/api\/config\/routes\/outbound',[\s\S]*?\n\}\);/);
    assert.ok(handler, 'POST /api/config/routes/outbound must exist');
    assert.match(handler[0], /resolveOutboundDialPatterns\(patterns\)/);
    assert.doesNotMatch(handler[0], /At least one Dial Pattern is required/);
});

test('create modal prefills defaults while edit keeps stored patterns', () => {
    const rendered = ejs.render(pageEjs, {
        isRtl: false,
        defaultOutboundPatterns: DEFAULT_OUTBOUND_DIAL_PATTERNS
    });

    assert.match(
        rendered,
        /const DEFAULT_OUTBOUND_DIAL_PATTERNS = \[\{"prefix":"","pattern":"X\.","cid":"","prepend":""\},\{"prefix":"\+2","pattern":"X\.","cid":"","prepend":"\+2"\}\];/
    );

    const openStart = rendered.indexOf('function openOutboundModal()');
    const editStart = rendered.indexOf('function editOutboundRoute(');
    const saveStart = rendered.indexOf('function saveOutboundRoute(');
    assert.ok(openStart > -1 && editStart > openStart && saveStart > editStart);

    const openFn = rendered.slice(openStart, editStart);
    assert.match(openFn, /DEFAULT_OUTBOUND_DIAL_PATTERNS/);
    assert.match(openFn, /\.map\(p => \(\{ \.\.\.p \}\)\)/);

    const editFn = rendered.slice(editStart, saveStart);
    assert.doesNotMatch(editFn, /DEFAULT_OUTBOUND_DIAL_PATTERNS/);
    assert.match(editFn, /modalPatternsList = patterns/);
});
