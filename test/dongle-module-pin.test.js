'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');

test('bundled chan_dongle.so is pinned to the known-good older build', () => {
    const binPath = path.join(root, 'installer-bundle', 'binaries', 'chan_dongle.so');
    const bin = fs.readFileSync(binPath);
    assert.equal(bin.length, 285944, 'bundled module must be the 285944-byte older build');
    assert.equal(
        crypto.createHash('sha256').update(bin).digest('hex'),
        '577f6d35aa3b9d79a61a4d47251ebb2b0fbae2c4d4cc08bcdfa5161275e15c90',
        'bundled module must remain the known-good 577f6d35 build'
    );
    assert.ok(bin.includes(Buffer.from('+CRING:')), 'older module must still support inbound +CRING');
    assert.ok(bin.includes(Buffer.from('AT+CRC=0\r')), 'older module must still support AT+CRC=0');
});
