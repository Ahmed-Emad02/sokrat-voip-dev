'use strict';

/**
 * Default dial patterns for a newly created outbound route.
 *
 * - `X.` passes local Egyptian numbers through as dialed (e.g. 01012345678).
 * - `+2` + `X.` matches E.164 Egyptian numbers (e.g. +201012345678).
 *   FreePBX strips `match_pattern_prefix` from the dialed number before
 *   handing it to the trunk, so `prepend_digits: '+2'` restores the country
 *   code and the trunk receives the number exactly as dialed.
 */
const DEFAULT_OUTBOUND_DIAL_PATTERNS = Object.freeze([
    Object.freeze({ prefix: '', pattern: 'X.', cid: '', prepend: '' }),
    Object.freeze({ prefix: '+2', pattern: 'X.', cid: '', prepend: '+2' })
]);

/**
 * Returns explicitly supplied patterns when present, otherwise the defaults.
 * Invalid entries are ignored so a malformed payload cannot suppress defaults.
 */
function resolveOutboundDialPatterns(patterns) {
    const requested = (Array.isArray(patterns) ? patterns : [])
        .filter(p => p && typeof p === 'object' && !Array.isArray(p) && String(p.pattern || '').trim() !== '');
    return requested.length > 0 ? requested : DEFAULT_OUTBOUND_DIAL_PATTERNS;
}

module.exports = { DEFAULT_OUTBOUND_DIAL_PATTERNS, resolveOutboundDialPatterns };
