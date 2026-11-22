'use strict';

/**
 * Per-extension jitter-buffer model.
 *
 * AstDB keys (under AMPUSER/<extension>/):
 *   jb_mode            inherit | adaptive | fixed | off
 *   jb_max_ms          20..1000
 *   jb_resync_ms       100..5000
 *   jb_target_extra_ms 0..200 (adaptive only)
 *
 * "inherit" is represented by removing all four keys. Missing keys therefore
 * mean inherit with the documented defaults; existing extensions are never
 * mass-written just to add an inherit marker.
 */

const JB_MODES = Object.freeze(['inherit', 'adaptive', 'fixed', 'off']);
const JB_DEFAULTS = Object.freeze({
    mode: 'inherit',
    maxMs: 200,
    resyncMs: 1000,
    targetExtraMs: 40
});
const JB_LIMITS = Object.freeze({
    maxMs: [20, 1000],
    resyncMs: [100, 5000],
    targetExtraMs: [0, 200]
});
const JITTER_FIELD_NAMES = Object.freeze({
    maxMs: 'jb_max_ms',
    resyncMs: 'jb_resync_ms',
    targetExtraMs: 'jb_target_extra_ms'
});
const JB_KEYS = Object.freeze({
    mode: 'jb_mode',
    maxMs: 'jb_max_ms',
    resyncMs: 'jb_resync_ms',
    targetExtraMs: 'jb_target_extra_ms'
});
const MANAGED_GLOBAL_JB_CONTEXTS = Object.freeze([
    'macro-dialout-trunk-predial-hook',
    'macro-dialout-one-predial-hook'
]);
const LEGACY_GLOBAL_JB_CONTEXTS = Object.freeze(['from-dongle-custom']);

class JitterBufferValidationError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'JitterBufferValidationError';
        this.code = 'invalid_jitter_buffer';
        this.statusCode = 400;
        this.field = field;
    }
}

function pickDefined(input, names) {
    if (!input || typeof input !== 'object') return undefined;
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(input, name) && input[name] !== undefined) {
            return input[name];
        }
    }
    return undefined;
}

function toInteger(value, field, [min, max]) {
    if (typeof value === 'boolean' || Array.isArray(value) || value === null) {
        throw new JitterBufferValidationError(`${field} must be an integer between ${min} and ${max}.`, field);
    }
    if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
        value = Number(value.trim());
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new JitterBufferValidationError(`${field} must be an integer between ${min} and ${max}.`, field);
    }
    return value;
}

function hasJitterBufferFields(payload = {}) {
    return pickDefined(payload, ['jb_mode', 'jbMode']) !== undefined
        || pickDefined(payload, ['jb_max_ms', 'jbMaxMs']) !== undefined
        || pickDefined(payload, ['jb_resync_ms', 'jbResyncMs']) !== undefined
        || pickDefined(payload, ['jb_target_extra_ms', 'jbTargetExtraMs']) !== undefined;
}

function normalizeJitterBuffer(payload = {}, base = {}) {
    const baseMode = JB_MODES.includes(base && base.mode) ? base.mode : JB_DEFAULTS.mode;
    const rawMode = pickDefined(payload, ['jb_mode', 'jbMode', 'mode']);
    const mode = rawMode === undefined || rawMode === null || String(rawMode).trim() === ''
        ? baseMode
        : String(rawMode).trim().toLowerCase();
    if (!JB_MODES.includes(mode)) {
        throw new JitterBufferValidationError(`jb_mode must be one of: ${JB_MODES.join(', ')}.`, 'jb_mode');
    }

    const readNumber = (aliases, baseValue, field, limits) => {
        const raw = pickDefined(payload, aliases);
        if (raw === undefined || raw === null || String(raw).trim() === '') {
            return baseValue === undefined || baseValue === null ? JB_DEFAULTS[field] : toInteger(baseValue, JITTER_FIELD_NAMES[field], limits);
        }
        return toInteger(raw, JITTER_FIELD_NAMES[field], limits);
    };

    return {
        mode,
        maxMs: readNumber(['jb_max_ms', 'jbMaxMs', 'maxMs'], base && base.maxMs, 'maxMs', JB_LIMITS.maxMs),
        resyncMs: readNumber(['jb_resync_ms', 'jbResyncMs', 'resyncMs'], base && base.resyncMs, 'resyncMs', JB_LIMITS.resyncMs),
        targetExtraMs: readNumber(['jb_target_extra_ms', 'jbTargetExtraMs', 'targetExtraMs'], base && base.targetExtraMs, 'targetExtraMs', JB_LIMITS.targetExtraMs)
    };
}

function formatJitterBufferValue(config) {
    const normalized = normalizeJitterBuffer({
        jb_mode: config && config.mode,
        jb_max_ms: config && config.maxMs,
        jb_resync_ms: config && config.resyncMs,
        jb_target_extra_ms: config && config.targetExtraMs
    });
    if (normalized.mode === 'inherit' || normalized.mode === 'off') return null;
    if (normalized.mode === 'fixed') return `${normalized.maxMs},${normalized.resyncMs}`;
    return `${normalized.maxMs},${normalized.resyncMs},${normalized.targetExtraMs}`;
}

function buildJitterBufferSet(config) {
    const normalized = normalizeJitterBuffer({
        jb_mode: config && config.mode,
        jb_max_ms: config && config.maxMs,
        jb_resync_ms: config && config.resyncMs,
        jb_target_extra_ms: config && config.targetExtraMs
    });
    const value = formatJitterBufferValue(normalized);
    if (!value) return null;
    return `Set(JITTERBUFFER(${normalized.mode})=${value})`;
}

function astdbCommandsForJitterBuffer(extension, config) {
    const ext = String(extension || '').trim();
    if (!/^\d+$/.test(ext)) {
        throw new JitterBufferValidationError('A numeric extension is required for jitter-buffer AstDB changes.', 'extension');
    }
    const normalized = normalizeJitterBuffer({
        jb_mode: config && config.mode,
        jb_max_ms: config && config.maxMs,
        jb_resync_ms: config && config.resyncMs,
        jb_target_extra_ms: config && config.targetExtraMs
    });
    if (normalized.mode === 'inherit') {
        return Object.values(JB_KEYS).map(key => `database del AMPUSER ${ext}/${key}`);
    }
    return [
        `database put AMPUSER ${ext}/${JB_KEYS.mode} ${normalized.mode}`,
        `database put AMPUSER ${ext}/${JB_KEYS.maxMs} ${normalized.maxMs}`,
        `database put AMPUSER ${ext}/${JB_KEYS.resyncMs} ${normalized.resyncMs}`,
        `database put AMPUSER ${ext}/${JB_KEYS.targetExtraMs} ${normalized.targetExtraMs}`
    ];
}

function parseAmpuserJitterBufferMap(stdout = '') {
    const values = new Map();
    const lines = String(stdout || '').split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/\/AMPUSER\/([^/]+)\/(jb_(?:mode|max_ms|resync_ms|target_extra_ms))\s*:\s*(.*?)\s*$/);
        if (!match) continue;
        const [, ext, key, value] = match;
        if (!values.has(ext)) values.set(ext, {});
        values.get(ext)[key] = value;
    }
    const result = {};
    for (const [ext, raw] of values.entries()) {
        try {
            result[ext] = normalizeJitterBuffer(raw);
        } catch (_) {
            result[ext] = { ...JB_DEFAULTS };
        }
    }
    return result;
}

function getJitterBufferFromAstdbMap(map, extension) {
    const found = map && map[String(extension)];
    return found ? { ...found } : { ...JB_DEFAULTS };
}

function effectiveJitterBufferFields(config) {
    const normalized = normalizeJitterBuffer({
        jb_mode: config && config.mode,
        jb_max_ms: config && config.maxMs,
        jb_resync_ms: config && config.resyncMs,
        jb_target_extra_ms: config && config.targetExtraMs
    });
    return {
        jb_mode: normalized.mode,
        jb_max_ms: normalized.maxMs,
        jb_resync_ms: normalized.resyncMs,
        jb_target_extra_ms: normalized.targetExtraMs
    };
}

function isManagedJitterBufferLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) return false;
    return /^(?:same\s*=>\s*[^,]+|exten\s*=>\s*[^,]+),[^,]*\bSet\(JITTERBUFFER\((?:adaptive|fixed)\)=/i.test(trimmed);
}

function stripManagedJitterBufferLines(content, contexts = MANAGED_GLOBAL_JB_CONTEXTS) {
    const targets = new Set(contexts);
    const out = [];
    let currentContext = null;
    for (const line of String(content || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        const contextMatch = trimmed.match(/^\[([^\]]+)\]/);
        if (contextMatch) currentContext = contextMatch[1].trim();
        if (currentContext && targets.has(currentContext) && isManagedJitterBufferLine(line)) {
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

function managedJitterBufferPresence(content, contexts = MANAGED_GLOBAL_JB_CONTEXTS) {
    const presence = {};
    for (const ctx of contexts) presence[ctx] = false;
    let currentContext = null;
    for (const line of String(content || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        const contextMatch = trimmed.match(/^\[([^\]]+)\]/);
        if (contextMatch) {
            currentContext = contextMatch[1].trim();
            continue;
        }
        if (currentContext && Object.prototype.hasOwnProperty.call(presence, currentContext) && isManagedJitterBufferLine(line)) {
            presence[currentContext] = true;
        }
    }
    return presence;
}

function renderSokratJbContext() {
    return [
        '[sokrat-jb]',
        '; Resolve one extension\'s jitter-buffer decision in this order:',
        '; explicit extension mode > per-dongle DONGLE_AUDIO/<dongle>/jb >',
        '; AUDIO_GLOBALS/cellular_jitterbuffer > global dialplan defaults.',
        '; mode=off executes no JITTERBUFFER Set at all. Global disabled suppresses',
        '; inherit only; explicit adaptive/fixed still apply.',
        'exten => s,1,NoOp(--- Sokrat jitter buffer for extension ${ARG1} dongle ${ARG2} ---)',
        'same => n,Set(JB_EXT=${IF($["${ARG1}" != ""]?${ARG1}:${CALLERID(num)})})',
        'same => n,GotoIf($["${CHANNEL(name):0:5}" = "PJSIP" | "${CHANNEL(name):0:3}" = "SIP"]?channel_ok)',
        'same => n,Goto(done)',
        'same => n(channel_ok),GotoIf($["${DB_EXISTS(AMPUSER/${JB_EXT}/cidname)}" != "1"]?done)',
        'same => n,Set(JB_DONGLE=${ARG2})',
        'same => n,Set(JB_MODE=${DB(AMPUSER/${JB_EXT}/jb_mode)})',
        'same => n,GotoIf($["${JB_MODE}" = "adaptive" | "${JB_MODE}" = "fixed" | "${JB_MODE}" = "off"]?explicit)',
        'same => n,Set(JB_GLOBAL=${DB(AUDIO_GLOBALS/dialplan_jitterbuffer_enabled)})',
        'same => n,ExecIf($["${JB_GLOBAL}" = ""]?Set(JB_GLOBAL=1))',
        'same => n,GotoIf($["${JB_GLOBAL}" != "1"]?done)',
        'same => n,Set(JB_GLOBAL_MODE=${DB(AUDIO_GLOBALS/dialplan_jb_mode)})',
        'same => n,ExecIf($["${JB_GLOBAL_MODE}" = ""]?Set(JB_GLOBAL_MODE=adaptive))',
        'same => n,GotoIf($["${JB_GLOBAL_MODE}" = "off"]?done)',
        'same => n,Set(JB_GLOBAL_MAX=${DB(AUDIO_GLOBALS/dialplan_jb_max_ms)})',
        'same => n,ExecIf($["${JB_GLOBAL_MAX}" = ""]?Set(JB_GLOBAL_MAX=200))',
        'same => n,Set(JB_GLOBAL_RESYNC=${DB(AUDIO_GLOBALS/dialplan_jb_resync_ms)})',
        'same => n,ExecIf($["${JB_GLOBAL_RESYNC}" = ""]?Set(JB_GLOBAL_RESYNC=1000))',
        'same => n,Set(JB_GLOBAL_TARGET=${DB(AUDIO_GLOBALS/dialplan_jb_target_extra_ms)})',
        'same => n,ExecIf($["${JB_GLOBAL_TARGET}" = ""]?Set(JB_GLOBAL_TARGET=40))',
        'same => n,Set(JB_GLOBAL_SYNC=${DB(AUDIO_GLOBALS/dialplan_jb_sync_video)})',
        'same => n,ExecIf($["${JB_GLOBAL_SYNC}" = ""]?Set(JB_GLOBAL_SYNC=no))',
        'same => n,GotoIf($["${JB_GLOBAL_MODE}" != ""]?inherit_default)',
        'same => n,Set(JB_KIND=)',
        'same => n,GotoIf($["${JB_DONGLE}" = ""]?inherit_default)',
        'same => n,GotoIf($["${DB_EXISTS(DONGLE_SETTINGS/${JB_DONGLE})}" != "1"]?inherit_default)',
        'same => n,Set(JB_KIND=${DB(DONGLE_AUDIO/${JB_DONGLE}/jb)})',
        'same => n,ExecIf($["${JB_KIND}" = ""]?Set(JB_KIND=${DB(AUDIO_GLOBALS/cellular_jitterbuffer)}))',
        'same => n,ExecIf($["${JB_KIND}" = ""]?Set(JB_KIND=${DB(AUDIO_GLOBALS/cellular_jb)}))',
        'same => n,GotoIf($["${JB_KIND}" = ""]?inherit_default)',
        'same => n,GotoIf($["${JB_KIND}" = "off"]?done)',
        'same => n,GotoIf($["${JB_KIND}" = "fixed"]?inherit_fixed:inherit_adaptive)',
        'same => n(inherit_default),Set(JB_KIND=${JB_GLOBAL_MODE})',
        'same => n,GotoIf($["${JB_KIND}" = "fixed"]?inherit_fixed:inherit_adaptive)',
        'same => n(inherit_fixed),Set(JB_VALUE=${JB_GLOBAL_MAX},${JB_GLOBAL_RESYNC},,${JB_GLOBAL_SYNC})',
        'same => n,Goto(apply_fixed)',
        'same => n(inherit_adaptive),Set(JB_VALUE=${JB_GLOBAL_MAX},${JB_GLOBAL_RESYNC},${JB_GLOBAL_TARGET},${JB_GLOBAL_SYNC})',
        'same => n,Goto(apply_adaptive)',
        'same => n(explicit),GotoIf($["${JB_MODE}" = "off"]?done)',
        'same => n,Set(JB_MAX=${DB(AMPUSER/${JB_EXT}/jb_max_ms)})',
        'same => n,ExecIf($["${JB_MAX}" = ""]?Set(JB_MAX=200))',
        'same => n,Set(JB_RESYNC=${DB(AMPUSER/${JB_EXT}/jb_resync_ms)})',
        'same => n,ExecIf($["${JB_RESYNC}" = ""]?Set(JB_RESYNC=1000))',
        'same => n,Set(JB_TARGET=${DB(AMPUSER/${JB_EXT}/jb_target_extra_ms)})',
        'same => n,ExecIf($["${JB_TARGET}" = ""]?Set(JB_TARGET=40))',
        'same => n,GotoIf($["${JB_MODE}" = "fixed"]?explicit_fixed)',
        'same => n,Set(JB_VALUE=${JB_MAX},${JB_RESYNC},${JB_TARGET})',
        'same => n,Goto(apply_adaptive)',
        'same => n(explicit_fixed),Set(JB_VALUE=${JB_MAX},${JB_RESYNC})',
        'same => n,Goto(apply_fixed)',
        'same => n(apply_adaptive),Set(JITTERBUFFER(adaptive)=${JB_VALUE})',
        'same => n,Goto(done)',
        'same => n(apply_fixed),Set(JITTERBUFFER(fixed)=${JB_VALUE})',
        'same => n(done),Return()'
    ].join('\n');
}

module.exports = {
    JB_MODES,
    JB_DEFAULTS,
    JB_LIMITS,
    JB_KEYS,
    MANAGED_GLOBAL_JB_CONTEXTS,
    LEGACY_GLOBAL_JB_CONTEXTS,
    JitterBufferValidationError,
    hasJitterBufferFields,
    normalizeJitterBuffer,
    formatJitterBufferValue,
    buildJitterBufferSet,
    astdbCommandsForJitterBuffer,
    parseAmpuserJitterBufferMap,
    getJitterBufferFromAstdbMap,
    effectiveJitterBufferFields,
    isManagedJitterBufferLine,
    stripManagedJitterBufferLines,
    managedJitterBufferPresence,
    renderSokratJbContext
};
