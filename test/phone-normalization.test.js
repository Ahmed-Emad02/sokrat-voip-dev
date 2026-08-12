const test = require('node:test');
const assert = require('node:assert/strict');
const {
    cleanPhoneString,
    extractPhoneFromClid,
    isValidPhoneNumber,
    getPhoneVariants
} = require('../lib/phone-normalization');

test('cleanPhoneString strips whitespace and non-digits except leading plus', () => {
    assert.equal(cleanPhoneString('+20 (101) 234-5678'), '+201012345678');
    assert.equal(cleanPhoneString('010 1234 5678'), '01012345678');
    assert.equal(cleanPhoneString(null), '');
    assert.equal(cleanPhoneString(''), '');
});

test('extractPhoneFromClid extracts phone digits from CLID formats', () => {
    assert.equal(extractPhoneFromClid('"Ahmed" <01012345678>'), '01012345678');
    assert.equal(extractPhoneFromClid('<+201012345678>'), '+201012345678');
    assert.equal(extractPhoneFromClid('01012345678'), '01012345678');
});

test('isValidPhoneNumber validates digit counts correctly', () => {
    assert.equal(isValidPhoneNumber('01012345678'), true);
    assert.equal(isValidPhoneNumber('+201012345678'), true);
    assert.equal(isValidPhoneNumber('123456'), false);
    assert.equal(isValidPhoneNumber('123456789012345678901'), false);
});

test('getPhoneVariants generates exact expected matching variants', () => {
    const variants = getPhoneVariants('01012345678', '20');
    assert.ok(variants.includes('01012345678'));
    assert.ok(variants.includes('201012345678'));
    assert.ok(variants.includes('00201012345678'));
    assert.ok(variants.includes('+201012345678'));
    assert.ok(variants.includes('1012345678'));

    const invalid = getPhoneVariants('123');
    assert.deepEqual(invalid, []);
});
