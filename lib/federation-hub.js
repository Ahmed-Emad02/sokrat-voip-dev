'use strict';

const { qualifyIaxPeer } = require('./federation-bootstrap');
const { federationGet, federationPost } = require('./federation-client');
const {
    syncPeerLive,
    syncPeerInventory,
    syncPeerContacts,
    syncPeerCdr,
    markPeerOffline
} = require('./federation-aggregator');

const INVENTORY_INTERVAL_MS = 60000;
const CDR_SYNC_INTERVAL_MS = 60000;

/**
 * Legacy peers returned `activeCalls` as an array. Normalize either shape to a
 * map keyed by extension so the live panel contract stays stable.
 */
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

class FederationHub {
    constructor({ pool, io, getLocalLiveStateFn, executeLocalActionFn, decryptFn, getLocalMetricsFn }) {
        this.pool = pool;
        this.io = io;
        this.getLocalLiveState = getLocalLiveStateFn;
        this.executeLocalAction = executeLocalActionFn;
        this.getLocalMetrics = getLocalMetricsFn;
        this.decryptFn = decryptFn;
        this.peersMap = new Map(); // peerId -> peerRecord
        this.localSettings = { local_site_code: '10', local_node_name: 'Main PBX', panel_role: 'local' };
        this.pollTimer = null;
        this.aggregatedExtensions = new Map(); // key: "siteCode:ext"
        this.peerLive = new Map(); // peerId -> latest normalized live payload
        this.lastInventorySync = new Map(); // peerId -> epoch ms
        this.lastCdrSync = new Map(); // peerId -> epoch ms
        this.overview = { timestamp: 0, local: {}, nodes: [], totals: {} };
        this.isRunning = false;
    }

    async init() {
        await this.reloadSettingsAndPeers();
    }

    /**
     * Star topology: only the central node polls peers. A local PBX keeps its
     * peer rows (they still drive the IAX2 trunk) but never aggregates them,
     * so its dashboard, reports and operator panel stay single-PBX.
     */
    applyPollingPolicy() {
        const shouldPoll = this.localSettings.panel_role === 'central' && this.peersMap.size > 0;
        if (shouldPoll) {
            this.startPolling();
            return;
        }
        this.stopPolling();
        this.aggregatedExtensions.clear();
        this.peerLive.clear();
        this.lastInventorySync.clear();
        this.lastCdrSync.clear();
        this.overview = { timestamp: 0, local: {}, nodes: [], totals: {} };
    }

    async reloadSettingsAndPeers() {
        if (!this.pool) return;
        try {
            const [settingsRows] = await this.pool.query('SELECT * FROM `asterisk`.`sokrat_federation_settings` WHERE id = 1');
            if (settingsRows && settingsRows.length > 0) {
                this.localSettings = settingsRows[0];
            }

            const [peerRows] = await this.pool.query('SELECT * FROM `asterisk`.`sokrat_federation_peers`');
            this.peersMap.clear();
            for (const peer of (peerRows || [])) {
                this.peersMap.set(Number(peer.id), peer);
            }
        } catch (err) {
            console.error('[FederationHub] Error reloading settings/peers:', err.message);
        }
        this.applyPollingPolicy();
    }

    startPolling() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.pollCycle();
    }

    stopPolling() {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async pollCycle() {
        if (!this.isRunning) return;
        try {
            await this.aggregateAllNodes();
        } catch (err) {
            console.error('[FederationHub] Poll error:', err.message);
        } finally {
            if (this.isRunning) {
                this.pollTimer = setTimeout(() => this.pollCycle(), 3000);
            }
        }
    }

    async aggregateAllNodes() {
        const localSiteCode = this.localSettings.local_site_code || '10';
        const localNodeName = this.localSettings.local_node_name || 'Main PBX';

        // 1. Gather local extensions and active states
        const localState = typeof this.getLocalLiveState === 'function' ? await this.getLocalLiveState() : { extensions: [], activeCalls: {} };
        const localActiveCalls = normalizeActiveCalls(localState.activeCalls);

        const currentAggregated = new Map();

        // Populate local extensions
        for (const ext of (localState.extensions || [])) {
            const compositeKey = `${localSiteCode}:${ext.extension}`;
            currentAggregated.set(compositeKey, {
                ...ext,
                compositeKey,
                siteCode: localSiteCode,
                nodeName: localNodeName,
                isLocal: true,
                peerId: null,
                dialAlias: ext.extension,
                activeCall: localActiveCalls[ext.extension] || null
            });
        }

        // 2. Poll every peer. Live state runs each cycle; inventory is refreshed
        // on a slower cadence because it replaces the directory tables.
        for (const [peerId, peer] of this.peersMap.entries()) {
            const peerSiteCode = peer.site_code;
            const peerNodeName = peer.node_name || `Site ${peerSiteCode}`;

            const lastInventory = this.lastInventorySync.get(peerId) || 0;
            if (Date.now() - lastInventory >= INVENTORY_INTERVAL_MS) {
                try {
                    await syncPeerInventory(this.pool, peer, {
                        localSiteCode,
                        decryptFn: this.decryptFn
                    });
                    this.lastInventorySync.set(peerId, Date.now());
                } catch (err) {
                    if (process.env.SOKRAT_FEDERATION_DEBUG === '1') {
                        console.warn(`[FederationHub] Inventory unavailable for site ${peer.site_code}: ${err.message}`);
                    }
                }
                try {
                    await syncPeerContacts(this.pool, peer, {
                        localSiteCode,
                        decryptFn: this.decryptFn
                    });
                } catch (err) {
                    if (process.env.SOKRAT_FEDERATION_DEBUG === '1') {
                        console.warn(`[FederationHub] Contacts unavailable for site ${peer.site_code}: ${err.message}`);
                    }
                }
            }

            const lastCdr = this.lastCdrSync.get(peerId) || 0;
            if (Date.now() - lastCdr >= CDR_SYNC_INTERVAL_MS) {
                try {
                    await syncPeerCdr(this.pool, peer, {
                        localSiteCode,
                        decryptFn: this.decryptFn
                    });
                    this.lastCdrSync.set(peerId, Date.now());
                } catch (err) {
                    if (process.env.SOKRAT_FEDERATION_DEBUG === '1') {
                        console.warn(`[FederationHub] CDR unavailable for site ${peer.site_code}: ${err.message}`);
                    }
                }
            }

            let remoteLiveState = null;
            try {
                remoteLiveState = await syncPeerLive(this.pool, peer, {
                    localSiteCode,
                    decryptFn: this.decryptFn,
                    timeout: 2000
                });
                this.peerLive.set(peerId, remoteLiveState);
            } catch (err) {
                // A single unreachable peer must not break the aggregate cycle.
                this.peerLive.delete(peerId);
                if (process.env.SOKRAT_FEDERATION_DEBUG === '1') {
                    console.warn(`[FederationHub] Live state unavailable for site ${peer.site_code}: ${err.message}`);
                }
            }

            try {
                const [extRows] = await this.pool.query(`
                    SELECT native_extension, dial_alias, display_name, status, last_seen_at
                    FROM \`asterisk\`.\`sokrat_federation_remote_extensions\`
                    WHERE peer_id = ?
                `, [peerId]);

                const remotePresenceMap = remoteLiveState?.peerStatus || {};
                const remoteActiveCallsMap = normalizeActiveCalls(remoteLiveState?.activeCalls);
                const remoteIpMap = remoteLiveState?.peerIPs || {};

                for (const row of extRows) {
                    const compositeKey = `${peerSiteCode}:${row.native_extension}`;
                    let isOnline = false;
                    let activeCall = null;
                    let extIp = null;

                    if (remoteLiveState) {
                        isOnline = Boolean(remotePresenceMap[row.native_extension]);
                        activeCall = remoteActiveCallsMap[row.native_extension] || null;
                        extIp = remoteIpMap[row.native_extension] || null;
                    }

                    const liveStatus = isOnline ? 'online' : 'offline';

                    currentAggregated.set(compositeKey, {
                        extension: row.native_extension,
                        name: row.display_name,
                        status: liveStatus,
                        compositeKey,
                        siteCode: peerSiteCode,
                        nodeName: peerNodeName,
                        isLocal: false,
                        peerId,
                        dialAlias: row.dial_alias || `${peerSiteCode}${row.native_extension}`,
                        ip: extIp,
                        activeCall: activeCall
                    });

                    if (row.status !== liveStatus) {
                        this.pool.query(
                            'UPDATE `asterisk`.`sokrat_federation_remote_extensions` SET status = ?, last_seen_at = NOW() WHERE peer_id = ? AND native_extension = ?',
                            [liveStatus, peerId, row.native_extension]
                        ).catch(() => {});
                    }
                }
            } catch (err) {
                console.error(`[FederationHub] Error aggregating peer ${peerId}:`, err.message);
            }
        }

        this.aggregatedExtensions = currentAggregated;
        await this.refreshOverview();

        // 3. Emit aggregated multi-node state to Socket.IO operator clients
        if (this.io) {
            const list = Array.from(this.aggregatedExtensions.values());
            this.io.emit('operator:federation_state', {
                timestamp: Date.now(),
                localSiteCode,
                localNodeName,
                panelRole: this.localSettings.panel_role,
                nodes: [
                    { siteCode: localSiteCode, nodeName: localNodeName, isLocal: true, status: 'online' },
                    ...Array.from(this.peersMap.values()).map(p => ({
                        siteCode: p.site_code,
                        nodeName: p.node_name,
                        isLocal: false,
                        status: p.status
                    }))
                ],
                extensions: list
            });
            this.io.emit('federation:overview', this.overview);
        }
    }

    /**
     * Build the read model that powers the node rail and health cards. Local
     * metrics come from the host process; remote metrics come from the
     * node-health table written by the aggregator.
     */
    async refreshOverview() {
        const localSiteCode = this.localSettings.local_site_code || '10';
        const localNodeName = this.localSettings.local_node_name || 'Main PBX';
        const list = Array.from(this.aggregatedExtensions.values());

        let localMetrics = {};
        try {
            if (typeof this.getLocalMetrics === 'function') {
                localMetrics = await this.getLocalMetrics();
            }
        } catch (_) {
            localMetrics = {};
        }

        const localOnline = list.filter(e => e.isLocal && e.status !== 'offline').length;
        const localTotal = list.filter(e => e.isLocal).length;
        const localActiveCalls = list.filter(e => e.isLocal && e.activeCall).length;

        const nodes = [{
            peerId: 0,
            siteCode: localSiteCode,
            nodeName: localNodeName,
            host: 'local',
            isLocal: true,
            status: 'online',
            latencyMs: 0,
            apiVersion: 1,
            nodeVersion: require('../package.json').version,
            asteriskVersion: localMetrics.asterisk_version || null,
            uptimeSec: localMetrics.uptime_sec || null,
            load1: localMetrics.load1 ?? null,
            diskPct: localMetrics.disk_pct ?? null,
            extensionsTotal: localTotal,
            extensionsOnline: localOnline,
            donglesTotal: Number(localMetrics.dongles_total) || 0,
            donglesFree: Number(localMetrics.dongles_free) || 0,
            activeCalls: localActiveCalls,
            callsToday: Number(localMetrics.calls_today) || 0,
            lastSeenAt: new Date().toISOString()
        }];

        try {
            const [rows] = await this.pool.query(`
                SELECT p.id, p.site_code, p.node_name, p.host, p.status AS peer_status,
                       p.api_version, p.node_version,
                       p.allow_report_read, p.allow_contact_write, p.allow_dongle_control, p.allow_campaign_control,
                       ns.status AS node_status, ns.last_seen_at, ns.last_error, ns.latency_ms,
                       ns.api_version AS health_api_version, ns.node_version AS health_node_version,
                       ns.asterisk_version, ns.uptime_sec, ns.load1, ns.disk_pct,
                       ns.extensions_total, ns.extensions_online,
                       ns.dongles_total, ns.dongles_free, ns.active_calls, ns.calls_today
                FROM \`asterisk\`.\`sokrat_federation_peers\` p
                LEFT JOIN \`asterisk\`.\`sokrat_federation_node_status\` ns ON ns.peer_id = p.id
                ORDER BY p.site_code ASC
            `);
            for (const row of (rows || [])) {
                const live = this.peerLive.get(Number(row.id));
                const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
                const stale = lastSeen && (Date.now() - lastSeen > 15000);
                const status = !lastSeen ? 'offline' : (stale ? 'offline' : (row.node_status || 'offline'));
                nodes.push({
                    peerId: Number(row.id),
                    siteCode: row.site_code,
                    nodeName: row.node_name,
                    host: row.host,
                    isLocal: false,
                    status,
                    latencyMs: row.latency_ms ?? null,
                    apiVersion: row.health_api_version || row.api_version || null,
                    nodeVersion: row.health_node_version || row.node_version || null,
                    asteriskVersion: row.asterisk_version || null,
                    uptimeSec: row.uptime_sec ?? null,
                    load1: row.load1 != null ? Number(row.load1) : null,
                    diskPct: row.disk_pct ?? null,
                    extensionsTotal: row.extensions_total ?? 0,
                    extensionsOnline: row.extensions_online ?? 0,
                    donglesTotal: row.dongles_total ?? 0,
                    donglesFree: row.dongles_free ?? 0,
                    activeCalls: row.active_calls ?? 0,
                    callsToday: row.calls_today ?? 0,
                    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
                    lastError: row.last_error || null,
                    policy: {
                        report_read: Number(row.allow_report_read) !== 0,
                        contact_write: Number(row.allow_contact_write) === 1,
                        dongle_control: Number(row.allow_dongle_control) === 1,
                        campaign_control: Number(row.allow_campaign_control) === 1
                    },
                    live: live ? {
                        extensions: live.extensions.length,
                        dongles: live.dongles.length,
                        activeCalls: Object.keys(live.activeCalls || {}).length
                    } : null
                });
            }
        } catch (err) {
            console.error('[FederationHub] Overview query failed:', err.message);
        }

        const totals = nodes.reduce((acc, node) => ({
            extensionTotal: acc.extensionTotal + Number(node.extensionsTotal || 0),
            extensionOnline: acc.extensionOnline + Number(node.extensionsOnline || 0),
            dongleTotal: acc.dongleTotal + Number(node.donglesTotal || 0),
            dongleFree: acc.dongleFree + Number(node.donglesFree || 0),
            activeCalls: acc.activeCalls + Number(node.activeCalls || 0),
            callsToday: acc.callsToday + Number(node.callsToday || 0)
        }), {
            extensionTotal: 0,
            extensionOnline: 0,
            dongleTotal: 0,
            dongleFree: 0,
            activeCalls: 0,
            callsToday: 0
        });

        this.overview = {
            timestamp: Date.now(),
            localSiteCode,
            localNodeName,
            panelRole: this.localSettings.panel_role,
            nodes,
            totals
        };
        return this.overview;
    }

    getOverview() {
        return this.overview;
    }

    async syncPeerNow(peerId) {
        const peer = this.peersMap.get(Number(peerId));
        if (!peer) return { success: false, error: `Peer ID ${peerId} not found` };
        try {
            const inventory = await syncPeerInventory(this.pool, peer, {
                localSiteCode: this.localSettings.local_site_code || '10',
                decryptFn: this.decryptFn
            });
            this.lastInventorySync.set(Number(peerId), Date.now());
            try {
                const live = await syncPeerLive(this.pool, peer, {
                    localSiteCode: this.localSettings.local_site_code || '10',
                    decryptFn: this.decryptFn
                });
                this.peerLive.set(Number(peerId), live);
            } catch (_) {}
            let cdrRows = 0;
            try {
                const cdr = await syncPeerCdr(this.pool, peer, {
                    localSiteCode: this.localSettings.local_site_code || '10',
                    decryptFn: this.decryptFn
                });
                this.lastCdrSync.set(Number(peerId), Date.now());
                cdrRows = cdr.rows;
            } catch (_) {}
            let contacts = 0;
            try {
                const contactSync = await syncPeerContacts(this.pool, peer, {
                    localSiteCode: this.localSettings.local_site_code || '10',
                    decryptFn: this.decryptFn
                });
                contacts = contactSync.contactsCount;
            } catch (_) {}
            await this.refreshOverview();
            return {
                success: true,
                peerId: Number(peerId),
                extensions: inventory.extensionsCount,
                dongles: inventory.donglesCount,
                cdrRows,
                contacts
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    getAggregatedExtensions() {
        return Array.from(this.aggregatedExtensions.values());
    }

    async executeAction({ action, peerId, targetExtension, supervisorExtension, channel }) {
        if (!peerId || Number(peerId) === 0) {
            // Local action
            if (typeof this.executeLocalAction === 'function') {
                return await this.executeLocalAction({ action, targetExtension, supervisorExtension, channel });
            }
            return { success: false, error: 'No local action executor defined' };
        }

        const peer = this.peersMap.get(Number(peerId));
        if (!peer) {
            return { success: false, error: `Peer ID ${peerId} not found` };
        }

        // Forward the action to the remote peer API with the same signed
        // transport used for reads. Only peers with the matching write policy
        // should reach this path.
        try {
            return await federationPost(peer, '/api/integrations/crm/v1/channels/action', {
                action,
                targetExtension,
                supervisorExtension,
                channel
            }, {
                localSiteCode: this.localSettings.local_site_code || '10',
                decryptFn: this.decryptFn,
                timeout: 5000
            });
        } catch (err) {
            return { success: false, error: `Remote action failed: ${err.message}` };
        }
    }
}

module.exports = FederationHub;
