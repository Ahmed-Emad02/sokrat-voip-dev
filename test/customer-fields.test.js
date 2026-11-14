'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeFieldDefinitions,
    normalizeCustomerData,
    CustomerFieldError
} = require('../lib/customer-fields');

test('normalizes typed definitions and dropdown options', () => {
    const fields = normalizeFieldDefinitions([
        { key: 'account_type', label_en: 'Account type', field_type: 'select', required: true, options: ['retail', 'business'] },
        { key: 'notes', label_en: 'Notes', field_type: 'textarea' },
        { key: 'name', label_en: 'Reserved' }
    ]);
    assert.equal(fields.length, 2);
    assert.equal(fields[0].field_type, 'select');
    assert.equal(fields[0].options.length, 2);
    assert.equal(fields[0].required, true);
    assert.equal(fields[1].field_type, 'textarea');
});

test('validates required, number, date, and select values', () => {
    const fields = normalizeFieldDefinitions([
        { key: 'tier', label_en: 'Tier', field_type: 'select', required: true, options: ['gold', 'silver'] },
        { key: 'age', label_en: 'Age', field_type: 'number' },
        { key: 'joined', label_en: 'Joined', field_type: 'date' }
    ]);
    assert.deepEqual(normalizeCustomerData(fields, { tier: 'gold', age: '42', joined: '2026-11-08' }), {
        tier: 'gold', age: '42', joined: '2026-11-08'
    });
    assert.throws(() => normalizeCustomerData(fields, { tier: '' }), CustomerFieldError);
    assert.throws(() => normalizeCustomerData(fields, { tier: 'platinum' }), /invalid option/);
    assert.throws(() => normalizeCustomerData(fields, { tier: 'gold', age: 'x' }), /must be a number/);
    assert.throws(() => normalizeCustomerData(fields, { tier: 'gold', joined: '08/11/2026' }), /must be a date/);
});

test('ignores unknown customer keys and trims values', () => {
    const fields = normalizeFieldDefinitions([{ key: 'note', label_en: 'Note', field_type: 'text' }]);
    assert.deepEqual(normalizeCustomerData(fields, { note: '  hello  ', unknown: 'x' }), { note: 'hello' });
});

test('deduplicates keys and rejects empty select definitions', () => {
    const fields = normalizeFieldDefinitions([
        { key: 'a', label_en: 'A' },
        { key: 'a', label_en: 'A duplicate' },
        { key: 'b', label_en: 'B', field_type: 'select', options: [] }
    ]);
    assert.deepEqual(fields.map(f => f.key), ['a', 'a_2']);
});
