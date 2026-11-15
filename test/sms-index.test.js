'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseSmsPartLog,
    parseSmsFullLog,
    smsPartKey,
    collectSmsIndices,
    normalizeIndex
} = require('../lib/sms-index');

test('parses a single-part full SMS with its storage index', () => {
    const line = "[2026-11-10 13:00:00] VERBOSE[1] at_response.c: [dongle0] Got full SMS from etisalat: 'hello'; [ref=0, index=7]";
    const parsed = parseSmsFullLog(line);
    assert.equal(parsed.dongleId, 'dongle0');
    assert.equal(parsed.sender, 'etisalat');
    assert.equal(parsed.content, 'hello');
    assert.equal(parsed.ref, 0);
    assert.equal(parsed.index, 7);
    assert.equal(parsed.legacy, false);
});

test('parses a multipart SMS part with its storage index', () => {
    const line = "[2026-11-10 13:00:00] VERBOSE[1] at_response.c: [dongle0] Got SM part from 20100: 'part one'; [ref=42, parts=2, order=0, index=3]";
    const parsed = parseSmsPartLog(line);
    assert.equal(parsed.dongleId, 'dongle0');
    assert.equal(parsed.sender, '20100');
    assert.equal(parsed.ref, 42);
    assert.equal(parsed.parts, 2);
    assert.equal(parsed.order, 0);
    assert.equal(parsed.index, 3);
});

test('collects every part index and the final full SMS index', () => {
    const parts = new Map();
    const first = parseSmsPartLog("[x] VERBOSE[1] at_response.c: [dongle0] Got SM part from 20100: 'part one'; [ref=42, parts=2, order=0, index=3]");
    const second = parseSmsPartLog("[x] VERBOSE[1] at_response.c: [dongle0] Got SM part from 20100: 'part two'; [ref=42, parts=2, order=1, index=9]");
    parts.set(smsPartKey(first.dongleId, first.sender, first.ref), { indices: new Set([first.index]) });
    parts.get(smsPartKey(second.dongleId, second.sender, second.ref)).indices.add(second.index);
    const full = parseSmsFullLog("[x] VERBOSE[1] at_response.c: [dongle0] Got full SMS from 20100: 'part onepart two'; [ref=42, index=9]");
    assert.deepEqual(collectSmsIndices(parts, full), [3, 9]);
});

test('legacy full SMS log is parsed but yields no storage index', () => {
    const full = parseSmsFullLog("[x] VERBOSE[1] at_response.c: [dongle0] Got full SMS from etisalat: 'legacy message'");
    assert.equal(full.legacy, true);
    assert.equal(full.content, 'legacy message');
    assert.deepEqual(collectSmsIndices(new Map(), full), []);
});

test('index normalization rejects invalid values', () => {
    assert.equal(normalizeIndex('7'), 7);
    assert.equal(normalizeIndex('0'), 0);
    assert.equal(normalizeIndex('-1'), null);
    assert.equal(normalizeIndex('10000'), null);
    assert.equal(normalizeIndex('abc'), null);
});

test('malformed lines are ignored', () => {
    assert.equal(parseSmsPartLog('not an SMS line'), null);
    assert.equal(parseSmsFullLog('not an SMS line'), null);
});
