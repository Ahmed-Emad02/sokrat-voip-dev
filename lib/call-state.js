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

module.exports = { parseCallStateLines };
