/**
 * Phone Normalization Helper Module
 * Provides safe phone number normalization and exact variant generation
 * for database queries without using loose SQL LIKE '%phone%' searches.
 */

/**
 * Clean raw input to digits and optional leading plus sign
 * @param {string} raw
 * @returns {string}
 */
function cleanPhoneString(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return '';
    const str = String(raw).trim();
    // Keep leading '+' if present, strip all other non-digits
    const hasPlus = str.startsWith('+');
    const digits = str.replace(/\D/g, '');
    if (!digits) return '';
    return hasPlus ? '+' + digits : digits;
}

/**
 * Extract phone digits from CLID field e.g. '"John Doe" <01012345678>' -> '01012345678'
 * @param {string} clid
 * @returns {string}
 */
function extractPhoneFromClid(clid) {
    if (!clid || typeof clid !== 'string') return '';
    const angleMatch = clid.match(/<([^>]+)>/);
    if (angleMatch && angleMatch[1]) {
        return cleanPhoneString(angleMatch[1]);
    }
    return cleanPhoneString(clid);
}

/**
 * Validate phone number length and structure
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhoneNumber(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 20;
}

/**
 * Generate exact matching phone variants for a given number and country code
 * @param {string} rawPhone
 * @param {string} [defaultCountryCode='20']
 * @returns {string[]} Unique array of exact string variants to query in SQL
 */
function getPhoneVariants(rawPhone, defaultCountryCode = '20') {
    const cleaned = cleanPhoneString(rawPhone);
    if (!cleaned || !isValidPhoneNumber(cleaned)) {
        return [];
    }

    const cc = String(defaultCountryCode || '20').replace(/\D/g, '');
    let digits = cleaned.replace(/\D/g, '');
    const variants = new Set();

    // Add raw cleaned input
    variants.add(cleaned);
    variants.add(digits);

    // If starts with country code (e.g. 201012345678)
    if (cc && digits.startsWith(cc) && digits.length > cc.length + 5) {
        const nationalNumber = digits.slice(cc.length); // e.g. 1012345678
        variants.add('0' + nationalNumber);            // e.g. 01012345678
        variants.add(nationalNumber);                  // e.g. 1012345678
        variants.add(cc + nationalNumber);             // e.g. 201012345678
        variants.add('00' + cc + nationalNumber);       // e.g. 00201012345678
        variants.add('+' + cc + nationalNumber);        // e.g. +201012345678
    } else if (digits.startsWith('00' + cc)) {
        const nationalNumber = digits.slice(2 + cc.length);
        variants.add('0' + nationalNumber);
        variants.add(nationalNumber);
        variants.add(cc + nationalNumber);
        variants.add('00' + cc + nationalNumber);
        variants.add('+' + cc + nationalNumber);
    } else if (digits.startsWith('0') && digits.length >= 8) {
        // Local zero-prefixed number (e.g. 01012345678)
        const nationalNumber = digits.slice(1); // e.g. 1012345678
        variants.add('0' + nationalNumber);
        variants.add(nationalNumber);
        if (cc) {
            variants.add(cc + nationalNumber);        // 201012345678
            variants.add('00' + cc + nationalNumber);  // 00201012345678
            variants.add('+' + cc + nationalNumber);   // +201012345678
        }
    } else if (digits.length >= 7) {
        // Bare national number (e.g. 1012345678)
        variants.add(digits);
        variants.add('0' + digits);
        if (cc) {
            variants.add(cc + digits);
            variants.add('00' + cc + digits);
            variants.add('+' + cc + digits);
        }
    }

    return Array.from(variants);
}

module.exports = {
    cleanPhoneString,
    extractPhoneFromClid,
    isValidPhoneNumber,
    getPhoneVariants
};
