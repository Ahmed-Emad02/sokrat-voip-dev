'use strict';

// Asterisk IDs are local to a PBX. Only the explicit federation marker can
// identify an anchor on another PBX; its linked legs are again site-local.
const GLOBAL_ID_SQL = `CASE WHEN LEFT(BINARY c.userfield, 11) = 'SOKRAT_FED:'
    THEN SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING(c.userfield, 12), '|', 1), ':', 1) END`;

function recordingScopeSql({ accountcode, extensions } = {}) {
    const tenant = accountcode ? { sql: ' AND c.accountcode = ?', params: [accountcode] } : { sql: '', params: [] };
    if (!extensions?.length) return tenant;
    const pattern = extensions.map(ext => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return {
        sql: `${tenant.sql} AND (c.src IN (?) OR c.dst IN (?) OR c.cnum IN (?)
            OR c.channel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)')
            OR c.dstchannel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)'))`,
        params: [...tenant.params, extensions, extensions, extensions, pattern, pattern]
    };
}

function ref(row) {
    const sequence = Number(row.sequence ?? 0);
    return row.uniqueid && Number.isSafeInteger(sequence) ? { uniqueid: row.uniqueid, sequence } : null;
}

function idsOf(row) {
    return [row.linkedid, row.uniqueid].filter(Boolean);
}

async function lookupSiteRecordings(pool, table, requests, scope) {
    const scoped = recordingScopeSql(scope);
    const globals = [...new Set(requests.map(r => r.global_call_id).filter(Boolean))];
    const anchors = new Map();
    if (globals.length) {
        const [rows] = await pool.query(`SELECT c.uniqueid, c.linkedid, ${GLOBAL_ID_SQL} AS global_call_id
            FROM ${table} c WHERE BINARY (${GLOBAL_ID_SQL}) IN (?)${scoped.sql}`, [globals, ...scoped.params]);
        for (const row of rows) {
            if (!anchors.has(row.global_call_id)) anchors.set(row.global_call_id, new Set());
            for (const id of idsOf(row)) anchors.get(row.global_call_id).add(id);
        }
    }
    const ids = [...new Set(requests.flatMap(idsOf).concat([...anchors.values()].flatMap(group => [...group])))];
    if (!ids.length) return requests.map(() => null);
    const [rows] = await pool.query(`SELECT c.uniqueid, c.linkedid, c.sequence
        FROM ${table} c WHERE (c.uniqueid IN (?) OR c.linkedid IN (?))
          AND TRIM(c.recordingfile) <> ''${scoped.sql}
        ORDER BY c.billsec DESC, c.calldate DESC, c.sequence DESC`, [ids, ids, ...scoped.params]);
    const byId = new Map();
    for (const [rank, row] of rows.entries()) {
        const recording = ref(row);
        if (!recording) continue;
        for (const id of idsOf(row)) {
            if (!byId.has(id)) byId.set(id, { recording, rank });
        }
    }
    return requests.map(row => {
        // For a same-site row, prefer its linked group then its own uniqueid.
        for (const id of idsOf(row)) {
            const match = byId.get(id);
            if (match) return match.recording;
        }
        let best;
        for (const id of anchors.get(row.global_call_id) || []) {
            const match = byId.get(id);
            if (match && (!best || match.rank < best.rank)) best = match;
        }
        return best?.recording || null;
    });
}

async function attachHistoryRecordings(rows, sites, localSite, lookup) {
    const pending = [];
    for (const row of rows) {
        const site = String(row.node_site_code ?? localSite);
        if (row.disposition !== 'ANSWERED' || !sites.includes(site)) continue;
        const direct = row.recordingfile?.trim() && ref(row);
        if (direct) {
            row.recording = { ...direct, site };
        } else {
            pending.push({ row, site });
        }
    }
    // Resolve on the displayed PBX first; a counterpart must not override it.
    const search = async (site, counterpart) => {
        const requests = pending.filter(entry => !entry.row.recording && (counterpart
            ? entry.site !== site && entry.row.global_call_id
            : entry.site === site && idsOf(entry.row).length));
        if (!requests.length) return [];
        const keys = requests.map(({ row }) => counterpart
            ? { global_call_id: row.global_call_id }
            : { uniqueid: row.uniqueid, linkedid: row.linkedid });
        const results = await lookup(site, keys);
        return requests.map(({ row }, i) => {
            const recording = results[i] && ref(results[i]);
            return { row, recording: recording && { ...recording, site } };
        });
    };
    for (const counterpart of [false, true]) {
        const matches = await Promise.all(sites.map(site => search(site, counterpart)));
        for (const { row, recording } of matches.flat()) {
            if (recording && !row.recording) row.recording = recording;
        }
    }
}

function historyRecordingUrl({ site, uniqueid, sequence }) {
    return `/audio/${encodeURIComponent(uniqueid)}?${new URLSearchParams({ site, sequence })}`;
}

module.exports = { attachHistoryRecordings, historyRecordingUrl, lookupSiteRecordings, recordingScopeSql };
