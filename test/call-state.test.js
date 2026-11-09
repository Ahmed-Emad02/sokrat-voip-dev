'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCallStateLines } = require('../lib/call-state');

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
