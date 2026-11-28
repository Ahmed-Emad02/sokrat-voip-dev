'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCallStateLines, readEndpointCallSnapshot } = require('../lib/call-state');

const caller = (target, uniqueId = '1794062878.41628') =>
    `PJSIP/103-00000088!macro-dialout-trunk!s!35!Ring!Dial!dongle/i:354300023801570/${target},300,Tr!103!!!3!0!!${uniqueId}`;
const dongle = (target, uniqueId = '1794062878.41630') =>
    `Dongle/dongle0-010000000e!from-dongle-custom!${target}!1!Dialing!AppDial!(Outgoing Line)!${target}!!!3!0!!${uniqueId}`;
const sipTrunk = (target, uniqueId = '1794062878.41631') =>
    `SIP/provider-00000010!from-internal!${target}!1!Up!Dial!${target}!!!3!0!!${uniqueId}`;
const local = (extension, uniqueId = '1794062878.41632') =>
    `PJSIP/${extension}-00000090!from-internal!${extension}!1!Ringing!AppDial!(Outgoing Line)!${extension}!!!3!0!!${uniqueId}`;

test('reports a live dongle trunk carrying the caller target', () => {
    assert.deepEqual(parseCallStateLines([
        caller('01281102350'),
        dongle('01281102350'),
    ], '103'), {
        callerActive: true,
        trunkActive: true,
        callerChannel: 'PJSIP/103-00000088',
        trunkChannel: 'Dongle/dongle0-010000000e',
    });
});

test('does not require matching unique IDs; trailing IDs differ', () => {
    assert.equal(parseCallStateLines([
        caller('01281102350', '111.1'),
        dongle('01281102350', '222.2'),
    ], '103').trunkActive, true);
});

test('does not attach a dongle carrying another target', () => {
    assert.deepEqual(parseCallStateLines([
        caller('01281102350'),
        dongle('01099999999'),
    ], '103'), {
        callerActive: true,
        trunkActive: false,
        callerChannel: 'PJSIP/103-00000088',
        trunkChannel: null,
    });
});

test('recognizes SIP trunks and ignores a local extension leg', () => {
    assert.equal(parseCallStateLines([
        caller('01281102350'),
        sipTrunk('01281102350'),
    ], '103').trunkActive, true);
    assert.equal(parseCallStateLines([
        caller('112'),
        local('112'),
    ], '103').trunkActive, false);
});

test('ignores another extension and malformed input', () => {
    const other = [caller('01281102350').replace('PJSIP/103-', 'PJSIP/150-')];
    assert.deepEqual(parseCallStateLines(other, '103'), {
        callerActive: false,
        trunkActive: false,
        callerChannel: null,
        trunkChannel: null,
    });
    assert.deepEqual(parseCallStateLines([caller('01281102350'), dongle('01281102350')], '10x'), {
        callerActive: false,
        trunkActive: false,
        callerChannel: null,
        trunkChannel: null,
    });
});

test('a surviving federation Local leg does not keep the ended endpoint call active', () => {
    const previous = { 103: { channel: 'PJSIP/103-00000088', state: 'In Call', start: 1000 } };
    const snapshot = readEndpointCallSnapshot([
        'Local/103@peer_20-00000001;2!peer_20!103!4!Up!Dial!IAX2/fed_out_site20/103!103!!!3!30!!55.2',
        'IAX2/fed_out_site20-8058!peer_20!103!4!Up!AppDial!(Outgoing Line)!103!!!3!30!!55.3',
        'Asterisk ending (0).'
    ].join('\n'), previous, 31000);
    assert.deepEqual([...snapshot.keys()], []);
});

test('reconciliation can replace a vanished channel with the new ringing leg for the same extension', () => {
    const previous = {
        112: { channel: 'PJSIP/112-00000088', state: 'In Call', start: 12000, partner: '101' }
    };
    const row = local('112').replace('!112!!!3!0!!', '!117!!!3!2!!');
    const snapshot = readEndpointCallSnapshot(row, previous, 50000);
    assert.deepEqual(snapshot.get('112'), {
        channel: 'PJSIP/112-00000090', state: 'Ringing', partner: '117', start: 48000
    });
});

test('reconciliation distinguishes a failed CLI read from a valid empty PBX', () => {
    assert.equal(readEndpointCallSnapshot('', {}, 50000), null);
    assert.equal(readEndpointCallSnapshot('No such command\nAsterisk ending (0).', {}, 50000), null);
    assert.equal(readEndpointCallSnapshot('Asterisk ending (0).\n', {}, 50000).size, 0);
});
