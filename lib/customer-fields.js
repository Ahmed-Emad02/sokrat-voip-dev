'use strict';

const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'select', 'checkbox']);
const RESERVED_KEYS = new Set([
    'name', 'phone', 'phone_number', 'email', 'id',
    'tenant_id', 'owner_user_id', 'created_at', 'updated_at', 'deleted_at'
]);
const MAX_FIELDS = 50;
const MAX_OPTIONS = 100;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

class CustomerFieldError extends Error {
    constructor(message, code = 'INVALID_CUSTOMER_FIELD') {
        super(message);
        this.name = 'CustomerFieldError';
        this.code = code;
        this.status = 400;
    }
}

function text(value, max) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max);
}

function truthy(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') return true;
    if (value === false || value === 0 || value === '0' || value === 'false' || value === 'off') return false;
    return fallback;
}

function normalizeKey(value) {
    const key = text(value, 50).toLowerCase();
    return KEY_PATTERN.test(key) ? key : '';
}

function slugify(value) {
    return text(value, 50).toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50);
}

function normalizeOptions(raw) {
    let source = raw;
    if (typeof source === 'string') {
        try { source = JSON.parse(source); } catch (_) { source = []; }
    }
    if (!Array.isArray(source)) return [];
    const output = [];
    const seen = new Set();
    for (const item of source) {
        if (output.length >= MAX_OPTIONS) break;
        if (item == null) continue;
        const object = typeof item === 'object' ? item : { value: item };
        const value = text(object.value != null ? object.value : object.key != null ? object.key : item, 100);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        const labelEn = text(object.label_en != null ? object.label_en : object.label != null ? object.label : value, 100);
        const labelAr = text(object.label_ar != null ? object.label_ar : '', 100);
        output.push({ value, label_en: labelEn || value, label_ar: labelAr || labelEn || value });
    }
    return output;
}

function normalizeFieldDefinitions(raw) {
    if (!Array.isArray(raw)) return [];
    const output = [];
    const seen = new Set();
    for (let index = 0; index < raw.length && output.length < MAX_FIELDS; index += 1) {
        const item = raw[index];
        if (!item || typeof item !== 'object') continue;
        const labelEn = text(item.label_en != null ? item.label_en : item.label, 100);
        const labelAr = text(item.label_ar, 100);
        if (!labelEn && !labelAr) continue;
        let key = normalizeKey(item.key != null ? item.key : item.field_key);
        if (!key) key = slugify(labelEn || labelAr) || `field_${index + 1}`;
        if (!KEY_PATTERN.test(key)) key = `field_${index + 1}`;
        if (RESERVED_KEYS.has(key)) continue;
        if (seen.has(key)) {
            let suffix = 2;
            while (suffix < 100 && seen.has(`${key}_${suffix}`)) suffix += 1;
            key = `${key}_${suffix}`.slice(0, 50);
            if (seen.has(key)) continue;
        }
        const requestedType = String(item.field_type != null ? item.field_type : item.type || 'text').toLowerCase();
        const fieldType = FIELD_TYPES.has(requestedType) ? requestedType : 'text';
        const options = fieldType === 'select'
            ? normalizeOptions(item.options != null ? item.options : item.options_json)
            : [];
        if (fieldType === 'select' && options.length === 0) continue;
        output.push({
            key,
            label_en: labelEn || labelAr,
            label_ar: labelAr || labelEn,
            field_type: fieldType,
            options,
            required: truthy(item.required, false),
            active: item.active === undefined ? true : truthy(item.active, true),
            sort_order: Number.isFinite(Number(item.sort_order != null ? item.sort_order : item.sortOrder))
                ? Number(item.sort_order != null ? item.sort_order : item.sortOrder)
                : output.length
        });
        seen.add(key);
    }
    return output;
}

function normalizeCustomerData(definitions, raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const output = {};
    for (const field of definitions) {
        if (!field.active) continue;
        let value = source[field.key];
        if (value === undefined || value === null) value = '';
        else if (typeof value === 'object') {
            try { value = JSON.stringify(value); } catch (_) { value = ''; }
        } else {
            value = String(value);
        }
        value = value.trim();
        if (field.field_type === 'checkbox') {
            value = truthy(value, false) ? '1' : '';
        } else if (field.field_type === 'number') {
            if (value && !/^-?\d+(?:\.\d+)?$/.test(value)) {
                throw new CustomerFieldError(`Field "${field.label_en}" must be a number.`, 'INVALID_NUMBER');
            }
        } else if (field.field_type === 'date') {
            if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                throw new CustomerFieldError(`Field "${field.label_en}" must be a date (YYYY-MM-DD).`, 'INVALID_DATE');
            }
        } else if (field.field_type === 'select') {
            if (value && !field.options.some(option => option.value === value)) {
                throw new CustomerFieldError(`Field "${field.label_en}" has an invalid option.`, 'INVALID_OPTION');
            }
        }
        const maxLength = field.field_type === 'textarea' ? 4000 : 255;
        value = value.slice(0, maxLength);
        if (field.required && field.field_type !== 'checkbox' && !value) {
            throw new CustomerFieldError(`Field "${field.label_en}" is required.`, 'FIELD_REQUIRED');
        }
        output[field.key] = value;
    }
    return output;
}

function parseOptions(raw) {
    if (Array.isArray(raw)) return raw;
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function fieldFromRow(row) {
    if (!row) return null;
    return {
        key: row.field_key,
        label_en: row.label_en,
        label_ar: row.label_ar,
        field_type: row.field_type,
        options: parseOptions(row.options_json),
        required: Boolean(row.required),
        active: Boolean(row.active),
        sort_order: Number(row.sort_order) || 0
    };
}

function parseCustomerData(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

module.exports = {
    FIELD_TYPES,
    RESERVED_KEYS,
    MAX_FIELDS,
    MAX_OPTIONS,
    CustomerFieldError,
    normalizeFieldDefinitions,
    normalizeCustomerData,
    normalizeOptions,
    fieldFromRow,
    parseOptions,
    parseCustomerData,
    text
};
