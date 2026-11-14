'use strict';

// Behavior contract for the answer-time AMI cancel bridge.
// createWakeAnswerCancel({ sendAction, cancel, timeoutMs, logger })
//   .handleEvent(parsedAmiPacket) -> Promise<void> | undefined
//   .close() -> void
// The module sends exactly two correlated Getvar requests on DialEnd ANSWER
// and calls cancel(callee, callId) only for validated, non-winner recipients.
// These tests drive parsed AMI packets, not Getvar text/order echoes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWakeAnswerCancel } = require('../lib/webrtc-wake-answer');

const CALL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseActions(actions) {
    return actions.map(action => {
        const fields = {};
        for (const line of String(action).split(/\r?\n/)) {
            const idx = line.indexOf(':');
            if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        return fields;
    });
}

function actionId(actions, variable, channel) {
    const match = parseActions(actions).find(fields => fields.Variable === variable &&
        (!channel || fields.Channel === channel));
    assert.ok(match && match.ActionID, `missing AMI Getvar for ${variable}`);
    return match.ActionID;
}

function success(id, value) {
    return { Response: 'Success', ActionID: id, Value: value };
}

function dialEnd(channel, destChannel) {
    return { Event: 'DialEnd', DialStatus: 'ANSWER', Channel: channel, DestChannel: destChannel };
}

function bridge(options = {}) {
    const actions = [];
    const cancels = [];
    const instance = createWakeAnswerCancel({
        sendAction: action => actions.push(action),
        cancel: async (callee, callId) => { cancels.push({ callee, callId }); },
        timeoutMs: options.timeoutMs || 80,
        logger: { warn() {}, error() {} },
    });
    return { instance, actions, cancels };
}

async function answer(harness, channel, destChannel, callId, callees) {
    const done = harness.instance.handleEvent(dialEnd(channel, destChannel));
    const id = actionId(harness.actions, 'SOKRAT_CALL_ID', channel);
    const list = actionId(harness.actions, 'SOKRAT_WAKE_CALLEES', channel);
    // Deliberately answer in reverse request order.
    harness.instance.handleEvent(success(list, callees));
    harness.instance.handleEvent(success(id, callId));
    await done;
}

async function answerIfRequested(harness, channel, destChannel, callId, callees) {
    const done = harness.instance.handleEvent(dialEnd(channel, destChannel));
    const parsed = parseActions(harness.actions);
    const id = parsed.find(fields => fields.Variable === 'SOKRAT_CALL_ID' && fields.Channel === channel);
    const list = parsed.find(fields => fields.Variable === 'SOKRAT_WAKE_CALLEES' && fields.Channel === channel);
    if (id && list) {
        harness.instance.handleEvent(success(list.ActionID, callees));
        harness.instance.handleEvent(success(id.ActionID, callId));
    }
    await done;
}

test('excludes the answered PJSIP extension and keeps the canonical call id', async () => {
    const h = bridge();
    await answer(h, 'SIP/150-00000001', 'PJSIP/102-00000052', CALL_ID, '101-102');
    assert.deepEqual(h.cancels, [{ callee: '101', callId: CALL_ID }]);
    h.instance.close();
});

test('excludes the answered Local extension', async () => {
    const h = bridge();
    await answer(h, 'SIP/150-00000002', 'Local/102@from-internal-00000001', CALL_ID, '101-102');
    assert.deepEqual(h.cancels, [{ callee: '101', callId: CALL_ID }]);
    h.instance.close();
});

test('unknown nonmobile winners cancel every woken mobile callee', async () => {
    const h = bridge();
    await answer(h, 'SIP/150-00000003', 'Dongle/dongle1-0100000014', CALL_ID, '101-102');
    assert.deepEqual(h.cancels, [
        { callee: '101', callId: CALL_ID },
        { callee: '102', callId: CALL_ID },
    ]);
    h.instance.close();
});

test('winner outside the woken list cancels all woken callees', async () => {
    const h = bridge();
    await answer(h, 'SIP/150-00000004', 'PJSIP/103-00000053', CALL_ID, '101-102');
    assert.deepEqual(h.cancels, [
        { callee: '101', callId: CALL_ID },
        { callee: '102', callId: CALL_ID },
    ]);
    h.instance.close();
});

test('malformed endpoint channels fail closed without cancelling', async () => {
    for (const channel of ['PJSIP/not-a-number-00000001', 'Local/102-00000001', 'PJSIP/102/extra-1', 'SIP/', '']) {
        const h = bridge();
        await answerIfRequested(h, 'SIP/150-00000005', channel, CALL_ID, '101-102');
        assert.deepEqual(h.cancels, [], channel);
        h.instance.close();
    }
});

test('malformed call id or callee list fails closed', async () => {
    for (const [callId, callees] of [
        ['not-a-uuid', '101-102'],
        [CALL_ID, ''],
        [CALL_ID, 'abc'],
        [CALL_ID, '101--102'],
        [CALL_ID, '101,102'],
    ]) {
        const h = bridge();
        await answer(h, 'SIP/150-00000006', 'PJSIP/102-00000052', callId, callees);
        assert.deepEqual(h.cancels, [], `${callId} / ${callees}`);
        h.instance.close();
    }
});

test('timeout and late responses produce no wrong-call cancel', async () => {
    const h = bridge({ timeoutMs: 25 });
    const done = h.instance.handleEvent(dialEnd('SIP/150-00000007', 'PJSIP/102-00000052'));
    const id = actionId(h.actions, 'SOKRAT_CALL_ID', 'SIP/150-00000007');
    const list = actionId(h.actions, 'SOKRAT_WAKE_CALLEES', 'SIP/150-00000007');
    await done;
    assert.deepEqual(h.cancels, []);
    h.instance.handleEvent(success(id, CALL_ID));
    h.instance.handleEvent(success(list, '101-102'));
    await tick(10);
    assert.deepEqual(h.cancels, []);
    h.instance.close();
});

test('interleaved calls with out-of-order responses stay call-scoped', async () => {
    const h = bridge();
    const first = h.instance.handleEvent(dialEnd('SIP/150-00000008', 'PJSIP/102-00000052'));
    const firstIds = { id: actionId(h.actions, 'SOKRAT_CALL_ID', 'SIP/150-00000008'), list: actionId(h.actions, 'SOKRAT_WAKE_CALLEES', 'SIP/150-00000008') };
    const second = h.instance.handleEvent(dialEnd('SIP/150-00000009', 'PJSIP/101-00000053'));
    const secondIds = { id: actionId(h.actions, 'SOKRAT_CALL_ID', 'SIP/150-00000009'), list: actionId(h.actions, 'SOKRAT_WAKE_CALLEES', 'SIP/150-00000009') };
    h.instance.handleEvent(success(secondIds.list, '101-102'));
    h.instance.handleEvent(success(firstIds.list, '101-102'));
    h.instance.handleEvent(success(secondIds.id, CALL_ID));
    h.instance.handleEvent(success(firstIds.id, CALL_ID));
    await Promise.all([first, second]);
    assert.deepEqual(h.cancels.sort((a, b) => a.callee.localeCompare(b.callee)), [
        { callee: '101', callId: CALL_ID },
        { callee: '102', callId: CALL_ID },
    ]);
    h.instance.close();
});

test('duplicate responses cancel once', async () => {
    const h = bridge();
    const done = h.instance.handleEvent(dialEnd('SIP/150-00000010', 'PJSIP/102-00000052'));
    const id = actionId(h.actions, 'SOKRAT_CALL_ID', 'SIP/150-00000010');
    const list = actionId(h.actions, 'SOKRAT_WAKE_CALLEES', 'SIP/150-00000010');
    h.instance.handleEvent(success(id, CALL_ID));
    h.instance.handleEvent(success(id, CALL_ID));
    h.instance.handleEvent(success(list, '101-102'));
    h.instance.handleEvent(success(list, '101-102'));
    await done;
    assert.deepEqual(h.cancels, [{ callee: '101', callId: CALL_ID }]);
    h.instance.close();
});

test('close invalidates pending work; a new connection is independent', async () => {
    const h = bridge();
    const done = h.instance.handleEvent(dialEnd('SIP/150-00000011', 'PJSIP/102-00000052'));
    const id = actionId(h.actions, 'SOKRAT_CALL_ID', 'SIP/150-00000011');
    const list = actionId(h.actions, 'SOKRAT_WAKE_CALLEES', 'SIP/150-00000011');
    h.instance.close();
    h.instance.handleEvent(success(id, CALL_ID));
    h.instance.handleEvent(success(list, '101-102'));
    await done;
    assert.deepEqual(h.cancels, []);

    const next = bridge();
    await answer(next, 'SIP/150-00000012', 'PJSIP/102-00000052', CALL_ID, '101-102');
    assert.deepEqual(next.cancels, [{ callee: '101', callId: CALL_ID }]);
    next.instance.close();
});
