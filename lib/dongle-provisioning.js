'use strict';

/**
 * Explicit dongle provisioning.
 *
 * chan_dongle can only see a modem when /etc/asterisk/dongle.conf has a section
 * for its IMEI. This module holds the pure pieces used by the root-only
 * "Add dongle" flow: read the configured sections, find a free slot, annotate
 * discovered modems, and append one section.
 *
 * Deliberately no timers and no automatic adoption: adding a modem reloads the
 * chan_dongle module for every dongle, so it must be an operator decision.
 */

const fs = require('fs');

const SECTION_RE = /^\[([^\]]+)\]/;
const SLOT_RE = /^dongle[0-9]+$/;
const IMEI_RE = /^[0-9]{15}$/;

/**
 * Accept a device node anywhere under /dev, including the nested
 * /dev/serial/by-path links, but never a traversal segment.
 */
function isValidDevicePath(value) {
    const text = String(value || '').trim();
    if (!text.startsWith('/dev/')) return false;
    const parts = text.slice('/dev/'.length).split('/');
    return parts.length > 0 && parts.every((part) => (
        part && part !== '.' && part !== '..' && /^[A-Za-z0-9._:-]+$/.test(part)
    ));
}

function clause(value) {
    // A value is written as a single unquoted token in dongle.conf; strip
    // anything that could open a new section or a comment.
    return String(value == null ? '' : value).replace(/[;\r\n\[\]]/g, '').trim();
}

function parseConfiguredState(configPath) {
    const content = fs.readFileSync(configPath, 'utf8');
    const sections = new Map();
    let current = null;
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        const section = trimmed.match(SECTION_RE);
        if (section) {
            current = section[1].trim().toLowerCase();
            if (!sections.has(current)) {
                sections.set(current, { name: current, imei: '', imsi: '', baud: '', audio: '', data: '', initstate: '' });
            }
            continue;
        }
        if (!current || !trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim().toLowerCase();
        const value = trimmed.slice(eq + 1).split(';')[0].trim();
        if (['imei', 'imsi', 'baud', 'audio', 'data', 'initstate'].includes(key)) sections.get(current)[key] = value;
    }
    return sections;
}

function findFreeSlot(sections) {
    for (let index = 0; index < 1000; index += 1) {
        const name = `dongle${index}`;
        if (!sections.has(name)) return name;
    }
    return null;
}

function freeSlots(sections, limit = 12) {
    const slots = [];
    for (let index = 0; index < 1000 && slots.length < limit; index += 1) {
        const name = `dongle${index}`;
        if (!sections.has(name)) slots.push(name);
    }
    return slots;
}

/** Annotate probe output with the slot that already owns the IMEI, if any. */
function annotateCandidates(candidates, sections) {
    const byImei = new Map();
    for (const section of sections.values()) {
        if (section.imei) byImei.set(section.imei, section);
    }
    return (Array.isArray(candidates) ? candidates : []).map(candidate => {
        const imei = String(candidate && candidate.imei || '').trim();
        const owner = byImei.get(imei) || null;
        return {
            imei,
            imsi: String(candidate && candidate.imsi || '').trim(),
            model: String(candidate && candidate.model || '').trim(),
            audioPort: String(candidate && candidate.audioPort || '').trim(),
            dataPort: String(candidate && candidate.dataPort || '').trim(),
            baud: Number(candidate && candidate.baud) || 0,
            simReady: Boolean(candidate && candidate.simReady),
            configured: Boolean(owner),
            slot: owner ? owner.name : null
        };
    });
}

function buildSectionBlock({ slot, imei, imsi, audioPort, dataPort, baud }) {
    // Canonical order, identical in every section the app writes.
    const lines = [`[${slot}]`, 'txgain=3', 'rxgain=3', `imei=${clause(imei)}`];
    if (imsi) lines.push(`imsi=${clause(imsi)}`);
    if (audioPort) lines.push(`audio=${clause(audioPort)}`);
    if (dataPort) lines.push(`data=${clause(dataPort)}`);
    if (Number(baud) === 57600) lines.push('baud=57600');
    return lines.join('\n');
}

/**
 * Validate an add request against the current config.
 * \return {{ok: true, section: string} | {ok: false, error: string}}
 */
function validateAddRequest({ slot, imei, imsi, audioPort, dataPort, baud }, sections) {
    const imeiValue = String(imei || '').trim();
    if (!IMEI_RE.test(imeiValue)) {
        return { ok: false, error: 'IMEI must be exactly 15 digits.' };
    }
    for (const section of sections.values()) {
        if (section.imei === imeiValue) {
            return { ok: false, error: `This IMEI is already configured as ${section.name}.` };
        }
    }
    const slotValue = String(slot || '').trim().toLowerCase() || findFreeSlot(sections);
    if (!slotValue || !SLOT_RE.test(slotValue)) {
        return { ok: false, error: 'Slot must look like dongle0, dongle1, …' };
    }
    if (sections.has(slotValue)) {
        return { ok: false, error: `${slotValue} already exists in dongle.conf.` };
    }
    for (const port of [audioPort, dataPort]) {
        const value = String(port || '').trim();
        if (value && !isValidDevicePath(value)) {
            return { ok: false, error: `Invalid serial port: ${value}` };
        }
    }
    return {
        ok: true,
        section: buildSectionBlock({
            slot: slotValue,
            imei: imeiValue,
            imsi: String(imsi || '').trim(),
            audioPort: String(audioPort || '').trim(),
            dataPort: String(dataPort || '').trim(),
            baud
        }),
        slot: slotValue
    };
}

/** Remove a whole [slot] section. Backup first; atomic replace. */
function removeSection(configPath, slotName) {
    const name = String(slotName || '').trim().toLowerCase();
    if (!SLOT_RE.test(name)) return { removed: false, backup: null };
    const original = fs.readFileSync(configPath, 'utf8');
    const lines = original.split('\n');
    const kept = [];
    let skip = false;
    let removed = false;
    for (const line of lines) {
        const section = line.trim().match(SECTION_RE);
        if (section) skip = section[1].trim().toLowerCase() === name;
        if (skip) { removed = true; continue; }
        kept.push(line);
    }
    if (!removed) return { removed: false, backup: null };
    const backup = `${configPath}.bak-remove-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
    fs.copyFileSync(configPath, backup);
    const tmp = `${configPath}.tmp-remove-${process.pid}-${Date.now()}`;
    const text = `${kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, configPath);
    return { removed: true, backup };
}

/** Append a validated section, keeping a timestamped backup first. */
function appendSection(configPath, block) {
    const backup = `${configPath}.bak-provision-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
    fs.copyFileSync(configPath, backup);
    const existing = fs.readFileSync(configPath, 'utf8');
    const prefix = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.appendFileSync(configPath, `${prefix}${block}\n`);
    return backup;
}


const UPDATABLE_KEYS = ['txgain', 'rxgain', 'audio', 'data', 'imei', 'imsi', 'baud', 'initstate', 'context'];

function sanitizeValue(value) {
    return String(value == null ? '' : value).replace(/[\r\n;\[\]]/g, '').trim();
}

function sectionRange(lines, slotName) {
    let start = -1;
    let end = lines.length;
    for (let index = 0; index < lines.length; index += 1) {
        const header = lines[index].trim().match(SECTION_RE);
        if (!header) continue;
        if (start < 0) {
            if (header[1].trim().toLowerCase() === slotName) start = index;
        } else {
            end = index;
            break;
        }
    }
    return { start, end };
}

/**
 * Single writer for /etc/asterisk/dongle.conf.
 *
 * Updates only the named slot: replaces the value of any provided key, appends
 * keys the section is missing, and removes a key only when its value is null.
 * Every other line (including comments and the other sections) is preserved.
 * Writes are backup-then-rename so a failed write cannot truncate the file.
 *
 * \param fields {{imei?,imsi?,audio?,data?,baud?,rxgain?,txgain?}} undefined = leave alone,
 *        null = delete the key, '' = ignore
 * \param options.requireExisting default true; pass false to append a new section
 */
function upsertSection(configPath, slot, fields = {}, options = {}) {
    const slotName = String(slot || '').trim().toLowerCase();
    if (!SLOT_RE.test(slotName)) {
        throw new Error('Slot must look like dongle0, dongle1, …');
    }
    const requireExisting = options.requireExisting !== false;

    const changes = new Map();
    for (const key of UPDATABLE_KEYS) {
        if (!(key in fields)) continue;
        if (fields[key] === null) {
            changes.set(key, null);
            continue;
        }
        const value = sanitizeValue(fields[key]);
        if (!value) continue;
        if ((key === 'audio' || key === 'data') && !isValidDevicePath(value)) {
            throw new Error(`Invalid serial port for ${key}: ${value}`);
        }
        if (key === 'imei' && !IMEI_RE.test(value)) {
            throw new Error('IMEI must be exactly 15 digits.');
        }
        changes.set(key, value);
    }

    const stat = fs.statSync(configPath);
    const original = fs.readFileSync(configPath, 'utf8');
    let lines = original.split('\n');
    let { start, end } = sectionRange(lines, slotName);

    if (start < 0) {
        if (requireExisting) {
            throw new Error(`Section [${slotName}] not found in ${configPath}`);
        }
        const block = buildSectionBlock({
            slot: slotName,
            imei: changes.get('imei') || '',
            imsi: changes.get('imsi') || '',
            audioPort: changes.get('audio') || '',
            dataPort: changes.get('data') || ''
        }).split('\n');
        if (changes.has('txgain') || changes.has('rxgain')) {
            // buildSectionBlock already emits txgain/rxgain=3; override below.
        }
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        lines = lines.concat([''], block, ['']);
        start = lines.length - block.length - 2;
        end = lines.length - 1;
    }

    // Collect the section's existing key lines.
    for (const [key, value] of changes) {
        const pattern = new RegExp(`^\\s*${key}\\s*=`, 'i');
        let found = false;
        for (let index = start + 1; index < end; index += 1) {
            if (!pattern.test(lines[index])) continue;
            if (value === null) {
                lines.splice(index, 1);
                end -= 1;
            } else {
                lines[index] = `${key}=${value}`;
            }
            found = true;
            break;
        }
        if (found || value === null) continue;
        let insertAt = end;
        while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
        lines.splice(insertAt, 0, `${key}=${value}`);
        end += 1;
    }

    const next = lines.join('\n');
    if (next !== original) {
        const backup = `${configPath}.bak-upsert-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
        fs.copyFileSync(configPath, backup);
        const tmp = `${configPath}.tmp-${process.pid}`;
        const tmpFd = fs.openSync(tmp, 'w', stat.mode & 0o777);
        try {
            fs.writeFileSync(tmpFd, next);
            fs.fsyncSync(tmpFd);
        } finally {
            fs.closeSync(tmpFd);
        }
        fs.renameSync(tmp, configPath);
        return { slot: slotName, changed: [...changes.keys()], backup };
    }
    return { slot: slotName, changed: [], backup: null };
}


/**
 * Plan one adoption pass. Identity is the key: an IMEI that already owns a
 * section is refreshed in place, a new IMEI takes a vacancy first (a section
 * whose hardware is gone) and otherwise the lowest free slot, and a modem with
 * no valid IMEI is ignored (a section without identity can never bind).
 * Pure: no file or device access, so it is unit-testable.
 *
 * options.vacantSlots: slot names whose configured modem is not on the bus.
 * They are reused in order, keeping the slot numbering dense.
 */
function planAdoption(candidates, sections, options = {}) {
    const vacant = (Array.isArray(options.vacantSlots) ? options.vacantSlots : [])
        .filter(name => sections.has(name));
    const byImei = new Map();
    for (const section of sections.values()) {
        if (section.imei) byImei.set(section.imei, section);
    }
    const used = new Set();
    const ops = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const imei = String(candidate && candidate.imei || '').trim();
        if (!IMEI_RE.test(imei)) continue;
        const owner = byImei.get(imei);
        if (owner) {
            ops.push({
                kind: 'refresh',
                slot: owner.name,
                imei,
                imsi: String(candidate.imsi || '').trim()
            });
            continue;
        }
        let slot = null;
        let kind = 'reclaim';
        // A vacant slot is already a section name, so it is peeled out of the
        // vacancy list instead of being looked up among the free names.
        while (vacant.length) {
            const candidateSlot = vacant.shift();
            if (used.has(candidateSlot)) continue;
            used.add(candidateSlot);
            slot = candidateSlot;
            kind = 'reclaim';
            break;
        }
        if (!slot) {
            // Slot creation is manual only: a new modem never grows the config.
            // Without a vacant/empty slot it is reported blocked for the operator.
            ops.push({ kind: 'blocked', imei, imsi: String(candidate.imsi || '').trim() });
            continue;
        }
        used.add(slot);
        ops.push({
            kind,
            slot,
            imei,
            imsi: String(candidate.imsi || '').trim(),
            audioPort: String(candidate.audioPort || '').trim(),
            dataPort: String(candidate.dataPort || '').trim()
        });
    }
    return ops;
}

/**
 * Validate an in-place refresh of an existing slot. The slot must exist and
 * must already own this IMEI (or be empty), so a pass can never retarget a
 * section to different hardware.
 */
function validateRefreshRequest({ slot, imei, imsi }, sections) {
    const slotName = String(slot || '').trim().toLowerCase();
    const imeiValue = String(imei || '').trim();
    if (!SLOT_RE.test(slotName)) return { ok: false, error: 'Invalid slot name.' };
    if (!IMEI_RE.test(imeiValue)) return { ok: false, error: 'IMEI must be exactly 15 digits.' };
    const section = sections.get(slotName);
    if (!section) return { ok: false, error: `Section [${slotName}] does not exist.` };
    if (section.imei && section.imei !== imeiValue) {
        return { ok: false, error: `${slotName} already belongs to IMEI ${section.imei}.` };
    }
    for (const other of sections.values()) {
        if (other.name !== slotName && other.imei === imeiValue) {
            return { ok: false, error: `This IMEI is already configured as ${other.name}.` };
        }
    }
    const fields = {};
    const imsiValue = String(imsi || '').trim();
    if (imsiValue && imsiValue !== section.imsi) fields.imsi = imsiValue;
    return { ok: true, slot: slotName, fields };
}

/**
 * Add and/or remove empty sections in one durable commit: a single backup,
 * one fsync'd temp file and one rename, so a batch can never half-apply.
 * Section order and every unrelated line are preserved.
 */
function updateEmptySlots(configPath, { add = [], remove = [] } = {}) {
    const additions = (Array.isArray(add) ? add : []).map(name => String(name || '').trim().toLowerCase());
    const removals = (Array.isArray(remove) ? remove : []).map(name => String(name || '').trim().toLowerCase());
    if (additions.some(name => !SLOT_RE.test(name)) || removals.some(name => !SLOT_RE.test(name))) {
        throw new Error('Slot must look like dongle0, dongle1, …');
    }
    if (new Set(additions).size !== additions.length || new Set(removals).size !== removals.length) {
        throw new Error('Duplicate slot name in batch.');
    }
    const overlap = additions.filter(name => removals.includes(name));
    if (overlap.length) throw new Error(`Cannot add and remove ${overlap.join(', ')} in one batch.`);

    const stat = fs.statSync(configPath);
    const original = fs.readFileSync(configPath, 'utf8');
    const removeSet = new Set(removals);
    const kept = [];
    const present = new Set();
    let skip = false;
    for (const line of original.split('\n')) {
        const section = line.trim().match(SECTION_RE);
        if (section) {
            const name = section[1].trim().toLowerCase();
            if (SLOT_RE.test(name)) present.add(name);
            skip = removeSet.has(name);
        }
        if (!skip) kept.push(line);
    }
    const missing = removals.filter(name => !present.has(name));
    if (missing.length) throw new Error(`Section not found: ${missing.join(', ')}`);

    let next = kept.join('\n').replace(/\s+$/, '');
    if (additions.length) {
        next += additions.map(name => `\n\n[${name}]\ntxgain=3\nrxgain=3\nimei=`).join('');
    }
    next = `${next.replace(/\n{3,}/g, '\n\n').trim()}\n`;
    if (next === original) return { backup: null, added: [], removed: [] };

    const backup = `${configPath}.bak-slots-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
    fs.copyFileSync(configPath, backup);
    const tmp = `${configPath}.tmp-slots-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, next, { mode: stat.mode & 0o7777 });
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chownSync(tmp, stat.uid, stat.gid);
    fs.chmodSync(tmp, stat.mode & 0o7777);
    fs.renameSync(tmp, configPath);
    return { backup, added: additions, removed: removals };
}

module.exports = {
    parseConfiguredState,
    findFreeSlot,
    freeSlots,
    annotateCandidates,
    buildSectionBlock,
    validateAddRequest,
    appendSection,
    upsertSection,
    planAdoption,
    validateRefreshRequest,
    removeSection,
    updateEmptySlots
};
