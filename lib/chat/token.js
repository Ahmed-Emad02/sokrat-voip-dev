'use strict';

/**
 * Short-lived chat socket token.
 *
 * The REST API is authenticated with the extension HMAC. The socket handshake
 * cannot replay that signature forever, so the client exchanges it once for a
 * ten-minute signed token.
 */

const crypto = require('crypto');

// Resolve the secret lazily: this module is required before server.js loads
// its .env file, so reading process.env at module load time would silently
// fall back to a random per-process secret and invalidate every token after
// a restart.
let cachedSecret = null;
function chatTokenSecret() {
    if (!cachedSecret) {
        cachedSecret = process.env.CHAT_TOKEN_SECRET
            || process.env.SESSION_SECRET
            || crypto.randomBytes(32).toString('hex');
    }
    return cachedSecret;
}

const TTL_SECONDS = 10 * 60;

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

function issueChatToken(extension) {
    const ext = String(extension || '').trim();
    if (!ext) throw new Error('Extension is required');
    const payload = base64url(JSON.stringify({
        ext,
        exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    }));
    const signature = crypto.createHmac('sha256', chatTokenSecret()).update(payload).digest('base64url');
    return {
        token: `${payload}.${signature}`,
        expires_at: new Date((Math.floor(Date.now() / 1000) + TTL_SECONDS) * 1000).toISOString(),
        ttl_seconds: TTL_SECONDS,
    };
}

function verifyChatToken(token) {
    const raw = String(token || '');
    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) return null;
    const payload = raw.slice(0, dot);
    const provided = raw.slice(dot + 1);
    const expected = crypto.createHmac('sha256', chatTokenSecret()).update(payload).digest('base64url');
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data || !data.ext || !Number.isFinite(Number(data.exp))) return null;
        if (Number(data.exp) <= Math.floor(Date.now() / 1000)) return null;
        return String(data.ext);
    } catch (_) {
        return null;
    }
}

module.exports = { issueChatToken, verifyChatToken, TTL_SECONDS };
