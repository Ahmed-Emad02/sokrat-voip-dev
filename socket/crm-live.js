/**
 * Socket.io /crm-live Namespace & Live Control Handler
 */

const { verifyEmbedSession, logCrmAudit } = require('../lib/integration-auth');
const { executeCallSpy, executeCallHangup } = require('../lib/call-control');

function registerCrmLiveSocket(io, pool, dependencies = {}) {
    const { getPeerStatus, getActiveCalls, getAmiClient, ASTERISK_BIN } = dependencies;
    const crmNamespace = io.of('/crm-live');

    // Socket.io Authentication Middleware for /crm-live
    crmNamespace.use(async (socket, next) => {
        const token = socket.handshake.auth && socket.handshake.auth.token;

        if (!token || typeof token !== 'string') {
            return next(new Error('Unauthorized. Embed session auth token required in handshake.auth.token.'));
        }

        try {
            const session = await verifyEmbedSession(pool, token);
            if (!session) {
                return next(new Error('Unauthorized. Invalid, expired, or revoked embed session.'));
            }

            socket.embedSession = session;
            next();
        } catch (err) {
            next(new Error('Authentication error'));
        }
    });

    /**
     * Helper to sanitize peer status map ONLY for user extensions in asterisk.users
     */
    async function getSanitizedPeerStatusMap() {
        const rawMap = typeof getPeerStatus === 'function' ? getPeerStatus() : {};
        const sanitized = {};

        try {
            const [rows] = await pool.query(`
                SELECT extension AS id, name
                FROM asterisk.users
                WHERE extension REGEXP '^[0-9]+$'
                ORDER BY CAST(extension AS UNSIGNED) ASC
            `);

            for (const r of rows) {
                const ext = String(r.id);
                const data = rawMap[ext];
                let isOnline = false;

                if (typeof data === 'boolean') {
                    isOnline = data;
                } else if (data && typeof data === 'object') {
                    const statusVal = data.status || '';
                    isOnline = statusVal.toLowerCase().includes('ok') || Boolean(data.online);
                }

                sanitized[ext] = {
                    extension: ext,
                    name: r.name || `Extension ${ext}`,
                    online: isOnline
                };
            }
        } catch (err) {
            console.error('CRM Live Socket peer status query error:', err.message);
        }

        return sanitized;
    }

    /**
     * Helper to sanitize active call list for CRM clients
     */
    function sanitizeActiveCallList() {
        const rawObj = typeof getActiveCalls === 'function' ? getActiveCalls() : {};
        const list = [];

        if (rawObj && typeof rawObj === 'object') {
            for (const [ext, c] of Object.entries(rawObj)) {
                if (!c) continue;

                const startMs = c.start || c.started_at || Date.now();
                const durSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));

                list.push({
                    extension: String(ext),
                    state: c.state || c.status || 'In Call',
                    partner: String(c.partner || c.callee || c.caller || ''),
                    started_at: startMs,
                    duration_seconds: durSec
                });
            }
        }

        return list;
    }

    async function broadcastStateUpdate() {
        const peerMap = await getSanitizedPeerStatusMap();
        const callList = sanitizeActiveCallList();
        crmNamespace.emit('peerStatus', peerMap);
        crmNamespace.emit('activeCalls', callList);
    }

    crmNamespace.on('connection', async (socket) => {
        const session = socket.embedSession;

        // Emit initial state
        const peerMap = await getSanitizedPeerStatusMap();
        socket.emit('peerStatus', peerMap);
        socket.emit('activeCalls', sanitizeActiveCallList());

        // Live Action Handlers
        socket.on('action', async (data, callback) => {
            const cb = typeof callback === 'function' ? callback : () => {};

            // Re-verify session and client status before EVERY live control action
            const rawToken = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
            const currentSession = await verifyEmbedSession(pool, rawToken);
            if (!currentSession) {
                socket.disconnect(true);
                return cb({ success: false, error: 'Session expired or client revoked' });
            }

            const { action, targetExtension, supervisorExtension: customSupExt } = data || {};
            if (!action || !targetExtension) {
                return cb({ success: false, error: 'Missing action or targetExtension' });
            }

            const supervisorExt = customSupExt || currentSession.supervisor_extension;
            if (!supervisorExt && action !== 'hangup') {
                return cb({ success: false, error: 'No supervisor extension provided for live control action' });
            }

            const requiredScope = `live:${action}`;
            if (!currentSession.scopes.includes(requiredScope)) {
                await logCrmAudit(pool, {
                    clientId: currentSession.client_id,
                    crmUserId: currentSession.crm_user_id,
                    supervisorExtension: supervisorExt || 'none',
                    targetExtension,
                    action,
                    success: false,
                    details: 'Permission denied: missing scope'
                });
                return cb({ success: false, error: `Forbidden. Missing scope: ${requiredScope}` });
            }

            const target = String(targetExtension).trim();
            if (!/^\d{2,10}$/.test(target)) {
                return cb({ success: false, error: 'Invalid target extension format' });
            }

            const ami = typeof getAmiClient === 'function' ? getAmiClient() : null;

            try {
                if (action === 'hangup') {
                    await executeCallHangup(ami, ASTERISK_BIN, getActiveCalls, target);
                } else if (['listen', 'whisper', 'barge'].includes(action)) {
                    await executeCallSpy(pool, ami, ASTERISK_BIN, {
                        supervisorExt: String(supervisorExt),
                        targetExt: target,
                        mode: action
                    });
                } else if (action === 'hijack') {
                    const activeMap = typeof getActiveCalls === 'function' ? getActiveCalls() : {};
                    const call = activeMap[target];
                    if (!call || !call.channel) {
                        throw new Error(`No active call channel found for extension ${target}`);
                    }
                    const { resolveDeviceChannel } = require('../lib/call-control');
                    const supervisorChan = await resolveDeviceChannel(pool, String(supervisorExt));

                    if (ami) {
                        ami.write(`Action: Redirect\r\nChannel: ${call.channel}\r\nContext: from-internal\r\nExten: ${supervisorExt}\r\nPriority: 1\r\n\r\n`);
                    } else {
                        const { execFile } = require('child_process');
                        await new Promise((resolve, reject) => {
                            execFile(ASTERISK_BIN || '/usr/sbin/asterisk', ['-rx', `channel redirect ${call.channel} from-internal,${supervisorExt},1`], (err) => {
                                if (err) return reject(err);
                                resolve();
                            });
                        });
                    }
                } else {
                    throw new Error(`Unsupported live action: ${action}`);
                }

                await logCrmAudit(pool, {
                    clientId: currentSession.client_id,
                    crmUserId: currentSession.crm_user_id,
                    supervisorExtension: supervisorExt || 'none',
                    targetExtension: target,
                    action,
                    success: true,
                    details: 'Action executed successfully'
                });

                cb({ success: true, message: `${action} executed for extension ${target}` });
            } catch (err) {
                await logCrmAudit(pool, {
                    clientId: currentSession.client_id,
                    crmUserId: currentSession.crm_user_id,
                    supervisorExtension: supervisorExt || 'none',
                    targetExtension: target,
                    action,
                    success: false,
                    details: err.message
                });

                cb({ success: false, error: err.message || 'Action failed' });
            }
        });
    });

    return {
        broadcastStateUpdate,
        disconnectClient: (clientId) => {
            if (!clientId) return;
            for (const [id, s] of crmNamespace.sockets.entries()) {
                if (s.embedSession && (s.embedSession.client_id === clientId || s.embedSession.client_id === `client_${clientId}`)) {
                    s.disconnect(true);
                }
            }
        }
    };
}

module.exports = registerCrmLiveSocket;
