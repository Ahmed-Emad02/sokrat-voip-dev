'use strict';

function normalizeIndex(value) {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index <= 9999 ? index : null;
}

function parseSmsPartLog(statement) {
    const match = /at_response\.c:\s+\[([^\]]+)\]\s+Got SM part from ([^:]+):\s*'(.*?)';\s*\[ref=(\d+),\s*parts=(\d+),\s*order=(\d+),\s*index=(\d+)\]/s.exec(String(statement || ''));
    if (!match) return null;
    const index = normalizeIndex(match[7]);
    if (index === null) return null;
    return {
        dongleId: match[1].trim(),
        sender: match[2].trim(),
        content: match[3],
        ref: Number(match[4]),
        parts: Number(match[5]),
        order: Number(match[6]),
        index
    };
}

function parseSmsFullLog(statement) {
    const text = String(statement || '');
    const indexed = /at_response\.c:\s+\[([^\]]+)\]\s+Got full SMS from ([^:]+):\s*'(.*?)';\s*\[ref=(\d+),\s*index=(\d+)\]/s.exec(text);
    if (indexed) {
        const index = normalizeIndex(indexed[5]);
        return {
            dongleId: indexed[1].trim(),
            sender: indexed[2].trim(),
            content: indexed[3].trim(),
            ref: Number(indexed[4]),
            index,
            legacy: false
        };
    }

    const legacy = /at_response\.c:\s+\[([^\]]+)\]\s+Got full SMS from ([^:]+):\s*'(.*)'/s.exec(text);
    if (!legacy) return null;
    return {
        dongleId: legacy[1].trim(),
        sender: legacy[2].trim(),
        content: legacy[3].replace(/'\s*$/, '').trim(),
        ref: null,
        index: null,
        legacy: true
    };
}

function smsPartKey(dongleId, sender, ref) {
    return `${String(dongleId || '').trim().toLowerCase()}|${String(sender || '').trim()}|${Number(ref)}`;
}

function collectSmsIndices(parts, full) {
    const indices = new Set();
    if (!full) return [];
    if (full.index !== null && full.index !== undefined) {
        const index = normalizeIndex(full.index);
        if (index !== null) indices.add(index);
    }
    if (full.ref !== null && full.ref !== undefined && parts && typeof parts.get === 'function') {
        const entry = parts.get(smsPartKey(full.dongleId, full.sender, full.ref));
        if (entry && entry.indices) {
            for (const index of entry.indices) {
                const normalized = normalizeIndex(index);
                if (normalized !== null) indices.add(normalized);
            }
        }
    }
    return Array.from(indices).sort((a, b) => a - b);
}

module.exports = {
    normalizeIndex,
    parseSmsPartLog,
    parseSmsFullLog,
    smsPartKey,
    collectSmsIndices
};
