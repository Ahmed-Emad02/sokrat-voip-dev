'use strict';

const DEFAULT_MAPPING_OVERRIDE = 'auto';

function normalizeIdentity(value) {
    const identity = String(value === undefined || value === null ? '' : value).trim();
    return /^\d{5,30}$/.test(identity) ? identity : '';
}

function normalizeDid(value) {
    const did = String(value === undefined || value === null ? '' : value).trim();
    return /^\+?\d{3,30}$/.test(did) ? did : '';
}

function normalizeSlotName(value) {
    const name = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    return /^[a-z0-9_-]+$/.test(name) ? name : '';
}

function normalizeMappingOverride(value) {
    const override = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    return override === 'disabled' ? 'disabled' : DEFAULT_MAPPING_OVERRIDE;
}

function normalizeInventoryRows(rows, alerts) {
    const inventory = new Map();

    for (const row of Array.isArray(rows) ? rows : []) {
        const imsi = normalizeIdentity(row && row.imsi);
        const did = normalizeDid(row && (row.did !== undefined ? row.did : row.phone_number));
        if (!imsi || !did) continue;

        const enabled = !(row.enabled === 0 || row.enabled === '0' || row.enabled === false);
        const existing = inventory.get(imsi);
        if (existing && existing.did !== did) {
            alerts.push({
                type: 'inventory_conflict',
                imsi,
                message: `Inventory contains conflicting DIDs for IMSI ${imsi}`
            });
            inventory.set(imsi, { imsi, did: '', enabled: false });
            continue;
        }

        inventory.set(imsi, { imsi, did, enabled });
    }

    return inventory;
}

function normalizeObservedDevices(devices) {
    const observed = new Map();

    for (const device of Array.isArray(devices) ? devices : []) {
        const name = normalizeSlotName(device && (device.ID || device.dongle_name));
        if (!name || !name.startsWith('dongle')) continue;
        observed.set(name, {
            name,
            imsi: normalizeIdentity(device && device.IMSI),
            imei: normalizeIdentity(device && device.IMEI),
            state: String((device && device.State) || '').trim(),
            number: String((device && device.Number) || '').trim()
        });
    }

    return observed;
}

function buildActionCollector() {
    const puts = new Map();
    const dels = new Map();

    function put(family, key, value) {
        if (!family || key === undefined || key === null || value === undefined || value === null || value === '') {
            return;
        }
        const actionKey = `${family}/${key}`;
        puts.set(actionKey, { family, key: String(key), value: String(value) });
        dels.delete(actionKey);
    }

    function del(family, key) {
        if (!family || key === undefined || key === null || key === '') return;
        const actionKey = `${family}/${key}`;
        puts.delete(actionKey);
        dels.set(actionKey, { family, key: String(key) });
    }

    return {
        put,
        del,
        result() {
            return {
                astdbWrites: Array.from(puts.values()),
                astdbDeletes: Array.from(dels.values())
            };
        }
    };
}

/**
 * Compute the desired dongle mapping state without performing I/O.
 *
 * Identity rules:
 * - A physical slot is identified by its dongle section name.
 * - A SIM is identified by IMSI. The SIM inventory is the source of truth for DID.
 * - IMEI is diagnostic only and never used to choose a DID.
 * - An unknown, missing, duplicate, or disabled SIM never inherits a slot's old DID.
 */
function resolveDongleMappingState({
    observedDevices = [],
    slotRows = [],
    inventory = [],
    configuredSlots = []
} = {}) {
    const alerts = [];
    const observed = normalizeObservedDevices(observedDevices);
    const inventoryByImsi = normalizeInventoryRows(inventory, alerts);

    const configured = new Set(
        (Array.isArray(configuredSlots) ? configuredSlots : Object.keys(configuredSlots || {}))
            .map(normalizeSlotName)
            .filter(name => name && name.startsWith('dongle'))
    );

    const previous = new Map();
    for (const row of Array.isArray(slotRows) ? slotRows : []) {
        const name = normalizeSlotName(row && row.dongle_name);
        if (!name || !name.startsWith('dongle')) continue;
        previous.set(name, row);
    }

    const activeSlots = new Set([...configured, ...observed.keys()]);
    const deleteSlots = [];
    for (const name of previous.keys()) {
        if (!activeSlots.has(name)) deleteSlots.push(name);
    }

    const slotNames = new Set([...activeSlots]);
    for (const name of previous.keys()) {
        if (activeSlots.has(name)) slotNames.add(name);
    }

    const imsiCounts = new Map();
    for (const device of observed.values()) {
        if (!device.imsi) continue;
        imsiCounts.set(device.imsi, (imsiCounts.get(device.imsi) || 0) + 1);
    }

    const duplicateImsis = new Set();
    for (const [imsi, count] of imsiCounts.entries()) {
        if (count <= 1) continue;
        duplicateImsis.add(imsi);
        alerts.push({
            type: 'duplicate_imsi',
            imsi,
            message: `IMSI ${imsi} is visible on ${count} dongle slots; refusing automatic DID assignment`
        });
    }

    const actions = buildActionCollector();
    const slots = [];
    const summary = {
        totalSlots: slotNames.size,
        observedSlots: observed.size,
        mappedSlots: 0,
        disabledSlots: 0,
        unknownSims: 0,
        missingSims: 0,
        duplicateSims: 0,
        alerts: 0
    };

    for (const name of Array.from(slotNames).sort()) {
        const prior = previous.get(name);
        const live = observed.get(name);
        const mappingOverride = normalizeMappingOverride(prior && prior.mapping_override);

        let imsi = live ? live.imsi : normalizeIdentity(prior && prior.imsi);
        let imei = live ? live.imei : normalizeIdentity(prior && prior.imei);
        let phoneNumber = '';
        let dynamicEnabled = false;
        let mappingState = 'absent';

        if (live) {
            if (!live.imsi) {
                imsi = '';
                phoneNumber = '';
                mappingState = 'missing_sim';
                summary.missingSims += 1;
                alerts.push({
                    type: 'missing_sim',
                    dongleName: name,
                    message: `${name} has no readable SIM/IMSI; DID mapping cleared`
                });
            } else if (duplicateImsis.has(live.imsi)) {
                phoneNumber = '';
                mappingState = 'duplicate_imsi';
                summary.duplicateSims += 1;
            } else {
                const inventoryEntry = inventoryByImsi.get(live.imsi);
                if (inventoryEntry && inventoryEntry.enabled && inventoryEntry.did) {
                    phoneNumber = inventoryEntry.did;
                    dynamicEnabled = mappingOverride === DEFAULT_MAPPING_OVERRIDE;
                    mappingState = dynamicEnabled ? 'mapped' : 'disabled';
                } else if (!inventoryEntry) {
                    const priorImsi = normalizeIdentity(prior && prior.imsi);
                    const priorDid = normalizeDid(prior && prior.phone_number);
                    if (priorImsi === live.imsi && priorDid) {
                        // Preserve a legacy same-slot mapping until the inventory is backfilled.
                        phoneNumber = priorDid;
                        dynamicEnabled = mappingOverride === DEFAULT_MAPPING_OVERRIDE;
                        mappingState = dynamicEnabled ? 'mapped_legacy' : 'disabled';
                    } else {
                        phoneNumber = '';
                        mappingState = 'unknown_imsi';
                        summary.unknownSims += 1;
                        alerts.push({
                            type: 'unknown_sim',
                            dongleName: name,
                            imsi: live.imsi,
                            message: `${name} has unknown IMSI ${live.imsi}; DID mapping cleared`
                        });
                    }
                } else {
                    phoneNumber = '';
                    mappingState = 'inventory_disabled';
                    summary.disabledSlots += 1;
                    alerts.push({
                        type: 'inventory_disabled',
                        dongleName: name,
                        imsi: live.imsi,
                        message: `${name} SIM inventory entry is disabled; DID mapping cleared`
                    });
                }
            }
        } else {
            phoneNumber = normalizeDid(prior && prior.phone_number);
            dynamicEnabled = false;
            mappingState = prior ? 'absent' : 'empty';
        }

        if (dynamicEnabled && phoneNumber) {
            summary.mappedSlots += 1;
        }

        slots.push({
            dongle_name: name,
            imsi: imsi || null,
            imei: imei || null,
            phone_number: phoneNumber || null,
            dynamic_enabled: dynamicEnabled ? 1 : 0,
            mapping_override: mappingOverride,
            mapping_state: mappingState
        });

        actions.put('DONGLE_SETTINGS', name, dynamicEnabled ? '1' : '0');

        if (live && live.imsi && !duplicateImsis.has(live.imsi)) {
            const inventoryEntry = inventoryByImsi.get(live.imsi);
            if (inventoryEntry && inventoryEntry.enabled && inventoryEntry.did) {
                actions.put('sim_map', live.imsi, inventoryEntry.did);
                actions.put('DONGLE_NUMBERS', live.imsi, inventoryEntry.did);
            }
        }

        if (dynamicEnabled && phoneNumber) {
            actions.put('dongle_map', name, phoneNumber);
        } else {
            actions.del('dongle_map', name);
        }
    }

    summary.alerts = alerts.length;
    const { astdbWrites, astdbDeletes } = actions.result();

    return {
        slots,
        deleteSlots,
        astdbWrites,
        astdbDeletes,
        alerts,
        summary
    };
}

module.exports = {
    resolveDongleMappingState,
    normalizeIdentity,
    normalizeDid,
    normalizeSlotName,
    normalizeMappingOverride
};
