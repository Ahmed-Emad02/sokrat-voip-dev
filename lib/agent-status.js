'use strict';

/**
 * Server-side agent status for PJSIP/WebRTC extensions.
 *
 * The status is the Sokrat agent availability shown in the operator panel,
 * not the PJSIP registration state. It is persisted in
 * `asterisk.synq_agent_status` and also controls DND and queue pause state.
 *
 * Keep the Asterisk side-effect rules here so the dashboard, CRM integration,
 * Chrome extension and desktop all use the same behaviour.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsyncDefault = promisify(execFile);
const ASTERISK_BIN = process.env.ASTERISK_BIN || '/usr/sbin/asterisk';

const EXTENSION_RE = /^[0-9A-Za-z*#._-]+$/;
const STATUS_RE = /^[a-z0-9_-]+$/;
const QUEUE_INTERFACE_RE = /^(?:Local|PJSIP|SIP|IAX2|DAHDI|Agent)\/[A-Za-z0-9*#._@\/-]+$/;

const STATIC_STATUSES = [
    {
        key: 'available',
        label_ar: 'متاح',
        label_en: 'Available',
        desc_ar: 'جاهز لاستقبال المكالمات',
        desc_en: 'Ready to receive calls',
        color: '#10b981',
        type: 'static',
        has_timer: false,
    },
    {
        key: 'offline',
        label_ar: 'غير متاح',
        label_en: 'Offline',
        desc_ar: 'حجب المكالمات مؤقتاً',
        desc_en: 'Temporarily not taking calls',
        color: '#94a3b8',
        type: 'static',
        has_timer: false,
    },
];

class AgentStatusError extends Error {
    constructor(message, statusCode = 500, code = 'agent_status_error') {
        super(message);
        this.name = 'AgentStatusError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

function normalizeExtension(value) {
    return String(value == null ? '' : value).trim();
}

function normalizeStatus(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

function isValidExtension(value) {
    return Boolean(value && EXTENSION_RE.test(value) && value.length <= 64);
}

function isPjsipTech(value) {
    const tech = String(value || '').trim().toLowerCase();
    return tech === 'pjsip' || tech === 'webrtc';
}

function isStaticStatus(value) {
    return value === 'available' || value === 'offline';
}

async function getExtensionTech(pool, extension) {
    try {
        const [rows] = await pool.query(
            'SELECT tech FROM `asterisk`.`devices` WHERE id = ? LIMIT 1',
            [extension],
        );
        if (rows && rows[0] && rows[0].tech) return String(rows[0].tech);
    } catch (_) {}

    try {
        const [rows] = await pool.query(
            'SELECT id FROM `asterisk`.`ps_endpoints` WHERE id = ? LIMIT 1',
            [extension],
        );
        if (rows && rows[0]) return 'pjsip';
    } catch (_) {}

    return '';
}

async function getExtensionGroup(pool, extension) {
    try {
        const [rows] = await pool.query(
            'SELECT emp_group FROM `asterisk`.`employee_extras` WHERE extension = ? LIMIT 1',
            [extension],
        );
        return rows && rows[0] ? String(rows[0].emp_group || '').trim() : '';
    } catch (_) {
        return '';
    }
}

async function getExtensionDisplayName(pool, extension, fallback) {
    try {
        const [rows] = await pool.query(
            'SELECT name FROM `asterisk`.`users` WHERE extension = ? LIMIT 1',
            [extension],
        );
        const name = rows && rows[0] ? String(rows[0].name || '').trim() : '';
        if (name) return name;
    } catch (_) {}
    return String(fallback || extension);
}

async function listDefinitions(pool, group) {
    const definitions = [STATIC_STATUSES[0]];
    const targetGroup = String(group || '').trim();

    try {
        const params = [];
        let sql = `SELECT status_key AS \`key\`, label_ar, label_en, desc_ar, desc_en, color, target_group, sort_order
                   FROM \`asterisk\`.\`synq_agent_status_definitions\`
                   WHERE is_active = 1`;
        if (targetGroup) {
            sql += ` AND (
                target_group IS NULL
                OR TRIM(target_group) = ''
                OR LOWER(TRIM(target_group)) = 'all'
                OR LOWER(TRIM(target_group)) = LOWER(?)
            )`;
            params.push(targetGroup);
        } else {
            sql += ` AND (target_group IS NULL OR TRIM(target_group) = '' OR LOWER(TRIM(target_group)) = 'all')`;
        }
        sql += ' ORDER BY sort_order ASC, id ASC';

        const [rows] = await pool.query(sql, params);
        for (const row of rows || []) {
            const key = normalizeStatus(row.key);
            if (!key || isStaticStatus(key)) continue;
            definitions.push({
                key,
                label_ar: String(row.label_ar || row.key || key),
                label_en: String(row.label_en || row.key || key),
                desc_ar: row.desc_ar || '',
                desc_en: row.desc_en || '',
                color: normalizeColor(row.color),
                target_group: row.target_group || null,
                sort_order: Number(row.sort_order) || 10,
                type: 'dynamic',
                has_timer: true,
            });
        }
    } catch (_) {}

    definitions.push(STATIC_STATUSES[1]);
    return definitions;
}

function normalizeColor(value) {
    const color = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : '#f59e0b';
}

function definitionFor(definitions, status) {
    return (definitions || []).find((definition) => definition.key === status) || null;
}

function fallbackDefinition(status) {
    return {
        key: status,
        label_ar: status,
        label_en: status,
        desc_ar: '',
        desc_en: '',
        color: '#94a3b8',
        type: 'dynamic',
        has_timer: !isStaticStatus(status),
    };
}

async function getStatusRow(pool, extension) {
    try {
        const [rows] = await pool.query(
            `SELECT extension, display_name, status, last_update
             FROM \`asterisk\`.\`synq_agent_status\`
             WHERE extension = ? LIMIT 1`,
            [extension],
        );
        return rows && rows[0] ? rows[0] : null;
    } catch (_) {
        return null;
    }
}

async function getDndPolicy(pool, extension) {
    try {
        const [rows] = await pool.query(
            'SELECT dnd FROM `asterisk`.`extension_policies` WHERE extension = ? LIMIT 1',
            [extension],
        );
        const value = rows && rows[0] ? String(rows[0].dnd || '').trim() : '';
        if (value === 'force_on' || value === 'force_off' || value === 'user_choice') return value;
    } catch (_) {}
    return 'user_choice';
}

function toIso(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function interfaceExtension(interfaceName) {
    const value = String(interfaceName || '').trim();
    const match = /^(?:Local|PJSIP|SIP|IAX2|DAHDI|Agent)\/([^@\/,]+)/i.exec(value);
    return match ? String(match[1]).trim() : '';
}

/**
 * Resolve the exact queue member interfaces belonging to an extension.
 *
 * FreePBX normally compiles queue members as `Local/107@from-queue/n`, while
 * other installations may use `PJSIP/107` or `SIP/107`. The old code always
 * assumed `PJSIP/<ext>`, which never matched the FreePBX members on this PBX.
 */
async function resolveQueueInterfaces(pool, extension) {
    const interfaces = new Set();
    try {
        const [rows] = await pool.query(
            "SELECT data FROM `asterisk`.`queues_details` WHERE keyword = 'member'",
        );
        for (const row of rows || []) {
            const data = String(row.data || '').trim();
            if (!data) continue;
            const interfaceName = data.split(',')[0].trim();
            if (!QUEUE_INTERFACE_RE.test(interfaceName)) continue;
            if (interfaceExtension(interfaceName) !== String(extension)) continue;
            interfaces.add(interfaceName);
        }
    } catch (_) {}
    return [...interfaces];
}

async function runAsteriskCommand(execFileAsync, command) {
    const result = await execFileAsync(ASTERISK_BIN, ['-rx', command]);
    const output = String((result && (result.stdout || result.stderr)) || '').trim();
    if (/\b(?:Unable|failed|No such|Invalid)\b/i.test(output)) {
        throw new Error(output || 'Asterisk command failed');
    }
    return output;
}

async function applyAsteriskStatus(extension, status, options = {}) {
    const warnings = [];
    const exec = options.execFileAsync || execFileAsyncDefault;
    const policy = options.policy || 'user_choice';
    const interfaces = Array.isArray(options.interfaces) ? options.interfaces : [];
    const isAvailable = status === 'available';

    // Preserve an administrator's force_on/force_off policy. Only the
    // user_choice policy is allowed to be changed by an agent status.
    if (policy === 'user_choice') {
        try {
            if (isAvailable) {
                await runAsteriskCommand(exec, `database del DND ${extension}`);
            } else {
                await runAsteriskCommand(exec, `database put DND ${extension} YES`);
            }
        } catch (error) {
            warnings.push(`DND update failed: ${error.message}`);
        }
    }

    const action = isAvailable ? 'unpause' : 'pause';
    for (const interfaceName of interfaces) {
        try {
            await runAsteriskCommand(exec, `queue ${action} member ${interfaceName}`);
        } catch (error) {
            warnings.push(`Queue ${action} failed for ${interfaceName}: ${error.message}`);
        }
    }

    return {
        policy,
        queue_interfaces: interfaces,
        queue_paused: !isAvailable,
        warnings,
    };
}

async function readAgentStatus(pool, extension, options = {}) {
    const ext = normalizeExtension(extension);
    if (!isValidExtension(ext)) {
        throw new AgentStatusError('Valid extension is required.', 400, 'agent_status_invalid_extension');
    }

    const tech = await getExtensionTech(pool, ext);
    const isPjsip = isPjsipTech(tech);
    const group = await getExtensionGroup(pool, ext);
    const definitions = await listDefinitions(pool, group);
    const current = await getStatusRow(pool, ext);
    const status = current && current.status ? normalizeStatus(current.status) : 'available';
    const definition = definitionFor(definitions, status) || fallbackDefinition(status);
    const displayName = await getExtensionDisplayName(pool, ext, current && current.display_name);
    const policy = await getDndPolicy(pool, ext);
    const online = typeof options.getPresence === 'function'
        ? Boolean(options.getPresence(ext))
        : null;

    return {
        success: true,
        extension: ext,
        display_name: displayName,
        tech: tech || 'unknown',
        is_pjsip: isPjsip,
        online,
        status,
        label_ar: definition.label_ar,
        label_en: definition.label_en,
        desc_ar: definition.desc_ar || '',
        desc_en: definition.desc_en || '',
        color: definition.color,
        has_timer: Boolean(definition.has_timer) && !isStaticStatus(status),
        last_update: toIso(current && current.last_update),
        dnd_policy: policy,
        definitions: isPjsip ? definitions : definitions.filter((item) => item.type === 'static'),
        queue_interfaces: await resolveQueueInterfaces(pool, ext),
    };
}

async function setAgentStatus(pool, extension, requestedStatus, options = {}) {
    const ext = normalizeExtension(extension);
    if (!isValidExtension(ext)) {
        throw new AgentStatusError('Valid extension is required.', 400, 'agent_status_invalid_extension');
    }

    const status = normalizeStatus(requestedStatus);
    if (!status || !STATUS_RE.test(status) || status.length > 50) {
        throw new AgentStatusError('Valid agent status is required.', 400, 'agent_status_invalid');
    }

    const tech = await getExtensionTech(pool, ext);
    if (!isPjsipTech(tech)) {
        throw new AgentStatusError(
            'Agent status is available only for PJSIP/WebRTC extensions.',
            409,
            'agent_status_not_pjsip',
        );
    }

    const group = await getExtensionGroup(pool, ext);
    const definitions = await listDefinitions(pool, group);
    if (!definitionFor(definitions, status)) {
        throw new AgentStatusError('The selected agent status is not configured for this extension.', 400, 'agent_status_invalid');
    }

    const conn = await pool.getConnection();
    let previousStatus = null;
    let displayName = String(options.displayName || '').trim();
    let policy = 'user_choice';
    let unchanged = false;
    let lastUpdate = null;

    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT status, display_name, last_update
             FROM \`asterisk\`.\`synq_agent_status\`
             WHERE extension = ? LIMIT 1
             FOR UPDATE`,
            [ext],
        );
        const current = rows && rows[0] ? rows[0] : null;
        previousStatus = current && current.status ? normalizeStatus(current.status) : null;
        unchanged = (!current && status === 'available') || (previousStatus === status);

        const [userRows] = await conn.query(
            'SELECT name FROM `asterisk`.`users` WHERE extension = ? LIMIT 1',
            [ext],
        );
        if (!displayName) {
            displayName = userRows && userRows[0] && userRows[0].name
                ? String(userRows[0].name).trim()
                : (current && current.display_name ? String(current.display_name) : ext);
        }

        try {
            const [policyRows] = await conn.query(
                'SELECT dnd FROM `asterisk`.`extension_policies` WHERE extension = ? LIMIT 1 FOR UPDATE',
                [ext],
            );
            const storedPolicy = policyRows && policyRows[0] ? String(policyRows[0].dnd || '').trim() : '';
            if (storedPolicy === 'force_on' || storedPolicy === 'force_off' || storedPolicy === 'user_choice') {
                policy = storedPolicy;
            } else if (!policyRows || !policyRows.length) {
                policy = 'user_choice';
                await conn.query(
                    "INSERT INTO `asterisk`.`extension_policies` (extension, dnd) VALUES (?, 'user_choice')",
                    [ext],
                );
            }
        } catch (_) {
            policy = 'user_choice';
        }

        if (!unchanged) {
            if (current && previousStatus && previousStatus !== status) {
                await conn.query(
                    `INSERT INTO \`asterisk\`.\`synq_agent_status_log\`
                     (extension, status, start_time, end_time, duration_seconds)
                     VALUES (?, ?, ?, NOW(), GREATEST(0, TIMESTAMPDIFF(SECOND, ?, NOW())))`,
                    [ext, previousStatus, current.last_update || new Date(), current.last_update || new Date()],
                );
            }

            await conn.query(
                `INSERT INTO \`asterisk\`.\`synq_agent_status\`
                 (extension, display_name, status, last_update)
                 VALUES (?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE status = VALUES(status),
                   display_name = VALUES(display_name), last_update = NOW()`,
                [ext, displayName, status],
            );
            lastUpdate = new Date();
        } else {
            lastUpdate = current && current.last_update ? current.last_update : null;
        }

        await conn.commit();
    } catch (error) {
        await conn.rollback().catch(() => {});
        throw error;
    } finally {
        conn.release();
    }

    const interfaces = await resolveQueueInterfaces(pool, ext);
    const asterisk = await applyAsteriskStatus(ext, status, {
        execFileAsync: options.execFileAsync,
        policy,
        interfaces,
    });

    const result = await readAgentStatus(pool, ext, { getPresence: options.getPresence });
    return {
        ...result,
        unchanged,
        previous_status: previousStatus,
        updated_at: result.last_update || toIso(lastUpdate),
        warnings: asterisk.warnings,
        queue_interfaces: asterisk.queue_interfaces,
        queue_paused: asterisk.queue_paused,
    };
}

module.exports = {
    AgentStatusError,
    STATIC_STATUSES,
    normalizeExtension,
    normalizeStatus,
    isStaticStatus,
    getExtensionTech,
    getExtensionGroup,
    getExtensionDisplayName,
    listDefinitions,
    resolveQueueInterfaces,
    interfaceExtension,
    readAgentStatus,
    setAgentStatus,
    applyAsteriskStatus,
    ASTERISK_BIN,
};
