'use strict';

/**
 * Select serial roles from the interfaces actually exposed by one USB modem.
 * A product entry is valid only when one of its variants matches the complete
 * interface topology.  Product ID alone must never choose a pair.
 */
function interfaceNumbers(byInterface) {
    return [...byInterface.keys()].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
}

function sameNumbers(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validRole(variant, byInterface) {
    if (!variant || !Number.isInteger(variant.audio) || !Number.isInteger(variant.data)) return null;
    if (variant.audio === variant.data || !byInterface.has(variant.audio) || !byInterface.has(variant.data)) return null;
    return {
        audioPort: byInterface.get(variant.audio),
        dataPort: byInterface.get(variant.data),
        audioInterface: variant.audio,
        dataInterface: variant.data
    };
}

function topologyRole(roleEntry, byInterface) {
    const variants = Array.isArray(roleEntry)
        ? roleEntry
        : Array.isArray(roleEntry && roleEntry.variants) ? roleEntry.variants : [];
    const actual = interfaceNumbers(byInterface);
    for (const variant of variants) {
        const expected = Array.isArray(variant && variant.interfaces)
            ? variant.interfaces.map(Number).filter(Number.isInteger).sort((a, b) => a - b)
            : [];
        if (!expected.length || !sameNumbers(expected, actual)) continue;
        const role = validRole(variant, byInterface);
        if (role) return { ...role, topology: actual };
    }
    return null;
}

function observedRole(observed, byInterface) {
    if (!observed || !observed.audioPort || !observed.dataPort || observed.audioPort === observed.dataPort) return null;
    const links = new Set(byInterface.values());
    if (!links.has(observed.audioPort) || !links.has(observed.dataPort)) return null;
    return { audioPort: observed.audioPort, dataPort: observed.dataPort };
}

/**
 * Preserve a known-working pair first. For a new or unhealthy slot, select
 * only an exact topology variant; the conservative 0/1/2 default remains for
 * unlisted classic three-interface modems. Any other layout is unresolved.
 */
function resolveInterfaceRoles({ byInterface, roleEntry, observed, preserveObserved = false }) {
    const existing = preserveObserved ? observedRole(observed, byInterface) : null;
    if (existing) return { ...existing, source: 'existing-working' };

    const mapped = topologyRole(roleEntry, byInterface);
    if (mapped) return { ...mapped, source: 'topology' };

    const actual = interfaceNumbers(byInterface);
    if (sameNumbers(actual, [0, 1, 2])) {
        const fallback = validRole({ audio: 1, data: 2 }, byInterface);
        if (fallback) return { ...fallback, source: 'default:0/1/2' };
    }
    return { audioPort: null, dataPort: null, source: 'unresolved' };
}

module.exports = { interfaceNumbers, topologyRole, observedRole, resolveInterfaceRoles };
