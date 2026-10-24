'use strict';

const { qualifyIaxPeer } = require('./federation-bootstrap');
const { federationGet, federationPost } = require('./federation-client');

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
    constructor({ pool, io, getLocalLiveStateFn, executeLocalActionFn, decryptFn }) {
        this.pool = pool;
        this.io = io;
        this.getLocalLiveState = getLocalLiveStateFn;
        this.executeLocalAction = executeLocalActionFn;
        this.decryptFn = decryptFn;
        this.peersMap = new Map(); // peerId -> peerRecord
        this.localSettings = { local_site_code: '10', local_node_name: 'Main PBX', panel_role: 'local' };
        this.pollTimer = null;
        this.aggregatedExtensions = new Map(); // key: "siteCode:ext"
        this.isRunning = false;
    }

    async init() {
        await this.reloadSettingsAndPeers();
        if (this.localSettings.panel_role === 'central' || this.peersMap.size > 0) {
            this.startPolling();
        }
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

        // 2. Query remote peers
        for (const [peerId, peer] of this.peersMap.entries()) {
            const peerSiteCode = peer.site_code;
            const peerNodeName = peer.node_name || `Site ${peerSiteCode}`;

            let remoteLiveState = null;
            try {
                const res = await federationGet(peer, '/api/federation/v1/live-state', {
                    localSiteCode,
                    decryptFn: this.decryptFn,
                    timeout: 2000
                });
                if (res && res.success && Array.isArray(res.extensions)) {
                    remoteLiveState = res;
                }
            } catch (err) {
                // A single unreachable peer must not break the aggregate cycle.
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
