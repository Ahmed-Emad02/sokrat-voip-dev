/**
 * CRM Integration Authentication, Scopes, Pairing & Audit Module
 */

const crypto = require('crypto');

const SUPPORTED_SCOPES = new Set([
    'extensions:read',
    'calls:read',
    'recordings:read',
    'stats:read',
    'live:read',
    'live:listen',
    'live:whisper',
    'live:barge',
    'live:hangup',
    'live:hijack',
    'softphone:use'
]);

const DEFAULT_READ_SCOPES = [
    'extensions:read',
    'calls:read',
    'recordings:read',
    'stats:read',
    'live:read',
    'softphone:use'
];

// In-memory throttles with periodic cleanup
const lastUsedUpdateCache = new Map();

const lastUsedCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, t] of lastUsedUpdateCache.entries()) {
        if (now - t > 120000) lastUsedUpdateCache.delete(k);
    }
}, 5 * 60 * 1000);
if (lastUsedCleanupTimer.unref) lastUsedCleanupTimer.unref();

/**
 * Safe JSON serializer for HTML script blocks
 * Escapes <, >, &, \u2028, \u2029 to prevent XSS script breakouts
 * @param {*} value
 * @returns {string}
 */
function safeJsonSerialize(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * Validate and normalize an allowed origin URL
 * @param {string} rawUrl
 * @returns {string|null} Canonical origin string (http://domain:port or https://domain:port) or null if invalid
 */
function validateOriginUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const str = rawUrl.trim();
    if (str === '*' || str === 'null' || /[\r\n\0]/.test(str)) return null;
    try {
        const parsed = new URL(str);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        if (parsed.search || parsed.hash) return null;
        if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
        return parsed.origin;
    } catch (_) {
        return null;
    }
}

/**
 * Initialize CRM integration database tables
 * @param {object} conn MySQL connection or pool
 */
async function initCrmTables(conn) {
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`asterisk\`.\`dashboard_crm_clients\` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            client_id VARCHAR(64) NOT NULL UNIQUE,
            name VARCHAR(100) NOT NULL,
            secret_hash VARCHAR(255) NOT NULL,
            allowed_origin VARCHAR(255) NOT NULL,
            default_country_code VARCHAR(10) NOT NULL DEFAULT '20',
            allowed_scopes TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_used_at DATETIME DEFAULT NULL,
            revoked_at DATETIME DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`asterisk\`.\`dashboard_crm_pairing_codes\` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            code_hash VARCHAR(255) NOT NULL UNIQUE,
            expires_at DATETIME NOT NULL,
            used_at DATETIME DEFAULT NULL,
            created_by VARCHAR(100) NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`asterisk\`.\`dashboard_crm_embed_tickets\` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ticket_hash VARCHAR(255) NOT NULL UNIQUE,
            session_token_hash VARCHAR(255) DEFAULT NULL UNIQUE,
            client_id VARCHAR(64) NOT NULL,
            crm_user_id VARCHAR(100) NOT NULL,
            crm_user_name VARCHAR(100) NOT NULL,
            supervisor_extension VARCHAR(20) DEFAULT NULL,
            effective_scopes TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            consumed_at DATETIME DEFAULT NULL,
            session_expires_at DATETIME DEFAULT NULL,
            KEY idx_session_hash (session_token_hash)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`asterisk\`.\`dashboard_crm_audit_logs\` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            client_id VARCHAR(64) NOT NULL,
            crm_user_id VARCHAR(100) DEFAULT NULL,
            supervisor_extension VARCHAR(20) DEFAULT NULL,
            target_extension VARCHAR(20) DEFAULT NULL,
            action VARCHAR(50) NOT NULL,
            success TINYINT(1) NOT NULL DEFAULT 1,
            details TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Schema version check for one-time group permission migration
    const [verRows] = await conn.execute(`
        SELECT setting_value FROM \`asterisk\`.\`dashboard_settings\` WHERE setting_key = 'action_permissions_migrated'
    `);

    if (verRows.length === 0) {
        try {
            const [rows] = await conn.execute("SELECT DISTINCT group_id FROM `asterisk`.`dashboard_group_permissions` WHERE tab = 'operator'");
            const actionPerms = ['operator-listen', 'operator-whisper', 'operator-barge', 'operator-hangup', 'operator-hijack'];
            for (const row of rows) {
                for (const perm of actionPerms) {
                    await conn.execute(
                        "INSERT IGNORE INTO `asterisk`.`dashboard_group_permissions` (group_id, tab) VALUES (?, ?)",
                        [row.group_id, perm]
                    );
                }
            }
            await conn.execute("INSERT INTO `asterisk`.`dashboard_settings` (setting_key, setting_value) VALUES ('action_permissions_migrated', '1')");
        } catch (_) {}
    }
}

/**
 * Hash a secret using SHA-256
 * @param {string} secret
 * @returns {string} Hex hash string
 */
function hashSecret(secret) {
    return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}

/**
 * Perform a timing-safe hash comparison
 * @param {string} a Hex string
 * @param {string} b Hex string
 * @returns {boolean}
 */
function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generate a random pairing code (8 uppercase alphanumeric chars)
 * @returns {string} Raw code
 */
function generateRawPairingCode() {
    return crypto.randomBytes(6).toString('base64url').substring(0, 8).toUpperCase();
}

/**
 * Generate and store a new 10-minute single-use pairing code
 * @param {object} db Pool or connection
 * @param {string} createdBy Username of administrator creating the code
 * @returns {Promise<{ rawCode: string, expiresAt: Date }>}
 */
async function createPairingCode(db, createdBy) {
    const rawCode = generateRawPairingCode();
    const codeHash = hashSecret(rawCode);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db.query(
        'INSERT INTO `asterisk`.`dashboard_crm_pairing_codes` (code_hash, expires_at, created_by) VALUES (?, ?, ?)',
        [codeHash, expiresAt, createdBy || 'admin']
    );

    return { rawCode, expiresAt };
}

/**
 * Create a new integration client record and consume pairing code atomically
 * @param {object} db
 * @param {object} params { pairingCode, name, origin, defaultCountryCode, allowedScopes }
 * @returns {Promise<{ clientId: string, rawSecret: string, bearerToken: string, scopes: string[] }|null>}
 */
async function createIntegrationClient(db, params) {
    const { pairingCode, name, origin, defaultCountryCode, allowedScopes } = params;
    if (!pairingCode || !origin) return null;

    const validOrigin = validateOriginUrl(origin);
    if (!validOrigin) return null;

    const codeHash = hashSecret(pairingCode.trim());

    // Single atomic transaction
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // 1. Mark code used atomically
        const [codeResult] = await conn.query(
            'UPDATE `asterisk`.`dashboard_crm_pairing_codes` SET used_at = NOW() WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW()',
            [codeHash]
        );

        if (codeResult.affectedRows !== 1) {
            await conn.rollback();
            conn.release();
            return null;
        }

        const clientId = 'crm_' + crypto.randomBytes(8).toString('hex');
        const rawSecret = crypto.randomBytes(32).toString('hex');
        const secretHash = hashSecret(rawSecret);

        const scopes = Array.isArray(allowedScopes) ? allowedScopes : DEFAULT_READ_SCOPES;
        const validatedScopes = scopes.filter(s => SUPPORTED_SCOPES.has(s));
        const cc = (defaultCountryCode || '20').replace(/\D/g, '') || '20';

        await conn.query(
            `INSERT INTO \`asterisk\`.\`dashboard_crm_clients\` (client_id, name, secret_hash, allowed_origin, default_country_code, allowed_scopes)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [clientId, name, secretHash, validOrigin, cc, JSON.stringify(validatedScopes)]
        );

        await conn.commit();
        conn.release();

        const bearerToken = `${clientId}.${rawSecret}`;
        return { clientId, rawSecret, bearerToken, scopes: validatedScopes };
    } catch (err) {
        await conn.rollback();
        conn.release();
        throw err;
    }
}

/**
 * Authenticate Bearer token (<client-id>.<secret>) against database
 * @param {object} db
 * @param {string} token
 * @returns {Promise<object|null>} Client record if valid and active
 */
async function authenticateClientToken(db, token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 2) return null;

    const [clientId, rawSecret] = parts;
    const computedHash = hashSecret(rawSecret);

    const [rows] = await db.query(
        'SELECT id, client_id, name, secret_hash, allowed_origin, default_country_code, allowed_scopes, revoked_at FROM `asterisk`.`dashboard_crm_clients` WHERE client_id = ? AND revoked_at IS NULL',
        [clientId]
    );

    if (rows.length === 0) return null;
    const client = rows[0];

    if (!timingSafeCompare(computedHash, client.secret_hash)) {
        return null;
    }

    try {
        client.scopes = typeof client.allowed_scopes === 'string' ? JSON.parse(client.allowed_scopes) : client.allowed_scopes;
        if (!Array.isArray(client.scopes)) client.scopes = [];
    } catch (_) {
        client.scopes = [];
    }

    const now = Date.now();
    const lastUpdate = lastUsedUpdateCache.get(clientId) || 0;
    if (now - lastUpdate > 60000) {
        lastUsedUpdateCache.set(clientId, now);
        db.query('UPDATE `asterisk`.`dashboard_crm_clients` SET last_used_at = NOW() WHERE id = ?', [client.id]).catch(() => {});
    }

    return client;
}

/**
 * Calculate scope intersection
 * @param {string[]} clientScopes
 * @param {string[]} requestedScopes
 * @returns {string[]}
 */
function calculateEffectiveScopes(clientScopes = [], requestedScopes = []) {
    const clientSet = new Set(clientScopes);
    const reqSet = new Set(requestedScopes);
    return Array.from(SUPPORTED_SCOPES).filter(s => clientSet.has(s) && reqSet.has(s));
}

/**
 * Create a single-use 60s embed ticket
 * @param {object} db
 * @param {object} client
 * @param {object} params { crmUserId, crmUserName, supervisorExtension, requestedScopes }
 * @returns {Promise<{ rawTicket: string, expiresAt: Date, effectiveScopes: string[] }>}
 */
async function createEmbedTicket(db, client, params) {
    const { crmUserId, crmUserName, supervisorExtension, extension, requestedScopes } = params;
    const resolvedExt = extension ? String(extension) : (supervisorExtension ? String(supervisorExtension) : null);

    const rawTicket = 'tkt_' + crypto.randomBytes(24).toString('base64url');
    const ticketHash = hashSecret(rawTicket);
    const expiresAt = new Date(Date.now() + 60 * 1000); // 60s TTL

    const clientScopes = Array.isArray(client.scopes) ? client.scopes : JSON.parse(client.allowed_scopes || '[]');
    const effectiveScopes = calculateEffectiveScopes(clientScopes, requestedScopes || []);

    await db.query(
        `INSERT INTO \`asterisk\`.\`dashboard_crm_embed_tickets\`
         (ticket_hash, client_id, crm_user_id, crm_user_name, supervisor_extension, effective_scopes, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ticketHash, client.client_id, crmUserId, crmUserName, resolvedExt, JSON.stringify(effectiveScopes), expiresAt]
    );

    return { rawTicket, expiresAt, effectiveScopes };
}

/**
 * @param {object} db
 * @param {string} rawTicket
 * @param {string|null} requiredScope
 * @returns {Promise<{ sessionToken: string, ticket: object }|null>}
 */
async function consumeEmbedTicket(db, rawTicket, requiredScope = null) {
    if (!rawTicket || typeof rawTicket !== 'string') return null;
    const cleanTicket = String(rawTicket).split('?')[0].split('&')[0].trim();
    if (!cleanTicket) return null;
    const ticketHash = hashSecret(cleanTicket);

    const [rows] = await db.query(
        `SELECT t.*, c.allowed_origin, c.revoked_at
         FROM \`asterisk\`.\`dashboard_crm_embed_tickets\` t
         JOIN \`asterisk\`.\`dashboard_crm_clients\` c ON c.client_id = t.client_id
         WHERE t.ticket_hash = ? AND c.revoked_at IS NULL`,
        [ticketHash]
    );

    if (rows.length === 0) return null;
    const ticket = rows[0];
    if (ticket.consumed_at || !ticket.expires_at || new Date(ticket.expires_at).getTime() <= Date.now()) {
        return null;
    }

    try {
        ticket.scopes = JSON.parse(ticket.effective_scopes || '[]');
    } catch (_) {
        return null;
    }
    if (!Array.isArray(ticket.scopes) || (requiredScope && !ticket.scopes.includes(requiredScope))) {
        return null;
    }

    const sessionToken = 'ses_' + crypto.randomBytes(32).toString('base64url');
    const sessionHash = hashSecret(sessionToken);
    const sessionExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const [result] = await db.query(
        `UPDATE \`asterisk\`.\`dashboard_crm_embed_tickets\`
         SET consumed_at = NOW(), session_token_hash = ?, session_expires_at = ?
         WHERE id = ? AND consumed_at IS NULL AND expires_at > NOW()`,
        [sessionHash, sessionExpiresAt, ticket.id]
    );
    if (!result || result.affectedRows !== 1) return null;

    return { sessionToken, ticket };
}

/**
 * Verify an active embed session token
 * @param {object} db
 * @param {string} sessionToken
 * @returns {Promise<object|null>}
 */
async function verifyEmbedSession(db, sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') return null;
    const sessionHash = hashSecret(sessionToken.trim());

    const [rows] = await db.query(
        'SELECT * FROM `asterisk`.`dashboard_crm_embed_tickets` WHERE session_token_hash = ?',
        [sessionHash]
    );

    if (rows.length === 0) return null;
    const session = rows[0];

    if (!session.session_expires_at || new Date(session.session_expires_at) < new Date()) {
        return null;
    }

    // Verify parent client is not revoked
    const [clientRows] = await db.query(
        'SELECT allowed_origin, revoked_at FROM `asterisk`.`dashboard_crm_clients` WHERE client_id = ?',
        [session.client_id]
    );

    if (clientRows.length === 0 || clientRows[0].revoked_at !== null) {
        return null;
    }

    session.allowed_origin = clientRows[0].allowed_origin;
    session.scopes = JSON.parse(session.effective_scopes || '[]');
    return session;
}

/**
 * Log CRM live control audit event
 * @param {object} db
 * @param {object} event { clientId, crmUserId, supervisorExtension, targetExtension, action, success, details }
 */
async function logCrmAudit(db, event) {
    try {
        const { clientId, crmUserId, supervisorExtension, targetExtension, action, success, details } = event;
        const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details || '');

        await db.query(
            `INSERT INTO \`asterisk\`.\`dashboard_crm_audit_logs\`
             (client_id, crm_user_id, supervisor_extension, target_extension, action, success, details)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [clientId, crmUserId || null, supervisorExtension || null, targetExtension || null, action, success ? 1 : 0, detailsStr]
        );
    } catch (err) {
        console.error('logCrmAudit error:', err.message);
    }
}

module.exports = {
    SUPPORTED_SCOPES,
    DEFAULT_READ_SCOPES,
    initCrmTables,
    validateOriginUrl,
    safeJsonSerialize,
    hashSecret,
    timingSafeCompare,
    createPairingCode,
    createIntegrationClient,
    authenticateClientToken,
    calculateEffectiveScopes,
    createEmbedTicket,
    consumeEmbedTicket,
    verifyEmbedSession,
    logCrmAudit
};
