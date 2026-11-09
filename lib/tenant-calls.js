'use strict';

/**
 * Sokrat Cloud Tenants — public click-to-call.
 *
 * Each tenant gets:
 *   - its own FreePBX ring group
 *   - a pool of hidden PJSIP guest endpoints
 *   - a locked-down dialplan context that can only dial that ring group
 *   - one or more public links that lease a guest endpoint per call
 *
 * The code deliberately does not create a FreePBX extension per click. Pools are
 * provisioned once and leased from the database, so a click never triggers a
 * PJSIP reload.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const ASTERISK_BIN = process.env.ASTERISK_BIN || '/usr/sbin/asterisk';
const RETRIEVE_CONF = process.env.SOKRAT_RETRIEVE_CONF || '/var/lib/asterisk/bin/retrieve_conf';
const DEFAULT_PJSIP_FILE = process.env.SOKRAT_WEBGUEST_PJSIP_FILE || '/etc/asterisk/pjsip_custom_post.conf';
const DEFAULT_DIALPLAN_FILE = process.env.SOKRAT_WEBGUEST_DIALPLAN_FILE || '/etc/asterisk/extensions_sokrat_webcall.conf';
const DEFAULT_EXTENSIONS_CUSTOM = process.env.SOKRAT_EXTENSIONS_CUSTOM_FILE || '/etc/asterisk/extensions_custom.conf';
const PJSIP_BEGIN = '; BEGIN SOKRAT WEBGUEST POOL';
const PJSIP_END = '; END SOKRAT WEBGUEST POOL';
const DIALPLAN_INCLUDE = '#include extensions_sokrat_webcall.conf';
const ACTIVE_SESSION_STATUSES = ['pending', 'registered', 'calling', 'answered'];
const GUEST_EXTENSION_MIN = 7000;
const GUEST_EXTENSION_MAX = 7999;

const TABLE_SQL = [
    `CREATE TABLE IF NOT EXISTS \`sokrat_tenants\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`public_id\` VARCHAR(24) NOT NULL,
        \`name\` VARCHAR(120) NOT NULL,
        \`status\` ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
        \`ring_group\` VARCHAR(20) NOT NULL,
        \`timezone\` VARCHAR(64) NOT NULL DEFAULT 'Africa/Cairo',
        \`max_concurrency\` SMALLINT UNSIGNED NOT NULL DEFAULT 5,
        \`max_call_seconds\` INT UNSIGNED NOT NULL DEFAULT 1800,
        \`recording_enabled\` TINYINT(1) NOT NULL DEFAULT 1,
        \`branding_json\` TEXT DEFAULT NULL,
        \`consent_text\` VARCHAR(500) DEFAULT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_sokrat_tenants_public_id\` (\`public_id\`),
        UNIQUE KEY \`uq_sokrat_tenants_ring_group\` (\`ring_group\`),
        KEY \`idx_sokrat_tenants_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sokrat_tenant_links\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\` INT UNSIGNED NOT NULL,
        \`slug\` VARCHAR(32) NOT NULL,
        \`label\` VARCHAR(100) NOT NULL DEFAULT 'Website',
        \`source\` VARCHAR(100) DEFAULT NULL,
        \`allowed_origins\` TEXT DEFAULT NULL,
        \`branding_json\` TEXT DEFAULT NULL,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`max_calls\` INT UNSIGNED DEFAULT NULL,
        \`expires_at\` DATETIME DEFAULT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_sokrat_tenant_links_slug\` (\`slug\`),
        KEY \`idx_sokrat_tenant_links_tenant\` (\`tenant_id\`, \`active\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sokrat_tenant_agents\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\` INT UNSIGNED NOT NULL,
        \`extension\` VARCHAR(20) NOT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_sokrat_tenant_agent\` (\`tenant_id\`, \`extension\`),
        KEY \`idx_sokrat_tenant_agent_ext\` (\`extension\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sokrat_guest_endpoints\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\` INT UNSIGNED NOT NULL,
        \`sip_username\` VARCHAR(64) NOT NULL,
        \`sip_secret_enc\` TEXT NOT NULL,
        \`status\` ENUM('free','leased','disabled') NOT NULL DEFAULT 'free',
        \`lease_session_id\` VARCHAR(40) DEFAULT NULL,
        \`lease_expires_at\` DATETIME DEFAULT NULL,
        \`last_used_at\` DATETIME DEFAULT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_sokrat_guest_sip_username\` (\`sip_username\`),
        KEY \`idx_sokrat_guest_tenant_status\` (\`tenant_id\`, \`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sokrat_web_sessions\` (
        \`id\` CHAR(32) NOT NULL,
        \`tenant_id\` INT UNSIGNED NOT NULL,
        \`link_id\` INT UNSIGNED DEFAULT NULL,
        \`endpoint_id\` INT UNSIGNED DEFAULT NULL,
        \`caller_id\` VARCHAR(32) NOT NULL,
        \`linkedid\` VARCHAR(64) DEFAULT NULL,
        \`status\` ENUM('pending','registered','calling','answered','ended','failed','expired') NOT NULL DEFAULT 'pending',
        \`ip_hash\` CHAR(64) DEFAULT NULL,
        \`origin\` VARCHAR(255) DEFAULT NULL,
        \`source\` VARCHAR(100) DEFAULT NULL,
        \`user_agent\` VARCHAR(255) DEFAULT NULL,
        \`started_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`expires_at\` DATETIME NOT NULL,
        \`connected_at\` DATETIME DEFAULT NULL,
        \`ended_at\` DATETIME DEFAULT NULL,
        \`duration_sec\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`hangup_cause\` VARCHAR(64) DEFAULT NULL,
        \`recording_ref\` VARCHAR(255) DEFAULT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`idx_sokrat_web_sessions_tenant\` (\`tenant_id\`, \`status\`, \`started_at\`),
        KEY \`idx_sokrat_web_sessions_link\` (\`link_id\`),
        KEY \`idx_sokrat_web_sessions_linkedid\` (\`linkedid\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

function randomToken(bytes = 18) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function randomHex(bytes = 4) {
    return crypto.randomBytes(bytes).toString('hex');
}

function randomGuestNumber() {
    return String(crypto.randomInt(100000, 1000000));
}

function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function normalizeExtensions(value) {
    const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
    const seen = new Set();
    for (const item of list) {
        const ext = String(item == null ? '' : item).trim();
        if (/^\d{1,20}$/.test(ext)) seen.add(ext);
    }
    return [...seen];
}

function normalizeRingGroupMembers(value) {
    return normalizeExtensions(String(value == null ? '' : value).split(/[-#]+/).join(' '));
}

function normalizeOrigin(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw || raw === '*' || raw === 'null') return null;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        return parsed.origin;
    } catch (_) {
        return null;
    }
}

function normalizeOrigins(value) {
    let list = value;
    if (typeof list === 'string') {
        try {
            const parsed = JSON.parse(list);
            list = Array.isArray(parsed) ? parsed : list.split(/[\s,;]+/);
        } catch (_) {
            list = list.split(/[\s,;]+/);
        }
    }
    if (!Array.isArray(list)) list = [];
    const seen = new Set();
    for (const item of list) {
        const origin = normalizeOrigin(item);
        if (origin) seen.add(origin);
    }
    return [...seen];
}

function sanitizeCallerName(value) {
    const clean = String(value == null ? '' : value)
        .replace(/["'\\\r\n;,$<>{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48);
    return clean || 'Business';
}

function slugifyTenantName(value) {
    const base = String(value == null ? '' : value)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 18)
        .replace(/-+$/g, '');
    return base || 'business';
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceManagedBlock(content, begin, end, block) {
    const source = String(content || '');
    const pattern = new RegExp(`\\n?${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, 'g');
    const stripped = source.replace(pattern, '').trimEnd();
    const prefix = stripped ? `${stripped}\n\n` : '';
    return `${prefix}${block.trimEnd()}\n`;
}

function writeFileAtomic(filePath, content) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(temp, filePath);
}

function buildGuestEndpointSection(tenant, endpoint) {
    const id = Number(tenant.id);
    const username = String(endpoint.sip_username);
    const secret = String(endpoint.secret || '');
    const section = [
        `[${username}]`,
        'type=endpoint',
        `context=from-webguest-${id}`,
        'disallow=all',
        'allow=opus,ulaw,alaw',
        'webrtc=yes',
        'media_encryption=dtls',
        'dtls_cert_file=/etc/asterisk/keys/asterisk.pem',
        'dtls_private_key=/etc/asterisk/keys/asterisk.key',
        'dtls_verify=fingerprint',
        'dtls_setup=actpass',
        'ice_support=yes',
        'use_avpf=yes',
        'rtcp_mux=yes',
        'force_rport=yes',
        'rewrite_contact=yes',
        'direct_media=no',
        'rtp_symmetric=yes',
        'rtp_timeout=30',
        'rtp_timeout_hold=60',
        'rtp_keepalive=5',
        'allow_transfer=no',
        'allow_subscribe=no',
        'timers=no',
        `accountcode=WEB${id}`,
        `callerid="Web Visitor" <web${id}>`,
        `auth=${username}_auth`,
        // res_pjsip_registrar resolves the endpoint's AOR by its section name.
        // The AOR must reuse the endpoint name (FreePBX does the same); a
        // suffixed AOR name produces "AOR '' not found" on REGISTER.
        `aors=${username}`,
        '',
        `[${username}_auth]`,
        'type=auth',
        'auth_type=userpass',
        `username=${username}`,
        `password=${secret}`,
        '',
        `[${username}]`,
        'type=aor',
        'max_contacts=1',
        'remove_existing=yes',
        'qualify_frequency=30'
    ];
    return section.join('\n');
}

function renderGuestPjsipBlock(tenants) {
    const lines = [PJSIP_BEGIN, '; Managed by Sokrat Cloud Tenants. Do not edit by hand.'];
    for (const tenant of tenants || []) {
        for (const endpoint of tenant.endpoints || []) {
            if (!endpoint || !endpoint.sip_username || !endpoint.secret) continue;
            lines.push('', buildGuestEndpointSection(tenant, endpoint));
        }
    }
    lines.push('', PJSIP_END);
    return lines.join('\n');
}

function renderWebguestDialplan(tenants) {
    const lines = [
        '; Sokrat Cloud Tenants — public web guest dialplan.',
        '; Managed by Sokrat. Do not edit by hand.',
        ''
    ];
    for (const tenant of tenants || []) {
        const id = Number(tenant.id);
        const ringGroup = String(tenant.ring_group || '');
        if (!id || !/^\d{1,20}$/.test(ringGroup)) continue;
        const displayName = sanitizeCallerName(tenant.name);
        lines.push(
            `[from-webguest-${id}]`,
            `exten => call,1,NoOp(Sokrat web guest -> tenant ${id})`,
            ` same => n,Set(__SOKRAT_TENANT_ID=${id})`,
            ` same => n,Set(SOKRAT_WEB_SESSION=\${FILTER(0-9a-f,\${PJSIP_HEADER(read,X-Sokrat-Session)})})`,
            ' same => n,Set(__SOKRAT_WEB_SESSION=${SOKRAT_WEB_SESSION})',
            ` same => n,Set(CDR(accountcode)=WEB${id})`,
            ' same => n,Set(GUEST_CID=${FILTER(0-9,${PJSIP_HEADER(read,X-Sokrat-Guest)})})',
            ' same => n,ExecIf($["${GUEST_CID}" != ""]?Set(CALLERID(num)=web${GUEST_CID}))',
            ` same => n,Set(CALLERID(name)=${displayName} Web Visitor)`,
            ` same => n,Goto(ext-group,${ringGroup},1)`,
            'exten => _X.,1,Hangup(21)',
            'exten => _+X.,1,Hangup(21)',
            'exten => _.,1,Hangup(21)',
            ''
        );
    }
    return lines.join('\n');
}

class SlidingWindowLimiter {
    constructor({ windowMs = 60000, max = 6 } = {}) {
        this.windowMs = windowMs;
        this.max = max;
        this.hits = new Map();
        this.timer = setInterval(() => this.prune(), Math.max(30000, windowMs)).unref?.();
    }

    prune(now = Date.now()) {
        for (const [key, timestamps] of this.hits.entries()) {
            const fresh = timestamps.filter(t => now - t < this.windowMs);
            if (fresh.length === 0) this.hits.delete(key);
            else this.hits.set(key, fresh);
        }
    }

    check(key, now = Date.now()) {
        const timestamps = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
        if (timestamps.length >= this.max) {
            const retryAfterMs = this.windowMs - (now - timestamps[0]);
            return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
        }
        timestamps.push(now);
        this.hits.set(key, timestamps);
        return { allowed: true };
    }

    close() {
        clearInterval(this.timer);
    }
}

function callError(code, message, status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

class TenantCallService {
    constructor({ db, cdrDb = null, encrypt = value => value, decrypt = value => value, config = {} } = {}) {
        if (!db) throw new Error('TenantCallService requires a database pool');
        this.db = db;
        this.cdrDb = cdrDb;
        this.encrypt = encrypt;
        this.decrypt = decrypt;
        this.config = {
            publicBaseUrl: '',
            wssUrl: '',
            sipDomain: '',
            pjsipFile: DEFAULT_PJSIP_FILE,
            dialplanFile: DEFAULT_DIALPLAN_FILE,
            extensionsCustomFile: DEFAULT_EXTENSIONS_CUSTOM,
            writeFiles: true,
            reload: true,
            reaper: true,
            rateWindowMs: 60000,
            rateMax: 6,
            ...config
        };
        this.limiter = new SlidingWindowLimiter({
            windowMs: this.config.rateWindowMs,
            max: this.config.rateMax
        });
        this.reaperTimer = null;
        if (this.config.reaper) this.startReaper();
    }

    async ensureSchema() {
        for (const sql of TABLE_SQL) {
            await this.db.query(sql);
        }
        return true;
    }

    startReaper() {
        if (this.reaperTimer) return;
        this.reaperTimer = setInterval(() => {
            this.reapExpired().catch(err => console.error('[tenant-calls] reaper:', err.message));
        }, 30000);
        this.reaperTimer.unref?.();
    }

    stop() {
        if (this.reaperTimer) clearInterval(this.reaperTimer);
        this.reaperTimer = null;
        this.limiter.close();
    }

    async listTenants() {
        const [rows] = await this.db.query(`
            SELECT t.*,
                (SELECT COUNT(*) FROM sokrat_guest_endpoints e
                  WHERE e.tenant_id = t.id AND e.status <> 'disabled') AS pool_total,
                (SELECT COUNT(*) FROM sokrat_guest_endpoints e
                  WHERE e.tenant_id = t.id AND e.status = 'free') AS pool_free,
                (SELECT COUNT(*) FROM sokrat_web_sessions s
                  WHERE s.tenant_id = t.id AND s.status IN ('pending','registered','calling','answered')) AS active_sessions,
                (SELECT COUNT(*) FROM sokrat_tenant_links l
                  WHERE l.tenant_id = t.id AND l.active = 1) AS active_links
            FROM sokrat_tenants t
            WHERE t.status <> 'deleted'
            ORDER BY t.id DESC
        `);
        return rows.map(row => this.tenantDto(row));
    }

    async getTenant(idOrPublicId) {
        const key = String(idOrPublicId || '').trim();
        if (!key) return null;
        const [rows] = await this.db.query(
            /^\d+$/.test(key)
                ? `SELECT * FROM sokrat_tenants WHERE id = ? AND status <> 'deleted' LIMIT 1`
                : `SELECT * FROM sokrat_tenants WHERE public_id = ? AND status <> 'deleted' LIMIT 1`,
            [key]
        );
        if (!rows.length) return null;
        const tenant = rows[0];
        const ringAgents = await this.syncTenantAgentsFromRingGroup(tenant.id, tenant.ring_group);
        let agents;
        if (ringAgents === null) {
            const [storedAgents] = await this.db.query(
                'SELECT extension FROM sokrat_tenant_agents WHERE tenant_id = ? ORDER BY CAST(extension AS UNSIGNED)',
                [tenant.id]
            );
            agents = storedAgents;
        } else {
            agents = ringAgents.map(extension => ({ extension }));
        }
        const [links] = await this.db.query(
            'SELECT * FROM sokrat_tenant_links WHERE tenant_id = ? ORDER BY id DESC',
            [tenant.id]
        );
        const [endpoints] = await this.db.query(
            `SELECT id, sip_username, status, lease_session_id, lease_expires_at, last_used_at, created_at
             FROM sokrat_guest_endpoints WHERE tenant_id = ? ORDER BY id`,
            [tenant.id]
        );
        const [sessions] = await this.db.query(
            `SELECT id, caller_id, status, source, origin, started_at, connected_at, ended_at,
                    duration_sec, hangup_cause, recording_ref
             FROM sokrat_web_sessions WHERE tenant_id = ?
             ORDER BY started_at DESC LIMIT 25`,
            [tenant.id]
        );
        return {
            ...this.tenantDto(tenant),
            agents: agents.map(row => row.extension),
            links: links.map(row => this.linkDto(row)),
            endpoints,
            sessions
        };
    }

    tenantDto(row) {
        return {
            id: row.id,
            public_id: row.public_id,
            name: row.name,
            status: row.status,
            ring_group: row.ring_group,
            timezone: row.timezone,
            max_concurrency: row.max_concurrency,
            max_call_seconds: row.max_call_seconds,
            recording_enabled: Boolean(row.recording_enabled),
            branding: this.parseJson(row.branding_json, {}),
            consent_text: row.consent_text || '',
            created_at: row.created_at,
            updated_at: row.updated_at,
            pool_total: row.pool_total === undefined ? undefined : Number(row.pool_total),
            pool_free: row.pool_free === undefined ? undefined : Number(row.pool_free),
            active_sessions: row.active_sessions === undefined ? undefined : Number(row.active_sessions),
            active_links: row.active_links === undefined ? undefined : Number(row.active_links)
        };
    }

    linkDto(row) {
        return {
            id: row.id,
            tenant_id: row.tenant_id,
            slug: row.slug,
            label: row.label,
            source: row.source || '',
            allowed_origins: this.parseJson(row.allowed_origins, []),
            branding: this.parseJson(row.branding_json, {}),
            active: Boolean(row.active),
            max_calls: row.max_calls == null ? null : Number(row.max_calls),
            expires_at: row.expires_at,
            created_at: row.created_at
        };
    }

    parseJson(value, fallback) {
        if (value == null || value === '') return fallback;
        if (typeof value === 'object') return value;
        try { return JSON.parse(value); } catch (_) { return fallback; }
    }

    async createTenant(payload = {}) {
        const name = String(payload.name || '').trim();
        if (name.length < 2 || name.length > 120) {
            throw callError('INVALID_NAME', 'Tenant name must be between 2 and 120 characters.');
        }
        const agents = normalizeExtensions(payload.agent_extensions != null ? payload.agent_extensions : payload.agents);
        const poolSize = clampInt(payload.pool_size, 1, 50, Math.max(5, agents.length || 1));
        const maxConcurrency = clampInt(payload.max_concurrency, 1, 50, Math.min(5, poolSize));
        const effectivePoolSize = Math.max(poolSize, maxConcurrency);
        const maxCallSeconds = clampInt(payload.max_call_seconds, 30, 7200, 1800);
        const recordingEnabled = payload.recording_enabled === false || payload.recording_enabled === 'false' || payload.recording_enabled === 0 ? 0 : 1;
        const timezone = String(payload.timezone || 'Africa/Cairo').trim().slice(0, 64) || 'Africa/Cairo';
        const consentText = String(payload.consent_text || '').trim().slice(0, 500);
        const branding = payload.branding && typeof payload.branding === 'object' ? payload.branding : {};

        if (agents.length) {
            await this.assertAgentsAvailable(agents);
        }

        const conn = await this.db.getConnection();
        let tenantId;
        let ringGroup;
        try {
            await conn.beginTransaction();
            ringGroup = await this.allocateRingGroup(conn, payload.ring_group);
            await this.insertRingGroup(conn, ringGroup, name, agents, recordingEnabled);
            const publicId = await this.allocatePublicId(conn);
            const [tenantResult] = await conn.query(`
                INSERT INTO sokrat_tenants
                    (public_id, name, status, ring_group, timezone, max_concurrency,
                     max_call_seconds, recording_enabled, branding_json, consent_text)
                VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
            `, [
                publicId, name, ringGroup, timezone, maxConcurrency,
                maxCallSeconds, recordingEnabled, JSON.stringify(branding), consentText || null
            ]);
            tenantId = tenantResult.insertId;
            for (const extension of agents) {
                await conn.query(
                    'INSERT INTO sokrat_tenant_agents (tenant_id, extension) VALUES (?, ?)',
                    [tenantId, extension]
                );
            }
            const endpointSecrets = [];
            for (let i = 0; i < effectivePoolSize; i += 1) {
                const sipUsername = `wg_${tenantId}_${randomHex(4)}`;
                const secret = randomToken(24);
                endpointSecrets.push({ sipUsername, secret });
                await conn.query(`
                    INSERT INTO sokrat_guest_endpoints
                        (tenant_id, sip_username, sip_secret_enc, status)
                    VALUES (?, ?, ?, 'free')
                `, [tenantId, sipUsername, this.encrypt(secret)]);
            }
            await conn.commit();
        } catch (error) {
            try { await conn.rollback(); } catch (_) {}
            throw error;
        } finally {
            conn.release();
        }

        const linkPayload = payload.link && typeof payload.link === 'object' ? payload.link : {};
        const link = await this.createLink(tenantId, {
            label: linkPayload.label || 'Website',
            source: linkPayload.source || payload.source || 'direct',
            allowed_origins: linkPayload.allowed_origins,
            branding: linkPayload.branding || branding,
            max_calls: linkPayload.max_calls,
            expires_at: linkPayload.expires_at
        });
        await this.syncConfig().catch(err => console.error('[tenant-calls] sync after create:', err.message));
        const tenant = await this.getTenant(tenantId);
        return { tenant, link };
    }

    async updateTenant(id, payload = {}) {
        const tenant = await this.getTenant(id);
        if (!tenant) throw callError('TENANT_NOT_FOUND', 'Tenant not found.', 404);

        const fields = [];
        const values = [];
        if (payload.name !== undefined) {
            const name = String(payload.name || '').trim();
            if (name.length < 2 || name.length > 120) {
                throw callError('INVALID_NAME', 'Tenant name must be between 2 and 120 characters.');
            }
            fields.push('name = ?'); values.push(name);
        }
        if (payload.status !== undefined) {
            const status = String(payload.status || '').toLowerCase();
            if (!['active', 'suspended'].includes(status)) {
                throw callError('INVALID_STATUS', 'Status must be active or suspended.');
            }
            fields.push('status = ?'); values.push(status);
        }
        if (payload.max_concurrency !== undefined) {
            fields.push('max_concurrency = ?'); values.push(clampInt(payload.max_concurrency, 1, 50, tenant.max_concurrency));
        }
        if (payload.max_call_seconds !== undefined) {
            fields.push('max_call_seconds = ?'); values.push(clampInt(payload.max_call_seconds, 30, 7200, tenant.max_call_seconds));
        }
        if (payload.recording_enabled !== undefined) {
            fields.push('recording_enabled = ?'); values.push(payload.recording_enabled === false || payload.recording_enabled === 'false' || payload.recording_enabled === 0 ? 0 : 1);
        }
        if (payload.timezone !== undefined) {
            fields.push('timezone = ?'); values.push(String(payload.timezone || tenant.timezone).trim().slice(0, 64));
        }
        if (payload.consent_text !== undefined) {
            fields.push('consent_text = ?'); values.push(String(payload.consent_text || '').trim().slice(0, 500) || null);
        }
        if (payload.branding !== undefined) {
            fields.push('branding_json = ?'); values.push(JSON.stringify(payload.branding && typeof payload.branding === 'object' ? payload.branding : {}));
        }
        if (fields.length) {
            values.push(tenant.id);
            await this.db.query(`UPDATE sokrat_tenants SET ${fields.join(', ')} WHERE id = ?`, values);
        }

        if (payload.name !== undefined || payload.recording_enabled !== undefined) {
            const groupName = String(payload.name !== undefined ? payload.name : tenant.name).trim().slice(0, 35);
            const recording = payload.recording_enabled !== undefined
                ? (payload.recording_enabled === false || payload.recording_enabled === 'false' || payload.recording_enabled === 0 ? 'dontcare' : 'always')
                : (tenant.recording_enabled ? 'always' : 'dontcare');
            await this.db.query(
                'UPDATE ringgroups SET description = ?, recording = ? WHERE grpnum = ?',
                [groupName, recording, tenant.ring_group]
            );
        }

        if (payload.agent_extensions !== undefined || payload.agents !== undefined) {
            const agents = normalizeExtensions(payload.agent_extensions != null ? payload.agent_extensions : payload.agents);
            await this.assertAgentsAvailable(agents, tenant.id);
            const conn = await this.db.getConnection();
            try {
                await conn.beginTransaction();
                await conn.query('DELETE FROM sokrat_tenant_agents WHERE tenant_id = ?', [tenant.id]);
                for (const extension of agents) {
                    await conn.query('INSERT INTO sokrat_tenant_agents (tenant_id, extension) VALUES (?, ?)', [tenant.id, extension]);
                }
                await conn.query(
                    'UPDATE ringgroups SET grplist = ?, description = ? WHERE grpnum = ?',
                    [agents.join('-'), String(payload.name || tenant.name).trim(), tenant.ring_group]
                );
                await conn.commit();
            } catch (error) {
                try { await conn.rollback(); } catch (_) {}
                throw error;
            } finally {
                conn.release();
            }
            await this.reloadPbxConfig();
        }

        await this.syncConfig().catch(err => console.error('[tenant-calls] sync after update:', err.message));
        return this.getTenant(tenant.id);
    }

    async deleteTenant(id) {
        const tenant = await this.getTenant(id);
        if (!tenant) throw callError('TENANT_NOT_FOUND', 'Tenant not found.', 404);
        await this.db.query(`UPDATE sokrat_tenants SET status = 'deleted' WHERE id = ?`, [tenant.id]);
        await this.db.query('UPDATE sokrat_tenant_links SET active = 0 WHERE tenant_id = ?', [tenant.id]);
        await this.db.query(`UPDATE sokrat_guest_endpoints SET status = 'disabled' WHERE tenant_id = ?`, [tenant.id]);
        await this.syncConfig().catch(err => console.error('[tenant-calls] sync after delete:', err.message));
        return { success: true };
    }

    async createLink(tenantId, payload = {}) {
        const tenant = await this.getTenant(tenantId);
        if (!tenant) throw callError('TENANT_NOT_FOUND', 'Tenant not found.', 404);
        const slug = await this.allocateLinkSlug(tenant.name);
        const allowedOrigins = normalizeOrigins(payload.allowed_origins);
        const label = String(payload.label || 'Website').trim().slice(0, 100) || 'Website';
        const source = String(payload.source || '').trim().slice(0, 100) || null;
        const branding = payload.branding && typeof payload.branding === 'object' ? payload.branding : {};
        const maxCalls = payload.max_calls == null || payload.max_calls === '' ? null : clampInt(payload.max_calls, 0, 1000000, null);
        const expiresAt = payload.expires_at ? new Date(payload.expires_at) : null;
        if (expiresAt && Number.isNaN(expiresAt.getTime())) {
            throw callError('INVALID_EXPIRY', 'expires_at must be a valid date.');
        }
        const [result] = await this.db.query(`
            INSERT INTO sokrat_tenant_links
                (tenant_id, slug, label, source, allowed_origins, branding_json, active, max_calls, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `, [
            tenant.id, slug, label, source,
            JSON.stringify(allowedOrigins), JSON.stringify(branding),
            maxCalls, expiresAt ? expiresAt.toISOString().slice(0, 19).replace('T', ' ') : null
        ]);
        const [rows] = await this.db.query('SELECT * FROM sokrat_tenant_links WHERE id = ?', [result.insertId]);
        return this.linkDto(rows[0]);
    }

    async updateLink(linkId, payload = {}) {
        const [rows] = await this.db.query('SELECT * FROM sokrat_tenant_links WHERE id = ?', [linkId]);
        if (!rows.length) throw callError('LINK_NOT_FOUND', 'Link not found.', 404);
        const link = this.linkDto(rows[0]);
        const fields = [];
        const values = [];
        if (payload.label !== undefined) {
            fields.push('label = ?'); values.push(String(payload.label || 'Website').trim().slice(0, 100) || 'Website');
        }
        if (payload.source !== undefined) {
            fields.push('source = ?'); values.push(String(payload.source || '').trim().slice(0, 100) || null);
        }
        if (payload.allowed_origins !== undefined) {
            fields.push('allowed_origins = ?'); values.push(JSON.stringify(normalizeOrigins(payload.allowed_origins)));
        }
        if (payload.branding !== undefined) {
            fields.push('branding_json = ?'); values.push(JSON.stringify(payload.branding && typeof payload.branding === 'object' ? payload.branding : {}));
        }
        if (payload.active !== undefined) {
            fields.push('active = ?'); values.push(payload.active === false || payload.active === 'false' || payload.active === 0 ? 0 : 1);
        }
        if (payload.max_calls !== undefined) {
            fields.push('max_calls = ?'); values.push(payload.max_calls == null || payload.max_calls === '' ? null : clampInt(payload.max_calls, 0, 1000000, null));
        }
        if (payload.expires_at !== undefined) {
            const expiresAt = payload.expires_at ? new Date(payload.expires_at) : null;
            if (expiresAt && Number.isNaN(expiresAt.getTime())) {
                throw callError('INVALID_EXPIRY', 'expires_at must be a valid date.');
            }
            fields.push('expires_at = ?'); values.push(expiresAt ? expiresAt.toISOString().slice(0, 19).replace('T', ' ') : null);
        }
        if (!fields.length) return link;
        values.push(link.id);
        await this.db.query(`UPDATE sokrat_tenant_links SET ${fields.join(', ')} WHERE id = ?`, values);
        const [updated] = await this.db.query('SELECT * FROM sokrat_tenant_links WHERE id = ?', [link.id]);
        return this.linkDto(updated[0]);
    }

    async deleteLink(linkId) {
        const [rows] = await this.db.query('SELECT id FROM sokrat_tenant_links WHERE id = ?', [linkId]);
        if (!rows.length) throw callError('LINK_NOT_FOUND', 'Link not found.', 404);
        await this.db.query('UPDATE sokrat_tenant_links SET active = 0 WHERE id = ?', [linkId]);
        return { success: true };
    }

    async resolvePublicLink(slug) {
        const clean = String(slug || '').trim();
        if (!clean || !/^[A-Za-z0-9_-]{4,32}$/.test(clean)) {
            throw callError('LINK_NOT_FOUND', 'Call link not found.', 404);
        }
        let [rows] = await this.db.query(`
            SELECT l.*, t.public_id AS tenant_public_id, t.name AS tenant_name, t.status AS tenant_status,
                   t.ring_group, t.max_concurrency, t.max_call_seconds, t.recording_enabled,
                   t.branding_json AS tenant_branding_json, t.consent_text AS tenant_consent_text
            FROM sokrat_tenant_links l
            JOIN sokrat_tenants t ON t.id = l.tenant_id
            WHERE l.slug = ? AND t.status <> 'deleted'
            LIMIT 1
        `, [clean]);
        if (!rows.length) {
            [rows] = await this.db.query(`
                SELECT l.*, t.public_id AS tenant_public_id, t.name AS tenant_name, t.status AS tenant_status,
                       t.ring_group, t.max_concurrency, t.max_call_seconds, t.recording_enabled,
                       t.branding_json AS tenant_branding_json, t.consent_text AS tenant_consent_text
                FROM sokrat_tenants t
                JOIN sokrat_tenant_links l ON l.tenant_id = t.id
                WHERE t.public_id = ? AND t.status <> 'deleted' AND l.active = 1
                ORDER BY l.id ASC LIMIT 1
            `, [clean]);
        }
        if (!rows.length) throw callError('LINK_NOT_FOUND', 'Call link not found.', 404);
        const row = rows[0];
        if (!row.active) throw callError('LINK_INACTIVE', 'This call link is disabled.', 403);
        if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
            throw callError('LINK_EXPIRED', 'This call link has expired.', 403);
        }
        if (row.tenant_status !== 'active') {
            throw callError('TENANT_INACTIVE', 'This business is not accepting calls right now.', 403);
        }
        const [ringRows] = await this.db.query('SELECT grplist FROM ringgroups WHERE grpnum = ? LIMIT 1', [row.ring_group]);
        const ringAgents = ringRows.length ? normalizeRingGroupMembers(ringRows[0].grplist) : [];
        if (ringAgents.length === 0) {
            throw callError('TENANT_NO_AGENTS', 'This business has no agents configured yet.', 403);
        }
        return {
            link: this.linkDto(row),
            tenant: {
                id: row.tenant_id,
                public_id: row.tenant_public_id,
                name: row.tenant_name,
                status: row.tenant_status,
                ring_group: row.ring_group,
                max_concurrency: row.max_concurrency,
                max_call_seconds: row.max_call_seconds,
                recording_enabled: Boolean(row.recording_enabled),
                branding: this.parseJson(row.tenant_branding_json, {}),
                consent_text: row.tenant_consent_text || ''
            }
        };
    }

    async allocateSession({ tenantSlug, linkSlug, origin, selfOrigin, source, ip, userAgent } = {}) {
        const resolved = await this.resolvePublicLink(linkSlug || tenantSlug);
        const tenant = resolved.tenant;
        const link = resolved.link;

        const normalizedOrigin = normalizeOrigin(origin);
        if (link.allowed_origins.length && normalizedOrigin) {
            const allowed = new Set(link.allowed_origins);
            for (const baseValue of [this.config.publicBaseUrl, selfOrigin]) {
                const base = normalizeOrigin(baseValue);
                if (base) allowed.add(base);
            }
            // The call page itself is served from the PBX origin. Browser fetches
            // from that page therefore carry the PBX Origin, not the embedding
            // business origin. The page-load Referer guard below is what checks
            // the embedding domain.
            if (!allowed.has(normalizedOrigin)) {
                throw callError('ORIGIN_NOT_ALLOWED', 'This website is not allowed to use this call link.', 403);
            }
        }

        if (link.max_calls != null) {
            const [linkUsage] = await this.db.query(
                'SELECT COUNT(*) AS used FROM sokrat_web_sessions WHERE link_id = ?',
                [link.id]
            );
            if (Number(linkUsage[0]?.used || 0) >= Number(link.max_calls)) {
                throw callError('LINK_CALL_LIMIT', 'This call link has reached its call limit.', 403);
            }
        }

        const rateKey = `${tenant.id}:${String(ip || '').slice(0, 64)}`;
        const rate = this.limiter.check(rateKey);
        if (!rate.allowed) {
            throw callError('RATE_LIMITED', `Too many call attempts. Try again in ${rate.retryAfterSec} seconds.`, 429);
        }

        const [activeRows] = await this.db.query(
            `SELECT COUNT(*) AS active FROM sokrat_web_sessions
             WHERE tenant_id = ? AND status IN ('pending','registered','calling','answered')`,
            [tenant.id]
        );
        if (Number(activeRows[0]?.active || 0) >= Number(tenant.max_concurrency || 5)) {
            throw callError('CONCURRENCY_LIMIT', 'All lines for this business are busy. Try again shortly.', 429);
        }

        const sessionId = crypto.randomBytes(16).toString('hex');
        const callerId = `web${randomGuestNumber()}`;
        const ttlSeconds = Number(tenant.max_call_seconds || 1800) + 120;
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

        const conn = await this.db.getConnection();
        let endpoint;
        try {
            await conn.beginTransaction();
            for (let attempt = 0; attempt < 5; attempt += 1) {
                const [rows] = await conn.query(`
                    SELECT * FROM sokrat_guest_endpoints
                    WHERE tenant_id = ? AND status = 'free'
                    ORDER BY id ASC LIMIT 1 FOR UPDATE
                `, [tenant.id]);
                if (!rows.length) break;
                const candidate = rows[0];
                const [update] = await conn.query(`
                    UPDATE sokrat_guest_endpoints
                    SET status = 'leased', lease_session_id = ?,
                        lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), last_used_at = NOW()
                    WHERE id = ? AND status = 'free'
                `, [sessionId, ttlSeconds, candidate.id]);
                if (update.affectedRows === 1) {
                    endpoint = candidate;
                    break;
                }
            }
            if (!endpoint) {
                throw callError('POOL_EXHAUSTED', 'All guest lines are busy. Try again shortly.', 503);
            }
            await conn.query(`
                INSERT INTO sokrat_web_sessions
                    (id, tenant_id, link_id, endpoint_id, caller_id, status, ip_hash, origin, source, user_agent, expires_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
            `, [
                sessionId, tenant.id, link.id, endpoint.id, callerId,
                crypto.createHash('sha256').update(String(ip || '')).digest('hex'),
                normalizedOrigin || null, String(source || link.source || '').slice(0, 100) || null,
                String(userAgent || '').slice(0, 255) || null,
                ttlSeconds
            ]);
            await conn.commit();
        } catch (error) {
            try { await conn.rollback(); } catch (_) {}
            throw error;
        } finally {
            conn.release();
        }

        const secret = this.decrypt(endpoint.sip_secret_enc);
        if (!secret) {
            await this.endSession(sessionId, { status: 'failed' }).catch(() => {});
            throw callError('ENDPOINT_SECRET_UNAVAILABLE', 'Guest line credentials are unavailable.', 500);
        }

        return {
            id: sessionId,
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            link_id: link.id,
            link_slug: link.slug,
            caller_id: callerId,
            extension: endpoint.sip_username,
            password: secret,
            target: 'call',
            sip_domain: this.config.sipDomain || '',
            wss_url: this.config.wssUrl || '',
            max_call_seconds: Number(tenant.max_call_seconds || 1800),
            expires_at: expiresAt.toISOString(),
            ice_servers: []
        };
    }

    async getSession(sessionId) {
        const id = String(sessionId || '').trim();
        if (!/^[a-f0-9]{32}$/.test(id)) {
            throw callError('SESSION_NOT_FOUND', 'Call session not found.', 404);
        }
        const [rows] = await this.db.query(
            `SELECT s.id, s.tenant_id, s.status, s.caller_id, s.source, s.started_at, s.expires_at,
                    s.connected_at, s.ended_at, s.duration_sec, s.hangup_cause, t.name AS tenant_name
             FROM sokrat_web_sessions s
             JOIN sokrat_tenants t ON t.id = s.tenant_id
             WHERE s.id = ? LIMIT 1`,
            [id]
        );
        if (!rows.length) throw callError('SESSION_NOT_FOUND', 'Call session not found.', 404);
        return rows[0];
    }

    async endSession(sessionId, { status = 'ended', duration = null, hangupCause = null } = {}) {
        const id = String(sessionId || '').trim();
        if (!/^[a-f0-9]{32}$/.test(id)) {
            throw callError('SESSION_NOT_FOUND', 'Call session not found.', 404);
        }
        const allowedStatus = ['ended', 'failed', 'expired'];
        const finalStatus = allowedStatus.includes(String(status)) ? String(status) : 'ended';
        const conn = await this.db.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query('SELECT * FROM sokrat_web_sessions WHERE id = ? FOR UPDATE', [id]);
            if (!rows.length) {
                throw callError('SESSION_NOT_FOUND', 'Call session not found.', 404);
            }
            const session = rows[0];
            if (!['ended', 'failed', 'expired'].includes(session.status)) {
                const durationSec = duration == null
                    ? Math.max(0, Math.round((Date.now() - new Date(session.started_at).getTime()) / 1000))
                    : Math.max(0, Math.min(86400, Number(duration) || 0));
                await conn.query(`
                    UPDATE sokrat_web_sessions
                    SET status = ?, ended_at = NOW(), duration_sec = ?, hangup_cause = ?
                    WHERE id = ?
                `, [finalStatus, durationSec, String(hangupCause || '').slice(0, 64) || null, id]);
                await conn.query(`
                    UPDATE sokrat_guest_endpoints
                    SET status = 'free', lease_session_id = NULL, lease_expires_at = NULL
                    WHERE lease_session_id = ?
                `, [id]);
            }
            await conn.commit();
        } catch (error) {
            try { await conn.rollback(); } catch (_) {}
            throw error;
        } finally {
            conn.release();
        }
        return this.getSession(id);
    }

    async reapExpired() {
        await this.db.query(`
            UPDATE sokrat_web_sessions
            SET status = 'expired', ended_at = NOW()
            WHERE status IN ('pending','registered','calling','answered') AND expires_at < NOW()
        `);
        await this.db.query(`
            UPDATE sokrat_guest_endpoints
            SET status = 'free', lease_session_id = NULL, lease_expires_at = NULL
            WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()
        `);
    }

    async getUsage(tenantId) {
        const tenant = await this.getTenant(tenantId);
        if (!tenant) throw callError('TENANT_NOT_FOUND', 'Tenant not found.', 404);
        const [rows] = await this.db.query(`
            SELECT
                COUNT(*) AS total_calls,
                SUM(CASE WHEN status = 'ended' THEN 1 ELSE 0 END) AS completed_calls,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_calls,
                COALESCE(SUM(duration_sec), 0) AS total_seconds,
                MAX(started_at) AS last_call_at
            FROM sokrat_web_sessions WHERE tenant_id = ?
        `, [tenant.id]);
        return { tenant_id: tenant.id, ...rows[0] };
    }

    async assertAgentsAvailable(agents, tenantId = null) {
        if (!agents.length) return;
        const placeholders = agents.map(() => '?').join(',');
        const [existing] = await this.db.query(
            `SELECT extension FROM users WHERE extension IN (${placeholders})`,
            agents
        );
        const existingSet = new Set(existing.map(row => String(row.extension)));
        const missing = agents.filter(ext => !existingSet.has(ext));
        if (missing.length) {
            throw callError('AGENT_NOT_FOUND', `Extensions not found: ${missing.join(', ')}`);
        }
        const params = tenantId == null ? agents : [...agents, tenantId];
        const [owned] = await this.db.query(
            `SELECT extension FROM sokrat_tenant_agents
             WHERE extension IN (${placeholders}) ${tenantId == null ? '' : 'AND tenant_id <> ?'}`,
            params
        );
        if (owned.length) {
            throw callError('AGENT_ALREADY_ASSIGNED', `Extensions already assigned to another tenant: ${owned.map(row => row.extension).join(', ')}`);
        }
    }

    async getRingGroupAgents(ringGroup) {
        const [rows] = await this.db.query('SELECT grplist FROM ringgroups WHERE grpnum = ? LIMIT 1', [ringGroup]);
        if (!rows.length) return null;
        return normalizeRingGroupMembers(rows[0].grplist);
    }

    async syncTenantAgentsFromRingGroup(tenantId, ringGroup) {
        const ringAgents = await this.getRingGroupAgents(ringGroup);
        if (ringAgents === null) return null;
        const [storedRows] = await this.db.query(
            'SELECT extension FROM sokrat_tenant_agents WHERE tenant_id = ? ORDER BY CAST(extension AS UNSIGNED)',
            [tenantId]
        );
        const stored = storedRows.map(row => String(row.extension));
        const same = stored.length === ringAgents.length && stored.every((ext, index) => ext === ringAgents[index]);
        if (!same) {
            await this.db.query('DELETE FROM sokrat_tenant_agents WHERE tenant_id = ?', [tenantId]);
            for (const extension of ringAgents) {
                await this.db.query(
                    'INSERT IGNORE INTO sokrat_tenant_agents (tenant_id, extension) VALUES (?, ?)',
                    [tenantId, extension]
                );
            }
        }
        return ringAgents;
    }

    async allocatePublicId(conn) {
        for (let i = 0; i < 10; i += 1) {
            const id = randomToken(9);
            const [rows] = await conn.query('SELECT id FROM sokrat_tenants WHERE public_id = ? LIMIT 1', [id]);
            if (!rows.length) return id;
        }
        throw callError('PUBLIC_ID_EXHAUSTED', 'Could not allocate a tenant id.');
    }

    async allocateLinkSlug(name) {
        const base = slugifyTenantName(name);
        for (let i = 0; i < 12; i += 1) {
            const slug = `${base}-${randomHex(2)}`;
            const [rows] = await this.db.query('SELECT id FROM sokrat_tenant_links WHERE slug = ? LIMIT 1', [slug]);
            if (!rows.length) return slug;
        }
        throw callError('LINK_SLUG_EXHAUSTED', 'Could not allocate a link slug.');
    }

    async allocateRingGroup(conn, preferred) {
        const requested = String(preferred || '').trim();
        if (requested) {
            if (!/^\d{1,20}$/.test(requested)) {
                throw callError('INVALID_RING_GROUP', 'Ring group must be numeric.');
            }
            const [tenantRows] = await conn.query('SELECT id FROM sokrat_tenants WHERE ring_group = ? LIMIT 1', [requested]);
            if (tenantRows.length) {
                throw callError('RING_GROUP_IN_USE', `Ring group ${requested} already belongs to another tenant.`);
            }
            const [existing] = await conn.query('SELECT grpnum FROM ringgroups WHERE grpnum = ? LIMIT 1', [requested]);
            if (existing.length) return requested;
            if (await this.numberInUse(conn, requested)) {
                throw callError('NUMBER_IN_USE', `Number ${requested} is already in use by the PBX.`);
            }
            return requested;
        }
        for (let num = GUEST_EXTENSION_MIN; num <= GUEST_EXTENSION_MAX; num += 1) {
            const value = String(num);
            const [tenantRows] = await conn.query('SELECT id FROM sokrat_tenants WHERE ring_group = ? LIMIT 1', [value]);
            if (tenantRows.length) continue;
            if (await this.numberInUse(conn, value)) continue;
            return value;
        }
        throw callError('RING_GROUP_EXHAUSTED', 'No free ring group numbers remain.');
    }

    async numberInUse(conn, number) {
        const [rows] = await conn.query(`
            SELECT 1 FROM ringgroups WHERE grpnum = ?
            UNION ALL SELECT 1 FROM users WHERE extension = ?
            UNION ALL SELECT 1 FROM devices WHERE id = ?
            LIMIT 1
        `, [number, number, number]);
        if (rows.length > 0) return true;
        try {
            const [queueRows] = await conn.query('SELECT 1 FROM queues WHERE extension = ? LIMIT 1', [number]);
            return queueRows.length > 0;
        } catch (error) {
            if (error && error.code === 'ER_NO_SUCH_TABLE') return false;
            throw error;
        }
    }

    async insertRingGroup(conn, grpnum, description, agents, recordingEnabled) {
        const [existing] = await conn.query('SELECT grpnum FROM ringgroups WHERE grpnum = ? LIMIT 1', [grpnum]);
        const grplist = agents.join('-');
        if (existing.length) {
            await conn.query(
                'UPDATE ringgroups SET description = ?, grplist = ?, recording = ? WHERE grpnum = ?',
                [String(description).slice(0, 35), grplist, recordingEnabled ? 'always' : 'dontcare', grpnum]
            );
            return;
        }
        await conn.query(`
            INSERT INTO ringgroups
                (grpnum, strategy, grptime, grppre, grplist, annmsg_id, postdest, description,
                 alertinfo, remotealert_id, needsconf, toolate_id, ringing, cwignore, cfignore, cpickup, recording)
            VALUES (?, 'ringall', 20, '', ?, 0, 'app-blackhole,hangup,1', ?,
                    '', 0, '', 0, 'Ring', 'CHECKED', '', '', ?)
        `, [grpnum, grplist, String(description).slice(0, 35), recordingEnabled ? 'always' : 'dontcare']);
    }

    async reloadPbxConfig() {
        if (!this.config.reload) return;
        try {
            await execFileAsync(RETRIEVE_CONF, [], { timeout: 60000 });
        } catch (error) {
            console.warn('[tenant-calls] retrieve_conf:', error.message);
        }
        try {
            await execFileAsync(ASTERISK_BIN, ['-rx', 'dialplan reload'], { timeout: 15000 });
        } catch (error) {
            console.warn('[tenant-calls] dialplan reload:', error.message);
        }
    }

    async syncConfig() {
        const [rows] = await this.db.query(`
            SELECT t.id AS tenant_id, t.name, t.ring_group, t.status,
                   e.id AS endpoint_id, e.sip_username, e.sip_secret_enc, e.status AS endpoint_status
            FROM sokrat_tenants t
            JOIN sokrat_guest_endpoints e ON e.tenant_id = t.id
            WHERE t.status = 'active' AND e.status <> 'disabled'
            ORDER BY t.id ASC, e.id ASC
        `);
        const tenants = new Map();
        for (const row of rows) {
            if (row.status !== 'active') continue;
            if (!tenants.has(row.tenant_id)) {
                tenants.set(row.tenant_id, {
                    id: row.tenant_id,
                    name: row.name,
                    ring_group: row.ring_group,
                    endpoints: []
                });
            }
            const secret = this.decrypt(row.sip_secret_enc);
            if (!secret) {
                console.warn(`[tenant-calls] cannot decrypt guest secret for endpoint ${row.endpoint_id}`);
                continue;
            }
            tenants.get(row.tenant_id).endpoints.push({
                sip_username: row.sip_username,
                secret
            });
        }
        const list = [...tenants.values()];
        const pjsipBlock = renderGuestPjsipBlock(list);
        const dialplanBlock = renderWebguestDialplan(list);

        if (this.config.writeFiles) {
            let current = '';
            try { current = fs.readFileSync(this.config.pjsipFile, 'utf8'); } catch (_) {}
            const next = replaceManagedBlock(current, PJSIP_BEGIN, PJSIP_END, pjsipBlock);
            if (next !== current) writeFileAtomic(this.config.pjsipFile, next);

            writeFileAtomic(this.config.dialplanFile, dialplanBlock);

            let custom = '';
            try { custom = fs.readFileSync(this.config.extensionsCustomFile, 'utf8'); } catch (_) {}
            const hasInclude = custom.split(/\r?\n/).some(line => line.trim() === DIALPLAN_INCLUDE);
            if (!hasInclude) {
                writeFileAtomic(this.config.extensionsCustomFile, `${custom.trimEnd()}\n\n${DIALPLAN_INCLUDE}\n`);
            }
        }

        if (this.config.reload) {
            try {
                await execFileAsync(ASTERISK_BIN, ['-rx', 'pjsip reload'], { timeout: 15000 });
            } catch (error) {
                console.warn('[tenant-calls] pjsip reload:', error.message);
            }
            await this.reloadPbxConfig();
        }
        return { tenants: list.length, endpoints: list.reduce((sum, t) => sum + t.endpoints.length, 0) };
    }
}

module.exports = {
    TenantCallService,
    SlidingWindowLimiter,
    TABLE_SQL,
    PJSIP_BEGIN,
    PJSIP_END,
    DIALPLAN_INCLUDE,
    normalizeExtensions,
    normalizeRingGroupMembers,
    normalizeOrigin,
    normalizeOrigins,
    sanitizeCallerName,
    slugifyTenantName,
    renderGuestPjsipBlock,
    renderWebguestDialplan,
    replaceManagedBlock,
    callError,
    randomToken
};
