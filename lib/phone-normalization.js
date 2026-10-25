'use strict';

/**
 * Phone Normalization Helper Module
 * Provides safe phone number normalization and exact variant generation
 * for database queries without using loose SQL LIKE '%phone%' searches.
 * Handles Eastern Arabic / Persian numerals, Excel zero-stripping recovery,
 * minimum length quality checks, and multi-format country variants.
 */

const EASTERN_ARABIC_DIGITS = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

/**
 * Convert Eastern Arabic / Persian numerals to Western digits (0-9)
 * @param {string|number} str
 * @returns {string}
 */
function translateArabicIndicDigits(str) {
    if (str == null) return '';
    return String(str).replace(/[٠-٩۰-۹]/g, ch => EASTERN_ARABIC_DIGITS[ch] || ch);
}

/**
 * Clean raw input to digits and optional leading plus sign.
 * Translates Eastern Arabic / Persian numerals before stripping non-digits.
 * @param {string|number} raw
 * @returns {string}
 */
function cleanPhoneString(raw) {
    if (raw == null) return '';
    const str = translateArabicIndicDigits(String(raw)).trim();
    if (!str) return '';
    const hasPlus = str.startsWith('+');
    const digits = str.replace(/\D/g, '');
    if (!digits) return '';
    return hasPlus ? '+' + digits : digits;
}

/**
 * Auto-restore leading zero if stripped by spreadsheet applications (e.g. Excel)
 * - Egypt mobile: 10 digits starting with 10, 11, 12, 15 -> '01' + 9 digits
 * - Saudi mobile: 9 digits starting with 5 -> '05' + 8 digits
 * - Bare national numbers: 7-9 digits without leading 0 -> prepend '0'
 * @param {string} phone
 * @returns {string}
 */
function restoreLeadingZero(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const str = phone.trim();
    if (str.startsWith('+') || str.startsWith('00')) return str;
    const digits = str.replace(/\D/g, '');
    if (digits.length === 10 && /^1[0125]\d{8}$/.test(digits)) {
        return '0' + digits;
    }
    if (digits.length === 9 && /^5\d{8}$/.test(digits)) {
        return '0' + digits;
    }
    if (/^\d+$/.test(str) && !str.startsWith('0') && str.length >= 7 && str.length <= 9) {
        return '0' + str;
    }
    return str;
}

/**
 * Check if a phone input is an anonymous, private, or dummy pattern
 * @param {string} phone
 * @returns {boolean}
 */
function isAnonymousOrDummyPhone(phone) {
    if (!phone) return true;
    const clean = String(phone).trim().toLowerCase();
    if (['anonymous', 'unknown', 'unavailable', 'private', 'none', 'null', 'undefined'].includes(clean)) {
        return true;
    }
    const digits = clean.replace(/\D/g, '');
    if (digits.length < 7) return true;
    // Reject all-identical digits e.g. 0000000, 11111111
    if (/^(\d)\1+$/.test(digits)) return true;
    // Reject simple sequential numbers
    if (digits === '12345678' || digits === '123456789' || digits === '0123456789') return true;
    return false;
}

/**
 * Validate phone number length and structure
 * Minimum 7 digits, maximum 20 digits, and not an anonymous/dummy placeholder.
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhoneNumber(phone) {
    if (!phone) return false;
    const cleaned = cleanPhoneString(phone);
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 20) return false;
    return !isAnonymousOrDummyPhone(cleaned);
}

/**
 * Standard phone normalization for contacts and leads:
 * Translates Eastern Arabic digits, strips non-dialable separators, restores leading zero,
 * and preserves international '+' prefix if applicable.
 * @param {string|number} raw
 * @returns {string}
 */
function normalizePhoneNumber(raw) {
    if (raw == null) return '';
    const cleaned = cleanPhoneString(raw);
    if (!cleaned) return '';
    return restoreLeadingZero(cleaned);
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
 * Generate exact matching phone variants for a given number and country code
 * @param {string} rawPhone
 * @param {string} [defaultCountryCode='20']
 * @returns {string[]} Unique array of exact string variants to query in SQL
 */
function getPhoneVariants(rawPhone, defaultCountryCode = '20') {
    const rawClean = translateArabicIndicDigits(rawPhone);
    const cleaned = cleanPhoneString(rawClean);
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

    // Also include zero-restored version if different
    const withZero = restoreLeadingZero(cleaned);
    if (withZero && withZero !== cleaned) {
        variants.add(withZero);
        variants.add(withZero.replace(/\D/g, ''));
    }

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
            variants.add('+' + code + nat);
            variants.add('00' + code + nat);
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
    translateArabicIndicDigits,
    cleanPhoneString,
    restoreLeadingZero,
    normalizePhoneNumber,
    extractPhoneFromClid,
    isValidPhoneNumber,
    isAnonymousOrDummyPhone,
    getPhoneVariants,
    isInternalExtension,
    sanitizeCallerName
};
