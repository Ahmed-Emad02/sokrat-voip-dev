'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitBicolorWord, formatBicolorText, formatBicolorHeader } = require('../lib/bicolor-text');

test('splitBicolorWord splits even-length English words in exact halves', () => {
    const html = splitBicolorWord('Overview');
    assert.ok(html.includes('<span class="bicolor-first">Over</span>'), 'first half is Over');
    assert.ok(html.includes('<span class="bicolor-second">view</span>'), 'second half is view');
});

test('splitBicolorWord splits odd-length English words with ceiling on first half', () => {
    const html = splitBicolorWord('History');
    assert.ok(html.includes('<span class="bicolor-first">Hist</span>'), 'first half is Hist (4 chars)');
    assert.ok(html.includes('<span class="bicolor-second">ory</span>'), 'second half is ory (3 chars)');
});

test('splitBicolorWord handles 3-letter acronyms', () => {
    const html = splitBicolorWord('GSM');
    assert.ok(html.includes('<span class="bicolor-first">GS</span>'), 'first half is GS');
    assert.ok(html.includes('<span class="bicolor-second">M</span>'), 'second half is M');
});

test('splitBicolorWord handles single character without breaking', () => {
    const html = splitBicolorWord('A');
    assert.ok(html.includes('<span class="bicolor-first">A</span>'));
    assert.ok(!html.includes('bicolor-second'));
});

test('splitBicolorWord preserves Arabic cursive connectivity with ZWJ', () => {
    const html = splitBicolorWord('نظرة');
    assert.ok(html.includes('نظ\u200D</span>'), 'first half has ZWJ at end');
    assert.ok(html.includes('>\u200Dرة</span>'), 'second half has ZWJ at start');
});

test('formatBicolorText formats multiple words preserving spaces', () => {
    const html = formatBicolorText('Call History');
    assert.ok(html.includes('>Ca</span><span class="bicolor-second">ll</span>'));
    assert.ok(html.includes('>Hist</span><span class="bicolor-second">ory</span>'));
    assert.ok(html.includes('</span> <span'), 'space preserved between words');
});

test('formatBicolorText handles hyphenated words like Auto-Dial', () => {
    const html = formatBicolorText('Auto-Dial');
    assert.ok(html.includes('>Au</span><span class="bicolor-second">to</span>'));
    assert.ok(html.includes('-'));
    assert.ok(html.includes('>Di</span><span class="bicolor-second">al</span>'));
});

test('formatBicolorHeader combines title and subtitle cleanly', () => {
    const html = formatBicolorHeader('Overview', '');
    assert.ok(html.includes('Over</span><span class="bicolor-second">view'));

    const html2 = formatBicolorHeader('Call', 'History');
    assert.ok(html2.includes('Ca</span><span class="bicolor-second">ll'));
    assert.ok(html2.includes('Hist</span><span class="bicolor-second">ory'));
});
