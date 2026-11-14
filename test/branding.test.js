'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeHexColor,
    normalizeLogoUrl,
    normalizeBranding,
    isPngBuffer,
    PNG_SIGNATURE
} = require('../lib/branding');

test('normalizeHexColor accepts 3, 6, and 8 digit colors and lowercases', () => {
    assert.equal(normalizeHexColor('#ABC'), '#abc');
    assert.equal(normalizeHexColor('#AABBCC'), '#aabbcc');
    assert.equal(normalizeHexColor('#AABBCCDD'), '#aabbccdd');
    assert.equal(normalizeHexColor('red', '#000000'), '#000000');
    assert.equal(normalizeHexColor('', '#000000'), '#000000');
});

test('normalizeLogoUrl only accepts http(s) and generated tenant logo paths', () => {
    assert.equal(normalizeLogoUrl('https://cdn.example/logo.png'), 'https://cdn.example/logo.png');
    assert.equal(normalizeLogoUrl('http://cdn.example/logo.png'), 'http://cdn.example/logo.png');
    assert.equal(normalizeLogoUrl('/uploads/tenant-logos/tenant-7-123456.png'), '/uploads/tenant-logos/tenant-7-123456.png');
    assert.equal(normalizeLogoUrl('/uploads/tenant-logos/other-7.png'), '');
    assert.equal(normalizeLogoUrl('/uploads/../secret.png'), '');
    assert.equal(normalizeLogoUrl('javascript:alert(1)'), '');
});

test('normalizeBranding merges, removes empty values, and caps button text', () => {
    const existing = { primary_color: '#111111', logo_url: '/uploads/tenant-logos/tenant-7-1.png', custom: 'keep' };
    const result = normalizeBranding({
        primary_color: '#AABBCC',
        secondary_color: '#DDEeff',
        background_color: '',
        button_text: 'x'.repeat(60)
    }, existing);
    assert.equal(result.primary_color, '#aabbcc');
    assert.equal(result.secondary_color, '#ddeeff');
    assert.equal(result.background_color, undefined);
    assert.equal(result.logo_url, existing.logo_url);
    assert.equal(result.custom, 'keep');
    assert.equal(result.button_text.length, 40);
});

test('normalizeBranding drops invalid logo URLs and unknown input types', () => {
    assert.deepEqual(normalizeBranding(null, { logo_url: '/uploads/tenant-logos/tenant-7-1.png' }), {
        logo_url: '/uploads/tenant-logos/tenant-7-1.png'
    });
    assert.deepEqual(normalizeBranding({ logo_url: 'data:image/png;base64,abc' }, {}), {});
    assert.deepEqual(normalizeBranding({ logo_url: '' }, { logo_url: '/uploads/tenant-logos/tenant-7-1.png' }), {});
});

test('isPngBuffer verifies the PNG signature', () => {
    assert.equal(isPngBuffer(Buffer.concat([PNG_SIGNATURE, Buffer.from('rest')])), true);
    assert.equal(isPngBuffer(Buffer.from('not a png')), false);
    assert.equal(isPngBuffer(PNG_SIGNATURE.subarray(0, 4)), false);
});
