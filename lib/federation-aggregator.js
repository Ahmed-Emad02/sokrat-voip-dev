'use strict';

/**
 * Federation aggregation layer.
 *
 * Polls a peer's `/live` and `/inventory` endpoints over the signed client and
 * materializes the results into the local read-model tables. Keeping this out
 * of the hub lets the hub focus on scheduling and Socket.IO emission.
 */

const { federationGet } = require('./federation-client');

function normalizeActiveCalls(value) {
    if (!value) return {};
    if (!Array.isArray(value)) return value;
    const map = {};
    for (const call of value) {
        if (!call) continue;
        const ext = call.extension || call.exten || call.src;
        if (ext) map[String(ext)] = call;
    }
    return map;
}

function parseSignalPct(value) {
    if (value === null || value === undefined) return null;
    const match = String(value).match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const n = Number(match[0]);
    if (!Number.isFinite(n)) return null;
    // chan_dongle reports RSSI on a 0-31 index; some firmwares report dBm or
    // an already-normalized percentage.
    if (n < 0) return Math.max(0, Math.min(100, Math.round(((n + 113) / 62) * 100)));
    if (n <= 31) return Math.round((n / 31) * 100);
    return Math.max(0, Math.min(100, Math.round(n)));
}

function str(value, maxLength) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text || text === 'Unknown' || text === 'N/A' || text === '-') return null;
    return maxLength ? text.slice(0, maxLength) : text;
}

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Accept both the v1 envelope and the legacy flat shape. */
function unwrapPayload(response) {
    if (!response || typeof response !== 'object') return {};
    if (response.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
        return { ...response.data, _meta: response };
    }
    return response;
}

function normalizeLivePayload(response) {
    const body = unwrapPayload(response);
    const meta = body._meta || response || {};
    return {
        success: body.success !== false,
        apiVersion: numberOrNull(meta.api_version ?? body.api_version) || 1,
        node: body.node || meta.node || {},
        serverTime: body.server_time || meta.server_time || null,
        extensions: Array.isArray(body.extensions) ? body.extensions : [],
        peerStatus: body.peerStatus && typeof body.peerStatus === 'object' ? body.peerStatus : {},
        peerIPs: body.peerIPs && typeof body.peerIPs === 'object' ? body.peerIPs : {},
        activeCalls: normalizeActiveCalls(body.activeCalls),
        dongles: Array.isArray(body.dongles) ? body.dongles : [],
        metrics: body.metrics && typeof body.metrics === 'object' ? body.metrics : {}
    };
}

function normalizeInventoryPayload(response) {
    const body = unwrapPayload(response);
    const meta = body._meta || response || {};
    return {
        success: body.success !== false,
        apiVersion: numberOrNull(meta.api_version ?? body.api_version) || 1,
        node: body.node || meta.node || {},
        extensions: Array.isArray(body.extensions) ? body.extensions : [],
        dongles: Array.isArray(body.dongles) ? body.dongles : [],
        counts: body.counts && typeof body.counts === 'object' ? body.counts : {
            queues: numberOrNull(body.queues) || 0,
            ringgroups: numberOrNull(body.ringgroups) || 0,
            trunks: numberOrNull(body.trunks) || 0,
            ivr: numberOrNull(body.ivr) || 0
        }
    };
}

/**
 * Normalize the address-book payload returned by a peer. Contacts live in a
 * per-node SQLite file, so `id` is only unique inside that node; the caller
 * scopes it with the peer id.
 */
function normalizeContactsPayload(response) {
    const body = unwrapPayload(response);
    const meta = body._meta || response || {};
    const contacts = (Array.isArray(body.contacts) ? body.contacts : [])
        .filter(contact => contact && typeof contact === 'object')
        .map(contact => ({
            sourceId: str(contact.id ?? contact.source_id ?? contact.telefono ?? contact.phone, 64),
            name: str(contact.name ?? contact.first_name, 150) || '',
            lastName: str(contact.last_name, 150) || '',
            phone: str(contact.telefono ?? contact.phone, 50) || ''
        }))
        .filter(contact => contact.sourceId && contact.phone);
    return {
        success: body.success !== false,
        apiVersion: numberOrNull(meta.api_version ?? body.api_version) || 1,
        node: body.node || meta.node || {},
        contacts
    };
}

async function setSyncState(pool, peerId, resource, patch = {}) {
    if (!pool || !peerId) return;
    const status = patch.status || 'idle';
    const now = new Date();
    const okAt = status === 'ok' ? now : null;
    const rows = Number.isFinite(Number(patch.rows)) ? Number(patch.rows) : 0;
    try {
        await pool.query(`
            INSERT INTO \`asterisk\`.\`sokrat_federation_sync_state\`
                (peer_id, resource, status, last_sync_at, last_success_at, cursor_value, rows_synced, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                status = VALUES(status),
                last_sync_at = VALUES(last_sync_at),
                last_success_at = COALESCE(VALUES(last_success_at), last_success_at),
                cursor_value = COALESCE(VALUES(cursor_value), cursor_value),
                rows_synced = VALUES(rows_synced),
                last_error = VALUES(last_error)
        `, [
            peerId,
            String(resource || 'live').slice(0, 32),
            status,
            now,
            okAt,
            patch.cursor ? String(patch.cursor).slice(0, 255) : null,
            rows,
            patch.error ? String(patch.error).slice(0, 500) : null
        ]);
    } catch (_) {
        // Sync-state bookkeeping must never break the data plane.
    }
}

async function upsertNodeStatus(pool, peer, payload = {}) {
    if (!pool || !peer || !peer.id) return;
    const metrics = payload.metrics || {};
    const node = payload.node || {};
    const status = payload.status || 'online';
    const peersStatus = status === 'degraded' ? 'online' : status;
    try {
        await pool.query(`
            INSERT INTO \`asterisk\`.\`sokrat_federation_node_status\`
                (peer_id, status, last_seen_at, last_error, latency_ms, api_version, node_version,
                 asterisk_version, uptime_sec, load1, disk_pct, extensions_total, extensions_online,
                 dongles_total, dongles_free, active_calls, calls_today)
            VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                status = VALUES(status),
                last_seen_at = NOW(),
                last_error = VALUES(last_error),
                latency_ms = VALUES(latency_ms),
                api_version = COALESCE(VALUES(api_version), api_version),
                node_version = COALESCE(VALUES(node_version), node_version),
                asterisk_version = COALESCE(VALUES(asterisk_version), asterisk_version),
                uptime_sec = COALESCE(VALUES(uptime_sec), uptime_sec),
                load1 = COALESCE(VALUES(load1), load1),
                disk_pct = COALESCE(VALUES(disk_pct), disk_pct),
                extensions_total = VALUES(extensions_total),
                extensions_online = VALUES(extensions_online),
                dongles_total = VALUES(dongles_total),
                dongles_free = VALUES(dongles_free),
                active_calls = VALUES(active_calls),
                calls_today = VALUES(calls_today)
        `, [
            peer.id,
            status,
            payload.error ? String(payload.error).slice(0, 255) : null,
            numberOrNull(payload.latencyMs),
            numberOrNull(payload.apiVersion) || 1,
            str(node.version || payload.nodeVersion, 50),
            str(metrics.asterisk_version || metrics.asteriskVersion, 64),
            numberOrNull(metrics.uptime_sec ?? metrics.uptimeSec),
            numberOrNull(metrics.load1),
            numberOrNull(metrics.disk_pct ?? metrics.diskPct),
            numberOrNull(metrics.extensions_total ?? payload.extensionsTotal) || 0,
            numberOrNull(metrics.extensions_online ?? payload.extensionsOnline) || 0,
            numberOrNull(metrics.dongles_total ?? payload.donglesTotal) || 0,
            numberOrNull(metrics.dongles_free ?? payload.donglesFree) || 0,
            numberOrNull(metrics.active_calls ?? payload.activeCalls) || 0,
            numberOrNull(metrics.calls_today ?? payload.callsToday) || 0
        ]);
    } catch (_) {}
    try {
        await pool.query(
            'UPDATE `asterisk`.`sokrat_federation_peers` SET status = ?, last_sync_at = NOW() WHERE id = ?',
            [peersStatus, peer.id]
        );
    } catch (_) {}
}

async function markPeerOffline(pool, peer, message) {
    if (!pool || !peer || !peer.id) return;
    const error = message ? String(message).slice(0, 255) : 'peer unreachable';
    try {
        await pool.query(`
            INSERT INTO \`asterisk\`.\`sokrat_federation_node_status\`
                (peer_id, status, last_error)
            VALUES (?, 'offline', ?)
            ON DUPLICATE KEY UPDATE status = 'offline', last_error = VALUES(last_error)
        `, [peer.id, error]);
    } catch (_) {}
    try {
        await pool.query('UPDATE `asterisk`.`sokrat_federation_peers` SET status = \'offline\' WHERE id = ?', [peer.id]);
    } catch (_) {}
}

/**
 * Fetch and persist live presence for one peer.
 */
async function syncPeerLive(pool, peer, options = {}) {
    const started = Date.now();
    await setSyncState(pool, peer.id, 'live', { status: 'syncing' });
    try {
        const response = await federationGet(peer, '/api/federation/v1/live', {
            localSiteCode: options.localSiteCode || '10',
            decryptFn: options.decryptFn,
            timeout: options.timeout || 3000
        });
        const payload = normalizeLivePayload(response);
        const latencyMs = Date.now() - started;
        await upsertNodeStatus(pool, peer, {
            status: payload.success ? 'online' : 'degraded',
            latencyMs,
            apiVersion: payload.apiVersion,
            node: payload.node,
            metrics: payload.metrics,
            extensionsTotal: payload.extensions.length,
            extensionsOnline: payload.extensions.filter(e => e && (e.status === 'online' || e.status === 'ringing' || e.status === 'in_call')).length,
            donglesTotal: payload.dongles.length,
            donglesFree: payload.dongles.filter(d => d && /free|ready|available/i.test(String(d.state || d.status || ''))).length,
            activeCalls: Object.keys(payload.activeCalls || {}).length
        });
        await setSyncState(pool, peer.id, 'live', { status: 'ok', rows: payload.extensions.length });
        return { ...payload, latencyMs };
    } catch (err) {
        await markPeerOffline(pool, peer, err.message);
        await setSyncState(pool, peer.id, 'live', { status: 'error', error: err.message });
        throw err;
    }
}

async function replaceRemoteExtensions(pool, peerId, extensions, siteCode) {
    const rows = (extensions || [])
        .filter(ext => ext && ext.extension !== undefined && ext.extension !== null)
        .map(ext => ({
            native: String(ext.extension).slice(0, 20),
            alias: str(`${siteCode}${ext.extension}`, 30),
            name: str(ext.name || ext.display_name || ext.extension, 100) || String(ext.extension),
            emp_group: ext.emp_group ? str(ext.emp_group, 100) : null,
            status: ['online', 'offline', 'ringing', 'in_call', 'unknown'].includes(String(ext.status))
                ? String(ext.status)
                : 'offline'
        }));

    const run = async (query) => {
        await query('DELETE FROM `asterisk`.`sokrat_federation_remote_extensions` WHERE peer_id = ?', [peerId]);
        for (const row of rows) {
            await query(`
                INSERT INTO \`asterisk\`.\`sokrat_federation_remote_extensions\`
                    (peer_id, native_extension, dial_alias, display_name, status, emp_group, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), status = VALUES(status), emp_group = VALUES(emp_group), last_seen_at = NOW()
            `, [peerId, row.native, row.alias, row.name, row.status, row.emp_group]);
        }
    };

    if (typeof pool.getConnection === 'function') {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await run(conn.query.bind(conn));
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            conn.release();
        }
    } else {
        await run(pool.query.bind(pool));
    }
    return rows.length;
}

async function replaceRemoteDongles(pool, peerId, dongles) {
    const rows = (dongles || [])
        .filter(d => d && d.dongle_name)
        .map(d => ({
            name: String(d.dongle_name).slice(0, 50),
            phone: str(d.phone_number || d.sim_number || d.number, 50),
            simNumber: str(d.sim_number || d.phone_number || d.number, 32),
            provider: str(d.provider || d.operator_name, 50),
            operator: str(d.operator_name || d.provider, 64),
            status: str(d.status || d.state, 50) || 'Unknown',
            state: str(d.state, 32),
            signal: parseSignalPct(d.signal_pct ?? d.signal ?? d.rssi),
            imsi: str(d.imsi, 32),
            imei: str(d.imei, 32),
            activeCall: str(d.active_call, 128)
        }));

    const run = async (query) => {
        await query('DELETE FROM `asterisk`.`sokrat_federation_remote_dongles` WHERE peer_id = ?', [peerId]);
        for (const row of rows) {
            await query(`
                INSERT INTO \`asterisk\`.\`sokrat_federation_remote_dongles\`
                    (peer_id, dongle_name, phone_number, provider, status, state, signal_pct,
                     operator_name, imsi, imei, sim_number, active_call, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    phone_number = VALUES(phone_number),
                    provider = VALUES(provider),
                    status = VALUES(status),
                    state = VALUES(state),
                    signal_pct = VALUES(signal_pct),
                    operator_name = VALUES(operator_name),
                    imsi = VALUES(imsi),
                    imei = VALUES(imei),
                    sim_number = VALUES(sim_number),
                    active_call = VALUES(active_call),
                    last_seen_at = NOW()
            `, [
                peerId, row.name, row.phone, row.provider, row.status, row.state, row.signal,
                row.operator, row.imsi, row.imei, row.simNumber, row.activeCall
            ]);
        }
    };

    if (typeof pool.getConnection === 'function') {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await run(conn.query.bind(conn));
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            conn.release();
        }
    } else {
        await run(pool.query.bind(pool));
    }
    return rows.length;
}

/**
 * Replace the cached address book for one peer. The peer sends the full list,
 * so a successful sync also propagates deletions.
 */
async function replaceRemoteContacts(pool, peerId, contacts) {
    const rows = (contacts || [])
        .filter(contact => contact && contact.sourceId && contact.phone)
        .map(contact => ({
            sourceId: String(contact.sourceId).slice(0, 64),
            name: String(contact.name || '').slice(0, 150),
            lastName: String(contact.lastName || '').slice(0, 150),
            phone: String(contact.phone).slice(0, 50)
        }));

    const run = async (query) => {
        await query('DELETE FROM `asterisk`.`sokrat_federation_remote_contacts` WHERE peer_id = ?', [peerId]);
        for (const row of rows) {
            await query(`
                INSERT INTO \`asterisk\`.\`sokrat_federation_remote_contacts\`
                    (peer_id, source_id, name, last_name, telefono, synced_at)
                VALUES (?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    name = VALUES(name),
                    last_name = VALUES(last_name),
                    telefono = VALUES(telefono),
                    synced_at = NOW()
            `, [peerId, row.sourceId, row.name, row.lastName, row.phone]);
        }
    };

    if (typeof pool.getConnection === 'function') {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await run(conn.query.bind(conn));
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) {}
            throw err;
        } finally {
            conn.release();
        }
    } else {
        await run(pool.query.bind(pool));
    }
    return rows.length;
}

/**
 * Fetch and persist inventory (extensions, dongles) for one peer.
 */
async function syncPeerInventory(pool, peer, options = {}) {
    await setSyncState(pool, peer.id, 'inventory', { status: 'syncing' });
    try {
        const response = await federationGet(peer, '/api/federation/v1/inventory', {
            localSiteCode: options.localSiteCode || '10',
            decryptFn: options.decryptFn,
            timeout: options.timeout || 5000
        });
        const payload = normalizeInventoryPayload(response);
        const siteCode = String(peer.site_code || payload.node.site_code || '');
        const extCount = await replaceRemoteExtensions(pool, peer.id, payload.extensions, siteCode);
        const dongleCount = await replaceRemoteDongles(pool, peer.id, payload.dongles);
        await setSyncState(pool, peer.id, 'inventory', {
            status: 'ok',
            rows: extCount + dongleCount,
            cursor: payload.node.uuid || null
        });
        return { ...payload, extensionsCount: extCount, donglesCount: dongleCount };
    } catch (err) {
        await setSyncState(pool, peer.id, 'inventory', { status: 'error', error: err.message });
        throw err;
    }
}

/**
 * Fetch and persist the peer address book for one peer.
 */
async function syncPeerContacts(pool, peer, options = {}) {
    await setSyncState(pool, peer.id, 'contacts', { status: 'syncing' });
    try {
        const response = await federationGet(peer, '/api/federation/v1/contacts', {
            localSiteCode: options.localSiteCode || '10',
            decryptFn: options.decryptFn,
            timeout: options.timeout || 5000
        });
        const payload = normalizeContactsPayload(response);
        const count = await replaceRemoteContacts(pool, peer.id, payload.contacts);
        await setSyncState(pool, peer.id, 'contacts', {
            status: 'ok',
            rows: count,
            cursor: payload.node.uuid || null
        });
        return { ...payload, contactsCount: count };
    } catch (err) {
        await setSyncState(pool, peer.id, 'contacts', { status: 'error', error: err.message });
        throw err;
    }
}

const CDR_BACKFILL_DAYS = Math.max(1, parseInt(process.env.SOKRAT_FEDERATION_CDR_BACKFILL_DAYS, 10) || 30);
const CDR_OVERLAP_MINUTES = 15;
const CDR_BATCH_LIMIT = 1000;
const CDR_MAX_BATCHES_PER_CYCLE = 5;

function toMysqlDateTime(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function getCdrCursor(pool, peerId) {
    try {
        const [rows] = await pool.query(
            'SELECT cursor_value FROM `asterisk`.`sokrat_federation_sync_state` WHERE peer_id = ? AND resource = ?',
            [peerId, 'cdr']
        );
        return rows && rows[0] ? rows[0].cursor_value : null;
    } catch (_) {
        return null;
    }
}

async function upsertRemoteCdr(pool, peerId, rows) {
    let written = 0;
    for (const row of rows) {
        if (!row || !row.uniqueid) continue;
        try {
            await pool.query(`
                INSERT INTO \`asteriskcdrdb\`.\`sokrat_federation_remote_cdr\`
                    (peer_id, uniqueid, linkedid, global_call_id, calldate, clid, src, dst, dcontext,
                     channel, dstchannel, lastapp, lastdata, duration, billsec, disposition, amaflags,
                     accountcode, userfield, did, recordingfile, cnum, cnam, outbound_cnum, outbound_cnam,
                     dst_cnam, peeraccount, sequence, direction, call_scope, fed_leg, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    linkedid = VALUES(linkedid),
                    global_call_id = VALUES(global_call_id),
                    calldate = VALUES(calldate),
                    clid = VALUES(clid),
                    src = VALUES(src),
                    dst = VALUES(dst),
                    dcontext = VALUES(dcontext),
                    channel = VALUES(channel),
                    dstchannel = VALUES(dstchannel),
                    lastapp = VALUES(lastapp),
                    lastdata = VALUES(lastdata),
                    duration = VALUES(duration),
                    billsec = VALUES(billsec),
                    disposition = VALUES(disposition),
                    amaflags = VALUES(amaflags),
                    accountcode = VALUES(accountcode),
                    userfield = VALUES(userfield),
                    did = VALUES(did),
                    recordingfile = VALUES(recordingfile),
                    cnum = VALUES(cnum),
                    cnam = VALUES(cnam),
                    outbound_cnum = VALUES(outbound_cnum),
                    outbound_cnam = VALUES(outbound_cnam),
                    dst_cnam = VALUES(dst_cnam),
                    peeraccount = VALUES(peeraccount),
                    sequence = VALUES(sequence),
                    direction = VALUES(direction),
                    call_scope = VALUES(call_scope),
                    fed_leg = VALUES(fed_leg),
                    synced_at = NOW()
            `, [
                peerId,
                String(row.uniqueid).slice(0, 150),
                str(row.linkedid, 150),
                str(row.global_call_id, 150),
                toMysqlDateTime(row.calldate) || toMysqlDateTime(new Date()),
                str(row.clid, 120),
                str(row.src, 80),
                str(row.dst, 80),
                str(row.dcontext, 80),
                str(row.channel, 120),
                str(row.dstchannel, 120),
                str(row.lastapp, 80),
                str(row.lastdata, 255),
                numberOrNull(row.duration) || 0,
                numberOrNull(row.billsec) || 0,
                str(row.disposition, 45),
                numberOrNull(row.amaflags),
                str(row.accountcode, 80),
                str(row.userfield, 255),
                str(row.did, 80),
                str(row.recordingfile, 255),
                str(row.cnum, 80),
                str(row.cnam, 80),
                str(row.outbound_cnum, 80),
                str(row.outbound_cnam, 80),
                str(row.dst_cnam, 80),
                str(row.peeraccount, 80),
                numberOrNull(row.sequence) || 0,
                ['INBOUND', 'OUTBOUND', 'INTERNAL', 'UNKNOWN'].includes(String(row.direction))
                    ? String(row.direction)
                    : 'UNKNOWN',
                ['INTERNAL', 'EXTERNAL', 'UNKNOWN'].includes(String(row.call_scope))
                    ? String(row.call_scope)
                    : 'UNKNOWN',
                Number(row.fed_leg) ? 1 : 0
            ]);
            written += 1;
        } catch (err) {
            if (process.env.SOKRAT_FEDERATION_DEBUG === '1') {
                console.warn(`[FederationAggregator] CDR row skipped: ${err.message}`);
            }
        }
    }
    return written;
}

/**
 * Incremental CDR mirror. The cursor is the newest remote calldate; each run
 * re-reads a 15 minute overlap so late-written rows are not lost.
 */
async function syncPeerCdr(pool, peer, options = {}) {
    await setSyncState(pool, peer.id, 'cdr', { status: 'syncing' });
    try {
        const cursor = options.ignoreCursor ? null : await getCdrCursor(pool, peer.id);
        const base = cursor ? new Date(cursor) : new Date(Date.now() - CDR_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
        let since = new Date(base.getTime() - CDR_OVERLAP_MINUTES * 60 * 1000);
        let total = 0;
        let maxCalldate = cursor ? toMysqlDateTime(base) : null;

        for (let batch = 0; batch < CDR_MAX_BATCHES_PER_CYCLE; batch += 1) {
            const sinceText = toMysqlDateTime(since);
            const response = await federationGet(
                peer,
                `/api/federation/v1/cdr?since=${encodeURIComponent(sinceText)}&limit=${CDR_BATCH_LIMIT}`,
                {
                    localSiteCode: options.localSiteCode || '10',
                    decryptFn: options.decryptFn,
                    timeout: options.timeout || 10000
                }
            );
            const rows = Array.isArray(response && response.rows) ? response.rows : [];
            if (!rows.length) break;

            total += await upsertRemoteCdr(pool, peer.id, rows);
            const lastRow = rows[rows.length - 1];
            const lastDate = toMysqlDateTime(lastRow && lastRow.calldate);
            if (lastDate) {
                maxCalldate = lastDate;
                since = new Date(new Date(lastDate).getTime() + 1000);
            }
            if (!response.has_more) break;
        }

        await setSyncState(pool, peer.id, 'cdr', {
            status: 'ok',
            rows: total,
            cursor: maxCalldate
        });
        return { rows: total, cursor: maxCalldate };
    } catch (err) {
        await setSyncState(pool, peer.id, 'cdr', { status: 'error', error: err.message });
        throw err;
    }
}

module.exports = {
    normalizeActiveCalls,
    normalizeLivePayload,
    normalizeInventoryPayload,
    normalizeContactsPayload,
    parseSignalPct,
    setSyncState,
    upsertNodeStatus,
    markPeerOffline,
    syncPeerLive,
    syncPeerInventory,
    syncPeerContacts,
    syncPeerCdr,
    replaceRemoteContacts,
    toMysqlDateTime
};
