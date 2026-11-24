'use strict';

const express = require('express');
const fs = require('fs');
const {
    parseConfiguredState,
    updateEmptySlots,
    removeSection,
    upsertSection
} = require('../lib/dongle-provisioning');

const SLOT_RE = /^dongle[0-9]+$/;
const MAX_BATCH = 32;
// States in which a configured slot has no usable modem, so its section may be
// removed. A bound/ringing/active device is never removable.
const ABSENT_MODEM_RE = /not\s*connec|not\s*init|disconnected|stopp|absent/i;

function requestError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function emptySection(section) {
    return Boolean(section) && !['imei', 'imsi', 'audio', 'data'].some(key => String(section[key] || '').trim());
}

function listSlots(sections, devices) {
    // Configured sections are the slot inventory. A runtime row without a
    // section is a driver leftover whose modem is gone; it must not keep
    // appearing as a slot the operator tries to remove again.
    const names = new Set([...sections.keys()].filter(name => SLOT_RE.test(name)));
    return [...names]
        .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
        .map(slot => {
            const section = sections.get(slot);
            const device = devices.get(slot);
            const empty = emptySection(section) && !device;
            const assigned = Boolean(section) && !emptySection(section);
            const deviceAbsent = Boolean(device) && ABSENT_MODEM_RE.test(String(device.State || ''));
            const modemAbsent = Boolean(section) && (!device || deviceAbsent);
            const orphan = !section && Boolean(device) && deviceAbsent;
            return {
                slot,
                empty,
                assigned,
                orphan,
                present: Boolean(device),
                modemAbsent,
                // Empty placeholders, assigned sections whose modem is not
                // connected, and orphaned driver rows for an absent modem may be
                // cleared; a live device is protected.
                removable: (Boolean(section) && (empty || (assigned && modemAbsent))) || orphan,
                state: device ? String(device.State || 'assigned') : (empty ? 'empty' : 'assigned')
            };
        });
}

/** Lowest unused names, skipping both configured and runtime slot names. */
function nextSlotNames(sections, devices, count) {
    const taken = new Set([...sections.keys(), ...devices.keys()]);
    const names = [];
    for (let index = 0; index < 1000 && names.length < count; index += 1) {
        const slot = `dongle${index}`;
        if (!taken.has(slot)) {
            names.push(slot);
            taken.add(slot);
        }
    }
    return names.length === count ? names : null;
}

// The provisioning helpers remain the only writers; restore metadata after their atomic rename.
function preservingMetadata(configPath, write) {
    const before = fs.statSync(configPath);
    const result = write();
    const after = fs.statSync(configPath);
    if (after.uid !== before.uid || after.gid !== before.gid) fs.chownSync(configPath, before.uid, before.gid);
    if ((after.mode & 0o7777) !== (before.mode & 0o7777)) fs.chmodSync(configPath, before.mode & 0o7777);
    return result;
}

function normaliseNames(raw, required) {
    if (!Array.isArray(raw) || !raw.length) {
        throw requestError(400, `Provide ${required} slot name(s) in "slots".`);
    }
    if (raw.length > MAX_BATCH) throw requestError(400, `At most ${MAX_BATCH} slots per request.`);
    const rawNames = raw.map(name => String(name == null ? '' : name));
    const invalid = rawNames.find(name => name !== name.trim() || !SLOT_RE.test(name));
    if (invalid !== undefined) throw requestError(400, `Invalid dongle slot name: ${invalid || '(empty)'}.`);
    const names = rawNames.map(name => name.toLowerCase());
    if (new Set(names).size !== names.length) throw requestError(400, 'Duplicate slot name in request.');
    return names;
}

/** Local placeholder management only: never adopts hardware or changes Asterisk runtime. */
function createDongleSlotsRouter({ configPath, withProvisionLock, readDevices, onChanged, stopSlot }) {
    const router = express.Router();

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!req.session || req.session.username !== 'root' || req.apiKey != null ||
            req.isApiKeyAuthenticated || req.trustedFederationPeer != null) {
            return res.status(403).json({ success: false, error: 'Interactive root access is required.' });
        }
        return next();
    });

    async function runtimeDevices() {
        try {
            const rows = await readDevices();
            if (!Array.isArray(rows) || rows.some(row => !row || typeof row.ID !== 'string' || !row.ID.trim())) {
                throw new Error('Invalid dongle runtime inventory.');
            }
            return new Map(rows.map(row => [row.ID.trim().toLowerCase(), row]));
        } catch (_) {
            throw requestError(503, 'Dongle runtime inventory is unavailable.');
        }
    }

    function failure(res, error) {
        return res.status(error.status || 500).json({
            success: false,
            error: error.status ? error.message : 'Unable to manage dongle slots.'
        });
    }

    async function notify(action, changedSlots, backup, req) {
        if (typeof onChanged !== 'function') return;
        try {
            await onChanged({
                action,
                changedSlots,
                slot: changedSlots.length === 1 ? changedSlots[0] : undefined,
                backup
            }, req);
        } catch (error) {
            // A notification failure must not turn a committed config change into a retryable failure.
            console.error('[dongle-slots] Change notification failed:', error);
        }
    }

    router.get('/', async (req, res) => {
        try {
            const result = await withProvisionLock(async () => {
                const sections = parseConfiguredState(configPath);
                const devices = await runtimeDevices();
                return { slots: listSlots(sections, devices), suggestedSlot: nextSlotNames(sections, devices, 1)?.[0] || null };
            });
            return res.json({ success: true, ...result });
        } catch (error) {
            return failure(res, error);
        }
    });

    router.post('/', async (req, res) => {
        try {
            const result = await withProvisionLock(async () => {
                const body = req.body == null ? {} : req.body;
                if (typeof body !== 'object' || Array.isArray(body)) {
                    throw requestError(400, 'Expected a JSON object: send {} or { "count": n }.');
                }
                const unknown = Object.keys(body).filter(key => key !== 'count');
                if (unknown.length) throw requestError(400, `Unsupported field: ${unknown[0]}.`);
                const count = body.count === undefined ? 1 : body.count;
                if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
                    throw requestError(400, `count must be a whole number from 1 to ${MAX_BATCH}.`);
                }
                const sections = parseConfiguredState(configPath);
                const devices = await runtimeDevices();
                const additions = nextSlotNames(sections, devices, count);
                if (!additions) throw requestError(409, 'No free dongle slot names remain.');
                const { backup } = preservingMetadata(configPath, () =>
                    updateEmptySlots(configPath, { add: additions }));
                return {
                    backup,
                    changedSlots: additions,
                    slots: listSlots(parseConfiguredState(configPath), devices)
                };
            });
            await notify('create', result.changedSlots, result.backup, req);
            return res.status(201).json({
                success: true,
                addedSlots: result.changedSlots,
                slot: result.changedSlots.length === 1 ? result.changedSlots[0] : undefined,
                slots: result.slots,
                backup: result.backup
            });
        } catch (error) {
            return failure(res, error);
        }
    });

    async function removeSlots(names, req, res) {
        try {
            const result = await withProvisionLock(async () => {
                const sections = parseConfiguredState(configPath);
                const devices = await runtimeDevices();
                const ghosts = [];
                for (const slot of names) {
                    const section = sections.get(slot);
                    const device = devices.get(slot);
                    if (!section) {
                        if (!device) throw requestError(404, `Dongle slot not found: ${slot}.`);
                        if (!ABSENT_MODEM_RE.test(String(device.State || ''))) {
                            throw requestError(409, `Dongle slot is in service and cannot be removed: ${slot} (${device.State}).`);
                        }
                        // Orphaned driver entry for a modem that is gone: stop it.
                        ghosts.push(slot);
                        continue;
                    }
                    if (device) {
                        if (!ABSENT_MODEM_RE.test(String(device.State || ''))) {
                            throw requestError(409, `Dongle slot is in service and cannot be removed: ${slot} (${device.State}).`);
                        }
                        if (emptySection(section)) {
                            // Nothing to delete from the config; the pvt would remain.
                            throw requestError(409, `Empty slot still has an Asterisk entry and cannot be removed: ${slot}.`);
                        }
                        // Its pvt survives a config-only change; it has to be dropped.
                        ghosts.push(slot);
                    }
                }
                // Runtime-only ghosts have no config section to remove. Validate
                // the whole request first, then commit only existing sections.
                const configured = names.filter(slot => sections.has(slot));
                const { backup } = configured.length
                    ? preservingMetadata(configPath, () => configured.length === 1
                        ? removeSection(configPath, configured[0])
                        : updateEmptySlots(configPath, { remove: configured }))
                    : { backup: null };
                // Release the orphaned pvt without rebuilding the module: a
                // module unload/load has already been observed to drop a modem
                // off the USB bus. The driver entry itself clears on the next
                // natural Asterisk restart.
                const stopped = [];
                const stopFailures = [];
                if (typeof stopSlot === 'function') {
                    for (const slot of ghosts) {
                        try {
                            await stopSlot(slot);
                            stopped.push(slot);
                        } catch (error) { stopFailures.push({ slot, error: error.message }); }
                    }
                }
                return {
                    backup,
                    changedSlots: names,
                    ghosts,
                    stopped,
                    stopFailures,
                    slots: listSlots(parseConfiguredState(configPath), devices)
                };
            });
            await notify('remove', result.changedSlots, result.backup, req);
            return res.json({
                success: true,
                removedSlots: result.changedSlots,
                slot: result.changedSlots.length === 1 ? result.changedSlots[0] : undefined,
                slots: result.slots,
                backup: result.backup,
                stopped: result.stopped,
                stopFailures: result.stopFailures
            });
        } catch (error) {
            return failure(res, error);
        }
    }

    router.delete('/', async (req, res) => {
        try {
            const names = normaliseNames(req.body && req.body.slots, 'explicit');
            return await removeSlots(names, req, res);
        } catch (error) {
            return failure(res, error);
        }
    });

    router.delete('/:slot', async (req, res) => {
        try {
            const names = normaliseNames([req.params.slot], 'one');
            return await removeSlots(names, req, res);
        } catch (error) {
            return failure(res, error);
        }
    });

    return router;
}

module.exports = { createDongleSlotsRouter };
