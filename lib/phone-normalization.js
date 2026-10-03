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
    const isExplicitInternational = String(rawPhone).trim().startsWith('+') || digits.startsWith('00');
    const internationalDigits = digits.startsWith('00') ? digits.slice(2) : digits;

    const variants = new Set();

    // Add raw cleaned input and international representations
    variants.add(cleaned);
    variants.add(digits);
    variants.add(internationalDigits);
    variants.add('+' + internationalDigits);
    variants.add('00' + internationalDigits);

    // If starts with default country code (e.g. 201012345678)
    if (cc && internationalDigits.startsWith(cc) && internationalDigits.length > cc.length + 5) {
        const nationalNumber = internationalDigits.slice(cc.length); // e.g. 1012345678
        variants.add('0' + nationalNumber);            // e.g. 01012345678
        variants.add(nationalNumber);                  // e.g. 1012345678
        variants.add(cc + nationalNumber);             // e.g. 201012345678
        variants.add('00' + cc + nationalNumber);       // e.g. 00201012345678
        variants.add('+' + cc + nationalNumber);        // e.g. +201012345678
    } else if (!isExplicitInternational && digits.startsWith('0') && digits.length >= 8) {
        // Local zero-prefixed number (e.g. 01012345678)
        const nationalNumber = digits.slice(1); // e.g. 1012345678
        variants.add('0' + nationalNumber);
        variants.add(nationalNumber);
        if (cc) {
            variants.add(cc + nationalNumber);        // 201012345678
            variants.add('00' + cc + nationalNumber);  // 00201012345678
            variants.add('+' + cc + nationalNumber);   // +201012345678
        }
    } else if (!isExplicitInternational && digits.length >= 7) {
        // Bare national number (e.g. 1012345678)
        variants.add(digits);
        variants.add('0' + digits);
        if (cc) {
            variants.add(cc + digits);
            variants.add('00' + cc + digits);
            variants.add('+' + cc + digits);
        }
    }

    // Handle common international country codes (GCC / Middle East / Global)
    const intlCodes = ['966', '971', '965', '974', '968', '973', '962', '961', '964', '218', '249', '44', '1'];
    for (const code of intlCodes) {
        if (internationalDigits.startsWith(code) && internationalDigits.length > code.length + 5) {
            const nat = internationalDigits.slice(code.length);
            variants.add(nat);
            variants.add('0' + nat);
            break;
        }
    }

    return Array.from(variants);
}

/**
 * Detect if a number is an internal extension or PBX feature code
 * Internal extensions are 2-5 digits without 0/+ prefixes, or start with *
 * @param {string} raw
 * @returns {boolean}
 */
function isInternalExtension(raw) {
    if (!raw) return false;
    const str = String(raw).trim();
    if (str.startsWith('*')) return true; // PBX feature codes (*80, *97, etc.)
    const digits = str.replace(/\D/g, '');
    return digits.length >= 2 && digits.length <= 5 && !str.startsWith('0') && !str.startsWith('+');
}

/**
 * Sanitize caller name by stripping hardware/trunk artifacts, IMEIs, and phone number repeats
 * @param {string} rawName
 * @param {string} [phone]
 * @returns {string|null}
 */
function sanitizeCallerName(rawName, phone) {
    if (!rawName || typeof rawName !== 'string') return null;
    const str = rawName.trim();
    if (!str) return null;

    // Reject pure numeric names or names identical to phone
    const cleanDigits = str.replace(/\D/g, '');
    if (cleanDigits.length > 0 && str.replace(/[\s\-\+\(\)\.]/g, '') === cleanDigits) {
        return null;
    }
    if (phone && cleanDigits === String(phone).replace(/\D/g, '')) {
        return null;
    }

    // Reject hardware / trunk strings
    if (/^(dongle|trunk|dahdi|sip|pjsip|imei|huawei|gsm|channel|unknown|anonymous)/i.test(str)) {
        return null;
    }

    // Clean non-printable characters and truncate to 75 chars
    return str.replace(/[^\p{L}\p{N}\s.,_\-']/gu, '').trim().substring(0, 75) || null;
}

module.exports = {
    cleanPhoneString,
    extractPhoneFromClid,
    isValidPhoneNumber,
    getPhoneVariants,
    isInternalExtension,
    sanitizeCallerName
};
