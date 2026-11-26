'use strict';

/**
 * Authoritative, persisted dongle lifecycle policy.
 *
 * The default is deliberately manual/read-only: monitoring, CLCC/status reads
 * and USB presence discovery stay enabled, but no autonomous restart, reset,
 * rebind, reconnect or config-sync mutation is permitted. Autonomous recovery
 * must be opted into explicitly by the operator in this file.
 *
 * The same JSON document is read by the Node service and the Laya daemon, so
 * disabling one watcher can never leave another mutating watcher active.
 */

const fs = require('fs');

const DEFAULT_PATH = '/etc/sokrat/dongle-lifecycle-policy.json';

const DEFAULTS = Object.freeze({
    version: 1,
    mode: 'manual',
    autonomousRecovery: false,
    maxRecoveryAttempts: 3,
    backoffBaseMs: 60000,
    backoffMaxMs: 1800000,
    recoveryPauseMs: 30 * 60 * 1000
});

function policyPath() {
    return process.env.SOKRAT_DONGLE_LIFECYCLE_POLICY || DEFAULT_PATH;
}

function clampInt(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(number)));
}

function normalizePolicy(raw = {}) {
    const mode = String(raw.mode || DEFAULTS.mode).trim().toLowerCase();
    const autonomous = raw.autonomousRecovery === true || raw.autonomousRecovery === 'true';
    return {
        version: clampInt(raw.version, DEFAULTS.version, 1, 1000),
        // `readonly`/`observe` are accepted spellings for the manual policy.
        mode: ['autonomous', 'auto'].includes(mode) ? 'autonomous' : 'manual',
        autonomousRecovery: autonomous,
        maxRecoveryAttempts: clampInt(raw.maxRecoveryAttempts, DEFAULTS.maxRecoveryAttempts, 1, 10),
        backoffBaseMs: clampInt(raw.backoffBaseMs, DEFAULTS.backoffBaseMs, 1000, 3600000),
        backoffMaxMs: clampInt(raw.backoffMaxMs, DEFAULTS.backoffMaxMs, 1000, 86400000),
        recoveryPauseMs: clampInt(raw.recoveryPauseMs, DEFAULTS.recoveryPauseMs, 60000, 86400000)
    };
}

function readLifecyclePolicy(file = policyPath()) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { ...normalizePolicy(raw), path: file, source: 'file' };
    } catch (error) {
        return {
            ...DEFAULTS,
            path: file,
            source: error && error.code === 'ENOENT' ? 'default-missing-file' : 'default-invalid-file',
            error: error && error.message
        };
    }
}

function autonomousRecoveryAllowed(policy) {
    const effective = policy && typeof policy === 'object' ? normalizePolicy(policy) : readLifecyclePolicy();
    return effective.mode === 'autonomous' && effective.autonomousRecovery === true;
}

function recoveryBackoffMs(policy, failures) {
    const effective = policy && typeof policy === 'object' ? normalizePolicy(policy) : readLifecyclePolicy();
    const exponent = Math.max(0, Math.min(20, Number(failures) - 1));
    return Math.min(effective.backoffMaxMs, effective.backoffBaseMs * (2 ** exponent));
}

module.exports = {
    DEFAULT_PATH,
    DEFAULTS,
    policyPath,
    normalizePolicy,
    readLifecyclePolicy,
    autonomousRecoveryAllowed,
    recoveryBackoffMs
};
