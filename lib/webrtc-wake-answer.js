'use strict';

// Answer-time AMI bridge: on DialEnd ANSWER, read the inherited wake variables
// from the original channel and cancel push notifications for every woken
// mobile extension except the one that actually answered. This never changes
// dialplan policy; it only consumes the SOKRAT_* variables the wake hook sets.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALLEE_LIST_PATTERN = /^\d{1,12}(?:-\d{1,12})*$/;

function parseWinner(channel) {
    const value = typeof channel === 'string' ? channel.trim() : '';
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) return { kind: 'ambiguous' };
    const tech = value.slice(0, slash).toUpperCase();
    const rest = value.slice(slash + 1);
    if (tech === 'PJSIP' || tech === 'SIP') {
        const match = /^(\d{1,12})-[0-9a-f]+$/i.exec(rest);
        if (!match) return { kind: 'ambiguous' };
        return { kind: 'mobile', extension: match[1] };
    }
    if (tech === 'LOCAL') {
        const at = rest.indexOf('@');
        if (at <= 0) return { kind: 'ambiguous' };
        const extension = rest.slice(0, at);
        if (!/^\d{1,12}$/.test(extension)) return { kind: 'ambiguous' };
        return { kind: 'mobile', extension };
    }
    // Dongle/DAHDI/IAX and other non-mobile winners do not identify a woken
    // mobile recipient; cancel all woken mobile callees.
    return { kind: 'unknown' };
}

function createWakeAnswerCancel({
    sendAction,
    cancel,
    timeoutMs = 1500,
    logger = console,
} = {}) {
    if (typeof sendAction !== 'function' || typeof cancel !== 'function') {
        throw new TypeError('wake-answer requires sendAction and cancel callbacks');
    }
    const pending = new Map();
    const entries = new Set();
    let generation = 0;
    let sequence = 0;

    function warn(message, error) {
        try { logger.warn(message, error && error.message ? error.message : error); } catch (_) {}
    }

    function writeAction(action) {
        try {
            sendAction(action);
            return true;
        } catch (error) {
            warn('[wake-answer] AMI write failed', error);
            return false;
        }
    }

    function finish(entry) {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        entry.timer = null;
        for (const id of entry.actionIds) pending.delete(id);
        entries.delete(entry);
        if (entry.closed || !entry.values.callId || !entry.values.callees) {
            entry.resolve();
            return;
        }
        const callId = String(entry.values.callId);
        const calleeValue = String(entry.values.callees);
        if (!UUID_PATTERN.test(callId) || !CALLEE_LIST_PATTERN.test(calleeValue)) {
            entry.resolve();
            return;
        }
        const recipients = [...new Set(calleeValue.split('-'))]
            .filter(callee => !(entry.winner.kind === 'mobile' && callee === entry.winner.extension));
        Promise.allSettled(recipients.map(callee => Promise.resolve()
            .then(() => cancel(callee, callId))
            .catch(error => warn(`[wake-answer] cancel failed callee=${callee}`, error))))
            .then(() => entry.resolve(), () => entry.resolve());
    }

    function response(event) {
        const item = pending.get(event.ActionID);
        if (!item) return;
        pending.delete(event.ActionID);
        const entry = item.entry;
        if (entry.settled) return;
        entry.values[item.field] = event.Response === 'Success' && Object.prototype.hasOwnProperty.call(event, 'Value')
            ? String(event.Value)
            : null;
        entry.remaining -= 1;
        if (entry.remaining <= 0) finish(entry);
    }

    function start(event) {
        if (event.settled || typeof event.Channel !== 'string' || !event.Channel.trim()) return Promise.resolve();
        const winner = parseWinner(event.DestChannel);
        if (winner.kind === 'ambiguous') return Promise.resolve();
        const entryId = generation;
        return new Promise(resolve => {
            const entry = {
                generation: entryId,
                channel: event.Channel.trim(),
                winner,
                values: {},
                remaining: 2,
                actionIds: [],
                timer: null,
                settled: false,
                closed: false,
                resolve,
            };
            entries.add(entry);
            const id = generation + '-' + (++sequence);
            const callIdAction = `wake-answer-${id}-call`;
            const calleesAction = `wake-answer-${id}-list`;
            entry.actionIds.push(callIdAction, calleesAction);
            pending.set(callIdAction, { entry, field: 'callId' });
            pending.set(calleesAction, { entry, field: 'callees' });
            const ok = writeAction([
                'Action: Getvar',
                `ActionID: ${callIdAction}`,
                `Channel: ${entry.channel}`,
                'Variable: SOKRAT_CALL_ID',
                '', '',
            ].join('\r\n')) && writeAction([
                'Action: Getvar',
                `ActionID: ${calleesAction}`,
                `Channel: ${entry.channel}`,
                'Variable: SOKRAT_WAKE_CALLEES',
                '', '',
            ].join('\r\n'));
            if (!ok) {
                finish(entry);
                return;
            }
            entry.timer = setTimeout(() => finish(entry), timeoutMs);
        });
    }

    function handleEvent(event) {
        if (!event || typeof event !== 'object') return undefined;
        if (event.Event === 'DialEnd' && String(event.DialStatus || '').toUpperCase() === 'ANSWER') {
            return start(event);
        }
        if (event.ActionID) response(event);
        return undefined;
    }

    function close() {
        generation += 1;
        for (const entry of [...entries]) {
            entry.closed = true;
            finish(entry);
        }
        pending.clear();
    }

    return { handleEvent, close };
}

module.exports = { createWakeAnswerCancel, parseWinner };
