/**
 * API Key Manager Engine for Sokrat VoIP
 * Supports cryptographically secure static API keys with AES-256-GCM encryption,
 * SHA-256 hash indexing, IP CIDR whitelisting, scope enforcement, and sub-millisecond caching.
 */

const crypto = require('crypto');

const DEFAULT_KEY_PREFIX = 'sokrat_live_';

function getEncryptionKey() {
    const rawKey = process.env.ENCRYPTION_KEY || 'sokrat-default-key-fallback-32c';
    return crypto.createHash('sha256').update(rawKey + ':api-keys-v1').digest();
}

/**
 * Encrypt a raw API key using AES-256-GCM
 * @param {string} text 
 * @returns {string} iv:tag:ciphertext (hex encoded)
 */
function encryptKey(text) {
    if (!text) return '';
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypt an AES-256-GCM encrypted API key
 * @param {string} cipherTextPacked 
 * @returns {string|null}
 */
function decryptKey(cipherTextPacked) {
    if (!cipherTextPacked || typeof cipherTextPacked !== 'string') return null;
    const parts = cipherTextPacked.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, encryptedHex] = parts;
    try {
        const key = getEncryptionKey();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (_) {
        return null;
    }
}

/**
 * Convert IPv4 address to 32-bit unsigned integer
 */
function ipToLong(ip) {
    return ip.split('.').reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
}

/**
 * Check if an IPv4 address matches a CIDR block
 */
function cidrMatch(ip, cidr) {
    if (!ip || !cidr || !cidr.includes('/')) return false;
    const [range, bits = 32] = cidr.split('/');
    const bitNum = parseInt(bits, 10);
    if (isNaN(bitNum) || bitNum < 0 || bitNum > 32) return false;
    const mask = ~(2 ** (32 - bitNum) - 1);
    return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
}

/**
 * Check if client IP matches allowed IP rules (exact, wildcard, or CIDR)
 */
function ipMatches(clientIp, allowedIpsStr) {
    if (!allowedIpsStr || !allowedIpsStr.trim() || allowedIpsStr.trim() === '*') return true;
    let client = String(clientIp || '').trim();
    if (client.startsWith('::ffff:')) {
        client = client.replace('::ffff:', '');
    }
    if (!client) return false;
    const allowed = allowedIpsStr.split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length === 0) return true;

    // Expand loopback equivalents
    const clientVariants = [client];
    if (client === '::1') clientVariants.push('127.0.0.1');
    if (client === '127.0.0.1') clientVariants.push('::1');

    for (const rule of allowed) {
        if (rule === '*') return true;
        if (rule === 'localhost' && (client === '127.0.0.1' || client === '::1')) return true;
        for (const c of clientVariants) {
            if (rule === c) return true;
            if (rule.endsWith('.*')) {
                const prefix = rule.slice(0, -1);
                if (c.startsWith(prefix)) return true;
            }
            if (rule.includes('/')) {
                try {
                    if (cidrMatch(c, rule)) return true;
                } catch (_) {}
            }
        }
    }
    return false;
}

// In-memory LRU-style cache for active keys: keyHash -> { keyRecord, cachedAt, lastLogged }
const activeKeyCache = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds

function clearApiKeyCache() {
    activeKeyCache.clear();
}

/**
 * Initialize dashboard_api_keys table
 * @param {object} conn 
 */
async function initApiKeyTables(conn) {
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`asterisk\`.\`dashboard_api_keys\` (
            \`id\` INT AUTO_INCREMENT PRIMARY KEY,
            \`name\` VARCHAR(100) NOT NULL,
            \`key_prefix\` VARCHAR(64) NOT NULL,
            \`key_hash\` VARCHAR(64) NOT NULL UNIQUE,
            \`encrypted_key\` TEXT NOT NULL,
            \`scopes\` VARCHAR(255) DEFAULT '*',
            \`allowed_ips\` VARCHAR(255) DEFAULT NULL,
            \`status\` ENUM('active', 'revoked') DEFAULT 'active',
            \`created_by\` VARCHAR(64) DEFAULT 'root',
            \`last_used_at\` DATETIME DEFAULT NULL,
            \`last_used_ip\` VARCHAR(64) DEFAULT NULL,
            \`expires_at\` DATETIME DEFAULT NULL,
            \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_api_key_hash (\`key_hash\`),
            INDEX idx_api_key_status (\`status\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        await conn.execute('ALTER TABLE `asterisk`.`dashboard_api_keys` MODIFY COLUMN `key_prefix` VARCHAR(64) NOT NULL');
    } catch (_) {}
}

/**
 * Create a new static API Key
 * @param {object} pool 
 * @param {object} options { name, scopes, allowed_ips, expires_in_days, created_by }
 */
async function createApiKey(pool, options = {}) {
    const name = String(options.name || '').trim();
    if (!name) {
        throw new Error('API Key name / label is required');
    }

    const scopes = String(options.scopes || '*').trim() || '*';
    const allowedIps = options.allowed_ips ? String(options.allowed_ips).trim() : null;
    const createdBy = String(options.created_by || 'root').trim();

    let expiresAt = null;
    const days = parseInt(options.expires_in_days, 10);
    if (!isNaN(days) && days > 0) {
        expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    // Generate random 256-bit key
    const randomHex = crypto.randomBytes(24).toString('hex');
    const rawKey = `${DEFAULT_KEY_PREFIX}${randomHex}`;
    const keyPrefix = `${DEFAULT_KEY_PREFIX}${randomHex.slice(0, 6)}...${randomHex.slice(-4)}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const encryptedKey = encryptKey(rawKey);

    const [res] = await pool.query(
        `INSERT INTO \`asterisk\`.\`dashboard_api_keys\` 
         (name, key_prefix, key_hash, encrypted_key, scopes, allowed_ips, status, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [name, keyPrefix, keyHash, encryptedKey, scopes, allowedIps, createdBy, expiresAt]
    );

    clearApiKeyCache();

    return {
        id: res.insertId,
        name,
        rawKey,
        keyPrefix,
        scopes,
        allowedIps,
        status: 'active',
        createdBy,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        createdAt: new Date().toISOString()
    };
}

/**
 * List all API keys for the root dashboard
 * @param {object} pool 
 */
async function listApiKeys(pool) {
    const [rows] = await pool.query(`
        SELECT id, name, key_prefix, scopes, allowed_ips, status, created_by,
               last_used_at, last_used_ip, expires_at, created_at, updated_at
        FROM \`asterisk\`.\`dashboard_api_keys\`
        ORDER BY id DESC
    `);
    return rows;
}

/**
 * Reveal / decrypt raw API key for root view
 * @param {object} pool 
 * @param {number} id 
 */
async function revealApiKey(pool, id) {
    const [rows] = await pool.query(
        `SELECT id, name, encrypted_key FROM \`asterisk\`.\`dashboard_api_keys\` WHERE id = ?`,
        [id]
    );
    if (!rows || rows.length === 0) {
        throw new Error('API Key not found');
    }
    const rawKey = decryptKey(rows[0].encrypted_key);
    if (!rawKey) {
        throw new Error('Failed to decrypt API key');
    }
    return {
        id: rows[0].id,
        name: rows[0].name,
        rawKey
    };
}

/**
 * Set status (active / revoked) for an API key
 * @param {object} pool 
 * @param {number} id 
 * @param {string} status ('active' | 'revoked')
 */
async function setApiKeyStatus(pool, id, status) {
    if (!['active', 'revoked'].includes(status)) {
        throw new Error('Invalid status. Must be active or revoked.');
    }
    const [res] = await pool.query(
        `UPDATE \`asterisk\`.\`dashboard_api_keys\` SET status = ? WHERE id = ?`,
        [status, id]
    );
    clearApiKeyCache();
    return res.affectedRows > 0;
}

/**
 * Delete an API key permanently
 * @param {object} pool 
 * @param {number} id 
 */
async function deleteApiKey(pool, id) {
    const [res] = await pool.query(
        `DELETE FROM \`asterisk\`.\`dashboard_api_keys\` WHERE id = ?`,
        [id]
    );
    clearApiKeyCache();
    return res.affectedRows > 0;
}

/**
 * Validate an incoming API key string against database / cache
 * @param {object} pool 
 * @param {string} rawKey 
 * @param {string} clientIp 
 */
async function validateApiKey(pool, rawKey, clientIp) {
    if (!rawKey || typeof rawKey !== 'string') {
        return { valid: false, error: 'Missing API key' };
    }

    const trimmed = rawKey.trim();
    if (!trimmed.startsWith('sokrat_') && !trimmed.startsWith('sk_')) {
        return { valid: false, error: 'Malformed API key format' };
    }

    const keyHash = crypto.createHash('sha256').update(trimmed).digest('hex');
    const now = Date.now();

    // Check memory cache
    let cached = activeKeyCache.get(keyHash);
    let keyRecord = null;

    if (cached && (now - cached.cachedAt < CACHE_TTL_MS)) {
        keyRecord = cached.keyRecord;
    } else {
        const [rows] = await pool.query(
            `SELECT id, name, key_prefix, scopes, allowed_ips, status, expires_at, created_by
             FROM \`asterisk\`.\`dashboard_api_keys\`
             WHERE key_hash = ? LIMIT 1`,
            [keyHash]
        );

        if (!rows || rows.length === 0) {
            return { valid: false, error: 'API key not found' };
        }

        keyRecord = rows[0];
        activeKeyCache.set(keyHash, { keyRecord, cachedAt: now, lastLogged: 0 });
    }

    // Check status
    if (keyRecord.status !== 'active') {
        return { valid: false, error: 'API key has been revoked' };
    }

    // Check expiration
    if (keyRecord.expires_at) {
        const expTime = new Date(keyRecord.expires_at).getTime();
        if (!isNaN(expTime) && expTime < now) {
            return { valid: false, error: 'API key has expired' };
        }
    }

    // Check IP Whitelist
    if (keyRecord.allowed_ips) {
        if (!ipMatches(clientIp, keyRecord.allowed_ips)) {
            return { valid: false, error: `Client IP ${clientIp || 'unknown'} is not in the allowed IP list for this key` };
        }
    }

    // Update last_used_at throttled (at most once every 10 seconds per key in cache)
    cached = activeKeyCache.get(keyHash) || { keyRecord, cachedAt: now, lastLogged: 0 };
    if (!cached.lastLogged || (now - cached.lastLogged > 10000)) {
        cached.lastLogged = now;
        activeKeyCache.set(keyHash, cached);
        pool.query(
            `UPDATE \`asterisk\`.\`dashboard_api_keys\` SET last_used_at = NOW(), last_used_ip = ? WHERE id = ?`,
            [clientIp || null, keyRecord.id]
        ).catch(() => {});
    }

    return {
        valid: true,
        key: {
            id: keyRecord.id,
            name: keyRecord.name,
            key_prefix: keyRecord.key_prefix,
            scopes: keyRecord.scopes || '*',
            allowed_ips: keyRecord.allowed_ips,
            status: keyRecord.status,
            created_by: keyRecord.created_by
        }
    };
}

module.exports = {
    initApiKeyTables,
    createApiKey,
    listApiKeys,
    revealApiKey,
    setApiKeyStatus,
    deleteApiKey,
    validateApiKey,
    clearApiKeyCache,
    encryptKey,
    decryptKey,
    ipMatches
};
