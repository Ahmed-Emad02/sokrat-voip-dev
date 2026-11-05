'use strict';

/**
 * Pure range builder for bulk PBX extension creation.
 * Keeps validation and leading-zero handling out of the HTTP route so it can
 * be tested without a database or Asterisk.
 */

const MAX_BULK_EXTENSIONS = 25;

function buildExtensionRange(startRaw, count, max = MAX_BULK_EXTENSIONS) {
    const start = String(startRaw === undefined || startRaw === null ? '' : startRaw).trim();
    if (!/^\d+$/.test(start)) {
        return { ok: false, error: 'A valid numeric start extension is required.' };
    }

    const startNum = Number(start);
    if (!Number.isSafeInteger(startNum) || startNum < 1) {
        return { ok: false, error: 'Start extension is outside the supported numeric range.' };
    }

    const total = Number.parseInt(count, 10);
    if (!Number.isInteger(total) || total < 1 || total > max) {
        return { ok: false, error: `Count must be between 1 and ${max}.` };
    }

    const width = start.startsWith('0') ? start.length : 0;
    const values = [];
    for (let index = 0; index < total; index++) {
        const next = startNum + index;
        if (!Number.isSafeInteger(next)) {
            return { ok: false, error: 'Extension range is outside the supported numeric range.' };
        }
        let value = String(next);
        if (width > value.length) value = value.padStart(width, '0');
        values.push(value);
    }

    return { ok: true, values };
}

module.exports = {
    MAX_BULK_EXTENSIONS,
    buildExtensionRange
};
