'use strict';

/**
 * Central → peer action gateway.
 *
 * The central panel renders one UI for every PBX. When the operator selects a
 * single remote PBX, mutating `/api/*` calls are relayed through this module
 * instead of hitting the local node. Every action is:
 *
 *   1. normalised and restricted to `/api/*`,
 *   2. checked against the peer's per-resource write policy,
 *   3. executed as a signed federation request (the peer trusts the hub as an
 *      administrator), and
 *   4. written to `sokrat_federation_action_log` for audit.
 *
 * The gateway is deliberately generic so new local endpoints become remotely
 * controllable without another allowlist entry. Destructive administrative
 * surfaces (federation management, login, API keys) stay local-only.
 */

const DENIED_PREFIXES = [
    '/api/federation',
    '/api/config/federation',
    '/api/auth',
    '/api/admin',
    '/api/peer'
];

const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

const POLICY_RULES = [
    { prefix: '/api/gsm-dongles', policy: 'allow_dongle_control' },
    { prefix: '/api/dongle', policy: 'allow_dongle_control' },
    { prefix: '/api/sim', policy: 'allow_dongle_control' },
    { prefix: '/api/contacts', policy: 'allow_contact_write' },
    { prefix: '/api/address-book', policy: 'allow_contact_write' },
    { prefix: '/api/dialer', policy: 'allow_campaign_control' },
    { prefix: '/api/campaigns', policy: 'allow_campaign_control' },
    { prefix: '/api/operator', policy: 'allow_internal_dialing' }
];

const DEFAULT_WRITE_POLICY = 'allow_config_write';

const POLICY_LABELS = {
    allow_dongle_control: 'Dongle control',
    allow_contact_write: 'Contact writes',
    allow_campaign_control: 'Campaign control',
    allow_internal_dialing: 'Internal dialing / operator actions',
    allow_config_write: 'Configuration writes'
};

function normalizeActionPath(value) {
    let raw = String(value || '').trim();
    if (!raw) return null;
    // Reject absolute URLs, protocol-relative URLs and traversal outright.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
    if (raw.includes('\\') || raw.includes('..')) return null;
    if (!raw.startsWith('/')) raw = `/${raw}`;
    const hash = raw.indexOf('#');
    if (hash !== -1) raw = raw.slice(0, hash);
    if (!raw.startsWith('/api/')) return null;
    // Keep the query string but never allow a second scheme/host.
    if (raw.includes('://')) return null;
    return raw;
}

function isDeniedActionPath(path) {
    // Compare only the pathname so a query string cannot smuggle a denied
    // endpoint past the prefix check (e.g. /api/config/federation?x=1).
    const pathname = String(path || '').split('?')[0].split('#')[0];
    for (const prefix of DENIED_PREFIXES) {
        if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
    }
    return false;
}

function requiredPolicyForAction(path, method) {
    const upper = String(method || 'POST').toUpperCase();
    if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return null;
    const normalized = normalizeActionPath(path);
    if (!normalized) return null;
    for (const rule of POLICY_RULES) {
        if (normalized === rule.prefix || normalized.startsWith(`${rule.prefix}/`) || normalized.startsWith(`${rule.prefix}?`)) {
            return rule.policy;
        }
    }
    return DEFAULT_WRITE_POLICY;
}

function peerAllowsPolicy(peer, policy) {
    if (!policy) return true;
    return Number(peer && peer[policy]) === 1;
}

function redactPayload(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 50).map(v => redactPayload(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            if (/password|secret|token|api[_-]?key|credential/i.test(key)) {
                out[key] = '[redacted]';
            } else {
                out[key] = redactPayload(val, depth + 1);
            }
        }
        return out;
    }
    if (typeof value === 'string' && value.length > 2048) return `${value.slice(0, 2048)}…`;
    return value;
}

function summarizeResponse(data) {
    if (data === null || data === undefined) return null;
    let text;
    try {
        text = typeof data === 'string' ? data : JSON.stringify(redactPayload(data));
    } catch (_) {
        text = String(data);
    }
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

async function startActionLog(pool, { peerId, actor, action, target, payload }) {
    if (!pool) return null;
    try {
        const [result] = await pool.query(
            `INSERT INTO \`asterisk\`.\`sokrat_federation_action_log\`
                (peer_id, actor, action, target, payload, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [
                peerId,
                actor ? String(actor).slice(0, 64) : null,
                String(action).slice(0, 64),
                target ? String(target).slice(0, 128) : null,
                payload === undefined || payload === null ? null : JSON.stringify(redactPayload(payload))
            ]
        );
        return result && result.insertId ? result.insertId : null;
    } catch (_) {
        return null;
    }
}

async function finishActionLog(pool, logId, status, response) {
    if (!pool || !logId) return;
    try {
        await pool.query(
            'UPDATE `asterisk`.`sokrat_federation_action_log` SET status = ?, response = ? WHERE id = ?',
            [status, response ? String(response).slice(0, 8000) : null, logId]
        );
    } catch (_) {}
}

/**
 * Execute one action against a peer.
 *
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string, policy?: string}>}
 */
async function executePeerAction({
    pool,
    peer,
    localSiteCode,
    actor,
    method,
    path,
    body = null,
    rawBody = null,
    contentType = null,
    decryptFn,
    requestFn,
    timeout
}) {
    const upper = String(method || 'POST').toUpperCase();
    if (!ALLOWED_METHODS.includes(upper)) {
        return { ok: false, status: 405, error: `Method ${upper} cannot be relayed to a remote PBX.` };
    }

    const normalized = normalizeActionPath(path);
    if (!normalized) {
        return { ok: false, status: 400, error: 'Invalid action path. Only /api/* paths can be relayed.' };
    }
    if (isDeniedActionPath(normalized)) {
        return { ok: false, status: 403, error: 'This endpoint is local to the central PBX and cannot be controlled remotely.' };
    }

    const policy = requiredPolicyForAction(normalized, upper);
    if (!peerAllowsPolicy(peer, policy)) {
        // A blocked remote write is still a control-plane event: record the
        // attempt so an operator can see who tried to drive what.
        const deniedLogId = await startActionLog(pool, {
            peerId: peer.id,
            actor,
            action: `${upper} ${normalized.split('?')[0]}`,
            target: normalized,
            payload: body
        });
        const deniedMessage = `Remote PBX policy blocks this action (${POLICY_LABELS[policy] || policy}). Enable it in Multi-Server PBX Federation.`;
        await finishActionLog(pool, deniedLogId, 'error', `policy-denied: ${policy}`);
        return {
            ok: false,
            status: 403,
            policy,
            error: deniedMessage
        };
    }

    if (typeof requestFn !== 'function') {
        return { ok: false, status: 500, error: 'Federation client is not configured.' };
    }

    const logId = await startActionLog(pool, {
        peerId: peer.id,
        actor,
        action: `${upper} ${normalized.split('?')[0]}`,
        target: normalized,
        payload: body
    });

    try {
        const result = await requestFn(peer, normalized, {
            method: upper,
            body,
            rawBody,
            contentType,
            localSiteCode,
            decryptFn,
            actor,
            withMeta: true,
            timeout
        });

        const status = Number(result && result.status) || 200;
        const ok = status >= 200 && status < 300;
        await finishActionLog(pool, logId, ok ? 'ok' : 'error', summarizeResponse(result && result.data));
        return { ok, status, data: result ? result.data : null };
    } catch (err) {
        const status = err && err.status ? err.status : 502;
        await finishActionLog(pool, logId, 'error', err && err.message ? err.message : 'request failed');
        return { ok: false, status, error: err && err.message ? err.message : 'Remote action failed.' };
    }
}

module.exports = {
    ALLOWED_METHODS,
    DEFAULT_WRITE_POLICY,
    DENIED_PREFIXES,
    POLICY_LABELS,
    POLICY_RULES,
    executePeerAction,
    finishActionLog,
    isDeniedActionPath,
    normalizeActionPath,
    peerAllowsPolicy,
    redactPayload,
    requiredPolicyForAction,
    startActionLog,
    summarizeResponse
};
