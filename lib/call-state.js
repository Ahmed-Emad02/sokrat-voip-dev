'use strict';

/**
 * Reduce Asterisk `core show channels concise` output to the state needed by
 * the mobile dongle reconciler: the extension's PJSIP channel and whether a
 * trunk channel is carrying the same dialed target.
 *
 * Asterisk 18's trailing concise fields are unique IDs, not a shared linkedid;
 * matching on the last field falsely reported a live dongle as missing. Match
 * the target carried by the caller's Dial data against the trunk row instead.
 */
/** Trunk-side channels must not be mistaken for a local extension leg. */
function isTrunkChannel(channel) {
    return /^(?:Dongle|SIP|IAX2|DAHDI)\//i.test(channel) ||
        /^PJSIP\/[^0-9]/i.test(channel);
}

function normalizeTarget(value) {
    return String(value || '').trim().split(',')[0].split('/').pop().replace(/[^\d+*#]/g, '');
}

function parseCallStateLines(lines, extension) {
    const ext = String(extension || '').trim();
    if (!/^[0-9]{1,12}$/.test(ext) || !Array.isArray(lines)) {
        return { callerActive: false, trunkActive: false, callerChannel: null, trunkChannel: null };
    }
    const rows = [];
    for (const line of lines) {
        const clean = String(line || '').replace(/^Output:\s*/, '').trim();
        if (!clean || !clean.includes('!')) continue;
        const parts = clean.split('!');
        if (!parts[0]) continue;
        rows.push({
            channel: parts[0],
            exten: parts[2] || '',
            data: parts[6] || '',
            callerId: parts[7] || '',
        });
    }
    const caller = rows.find((row) => row.channel.startsWith(`PJSIP/${ext}-`)) || null;
    if (!caller) {
        return { callerActive: false, trunkActive: false, callerChannel: null, trunkChannel: null };
    }
    const target = normalizeTarget(caller.data);
    const trunk = target
        ? rows.find((row) =>
            isTrunkChannel(row.channel) &&
            normalizeTarget(row.exten || row.callerId) === target) || null
        : null;
    return {
        callerActive: true,
        trunkActive: Boolean(trunk),
        callerChannel: caller.channel,
        trunkChannel: trunk ? trunk.channel : null,
    };
}

function getEndpointExtensionFromChannel(channelName) {
    return String(channelName || '').match(/^(?:SIP|PJSIP|IAX2)\/(\d{2,5})(?:[-@:;]|$)/i)?.[1] || null;
}

// Local/<extension> is a dialplan helper, not evidence that a phone still has
// a call. Reconcile against endpoint legs only, and do not treat CLI errors as
// an authoritative empty snapshot.
function readEndpointCallSnapshot(output, previousCalls, now) {
    const calls = new Map();
    let valid = false;
    for (const line of String(output || '').split('\n')) {
        const row = line.trim();
        if (!row) continue;
        if (/^Asterisk ending \(0\)\.$/.test(row)) {
            valid = true;
            continue;
        }
        const fields = row.split('!');
        if (fields.length < 12 || !/^[^/!\s]+\//.test(fields[0])) return null;
        valid = true;
        const channel = fields[0];
        const extension = getEndpointExtensionFromChannel(channel);
        if (!extension) continue;
        const state = fields[4].toLowerCase() === 'up' ? 'In Call' : 'Ringing';
        const previous = previousCalls[extension];
        const sameChannel = previous?.channel === channel;
        const selected = calls.get(extension);
        if (selected && (selected.state === state ? !sameChannel : state !== 'In Call')) continue;

        const caller = fields[7];
        const destination = fields[2];
        const partner = (sameChannel && previous.partner && previous.partner !== 'Connecting...' && previous.partner)
            || (caller && caller !== extension && caller !== '(None)' && caller !== '<unknown>' && caller)
            || (destination && destination !== extension && destination.length >= 3 && destination)
            || 'Connecting...';
        const duration = Number(fields[11]);
        const estimatedStart = Number.isFinite(duration) && duration >= 0 ? now - duration * 1000 : now;
        const start = sameChannel && previous.start &&
            Math.abs(previous.start - estimatedStart) <= 5000 ? previous.start : estimatedStart;
        calls.set(extension, { state, partner, start, channel });
    }
    return valid ? calls : null;
}

module.exports = { parseCallStateLines, getEndpointExtensionFromChannel, readEndpointCallSnapshot };
