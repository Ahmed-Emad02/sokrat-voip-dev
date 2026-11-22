'use strict';

const EventEmitter = require('node:events');

const MAX_CALL_AGE_MS = 4 * 60 * 60 * 1000;

function isSipChannel(channel) {
    return /^(SIP|PJSIP)\//i.test(String(channel || ''));
}

function isInboundTrunkContext(context) {
    return /^from-(?:trunk|pstn|pstn-|sip-external|did)/i.test(String(context || ''));
}

function cleanNumber(value) {
    const number = String(value || '').trim();
    if (!number || number === '<unknown>' || number === 's' || number === 'unknown') return '';
    return number;
}

/**
 * Tracks inbound SIP/PJSIP trunk calls from AMI events and emits a small,
 * stable lifecycle contract:
 *
 *   call_ringing -> call_answered -> call_ended
 *
 * The payload deliberately uses caller/called naming consistent with the
 * existing inbound GSM webhook. No number normalization is performed.
 */
class CallLifecycle extends EventEmitter {
    constructor() {
        super();
        this.calls = new Map();
        this.channelToCall = new Map();
        this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    cleanup(now = Date.now()) {
        for (const [id, call] of this.calls.entries()) {
            if (!call || now - call.startedAt > MAX_CALL_AGE_MS) {
                this.removeCall(id);
            }
        }
    }

    removeCall(id) {
        const call = this.calls.get(id);
        if (!call) return;
        if (call.channel && this.channelToCall.get(call.channel) === id) {
            this.channelToCall.delete(call.channel);
        }
        this.calls.delete(id);
    }

    findCall(event) {
        const channel = String(event.Channel || '');
        const uniqueid = String(event.Uniqueid || '');
        const linkedid = String(event.Linkedid || '');
        const byChannel = channel ? this.channelToCall.get(channel) : null;
        if (byChannel && this.calls.has(byChannel)) return this.calls.get(byChannel);
        if (uniqueid && this.calls.has(uniqueid)) return this.calls.get(uniqueid);
        if (linkedid) {
            for (const call of this.calls.values()) {
                if (call.linkedid === linkedid) return call;
            }
        }
        return null;
    }

    emitEvent(call, event, extra = {}) {
        const payload = {
            ...call.payload,
            event,
            uniqueid: call.uniqueid,
            linkedid: call.linkedid,
            timestamp: new Date().toISOString(),
            ...extra
        };
        this.emit('event', payload);
    }

    handleAmiEvent(event) {
        if (!event || !event.Event) return null;
        const eventName = String(event.Event);

        if (eventName === 'Newchannel') {
            const channel = String(event.Channel || '');
            const context = String(event.Context || '');
            if (!isSipChannel(channel) || !isInboundTrunkContext(context)) return null;
            if (!event.Uniqueid) return null;

            const uniqueid = String(event.Uniqueid);
            if (this.calls.has(uniqueid)) return this.calls.get(uniqueid);
            const linkedid = String(event.Linkedid || uniqueid);
            const caller = cleanNumber(event.CallerIDNum || event.CallerIDNumber);
            const called = cleanNumber(event.Exten || event.ConnectedLineNum);
            const call = {
                uniqueid,
                linkedid,
                channel,
                startedAt: Date.now(),
                answered: false,
                ended: false,
                payload: {
                    source: 'sip-trunk',
                    direction: 'inbound',
                    channel,
                    caller_number: caller,
                    called_number: called,
                    extension: null
                }
            };
            this.calls.set(uniqueid, call);
            if (channel) this.channelToCall.set(channel, uniqueid);
            this.emitEvent(call, 'call_ringing');
            return call;
        }

        const call = this.findCall(event);
        if (!call || call.ended) return null;
        const channel = String(event.Channel || '');
        if (channel && !this.channelToCall.has(channel)) this.channelToCall.set(channel, call.uniqueid);

        if (!call.answered && (eventName === 'Newstate' || eventName === 'Bridge' || eventName === 'BridgeEnter')) {
            const desc = String(event.ChannelStateDesc || event.State || '').toLowerCase();
            const state = String(event.ChannelState || '');
            const isUp = desc === 'up' || state === '6' || eventName === 'Bridge' || eventName === 'BridgeEnter';
            if (isUp) {
                call.answered = true;
                call.answeredAt = Date.now();
                this.emitEvent(call, 'call_answered');
            }
        }

        if (eventName === 'Hangup' || eventName === 'ChannelDestroy') {
            call.ended = true;
            const durationSec = Math.max(0, Math.floor((Date.now() - (call.answeredAt || call.startedAt)) / 1000));
            this.emitEvent(call, 'call_ended', {
                duration_seconds: durationSec,
                cause: String(event.Cause || event['Cause-txt'] || '')
            });
            this.removeCall(call.uniqueid);
            return call;
        }

        return call;
    }

    getActiveCalls() {
        return Array.from(this.calls.values())
            .filter(call => !call.ended)
            .map(call => ({
                ...call.payload,
                uniqueid: call.uniqueid,
                linkedid: call.linkedid,
                event: call.answered ? 'call_answered' : 'call_ringing',
                timestamp: new Date().toISOString(),
                started_at: new Date(call.startedAt).toISOString(),
                answered_at: call.answeredAt ? new Date(call.answeredAt).toISOString() : null
            }));
    }
}

const callLifecycle = new CallLifecycle();
callLifecycle.CallLifecycle = CallLifecycle;
module.exports = callLifecycle;
