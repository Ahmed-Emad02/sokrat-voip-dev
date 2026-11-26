'use strict';

const fs = require('fs');
const { upsertSection, removeSection } = require('./dongle-provisioning');
const {
    readLifecyclePolicy,
    autonomousRecoveryAllowed,
    recoveryBackoffMs
} = require('./dongle-lifecycle-policy');
const SLOT_RE = /^dongle\d+$/;
const STAGES = { downBeforeRestart: 90000, restartToUsb: 120000, usbToFlag: 120000, pauseMs: 30 * 60 * 1000 };

// Include lifecycle policy (including inherited defaults), which the provisioning
// parser deliberately does not expose. Identity/ports are never inherited.
function readDongleSections(configPath) {
    const sections = new Map();
    let current;
    for (const line of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
        const text = line.trim();
        const header = /^\[([^\]]+)\]/.exec(text);
        if (header) {
            const name = header[1].trim().toLowerCase();
            if (!sections.has(name)) sections.set(name, { name });
            current = sections.get(name);
        } else if (current && text && !/^[;#]/.test(text)) {
            const match = /^([^=]+)=(.*)$/.exec(text);
            if (match) current[match[1].trim().toLowerCase()] = match[2].split(';')[0].trim();
        }
    }
    const defaults = sections.get('defaults') || {};
    for (const [slot, section] of sections) {
        if (!SLOT_RE.test(slot)) continue;
        for (const key of ['initstate', 'disable']) {
            if (!(key in section) && key in defaults) section[key] = defaults[key];
        }
    }
    return sections;
}

function slotIntentionallyDisabled(section) {
    return Boolean(section) && (/^(stop|remove)$/i.test(String(section.initstate || '').trim()) ||
        /^(yes|true|on|1)$/i.test(String(section.disable || '').trim()));
}

function recoveryEligible(section) {
    return Boolean(section) && !slotIntentionallyDisabled(section) &&
        ['imei', 'imsi', 'audio', 'data'].some(key => String(section[key] || '').trim());
}

function detailSafety(output, slot) {
    const fields = new Map();
    for (const line of String(output).split('\n')) {
        const match = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
        if (match) fields.set(match[1].toLowerCase(), match[2]);
    }
    const counts = ['calls/channels', 'active', 'held', 'dialing', 'alerting', 'incoming', 'waiting', 'releasing', 'initializing', 'tasks in queue', 'commands in queue'];
    if (fields.get('device')?.toLowerCase() !== slot || !fields.get('state') ||
        !/^(start|stop|restart|remove)$/i.test(fields.get('desired device state') || '') ||
        !/^(?:free|ready|registered|idle|not\s*(?:connected|initialized)|gsm not registered|disconnected|stopped|ring|dialing|waiting|active|held|incoming|outgoing|sms)\b/i.test(fields.get('state') || '') ||
        counts.some(key => !/^\d+$/.test(fields.get(key) || ''))) {
        return { safe: false, reason: `Unknown call/SMS state: ${slot}` };
    }
    if (counts.some(key => Number(fields.get(key)) > 0) ||
        /sms|ring|dialing|active|incoming|waiting|held|releasing|initializing/i.test(fields.get('state'))) {
        return { safe: false, reason: `Call, SMS or queued command active: ${slot}` };
    }
    return { safe: true, stopped: /^(stop|remove)$/i.test(fields.get('desired device state')), state: fields.get('state') };
}

function createDongleRuntime({ configPath, run, readStates, isHealthy, isCallState, audit = () => {}, usbTarget, usbRebind, notifyFailure = () => {}, now = Date.now, lifecyclePolicy = () => readLifecyclePolicy() }) {
    const recovery = new Map();
    const pendingRollbacks = new Map();
    let inFlight = false;
    let manualObservationAudited = false;

    function currentPolicy() {
        try {
            return typeof lifecyclePolicy === 'function' ? lifecyclePolicy() : lifecyclePolicy;
        } catch (_) {
            return readLifecyclePolicy();
        }
    }

    async function checked(command, expected) {
        const output = String(await run(command));
        if (!expected.test(output) || /no such command|unable|failed|error|not found/i.test(output)) {
            throw new Error(`${command}: ${output.trim() || 'No acknowledgement from Asterisk'}`);
        }
        return output.trim();
    }

    // Read both Asterisk channels and the driver's radio/AT queue counters. A
    // disconnected label or zero PBX channels alone does not prove radio idle.
    async function safety(slots = []) {
        try {
            const channels = String(await run('core show channels'));
            if (!/^\s*\d+ active channels?\s*$/im.test(channels)) return { safe: false, reason: 'Unknown Asterisk channel state' };
            if (/Dongle\//i.test(channels)) {
                return { safe: false, reason: 'Dongle calls active' };
            }
            const states = await readStates();
            if (!(states instanceof Map)) return { safe: false, reason: 'Unknown dongle inventory' };
            const targets = new Set([...states.keys(), ...slots]);
            const details = new Map();
            for (const slot of targets) {
                if (!SLOT_RE.test(slot) || !states.has(slot)) continue;
                const detail = detailSafety(await run(`dongle show device state ${slot}`), slot);
                if (!detail.safe) return detail;
                details.set(slot, detail);
            }
            return { safe: true, states, details };
        } catch (error) {
            return { safe: false, reason: `Unknown dongle safety: ${error.message}` };
        }
    }

    async function requireIdle(slots = []) {
        const result = await safety(slots);
        if (!result.safe) {
            const error = new Error(result.reason);
            error.deferred = true;
            throw error;
        }
        return result;
    }

    function mutationAuthorized(request = {}) {
        return request.autonomous !== true || autonomousRecoveryAllowed(currentPolicy());
    }

    function policyDeferred(slot) {
        return { ...(slot === undefined ? {} : { slot }), success: false, pending: true, reason: 'manual lifecycle policy blocks autonomous maintenance' };
    }

    async function reloadConfiguration(slots, source, authority = {}) {
        const guard = await safety(slots);
        if (!guard.safe) return { success: false, pending: true, reason: guard.reason };
        const sections = readDongleSections(configPath);
        for (const [slot, detail] of guard.details) {
            const section = sections.get(slot);
            if (detail.stopped && !slots.includes(slot) && section && !/^(stop|remove)$/i.test(String(section.initstate || '').trim())) {
                return { success: false, pending: true, reason: `Unrelated slot stopped at runtime: ${slot}` };
            }
        }
        if (!mutationAuthorized(authority)) return policyDeferred();
        try {
            const output = await checked('module reload chan_dongle.so', /Module\s+['"]?chan_dongle\.so['"]?\s+reloaded successfully/i);
            audit({ type: 'provision', phase: 'conf_reloaded', source, slots, output });
            return { success: true };
        } catch (error) {
            audit({ type: 'provision', phase: 'conf_reload_failed', source, slots, error: error.message });
            return { success: false, error: error.message };
        }
    }

    async function stopSlot(slot) {
        await requireIdle([slot]);
        return checked(`dongle stop now ${slot}`, new RegExp(`\\[${slot}\\]\\s+Stop scheduled`, 'i'));
    }

    function rollbackSnapshot(section, previous) {
        if (!section) return 'null';
        const keys = previous ? Object.keys(previous).sort() : Object.keys(section).sort();
        return JSON.stringify(keys.map(key => [key, section[key] ?? null]));
    }

    // Only restore fields of this slot, never a whole backup. Driver ghosts may
    // remain stopped until a natural daemon restart; unloading every pvt is unsafe.
    async function attemptRollback(request) {
        const { slot, previous = null, source, reloadOnly = false } = request;
        try {
            // Capture before a policy deferral, but preserve failure reporting
            // if the configuration is unavailable.
            if (!reloadOnly && request.expected === undefined) {
                request.expected = rollbackSnapshot(readDongleSections(configPath).get(slot), previous);
            }
            if (!mutationAuthorized(request)) return policyDeferred(slot);
            if (reloadOnly) {
                const applied = await reloadConfiguration([slot], source, request);
                if (!applied.success) return { slot, ...applied, configRestored: true };
                audit({ type: 'provision', phase: 'slot_rolled_back', dongleId: slot, source, removed: !previous });
                return { slot, success: true, configRestored: true };
            }
            const guard = await safety([slot]);
            if (!guard.safe) {
                audit({ type: 'provision', phase: 'rollback_pending', dongleId: slot, source, reason: guard.reason });
                return { slot, success: false, pending: true, reason: guard.reason };
            }
            const section = readDongleSections(configPath).get(slot);
            if (section && slotIntentionallyDisabled(section)) {
                return { slot, success: true, skipped: true, reason: 'Slot intentionally disabled' };
            }
            if (previous && !section) return { slot, success: true, skipped: true, reason: 'Slot already removed' };
            if (rollbackSnapshot(section, previous) !== request.expected) {
                return { slot, success: true, skipped: true, reason: 'Slot changed while rollback was pending' };
            }
            if (!mutationAuthorized(request)) return policyDeferred(slot);
            if (guard.states.has(slot)) {
                await checked(`dongle stop gracefully ${slot}`, new RegExp(`\\[${slot}\\]\\s+Stop scheduled`, 'i'));
                const afterStop = await safety([slot]);
                if (!afterStop.safe || (afterStop.states.has(slot) && !afterStop.details.get(slot)?.stopped)) {
                    return { slot, success: false, pending: true, reason: afterStop.reason || 'Waiting for affected slot to stop' };
                }
            }
            // Deferred automatic work never inherits operator authority.
            if (!mutationAuthorized(request)) return policyDeferred(slot);
            // No await between this final policy read and the field-level write.
            const latest = readDongleSections(configPath).get(slot);
            if (latest && slotIntentionallyDisabled(latest)) return { slot, success: true, skipped: true, reason: 'Slot intentionally disabled' };
            if (rollbackSnapshot(latest, previous) !== request.expected) {
                return { slot, success: true, skipped: true, reason: 'Slot changed while rollback was pending' };
            }
            if (previous) {
                if (!latest) return { slot, success: true, skipped: true, reason: 'Slot already removed' };
                upsertSection(configPath, slot, previous);
            } else if (latest) {
                removeSection(configPath, slot);
            }
            const applied = await reloadConfiguration([slot], source, request);
            if (!applied.success) return { slot, ...applied, configRestored: true };
            audit({ type: 'provision', phase: 'slot_rolled_back', dongleId: slot, source, removed: !previous });
            return { slot, success: true, removed: !previous };
        } catch (error) {
            audit({ type: 'provision', phase: 'rollback_failed', dongleId: slot, source, error: error.message });
            return { slot, success: false, error: error.message };
        }
    }

    async function rollbackSlot(request) {
        const result = await attemptRollback(request);
        if (result.pending) pendingRollbacks.set(request.slot, { ...request, reloadOnly: Boolean(request.reloadOnly || result.configRestored) });
        else pendingRollbacks.delete(request.slot);
        return result;
    }

    async function retryPendingRollbacks() {
        const results = [];
        for (const request of [...pendingRollbacks.values()]) results.push(await rollbackSlot(request));
        return results;
    }

    async function watchdog(slotStates) {
        if (inFlight) return;
        inFlight = true;
        try {
            const policy = currentPolicy();
            if (!autonomousRecoveryAllowed(policy)) {
                /* Manual/read-only lifecycle policy: the authoritative default.
                 * Observation (USB presence, device state, calls, CLCC) remains
                 * in the callers; this watcher must not restart, reset, rebind
                 * or replay a config-driven session mutation. Explicit
                 * authenticated operator maintenance keeps working. */
                if (recovery.size) recovery.clear();
                if (!manualObservationAudited) {
                    manualObservationAudited = true;
                    audit({ type: 'recovery', phase: 'observation_only', mode: policy.mode,
                        reason: 'manual lifecycle policy blocks autonomous recovery mutations' });
                }
                return { mode: 'manual', autonomous: false, mutations: 0 };
            }
            const sections = readDongleSections(configPath);
            const slots = new Set([...sections.keys(), ...slotStates.keys(), ...recovery.keys()]);
            for (const slot of slots) {
                if (!SLOT_RE.test(slot)) continue;
                const state = slotStates.get(slot);
                if (pendingRollbacks.has(slot)) {
                    if (!recoveryEligible(sections.get(slot))) recovery.delete(slot);
                    continue;
                }
                if (!recoveryEligible(sections.get(slot)) || /stopp|remov/i.test(String(state || ''))) {
                    recovery.delete(slot);
                    continue;
                }
                if (isHealthy(state) || isCallState(state)) {
                    if (recovery.delete(slot)) audit({ type: 'recovery', phase: 'healthy', dongleId: slot, state });
                    continue;
                }
                let record = recovery.get(slot);
                const time = now();
                if (!record) {
                    recovery.set(slot, { since: time, stage: 0, nextAt: 0, pausedUntil: 0, attempts: 0, failures: 0, stopped: false });
                    continue;
                }
                if (record.stopped) {
                    /* Terminal, operator-visible stop. A healthy/config change
                     * deletes the record above; otherwise stay silent. */
                    continue;
                }
                if (time < record.pausedUntil || time < (record.nextAt || (record.since + STAGES.downBeforeRestart))) continue;
                /* Bound total mutations per episode. */
                if ((record.attempts || 0) >= policy.maxRecoveryAttempts) {
                    record.stopped = true;
                    record.pausedUntil = time + policy.recoveryPauseMs;
                    audit({ type: 'recovery', phase: 'stopped', dongleId: slot, state,
                        reason: `recovery attempt limit reached (${record.attempts}/${policy.maxRecoveryAttempts})`,
                        retryAfterSec: Math.ceil(policy.recoveryPauseMs / 1000) });
                    notifyFailure({ dongleId: slot, state, reason: 'recovery_stopped', retryAfterSec: Math.ceil(policy.recoveryPauseMs / 1000) });
                    continue;
                }
                const guard = await safety([slot]);
                // Re-read intent after all live queries, immediately before any mutation.
                if (!recoveryEligible(readDongleSections(configPath).get(slot)) || guard.details?.get(slot)?.stopped) {
                    recovery.delete(slot);
                    continue;
                }
                if (!guard.safe) {
                    audit({ type: 'recovery', phase: 'deferred', dongleId: slot, reason: guard.reason });
                    continue;
                }
                if (isHealthy(guard.states.get(slot)) || isCallState(guard.states.get(slot)) || isHealthy(guard.details.get(slot)?.state) || isCallState(guard.details.get(slot)?.state)) {
                    recovery.delete(slot);
                    continue;
                }
                // Policy can change while the asynchronous safety queries run.
                // Revocation must take effect before the next lifecycle write.
                if (!autonomousRecoveryAllowed(currentPolicy())) {
                    recovery.clear();
                    return { mode: 'manual', autonomous: false, mutations: 0 };
                }
                try {
                    if (record.stage === 0) {
                        const output = await checked(`dongle restart gracefully ${slot}`, new RegExp(`\\[${slot}\\]\\s+Restart scheduled`, 'i'));
                        record.attempts = (record.attempts || 0) + 1;
                        record.failures = 0;
                        record.stage = 1;
                        record.nextAt = time + STAGES.restartToUsb;
                        audit({ type: 'recovery', phase: 'restart', dongleId: slot, state, output, downMs: time - record.since, attempt: record.attempts });
                    } else if (record.stage === 1) {
                        const target = usbTarget(slot);
                        if (!target) throw new Error('USB device could not be resolved');
                        // The safety read is deliberately adjacent to the rebind, not
                        // separated by a sleep/reload or an earlier recovery stage.
                        const method = await usbRebind(target.device);
                        record.attempts = (record.attempts || 0) + 1;
                        record.failures = 0;
                        record.stage = 2;
                        record.nextAt = time + STAGES.usbToFlag;
                        audit({ type: 'recovery', phase: 'usb_rebind', dongleId: slot, state, device: target.device, method, attempt: record.attempts });
                    } else if (record.stage === 2) {
                        record.attempts = (record.attempts || 0) + 1;
                        record.stage = 3;
                        record.stopped = true;
                        record.pausedUntil = time + policy.recoveryPauseMs;
                        audit({ type: 'recovery', phase: 'needs_attention', dongleId: slot, state, reason: 'Device remains unavailable after restart and USB rebind; inspect hardware and driver logs', retryAfterSec: Math.ceil(policy.recoveryPauseMs / 1000) });
                        notifyFailure({ dongleId: slot, state, reason: 'recovery_exhausted', retryAfterSec: Math.ceil(policy.recoveryPauseMs / 1000) });
                    }
                } catch (error) {
                    record.failures = (record.failures || 0) + 1;
                    record.attempts = (record.attempts || 0) + 1;
                    if (record.attempts >= policy.maxRecoveryAttempts) {
                        record.stopped = true;
                        record.pausedUntil = time + policy.recoveryPauseMs;
                        audit({ type: 'recovery', phase: 'stopped', dongleId: slot, error: error.message,
                            attempts: record.attempts, retryAfterSec: Math.ceil(policy.recoveryPauseMs / 1000) });
                        notifyFailure({ dongleId: slot, state, reason: 'recovery_stopped', retryAfterSec: Math.ceil(policy.recoveryPauseMs / 1000) });
                    } else {
                        const backoff = recoveryBackoffMs(policy, record.failures);
                        record.nextAt = time + backoff;
                        audit({ type: 'recovery', phase: 'failed', dongleId: slot, error: error.message,
                            failures: record.failures, retryInMs: backoff, backoff: true, attempt: record.attempts });
                    }
                }
            }
        } finally {
            inFlight = false;
        }
    }

    return { watchdog, safety, requireIdle, reloadConfiguration, rollbackSlot, retryPendingRollbacks, stopSlot };
}

module.exports = { readDongleSections, slotIntentionallyDisabled, recoveryEligible, createDongleRuntime };
