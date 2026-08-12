const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createMediaId,
    decodeMediaId,
    isPathUnderRoot
} = require('../lib/recordings');

test('createMediaId and decodeMediaId roundtrip confidential media tokens correctly', () => {
    const uniqueid = '123456.789';
    const mediaId = createMediaId(uniqueid);

    assert.ok(typeof mediaId === 'string' && mediaId.includes('.'));
    // Confidentiality check: mediaId must NOT contain raw uniqueid text
    assert.equal(mediaId.includes('123456.789'), false);
    
    const decoded = decodeMediaId(mediaId);
    assert.equal(decoded, uniqueid);
});

test('decodeMediaId rejects invalid or tampered media tokens', () => {
    assert.equal(decodeMediaId('invalid-token'), null);
    assert.equal(decodeMediaId('badhash.encodeddata'), null);
});

test('isPathUnderRoot prevents directory traversal', () => {
    const root = '/var/spool/asterisk/monitor';
    
    assert.equal(isPathUnderRoot('/var/spool/asterisk/monitor/2026/08/12/rec.wav', root), true);
    assert.equal(isPathUnderRoot('/var/spool/asterisk/monitor/../etc/passwd', root), false);
    assert.equal(isPathUnderRoot('/etc/passwd', root), false);
});
