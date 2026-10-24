'use strict';

/**
 * Federation request authentication.
 *
 * Every server-to-server request is signed with the per-peer API key that the
 * SSH bootstrap already stores (encrypted) in `sokrat_federation_peers`.
 * The signature covers the method, full path (including query string),
 * timestamp, nonce, and the SHA-256 hash of the raw request body.
 *
 * This module is intentionally dependency-free so it can be used by the HTTP
 * client, the Express middleware, and unit tests without a database.
 */

const crypto = require('crypto');

const API_VERSION = 1;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const MAX_REPLAY_ENTRIES = 10000;
const READ_RATE_LIMIT = 120;
const WRITE_RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;

const replayCache = new Map();
const rateBuckets = new Map();
let lastReplaySweep = Date.now();

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value == null ? '' : String(value), 'utf8').digest('hex');
}

/**
 * Normalize a peer host / URL into the origin used for federation API calls.
 * Legacy rows wrote `https://host:8443`, which is the softphone vhost and does
 * not serve the federation API. Strip that port and keep HTTPS unless the
 * operator explicitly opts into plain HTTP.
 */
function normalizeFederationBaseUrl(value, options = {}) {
    const allowHttp = options.allowHttp !== undefined
        ? Boolean(options.allowHttp)
        : process.env.SOKRAT_FEDERATION_ALLOW_HTTP === '1';

    let raw = String(value || '').trim();
    if (!raw) return '';
    raw = raw.replace(/\/+$/, '');

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        raw = `https://${raw}`;
    }

    try {
        const url = new URL(raw);
        if (url.port === '8443') url.port = '';
        if (!allowHttp && url.protocol === 'http:') url.protocol = 'https:';
        return url.origin;
    } catch (_) {
        return raw;
    }
}

function canonicalRequest(method, url, timestamp, nonce, bodyHash) {
    return [
        String(method || 'GET').toUpperCase(),
        String(url || ''),
        String(timestamp || ''),
        String(nonce || ''),
        String(bodyHash || '')
    ].join('\n');
}

function signCanonicalString(apiKey, canonical) {
    return crypto.createHmac('sha256', String(apiKey)).update(canonical, 'utf8').digest('hex');
}

function buildSignatureHeaders({
    apiKey,
    siteCode,
    method = 'GET',
    url = '/',
    body = null,
    actor = null,
    timestamp = Date.now(),
    nonce = crypto.randomBytes(16).toString('hex')
}) {
    if (!apiKey) throw new Error('Federation API key is required to sign a request');
    if (!siteCode) throw new Error('Federation site code is required to sign a request');

    const bodyText = body == null
        ? ''
        : (typeof body === 'string' ? body : JSON.stringify(body));
    const bodyHash = sha256Hex(bodyText);
    const canonical = canonicalRequest(method, url, timestamp, nonce, bodyHash);
    const signature = signCanonicalString(apiKey, canonical);

    const headers = {
        'X-Sokrat-Site': String(siteCode),
        'X-Sokrat-Timestamp': String(timestamp),
        'X-Sokrat-Nonce': String(nonce),
        'X-Sokrat-Signature': signature,
        'X-Sokrat-Federation-Version': String(API_VERSION)
    };
    if (actor) headers['X-Sokrat-Actor'] = String(actor);
    return headers;
}

function sweepReplayCache(now = Date.now()) {
    if (now - lastReplaySweep < 60 * 1000 && replayCache.size < MAX_REPLAY_ENTRIES) {
        return;
    }
    lastReplaySweep = now;
    for (const [key, expiresAt] of replayCache.entries()) {
        if (expiresAt <= now) replayCache.delete(key);
    }
    // Hard cap to avoid unbounded growth under abuse. Drop oldest insertion order.
    while (replayCache.size > MAX_REPLAY_ENTRIES) {
        const oldest = replayCache.keys().next().value;
        if (oldest === undefined) break;
        replayCache.delete(oldest);
    }
}

function checkRateLimit(siteCode, method, now = Date.now()) {
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
    const limit = isWrite ? WRITE_RATE_LIMIT : READ_RATE_LIMIT;
    const key = `${siteCode}:${isWrite ? 'w' : 'r'}`;
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
        bucket = { windowStart: now, count: 0 };
        rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
        return { allowed: false, limit, retryAfterSec: Math.max(1, Math.ceil((bucket.windowStart + RATE_WINDOW_MS - now) / 1000)) };
    }
    return { allowed: true, limit };
}

/**
 * Verify a signature without touching the database.
 * Returns { ok: true } or { ok: false, error, status }.
 */
function verifyFederationSignature({
    apiKey,
    siteCode,
    method,
    url,
    bodyText = '',
    timestamp,
    nonce,
    signature,
    now = Date.now(),
    consumeNonce = true
}) {
    if (!apiKey) return { ok: false, error: 'unknown peer key', status: 401 };
    if (!siteCode) return { ok: false, error: 'missing site code', status: 401 };
    if (!timestamp || !nonce || !signature) return { ok: false, error: 'missing signature headers', status: 401 };

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, error: 'invalid timestamp', status: 401 };
    if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
        return { ok: false, error: 'clock skew too large', status: 401 };
    }

    const nonceStr = String(nonce);
    if (nonceStr.length < 8 || nonceStr.length > 128) {
        return { ok: false, error: 'invalid nonce', status: 401 };
    }

    sweepReplayCache(now);
    const replayKey = `${siteCode}:${nonceStr}`;
    if (replayCache.has(replayKey)) {
        return { ok: false, error: 'replayed request', status: 401 };
    }

    const bodyHash = sha256Hex(bodyText);
    const canonical = canonicalRequest(method, url, ts, nonceStr, bodyHash);
    const expected = signCanonicalString(apiKey, canonical);
    const provided = String(signature || '').toLowerCase();
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
        return { ok: false, error: 'signature mismatch', status: 401 };
    }

    if (consumeNonce) replayCache.set(replayKey, now + REPLAY_WINDOW_MS);
    return { ok: true };
}

async function recordPeerSeen(pool, peerId, now = new Date()) {
    if (!pool || !peerId) return;
    try {
        await pool.query(
            'UPDATE `asterisk`.`sokrat_federation_peers` SET status = ?, last_sync_at = ? WHERE id = ?',
            ['online', now, peerId]
        );
    } catch (_) {}
    try {
        await pool.query(
            `INSERT INTO \`asterisk\`.\`sokrat_federation_node_status\`
                (peer_id, status, last_seen_at)
             VALUES (?, 'online', ?)
             ON DUPLICATE KEY UPDATE status = 'online', last_seen_at = VALUES(last_seen_at)`,
            [peerId, now]
        );
    } catch (_) {}
}

/**
 * Express middleware for `/api/federation/v1`.
 * Every route except the explicit public paths requires a valid HMAC.
 */
function federationAuthMiddleware({ pool, decryptFn, publicPaths = ['/ping'], logger = console } = {}) {
    const publicSet = new Set((publicPaths || []).map(p => String(p).replace(/\/+$/, '') || '/'));
    const getDb = () => (typeof pool === 'function' ? pool() : pool);

    return async function federationAuth(req, res, next) {
        const path = String(req.path || '/');
        if (publicSet.has(path)) return next();

        const siteCode = String(req.headers['x-sokrat-site'] || '').trim();
        const timestamp = String(req.headers['x-sokrat-timestamp'] || '').trim();
        const nonce = String(req.headers['x-sokrat-nonce'] || '').trim();
        const signature = String(req.headers['x-sokrat-signature'] || '').trim();

        if (!siteCode || !timestamp || !nonce || !signature) {
            return res.status(401).json({ success: false, error: 'Federation authentication required' });
        }

        const db = getDb();
        if (!db || typeof decryptFn !== 'function') {
            return res.status(503).json({ success: false, error: 'Federation authentication is not configured' });
        }

        let peer;
        try {
            const [rows] = await db.query(
                'SELECT id, site_code, api_key_enc FROM `asterisk`.`sokrat_federation_peers` WHERE site_code = ? LIMIT 1',
                [siteCode]
            );
            peer = rows && rows[0];
        } catch (err) {
            logger.error('[FederationAuth] Peer lookup failed:', err.message);
            return res.status(503).json({ success: false, error: 'Federation authentication unavailable' });
        }

        if (!peer) {
            logger.warn(`[FederationAuth] Rejected request from unknown site ${siteCode} (${req.ip || ''})`);
            return res.status(401).json({ success: false, error: 'Federation authentication failed' });
        }

        let apiKey = null;
        try {
            apiKey = decryptFn(peer.api_key_enc);
        } catch (_) {}
        if (!apiKey) {
            logger.warn(`[FederationAuth] Peer ${siteCode} has no decryptable API key`);
            return res.status(401).json({ success: false, error: 'Federation authentication failed' });
        }

        const bodyText = req.rawBody ? req.rawBody.toString('utf8') : '';
        const verdict = verifyFederationSignature({
            apiKey,
            siteCode,
            method: req.method,
            url: req.originalUrl,
            bodyText,
            timestamp,
            nonce,
            signature
        });

        if (!verdict.ok) {
            logger.warn(`[FederationAuth] Rejected request from site ${siteCode}: ${verdict.error}`);
            return res.status(401).json({ success: false, error: 'Federation authentication failed' });
        }

        const rate = checkRateLimit(siteCode, req.method);
        if (!rate.allowed) {
            res.set('Retry-After', String(rate.retryAfterSec));
            return res.status(429).json({ success: false, error: 'Federation rate limit exceeded' });
        }

        req.isFederationAuthenticated = true;
        req.federationPeer = peer;
        req.federationSiteCode = siteCode;

        // Do not make the request wait for bookkeeping.
        recordPeerSeen(db, peer.id).catch(() => {});

        return next();
    };
}

module.exports = {
    API_VERSION,
    MAX_CLOCK_SKEW_MS,
    REPLAY_WINDOW_MS,
    canonicalRequest,
    sha256Hex,
    signCanonicalString,
    buildSignatureHeaders,
    verifyFederationSignature,
    normalizeFederationBaseUrl,
    checkRateLimit,
    federationAuthMiddleware,
    _replayCache: replayCache
};
