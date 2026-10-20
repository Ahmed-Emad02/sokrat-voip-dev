'use strict';

/**
 * HMAC authentication for the Chrome extension's direct address-book access.
 *
 * The extension already holds the SIP password for its extension. Instead of
 * sending that password over HTTP, every request is signed:
 *
 *   canonical = extension \n timestamp \n METHOD \n originalUrl
 *   signature = hex(HMAC-SHA256(sip_password, canonical))
 *
 * Headers: X-Sokrat-Extension, X-Sokrat-Timestamp (ms), X-Sokrat-Signature.
 * Timestamps outside a five-minute window are rejected, so a captured request
 * cannot be replayed later. No credential ever travels in the URL or body.
 */

const crypto = require('crypto');
const { lookupExtensionPassword, normalizeExtension } = require('./extension-password');

const MAX_SKEW_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 180;

const rateBuckets = new Map();
const rateTimer = setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [key, timestamps] of rateBuckets.entries()) {
        const fresh = timestamps.filter((ts) => ts > cutoff);
        if (fresh.length === 0) rateBuckets.delete(key);
        else rateBuckets.set(key, fresh);
    }
}, RATE_WINDOW_MS);
if (rateTimer.unref) rateTimer.unref();

function buildCanonical(extension, timestamp, method, originalUrl) {
    return `${extension}\n${timestamp}\n${String(method || 'GET').toUpperCase()}\n${originalUrl}`;
}

function signRequest(password, canonical) {
    return crypto.createHmac('sha256', String(password || '')).update(canonical).digest('hex');
}

function safeEqualHex(expected, provided) {
    const a = Buffer.from(String(expected || ''), 'hex');
    const b = Buffer.from(String(provided || ''), 'hex');
    if (!a.length || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function rateLimited(key) {
    const now = Date.now();
    const bucket = (rateBuckets.get(key) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
    bucket.push(now);
    rateBuckets.set(key, bucket);
    return bucket.length > RATE_LIMIT;
}

function requireExtensionSignature(pool) {
    return async function extensionSignatureMiddleware(req, res, next) {
        const extension = normalizeExtension(req.get('X-Sokrat-Extension'));
        const timestamp = String(req.get('X-Sokrat-Timestamp') || '').trim();
        const signature = String(req.get('X-Sokrat-Signature') || '').trim();

        if (!extension || !timestamp || !signature) {
            return res.status(401).json({
                success: false,
                error: 'Extension authentication is required.',
                code: 'extension_auth_required'
            });
        }

        const ts = Number(timestamp);
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
            return res.status(401).json({
                success: false,
                error: 'The request signature has expired. Check the device clock and try again.',
                code: 'extension_signature_expired'
            });
        }

        if (rateLimited(`${req.ip || 'unknown'}|${extension}`)) {
            return res.status(429).json({
                success: false,
                error: 'Too many requests. Please slow down.',
                code: 'rate_limited'
            });
        }

        try {
            const password = await lookupExtensionPassword(pool, extension);
            if (!password) {
                return res.status(401).json({
                    success: false,
                    error: 'Unknown extension credentials.',
                    code: 'extension_unknown'
                });
            }

            const canonical = buildCanonical(extension, timestamp, req.method, req.originalUrl);
            const expected = signRequest(password, canonical);
            if (!safeEqualHex(expected, signature)) {
                return res.status(401).json({
                    success: false,
                    error: 'Invalid request signature.',
                    code: 'extension_signature_invalid'
                });
            }

            req.sokratExtension = extension;
            return next();
        } catch (err) {
            console.error('[extension-auth] verification failed:', err.message);
            return res.status(503).json({
                success: false,
                error: 'Unable to verify extension credentials.',
                code: 'extension_auth_unavailable'
            });
        }
    };
}

module.exports = {
    requireExtensionSignature,
    buildCanonical,
    signRequest,
    MAX_SKEW_MS
};
