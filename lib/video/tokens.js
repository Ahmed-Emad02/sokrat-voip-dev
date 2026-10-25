'use strict';

/**
 * LiveKit access tokens.
 *
 * This intentionally implements the small HS256 JWT contract directly so the
 * PBX does not need the LiveKit server SDK in its dependency tree. The API
 * secret never leaves the server.
 */

const crypto = require('crypto');
const rooms = require('./rooms');

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

function getConfig() {
    const url = String(process.env.LIVEKIT_URL || '').trim().replace(/\/+$/, '');
    const apiKey = String(process.env.LIVEKIT_API_KEY || '').trim();
    const apiSecret = String(process.env.LIVEKIT_API_SECRET || '').trim();
    const ttl = Number(process.env.LIVEKIT_TOKEN_TTL || 7200);
    return {
        url,
        apiKey,
        apiSecret,
        ttl: Number.isFinite(ttl) ? Math.min(86400, Math.max(60, Math.floor(ttl))) : 7200,
    };
}

function isConfigured() {
    const config = getConfig();
    return Boolean(config.url && config.apiKey && config.apiSecret);
}

function issueToken({ roomName, extension, name, role }) {
    const config = getConfig();
    if (!isConfigured()) {
        throw rooms.httpError(503, 'Video conferencing is not configured on this PBX.', 'video_not_configured');
    }
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: config.apiKey,
        sub: String(extension),
        name: String(name || extension),
        nbf: now - 5,
        exp: now + config.ttl,
        video: {
            roomJoin: true,
            room: String(roomName),
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
            roomAdmin: role === 'owner',
        },
        metadata: JSON.stringify({
            extension: String(extension),
            role: role || 'member',
        }),
    };
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64url(JSON.stringify(payload));
    const signature = crypto
        .createHmac('sha256', config.apiSecret)
        .update(`${header}.${body}`)
        .digest('base64url');
    return {
        token: `${header}.${body}.${signature}`,
        livekit_url: config.url,
        expires_at: new Date((now + config.ttl) * 1000).toISOString(),
        ttl_seconds: config.ttl,
    };
}

module.exports = {
    getConfig,
    isConfigured,
    issueToken,
};
