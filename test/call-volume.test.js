'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dbToAsteriskVolume } = require('../lib/call-volume');

test('converts mic dB values to Asterisk linear factors', () => {
    assert.equal(dbToAsteriskVolume(0), 0);
    assert.equal(dbToAsteriskVolume(6), 1.9953);
    assert.equal(dbToAsteriskVolume(-6), -1.9953);
    assert.equal(dbToAsteriskVolume(99), 125.8925);
});
