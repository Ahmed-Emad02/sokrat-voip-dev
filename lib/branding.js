'use strict';

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const LOCAL_LOGO_RE = /^\/uploads\/tenant-logos\/tenant-[0-9]+-[0-9]+\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_KEYS = ['primary_color', 'secondary_color', 'background_color', 'text_color', 'muted_color', 'button_text_color'];

function normalizeHexColor(value, fallback = '') {
    const color = String(value || '').trim();
    return HEX_RE.test(color) ? color.toLowerCase() : fallback;
}

function normalizeLogoUrl(value, fallback = '') {
    const url = String(value || '').trim().slice(0, 500);
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (LOCAL_LOGO_RE.test(url)) return url;
    return fallback;
}

function normalizeBranding(raw, existing = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    const output = { ...base };
    for (const key of COLOR_KEYS) {
        if (source[key] === undefined) continue;
        const color = normalizeHexColor(source[key], '');
        if (color) output[key] = color;
        else delete output[key];
    }
    if (source.button_text !== undefined) {
        const text = String(source.button_text || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 40);
        if (text) output.button_text = text;
        else delete output.button_text;
    }
    if (source.logo_url !== undefined) {
        const url = normalizeLogoUrl(source.logo_url, '');
        if (url) output.logo_url = url;
        else delete output.logo_url;
    }
    return output;
}

function isPngBuffer(buffer) {
    return Buffer.isBuffer(buffer)
        && buffer.length >= PNG_SIGNATURE.length
        && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

module.exports = {
    HEX_RE,
    LOCAL_LOGO_RE,
    PNG_SIGNATURE,
    COLOR_KEYS,
    normalizeHexColor,
    normalizeLogoUrl,
    normalizeBranding,
    isPngBuffer
};
