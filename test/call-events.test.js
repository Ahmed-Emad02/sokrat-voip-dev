'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CallLifecycle } = require('../lib/call-events');

function makeLifecycle() {
    const lifecycle = new CallLifecycle();
    lifecycle.cleanupTimer.unref();
    return lifecycle;
}

test('inbound SIP trunk lifecycle emits ringing, answered and ended once', () => {
    const lifecycle = makeLifecycle();
    const events = [];
    lifecycle.on('event', event => events.push(event));

    const base = {
        Channel: 'SIP/trunk-00000001',
        Context: 'from-trunk',
        Uniqueid: 'call-100.1',
        Linkedid: 'call-100.1',
        CallerIDNum: '01011719380',
        Exten: '0223456789'
    };

    lifecycle.handleAmiEvent({ ...base, Event: 'Newchannel' });
    lifecycle.handleAmiEvent({ ...base, Event: 'Newchannel' });
    lifecycle.handleAmiEvent({ ...base, Event: 'Newstate', ChannelStateDesc: 'Up', ChannelState: '6' });
    lifecycle.handleAmiEvent({ ...base, Event: 'Newstate', ChannelStateDesc: 'Up', ChannelState: '6' });
    lifecycle.handleAmiEvent({ ...base, Event: 'Hangup', Cause: '16' });
    lifecycle.handleAmiEvent({ ...base, Event: 'Hangup', Cause: '16' });

    assert.deepEqual(events.map(event => event.event), ['call_ringing', 'call_answered', 'call_ended']);
    assert.equal(events[0].caller_number, '01011719380');
    assert.equal(events[0].called_number, '0223456789');
    assert.equal(events[0].source, 'sip-trunk');
    assert.equal(events[2].cause, '16');
    assert.equal(lifecycle.getActiveCalls().length, 0);
});

test('non-trunk SIP channels do not trigger the SIP trunk stream', () => {
    const lifecycle = makeLifecycle();
    const events = [];
    lifecycle.on('event', event => events.push(event));
    lifecycle.handleAmiEvent({
        Event: 'Newchannel',
        Channel: 'SIP/101-00000001',
        Context: 'from-internal',
        Uniqueid: 'call-101.1',
        CallerIDNum: '101'
    });
    assert.deepEqual(events, []);
    assert.deepEqual(lifecycle.getActiveCalls(), []);
});

test('active call snapshot exposes ringing/answered state', () => {
    const lifecycle = makeLifecycle();
    lifecycle.handleAmiEvent({
        Event: 'Newchannel',
        Channel: 'PJSIP/trunk-00000001',
        Context: 'from-pstn',
        Uniqueid: 'call-200.1',
        Linkedid: 'call-200.1',
        CallerIDNum: '+447700900123',
        Exten: '+201156804841'
    });
    const ringing = lifecycle.getActiveCalls();
    assert.equal(ringing.length, 1);
    assert.equal(ringing[0].event, 'call_ringing');

    lifecycle.handleAmiEvent({
        Event: 'BridgeEnter',
        Channel: 'PJSIP/trunk-00000001',
        Uniqueid: 'call-200.1',
        Linkedid: 'call-200.1'
    });
    assert.equal(lifecycle.getActiveCalls()[0].event, 'call_answered');
});
