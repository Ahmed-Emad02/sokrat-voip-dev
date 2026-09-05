/**
 * CRM Integration REST API Router
 * Handles /api/integrations/crm/v1/* endpoints
 */

const express = require('express');
const moment = require('moment');
const path = require('path');
const pkg = require('../package.json');
const {
    authenticateClientToken,
    verifyAndUsePairingCode,
    createIntegrationClient,
    createEmbedTicket,
    validateOriginUrl,
    SUPPORTED_SCOPES
} = require('../lib/integration-auth');
const { getCustomerCallHistory, getExtensionStats } = require('../lib/cdr-aggregation');
const { resolveRecordingPath, streamRecordingFile } = require('../lib/recordings');

// Rate limiting map for pairing attempts (IP -> timestamps array)
const pairingRateLimitMap = new Map();

const pairingRateLimitTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of pairingRateLimitMap.entries()) {
        const fresh = timestamps.filter(t => now - t < 60000);
        if (fresh.length === 0) pairingRateLimitMap.delete(ip);
        else pairingRateLimitMap.set(ip, fresh);
    }
}, 5 * 60 * 1000);
if (pairingRateLimitTimer.unref) pairingRateLimitTimer.unref();

function createCrmRouter(pool, options = {}) {
    const getPeerStatus = typeof options === 'function' ? options : (options.getPeerStatus || (() => options.peerStatus || {}));
    const getActiveCalls = typeof options === 'object' && typeof options.getActiveCalls === 'function'
        ? options.getActiveCalls
        : (() => options.activeCalls || {});
    const router = express.Router();

    // 1. PUBLIC HEALTH ENDPOINT
    router.get('/health', (req, res) => {
        res.json({
            service: 'sokrat-voip',
            status: 'ok',
            api_version: '1.0',
            application_version: pkg.version || '1.0.0',
            server_time: moment().format(),
            timezone: 'Africa/Cairo'
        });
    });

    // 2. PAIRING ENDPOINT (Public with single-use pairing code & origin validation)
    router.post('/pair', async (req, res) => {
        const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
        const now = Date.now();

        let attempts = (pairingRateLimitMap.get(ip) || []).filter(t => now - t < 60000);
        if (attempts.length >= 5) {
            return res.status(429).json({ success: false, error: 'Too many pairing attempts. Please try again later.' });
        }
        attempts.push(now);
        pairingRateLimitMap.set(ip, attempts);

        const { pairing_code, name, origin, default_country_code } = req.body || {};

        if (!pairing_code || !name || !origin) {
            return res.status(400).json({ success: false, error: 'Missing required parameters: pairing_code, name, origin' });
        }

        const validOrigin = validateOriginUrl(origin);
        if (!validOrigin) {
            return res.status(400).json({ success: false, error: 'Invalid origin URL. Must be http:// or https:// without paths, queries, or wildcards.' });
        }

        try {
            const client = await createIntegrationClient(pool, {
                pairingCode: String(pairing_code).trim(),
                name: String(name).trim(),
                origin: validOrigin,
                defaultCountryCode: String(default_country_code || '20').trim()
            });

            if (!client) {
                return res.status(401).json({ success: false, error: 'Invalid, expired, or already used pairing code' });
            }

            const liveControls = (client.scopes || []).filter(s => s.startsWith('live:') && s !== 'live:read').map(s => s.substring(5));

            return res.json({
                client_id: client.clientId,
                client_secret: client.bearerToken,
                api_version: '1.0',
                capabilities: {
                    call_history: true,
                    recordings: true,
                    extension_stats: true,
                    live_panel: true,
                    live_controls: liveControls
                }
            });
        } catch (err) {
            console.error('CRM Pairing error:', err.message);
            return res.status(500).json({ success: false, error: 'Internal server error during pairing' });
        }
    });

    // CRM AUTHENTICATION & SCOPE MIDDLEWARE
    function requireCrmScope(requiredScope) {
        return async (req, res, next) => {
            try {
                const authHeader = req.headers.authorization || '';
                if (!authHeader.startsWith('Bearer ')) {
                    return res.status(401).json({ success: false, error: 'Unauthorized. Bearer authentication required.' });
                }

                const token = authHeader.substring(7).trim();
                if (token.length < 10 || token.length > 256 || !token.includes('.')) {
                    return res.status(401).json({ success: false, error: 'Unauthorized. Malformed bearer token.' });
                }

                const client = await authenticateClientToken(pool, token);

                if (!client) {
                    return res.status(401).json({ success: false, error: 'Unauthorized. Invalid, expired, or revoked integration credentials.' });
                }

                if (requiredScope) {
                    const hasScope = Array.isArray(requiredScope)
                        ? requiredScope.some(s => client.scopes.includes(s))
                        : client.scopes.includes(requiredScope);
                    if (!hasScope) {
                        return res.status(403).json({ success: false, error: `Forbidden. Missing required scope: ${Array.isArray(requiredScope) ? requiredScope.join(' or ') : requiredScope}` });
                    }
                }

                req.crmClient = client;
                next();
            } catch (err) {
                console.error('CRM Auth Middleware error:', err.message);
                return res.status(503).json({ success: false, error: 'Service temporarily unavailable' });
            }
        };
    }

    // 3. CAPABILITIES ENDPOINT
    router.get('/capabilities', requireCrmScope(), (req, res) => {
        const clientScopes = req.crmClient.scopes || [];
        const liveControls = clientScopes.filter(s => s.startsWith('live:') && s !== 'live:read').map(s => s.substring(5));

        res.json({
            api_version: '1.0',
            application_version: pkg.version || '1.0.0',
            supported: {
                call_history: true,
                recordings: true,
                extension_stats: true,
                live_panel: true,
                live_controls: ['listen', 'whisper', 'barge', 'hangup', 'hijack']
            },
            granted_scopes: clientScopes,
            effective_live_controls: liveControls
        });
    });

    // 4. SAFE LIVE EXTENSION LIST
    router.get('/extensions', requireCrmScope('extensions:read'), async (req, res) => {
        try {
            const [rows] = await pool.query(`
                SELECT extension AS id, name
                FROM asterisk.users
                WHERE extension REGEXP '^[0-9]+$'
                ORDER BY CAST(extension AS UNSIGNED) ASC
            `);

            const peerMap = typeof getPeerStatus === 'function' ? getPeerStatus() : {};
            const activeCallMap = getActiveCalls();

            const extensions = rows.map(r => {
                const ext = String(r.id);
                const peer = peerMap[ext];
                const activeCall = activeCallMap && typeof activeCallMap === 'object'
                    ? activeCallMap[ext]
                    : null;
                let isOnline = false;

                if (typeof peer === 'boolean') {
                    isOnline = peer;
                } else if (peer && typeof peer === 'object') {
                    const peerStatus = String(peer.status || '').toLowerCase();
                    isOnline = Boolean(peer.online)
                        || peerStatus.includes('ok')
                        || ['online', 'registered', 'available', 'idle', 'ready'].includes(peerStatus);
                }

                const inCall = Boolean(activeCall);
                const rawCallState = String(activeCall?.state || activeCall?.status || '').toLowerCase();
                const status = inCall
                    ? (rawCallState.includes('ring') ? 'ringing' : 'in_call')
                    : (isOnline ? 'online' : 'offline');
                const startedAt = inCall
                    ? (Number(activeCall.start || activeCall.started_at) || Date.now())
                    : null;

                return {
                    extension: ext,
                    name: r.name || `Extension ${ext}`,
                    technology: 'sip',
                    enabled: true,
                    online: isOnline || inCall,
                    in_call: inCall,
                    status,
                    call: inCall ? {
                        state: activeCall.state || activeCall.status || 'In Call',
                        partner: String(activeCall.partner || activeCall.callee || activeCall.caller || ''),
                        started_at: startedAt,
                        duration_seconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
                    } : null
                };
            });

            res.json({
                extensions,
                generated_at: new Date().toISOString()
            });
        } catch (err) {
            console.error('CRM Extensions fetch error:', err.message);
            res.status(500).json({ success: false, error: 'Failed to retrieve extensions' });
        }
    });

    // 5. CUSTOMER CALL HISTORY API
    router.get('/calls', requireCrmScope('calls:read'), async (req, res) => {
        const { phone } = req.query;
        if (!phone) {
            return res.status(400).json({ success: false, error: 'Missing required parameter: phone' });
        }

        try {
            const countryCode = req.crmClient.default_country_code || '20';
            const history = await getCustomerCallHistory(pool, req.query, countryCode);
            res.json(history);
        } catch (err) {
            if (err.message.includes('required') || err.message.includes('End date')) {
                return res.status(400).json({ success: false, error: err.message });
            }
            console.error('CRM Call History error:', err.message);
            res.status(500).json({ success: false, error: 'Failed to retrieve customer call history' });
        }
    });

    // 6. RECORDING STREAMING API
    router.get('/recordings/:mediaId', requireCrmScope('recordings:read'), async (req, res) => {
        const { mediaId } = req.params;
        try {
            const recordingPath = await resolveRecordingPath(mediaId, pool);
            if (!recordingPath) {
                return res.status(404).json({ success: false, error: 'Recording file not found' });
            }
            streamRecordingFile(req, res, recordingPath);
        } catch (err) {
            console.error('CRM Recording streaming error:', err.message);
            res.status(500).json({ success: false, error: 'Failed to stream recording file' });
        }
    });

    // 7. EXTENSION STATISTICS API
    router.get('/extensions/:extension/stats', requireCrmScope('stats:read'), async (req, res) => {
        const { extension } = req.params;
        try {
            const stats = await getExtensionStats(pool, extension, req.query);
            res.json(stats);
        } catch (err) {
            if (err.message.includes('Invalid extension') || err.message.includes('Date range') || err.message.includes('direction')) {
                return res.status(400).json({ success: false, error: err.message });
            }
            console.error('CRM Extension Stats error:', err.message);
            res.status(500).json({ success: false, error: 'Failed to generate extension statistics' });
        }
    });

    // 8. EMBED TICKET GENERATOR
    router.post('/embed-tickets', requireCrmScope(['live:read', 'softphone:use']), async (req, res) => {
        const { crm_user_id, crm_user_name, supervisor_extension, requested_scopes, extension } = req.body || {};

        if (!crm_user_id || !crm_user_name) {
            return res.status(400).json({ success: false, error: 'Missing required parameters: crm_user_id, crm_user_name' });
        }

        try {
            const requestedScopes = Array.isArray(requested_scopes)
                ? requested_scopes
                : ['softphone:use', 'live:read'];
            const canIssueRequestedTicket = requestedScopes.some(scope =>
                (scope === 'softphone:use' || scope === 'live:read') &&
                req.crmClient.scopes.includes(scope)
            );
            if (!canIssueRequestedTicket) {
                return res.status(403).json({
                    success: false,
                    error: 'Forbidden. Requested embed scope is not granted to this client.'
                });
            }
            const ticket = await createEmbedTicket(pool, req.crmClient, {
                crmUserId: String(crm_user_id),
                crmUserName: String(crm_user_name),
                supervisorExtension: supervisor_extension ? String(supervisor_extension) : null,
                extension: extension ? String(extension) : null,
                requestedScopes
            });
            if (ticket.effectiveScopes.length === 0) {
                throw new Error('Embed ticket was created without an effective scope');
            }

            res.json({
                ticket: ticket.rawTicket,
                expires_at: ticket.expiresAt.toISOString(),
                effective_scopes: ticket.effectiveScopes
            });
        } catch (err) {
            console.error('CRM Embed Ticket creation error:', err.message);
            res.status(500).json({ success: false, error: 'Failed to create embed ticket' });
        }
    });

    return router;
}

module.exports = createCrmRouter;
