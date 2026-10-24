'use strict';

/**
 * Per-campaign post-call follow-up form: normalisation and validation.
 *
 * The campaign stores one JSON document:
 *
 *   {
 *     "version": 1,
 *     "settings": {
 *       "require_submit": false,      // agent must submit before the next dialer call
 *       "allow_skip": true,
 *       "skip_requires_reason": false,
 *       "edit_window_minutes": 10,    // 0 = no edits after submit
 *       "dispositions": []            // allowlist; empty = all global dispositions
 *     },
 *     "fields": [
 *       { "key": "interest", "label": "Interest", "label_ar": "الاهتمام",
 *         "type": "select", "required": true,
 *         "options": [{ "value": "hot", "label": "Hot", "label_ar": "ساخن" }] }
 *     ]
 *   }
 *
 * Everything is validated again on submission; the client form is a
 * convenience, not the source of truth.
 */

const MAX_FIELDS = 40;
const MAX_KEY_LENGTH = 64;
const MAX_LABEL_LENGTH = 120;
const MAX_OPTIONS = 50;
const MAX_TEXT_LENGTH = 5000;
const MAX_DISPOSITIONS = 100;
const MAX_DISPOSITION_LENGTH = 50;
const MAX_SKIP_REASON = 500;

const FIELD_TYPES = new Set([
    'text', 'textarea', 'tel', 'number', 'date', 'datetime',
    'select', 'radio', 'checkbox'
]);

const DEFAULT_FOLLOWUP_SETTINGS = Object.freeze({
    require_submit: false,
    allow_skip: true,
    skip_requires_reason: false,
    edit_window_minutes: 10,
    dispositions: []
});

function normalizeBoolean(value, fallback = false) {
    if (value === true || value === 1 || value === '1' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'false') return false;
    return Boolean(fallback);
}

function normalizeText(value, max) {
    return String(value == null ? '' : value)
        .replace(/[\r\n\0]+/g, ' ')
        .trim()
        .slice(0, max);
}

function normalizeKey(value) {
    const key = String(value == null ? '' : value).trim();
    return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) ? key : '';
}

function parseJson(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function normalizeOptions(raw) {
    if (!Array.isArray(raw)) return [];
    const options = [];
    const seen = new Set();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const value = normalizeText(item.value, MAX_KEY_LENGTH);
        const label = normalizeText(item.label || item.value, MAX_LABEL_LENGTH);
        const labelAr = normalizeText(item.label_ar || item.labelAr || item.label || item.value, MAX_LABEL_LENGTH);
        if (!value || !label || seen.has(value)) continue;
        seen.add(value);
        options.push({ value, label, label_ar: labelAr });
        if (options.length >= MAX_OPTIONS) break;
    }
    return options;
}

function normalizeField(raw, seenKeys) {
    if (!raw || typeof raw !== 'object') return null;
    const key = normalizeKey(raw.key);
    const label = normalizeText(raw.label || raw.key, MAX_LABEL_LENGTH);
    const labelAr = normalizeText(raw.label_ar || raw.labelAr || raw.label || raw.key, MAX_LABEL_LENGTH);
    if (!key || !label || seenKeys.has(key)) return null;
    const type = FIELD_TYPES.has(String(raw.type || '').toLowerCase())
        ? String(raw.type).toLowerCase()
        : 'text';
    const options = (type === 'select' || type === 'radio') ? normalizeOptions(raw.options) : [];
    if ((type === 'select' || type === 'radio') && options.length === 0) return null;
    seenKeys.add(key);
    const maxLength = Math.min(
        MAX_TEXT_LENGTH,
        Math.max(1, parseInt(raw.max_length, 10) || (type === 'textarea' ? 1000 : 200))
    );
    return {
        key,
        label,
        label_ar: labelAr,
        type,
        required: normalizeBoolean(raw.required, false),
        placeholder: normalizeText(raw.placeholder, MAX_LABEL_LENGTH),
        placeholder_ar: normalizeText(raw.placeholder_ar || raw.placeholderAr || raw.placeholder, MAX_LABEL_LENGTH),
        help: normalizeText(raw.help, 240),
        help_ar: normalizeText(raw.help_ar || raw.helpAr || raw.help, 240),
        max_length: maxLength,
        options
    };
}

function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    let editWindow = parseInt(source.edit_window_minutes, 10);
    if (!Number.isFinite(editWindow)) editWindow = DEFAULT_FOLLOWUP_SETTINGS.edit_window_minutes;
    editWindow = Math.min(1440, Math.max(0, editWindow));
    let dispositions = [];
    if (Array.isArray(source.dispositions)) {
        dispositions = source.dispositions
            .map((name) => normalizeText(name, MAX_DISPOSITION_LENGTH))
            .filter(Boolean)
            .slice(0, MAX_DISPOSITIONS);
        dispositions = Array.from(new Set(dispositions));
    }
    return {
        require_submit: normalizeBoolean(source.require_submit, DEFAULT_FOLLOWUP_SETTINGS.require_submit),
        allow_skip: normalizeBoolean(source.allow_skip, DEFAULT_FOLLOWUP_SETTINGS.allow_skip),
        skip_requires_reason: normalizeBoolean(source.skip_requires_reason, DEFAULT_FOLLOWUP_SETTINGS.skip_requires_reason),
        edit_window_minutes: editWindow,
        dispositions
    };
}

/** Normalises any stored/API value into `{ version, settings, fields }`. */
function normalizeFollowupConfig(raw) {
    const source = parseJson(raw);
    const root = source && typeof source === 'object' ? source : {};
    const seenKeys = new Set();
    const fields = [];
    const list = Array.isArray(root.fields) ? root.fields : [];
    for (const item of list) {
        const field = normalizeField(item, seenKeys);
        if (!field) continue;
        fields.push(field);
        if (fields.length >= MAX_FIELDS) break;
    }
    return {
        version: 1,
        settings: normalizeSettings(root.settings || root),
        fields
    };
}

function isFollowupConfigEmpty(config) {
    return !config || !Array.isArray(config.fields) || config.fields.length === 0;
}

function validateFollowupSubmission(config, rawValues, { disposition, skipped, skipReason } = {}) {
    const normalized = normalizeFollowupConfig(config);
    const settings = normalized.settings;
    const errors = [];
    const values = {};

    if (skipped) {
        if (!settings.allow_skip) {
            errors.push({ key: '_skip', message: 'Skipping this follow-up is not allowed for this campaign.' });
        }
        const reason = normalizeText(skipReason, MAX_SKIP_REASON);
        if (settings.skip_requires_reason && !reason) {
            errors.push({ key: '_skip_reason', message: 'A skip reason is required.' });
        }
        const chosen = normalizeText(disposition, MAX_DISPOSITION_LENGTH);
        if (chosen && settings.dispositions.length > 0 && !settings.dispositions.includes(chosen)) {
            errors.push({ key: '_disposition', message: 'This disposition is not allowed for this campaign.' });
        }
        return {
            ok: errors.length === 0,
            errors,
            values: {},
            disposition: chosen || '',
            skipped: true,
            skipReason: reason
        };
    }

    const source = rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues) ? rawValues : {};
    for (const field of normalized.fields) {
        const hasValue = Object.prototype.hasOwnProperty.call(source, field.key);
        const raw = hasValue ? source[field.key] : undefined;

        if (field.type === 'checkbox') {
            const checked = normalizeBoolean(raw, false);
            if (field.required && !checked) {
                errors.push({ key: field.key, message: 'This field is required.' });
            }
            values[field.key] = checked;
            continue;
        }

        const text = raw == null ? '' : String(raw).trim();
        if (field.required && !text) {
            errors.push({ key: field.key, message: 'This field is required.' });
            continue;
        }
        if (!text) continue;

        if ((field.type === 'select' || field.type === 'radio')) {
            const allowed = field.options.some((option) => option.value === text);
            if (!allowed) {
                errors.push({ key: field.key, message: 'Choose one of the available options.' });
                continue;
            }
            values[field.key] = text;
            continue;
        }

        if (field.type === 'number') {
            const number = Number(text);
            if (!Number.isFinite(number)) {
                errors.push({ key: field.key, message: 'Enter a valid number.' });
                continue;
            }
            values[field.key] = number;
            continue;
        }

        if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
            errors.push({ key: field.key, message: 'Enter a valid date.' });
            continue;
        }

        if (field.type === 'datetime' && !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(text)) {
            errors.push({ key: field.key, message: 'Enter a valid date and time.' });
            continue;
        }

        values[field.key] = text.slice(0, field.max_length);
    }

    const chosen = normalizeText(disposition, MAX_DISPOSITION_LENGTH);
    if (chosen && settings.dispositions.length > 0 && !settings.dispositions.includes(chosen)) {
        errors.push({ key: '_disposition', message: 'This disposition is not allowed for this campaign.' });
    }

    return {
        ok: errors.length === 0,
        errors,
        values,
        disposition: chosen || '',
        skipped: false,
        skipReason: ''
    };
}

module.exports = {
    DEFAULT_FOLLOWUP_SETTINGS,
    FIELD_TYPES,
    MAX_FIELDS,
    MAX_LABEL_LENGTH,
    MAX_DISPOSITION_LENGTH,
    MAX_SKIP_REASON,
    normalizeFollowupConfig,
    isFollowupConfigEmpty,
    validateFollowupSubmission
};
