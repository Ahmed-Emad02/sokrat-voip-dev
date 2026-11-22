'use strict';

const DEFAULT_LIMIT = 300;
const DEFAULT_WINDOW_MS = 60_000;
const buckets = new Map();
let lastCleanup = 0;

function resolveLimit(options = {}) {
    const configured = Number(options.limit || process.env.API_KEY_RATE_LIMIT_PER_MINUTE);
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_LIMIT;
    return Math.min(10000, Math.max(1, Math.floor(configured)));
}

function resolveWindow(options = {}) {
    const configured = Number(options.windowMs || process.env.API_KEY_RATE_LIMIT_WINDOW_MS);
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_WINDOW_MS;
    return Math.min(3_600_000, Math.max(1_000, Math.floor(configured)));
}

function cleanup(now) {
    if (now - lastCleanup < 60_000) return;
    lastCleanup = now;
    for (const [key, bucket] of buckets.entries()) {
        if (!bucket || bucket.resetAt <= now) buckets.delete(key);
    }
}

/**
 * Fixed-window API-key limiter. The key id is used as the primary identity;
 * the client IP is included so a leaked key cannot be sprayed from a second
 * location without also consuming its own bucket.
 */
function checkApiKeyRateLimit(keyId, clientIp, options = {}) {
    const now = Date.now();
    cleanup(now);
    const limit = resolveLimit(options);
    const windowMs = resolveWindow(options);
    const identity = `${String(keyId || 'unknown')}|${String(clientIp || 'unknown')}`;
    let bucket = buckets.get(identity);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(identity, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= limit;
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return {
        allowed,
        limit,
        remaining: Math.max(0, limit - bucket.count),
        resetAt: bucket.resetAt,
        retryAfterSec
    };
}

function resetApiKeyRateLimits() {
    buckets.clear();
    lastCleanup = 0;
}

module.exports = {
    DEFAULT_LIMIT,
    DEFAULT_WINDOW_MS,
    checkApiKeyRateLimit,
    resetApiKeyRateLimits
};
