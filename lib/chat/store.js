'use strict';

/**
 * Internal extension chat storage.
 *
 * The server is the source of truth: every conversation, message and
 * attachment is written to MariaDB before it is returned or broadcast.
 */

const crypto = require('crypto');
const { lookupExtensionPassword, normalizeExtension } = require('../extension-password');

const MAX_BODY = 4000;
const MAX_CONTACT = 120;
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function httpError(status, message, code) {
    const err = new Error(message);
    err.statusCode = status;
    err.code = code || 'chat_error';
    return err;
}

function asText(value) {
    return String(value == null ? '' : value).trim();
}

function parseJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
}

function serializeMessage(row, attachments) {
    return {
        id: Number(row.id),
        conversation_id: Number(row.conversation_id),
        sender_extension: String(row.sender_extension || ''),
        type: String(row.type || 'text'),
        body: String(row.body || ''),
        metadata: parseJson(row.metadata_json),
        client_id: row.client_id ? String(row.client_id) : null,
        created_at: row.created_at,
        deleted_at: row.deleted_at || null,
        attachments: (attachments || []).map((a) => ({
            id: Number(a.id),
            original_name: a.original_name,
            mime: a.mime,
            size_bytes: Number(a.size_bytes),
            kind: a.kind,
            sha256: a.sha256,
        })),
    };
}

async function ensureChatSchema(pool) {
    const statements = [
        `CREATE TABLE IF NOT EXISTS asterisk.chat_conversations (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`type\` ENUM('direct','group') NOT NULL DEFAULT 'direct',
            \`direct_key\` VARCHAR(64) DEFAULT NULL,
            \`title\` VARCHAR(255) DEFAULT NULL,
            \`created_by\` VARCHAR(20) NOT NULL,
            \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            \`last_message_at\` TIMESTAMP NULL DEFAULT NULL,
            UNIQUE KEY \`uniq_chat_direct\` (\`direct_key\`),
            KEY \`idx_chat_last\` (\`last_message_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
        `CREATE TABLE IF NOT EXISTS asterisk.chat_participants (
            \`conversation_id\` BIGINT NOT NULL,
            \`extension\` VARCHAR(20) NOT NULL,
            \`role\` ENUM('member','owner') NOT NULL DEFAULT 'member',
            \`last_read_message_id\` BIGINT DEFAULT NULL,
            \`muted\` TINYINT(1) NOT NULL DEFAULT 0,
            \`joined_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (\`conversation_id\`,\`extension\`),
            KEY \`idx_chat_participant_ext\` (\`extension\`),
            CONSTRAINT \`fk_chat_participant_conversation\` FOREIGN KEY (\`conversation_id\`)
                REFERENCES asterisk.chat_conversations (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
        `CREATE TABLE IF NOT EXISTS asterisk.chat_messages (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`conversation_id\` BIGINT NOT NULL,
            \`sender_extension\` VARCHAR(20) NOT NULL,
            \`type\` ENUM('text','attachment','contact','system') NOT NULL DEFAULT 'text',
            \`body\` TEXT DEFAULT NULL,
            \`metadata_json\` JSON DEFAULT NULL,
            \`client_id\` VARCHAR(64) DEFAULT NULL,
            \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            \`edited_at\` TIMESTAMP NULL DEFAULT NULL,
            \`deleted_at\` TIMESTAMP NULL DEFAULT NULL,
            \`deleted_by\` VARCHAR(20) DEFAULT NULL,
            UNIQUE KEY \`uniq_chat_client\` (\`conversation_id\`,\`sender_extension\`,\`client_id\`),
            KEY \`idx_chat_message_conversation\` (\`conversation_id\`,\`id\`),
            KEY \`idx_chat_message_created\` (\`created_at\`),
            CONSTRAINT \`fk_chat_message_conversation\` FOREIGN KEY (\`conversation_id\`)
                REFERENCES asterisk.chat_conversations (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
        `CREATE TABLE IF NOT EXISTS asterisk.chat_attachments (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`message_id\` BIGINT DEFAULT NULL,
            \`uploader_extension\` VARCHAR(20) NOT NULL,
            \`original_name\` VARCHAR(255) NOT NULL,
            \`stored_name\` VARCHAR(255) NOT NULL,
            \`mime\` VARCHAR(120) NOT NULL,
            \`size_bytes\` BIGINT NOT NULL,
            \`sha256\` CHAR(64) NOT NULL,
            \`kind\` ENUM('image','pdf','excel') NOT NULL,
            \`width\` INT DEFAULT NULL,
            \`height\` INT DEFAULT NULL,
            \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY \`idx_chat_attachment_message\` (\`message_id\`),
            KEY \`idx_chat_attachment_uploader\` (\`uploader_extension\`),
            CONSTRAINT \`fk_chat_attachment_message\` FOREIGN KEY (\`message_id\`)
                REFERENCES asterisk.chat_messages (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
        `CREATE TABLE IF NOT EXISTS asterisk.chat_admin_audit (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`admin_user\` VARCHAR(120) NOT NULL,
            \`action\` VARCHAR(40) NOT NULL,
            \`conversation_id\` BIGINT DEFAULT NULL,
            \`message_id\` BIGINT DEFAULT NULL,
            \`attachment_id\` BIGINT DEFAULT NULL,
            \`details\` TEXT DEFAULT NULL,
            \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY \`idx_chat_audit_created\` (\`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    ];
    for (const sql of statements) await pool.query(sql);
}

async function extensionExists(pool, extension) {
    const ext = normalizeExtension(extension);
    if (!ext) return false;
    const password = await lookupExtensionPassword(pool, ext);
    return Boolean(password);
}


async function listChatExtensions(pool) {
    const [rows] = await pool.query(
        `SELECT extension, name
         FROM asterisk.users
         WHERE extension REGEXP '^[0-9]+$'
         ORDER BY CAST(extension AS UNSIGNED) ASC`,
    );
    return (rows || []).map((row) => ({
        extension: String(row.extension),
        name: String(row.name || row.extension || ''),
    }));
}

async function isParticipant(pool, conversationId, extension) {
    const [rows] = await pool.query(
        'SELECT 1 FROM asterisk.chat_participants WHERE conversation_id = ? AND extension = ? LIMIT 1',
        [conversationId, normalizeExtension(extension)],
    );
    return rows.length > 0;
}

async function findOrCreateDirect(pool, selfExtension, otherExtension) {
    const self = normalizeExtension(selfExtension);
    const other = normalizeExtension(otherExtension);
    if (!self || !other) throw httpError(400, 'Both extensions are required.', 'chat_extension_required');
    if (self === other) throw httpError(400, 'You cannot start a chat with yourself.', 'chat_self_conversation');
    if (!(await extensionExists(pool, self)) || !(await extensionExists(pool, other))) {
        throw httpError(404, 'One of the extensions does not exist.', 'chat_extension_unknown');
    }

    const directKey = [self, other].sort().join(':');
    const [existing] = await pool.query(
        'SELECT id FROM asterisk.chat_conversations WHERE direct_key = ? LIMIT 1',
        [directKey],
    );
    if (existing.length) return Number(existing[0].id);

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [created] = await conn.query(
            'INSERT INTO asterisk.chat_conversations (type, direct_key, created_by) VALUES (?, ?, ?)',
            ['direct', directKey, self],
        );
        const conversationId = created.insertId;
        await conn.query(
            'INSERT INTO asterisk.chat_participants (conversation_id, extension, role) VALUES (?, ?, ?), (?, ?, ?)',
            [conversationId, self, 'owner', conversationId, other, 'member'],
        );
        await conn.commit();
        return Number(conversationId);
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        if (err && err.code === 'ER_DUP_ENTRY') {
            const [rows] = await pool.query(
                'SELECT id FROM asterisk.chat_conversations WHERE direct_key = ? LIMIT 1',
                [directKey],
            );
            if (rows.length) return Number(rows[0].id);
        }
        throw err;
    } finally {
        conn.release();
    }
}

async function listParticipants(pool, conversationIds) {
    if (!conversationIds.length) return new Map();
    const [rows] = await pool.query(
        'SELECT conversation_id, extension, role, last_read_message_id, muted FROM asterisk.chat_participants WHERE conversation_id IN (?)',
        [conversationIds],
    );
    const map = new Map();
    for (const row of rows || []) {
        const key = Number(row.conversation_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({
            extension: String(row.extension),
            role: row.role,
            last_read_message_id: row.last_read_message_id == null ? null : Number(row.last_read_message_id),
            muted: Boolean(row.muted),
        });
    }
    return map;
}

async function getConversationSummary(pool, conversationId) {
    const [rows] = await pool.query(
        `SELECT id, type, title, created_by, created_at, updated_at, last_message_at
         FROM asterisk.chat_conversations WHERE id = ? LIMIT 1`,
        [conversationId],
    );
    if (!rows.length) throw httpError(404, 'Conversation not found.', 'chat_conversation_not_found');
    const conversation = rows[0];
    const participants = await listParticipants(pool, [conversationId]);
    return {
        id: Number(conversation.id),
        type: conversation.type,
        title: conversation.title || null,
        created_by: conversation.created_by,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        last_message_at: conversation.last_message_at,
        participants: participants.get(Number(conversationId)) || [],
    };
}

async function listConversations(pool, extension) {
    const ext = normalizeExtension(extension);
    if (!ext) throw httpError(400, 'Extension is required.', 'chat_extension_required');
    const [rows] = await pool.query(
        `SELECT c.id, c.type, c.title, c.created_by, c.created_at, c.updated_at, c.last_message_at,
                p.last_read_message_id, p.muted,
                lm.id AS last_message_id, lm.sender_extension AS last_sender,
                lm.type AS last_type, lm.body AS last_body, lm.metadata_json AS last_metadata,
                lm.created_at AS last_created_at,
                (SELECT COUNT(*) FROM asterisk.chat_messages um
                  WHERE um.conversation_id = c.id
                    AND um.sender_extension <> ?
                    AND um.id > COALESCE(p.last_read_message_id, 0)) AS unread
         FROM asterisk.chat_participants p
         JOIN asterisk.chat_conversations c ON c.id = p.conversation_id
         LEFT JOIN asterisk.chat_messages lm ON lm.id = (
             SELECT m2.id FROM asterisk.chat_messages m2
             WHERE m2.conversation_id = c.id
             ORDER BY m2.id DESC LIMIT 1
         )
         WHERE p.extension = ?
         ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
         LIMIT 200`,
        [ext, ext],
    );
    const participants = await listParticipants(pool, rows.map((row) => Number(row.id)));
    const conversations = rows.map((row) => ({
        id: Number(row.id),
        type: row.type,
        title: row.title || null,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_message_at: row.last_message_at,
        muted: Boolean(row.muted),
        last_read_message_id: row.last_read_message_id == null ? null : Number(row.last_read_message_id),
        unread: Number(row.unread || 0),
        participants: participants.get(Number(row.id)) || [],
        last_message: row.last_message_id == null ? null : {
            id: Number(row.last_message_id),
            sender_extension: String(row.last_sender || ''),
            type: String(row.last_type || 'text'),
            body: String(row.last_body || ''),
            metadata: parseJson(row.last_metadata),
            created_at: row.last_created_at,
        },
    }));
    return conversations;
}

async function getMessages(pool, conversationId, extension, beforeId, limit) {
    const ext = normalizeExtension(extension);
    if (!ext) throw httpError(400, 'Extension is required.', 'chat_extension_required');
    if (!(await isParticipant(pool, conversationId, ext))) {
        throw httpError(403, 'You are not a participant in this conversation.', 'chat_forbidden');
    }
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const params = [Number(conversationId)];
    let where = 'conversation_id = ?';
    if (Number(beforeId) > 0) {
        where += ' AND id < ?';
        params.push(Number(beforeId));
    }
    params.push(safeLimit + 1);
    const [rows] = await pool.query(
        `SELECT id, conversation_id, sender_extension, type, body, metadata_json, client_id,
                created_at, deleted_at
         FROM asterisk.chat_messages WHERE ${where} ORDER BY id DESC LIMIT ?`,
        params,
    );
    const page = rows.slice(0, safeLimit).reverse();
    const ids = page.map((row) => Number(row.id));
    const attachments = await listAttachmentsForMessages(pool, ids);
    return {
        messages: page.map((row) => serializeMessage(row, attachments.get(Number(row.id)) || [])),
        has_more: rows.length > safeLimit,
    };
}

async function listAttachmentsForMessages(pool, messageIds) {
    const map = new Map();
    if (!messageIds.length) return map;
    const [rows] = await pool.query(
        'SELECT id, message_id, original_name, mime, size_bytes, sha256, kind FROM asterisk.chat_attachments WHERE message_id IN (?)',
        [messageIds],
    );
    for (const row of rows || []) {
        const key = Number(row.message_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

function validateContact(contact) {
    if (!contact || typeof contact !== 'object') throw httpError(400, 'Contact data is required.', 'chat_contact_invalid');
    const extension = normalizeExtension(contact.extension);
    const name = asText(contact.name).slice(0, MAX_CONTACT);
    const company = asText(contact.company).slice(0, MAX_CONTACT);
    const phone = asText(contact.phone).slice(0, MAX_CONTACT);
    const email = asText(contact.email).slice(0, MAX_CONTACT);
    if (!extension || !name) throw httpError(400, 'Contact name and extension are required.', 'chat_contact_invalid');
    return { extension, name, company, phone, email };
}

async function sendMessage(pool, conversationId, extension, payload) {
    const ext = normalizeExtension(extension);
    if (!ext) throw httpError(400, 'Extension is required.', 'chat_extension_required');
    if (!(await isParticipant(pool, conversationId, ext))) {
        throw httpError(403, 'You are not a participant in this conversation.', 'chat_forbidden');
    }

    const type = String(payload && payload.type || 'text').toLowerCase();
    if (!['text', 'attachment', 'contact'].includes(type)) {
        throw httpError(400, 'Unsupported message type.', 'chat_message_type_invalid');
    }
    const body = asText(payload && payload.body).slice(0, MAX_BODY);
    const clientId = asText(payload && payload.client_id).slice(0, 64) || crypto.randomBytes(12).toString('hex');
    const attachmentIds = Array.isArray(payload && payload.attachment_ids)
        ? payload.attachment_ids.map((value) => Number(value)).filter((value) => Number.isFinite(value))
        : [];
    if (attachmentIds.length > MAX_ATTACHMENTS) {
        throw httpError(400, `A message can carry at most ${MAX_ATTACHMENTS} attachments.`, 'chat_attachment_limit');
    }
    if (type === 'text' && !body) throw httpError(400, 'Message text is required.', 'chat_message_empty');
    if (type === 'attachment' && attachmentIds.length === 0) {
        throw httpError(400, 'At least one attachment is required.', 'chat_attachment_required');
    }
    if (type === 'contact') {
        const contact = validateContact(payload && payload.contact);
        if (!(await extensionExists(pool, contact.extension))) {
            throw httpError(404, 'The shared contact extension does not exist.', 'chat_contact_extension_unknown');
        }
        payload.contact = contact;
    }
    if (type === 'attachment' && body && body.length > MAX_BODY) {
        throw httpError(400, 'The caption is too long.', 'chat_message_too_long');
    }

    const [existing] = await pool.query(
        'SELECT id FROM asterisk.chat_messages WHERE conversation_id = ? AND sender_extension = ? AND client_id = ? LIMIT 1',
        [conversationId, ext, clientId],
    );
    if (existing.length) {
        return getMessageById(pool, Number(existing[0].id));
    }

    let metadata = null;
    if (type === 'contact') metadata = payload.contact;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [created] = await conn.query(
            `INSERT INTO asterisk.chat_messages
                (conversation_id, sender_extension, type, body, metadata_json, client_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [conversationId, ext, type, body || null, metadata ? JSON.stringify(metadata) : null, clientId],
        );
        const messageId = created.insertId;

        if (attachmentIds.length) {
            const [linked] = await conn.query(
                `UPDATE asterisk.chat_attachments
                 SET message_id = ?
                 WHERE id IN (?) AND uploader_extension = ? AND message_id IS NULL`,
                [messageId, attachmentIds, ext],
            );
            if (Number(linked.affectedRows) !== attachmentIds.length) {
                throw httpError(400, 'One or more attachments are not available.', 'chat_attachment_invalid');
            }
        }

        await conn.query(
            'UPDATE asterisk.chat_conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
            [conversationId],
        );
        await conn.commit();
        return getMessageById(pool, Number(messageId));
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        throw err;
    } finally {
        conn.release();
    }
}

async function getMessageById(pool, messageId) {
    const [rows] = await pool.query(
        `SELECT id, conversation_id, sender_extension, type, body, metadata_json, client_id,
                created_at, deleted_at
         FROM asterisk.chat_messages WHERE id = ? LIMIT 1`,
        [messageId],
    );
    if (!rows.length) throw httpError(404, 'Message not found.', 'chat_message_not_found');
    const attachments = await listAttachmentsForMessages(pool, [Number(messageId)]);
    return serializeMessage(rows[0], attachments.get(Number(messageId)) || []);
}

async function markRead(pool, conversationId, extension, messageId) {
    const ext = normalizeExtension(extension);
    if (!(await isParticipant(pool, conversationId, ext))) {
        throw httpError(403, 'You are not a participant in this conversation.', 'chat_forbidden');
    }
    const target = Number(messageId);
    if (!Number.isFinite(target) || target <= 0) throw httpError(400, 'A message id is required.', 'chat_message_invalid');
    const [messageRows] = await pool.query(
        'SELECT id FROM asterisk.chat_messages WHERE id = ? AND conversation_id = ? LIMIT 1',
        [target, conversationId],
    );
    if (!messageRows.length) throw httpError(404, 'Message not found.', 'chat_message_not_found');
    await pool.query(
        `UPDATE asterisk.chat_participants
         SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), ?)
         WHERE conversation_id = ? AND extension = ?`,
        [target, conversationId, ext],
    );
    return { conversation_id: Number(conversationId), last_read_message_id: target };
}

async function getUnread(pool, extension) {
    const ext = normalizeExtension(extension);
    if (!ext) throw httpError(400, 'Extension is required.', 'chat_extension_required');
    const [rows] = await pool.query(
        `SELECT c.id AS conversation_id,
                (SELECT COUNT(*) FROM asterisk.chat_messages m
                  WHERE m.conversation_id = c.id
                    AND m.sender_extension <> ?
                    AND m.id > COALESCE(p.last_read_message_id, 0)) AS unread
         FROM asterisk.chat_participants p
         JOIN asterisk.chat_conversations c ON c.id = p.conversation_id
         WHERE p.extension = ?`,
        [ext, ext],
    );
    const conversations = rows.map((row) => ({
        conversation_id: Number(row.conversation_id),
        unread: Number(row.unread || 0),
    }));
    return {
        total: conversations.reduce((sum, row) => sum + row.unread, 0),
        conversations,
    };
}

async function createAttachment(pool, uploaderExtension, file, info) {
    const ext = normalizeExtension(uploaderExtension);
    if (!ext) throw httpError(400, 'Extension is required.', 'chat_extension_required');
    const [created] = await pool.query(
        `INSERT INTO asterisk.chat_attachments
            (uploader_extension, original_name, stored_name, mime, size_bytes, sha256, kind, width, height)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ext, info.originalName, info.storedName, info.mime, info.sizeBytes, info.sha256, info.kind, info.width || null, info.height || null],
    );
    return {
        id: Number(created.insertId),
        original_name: info.originalName,
        mime: info.mime,
        size_bytes: info.sizeBytes,
        kind: info.kind,
        sha256: info.sha256,
    };
}

async function getAttachment(pool, attachmentId, extension) {
    const ext = normalizeExtension(extension);
    const [rows] = await pool.query(
        `SELECT a.id, a.message_id, a.uploader_extension, a.original_name, a.stored_name,
                a.mime, a.size_bytes, a.sha256, a.kind, a.created_at, m.conversation_id
         FROM asterisk.chat_attachments a
         LEFT JOIN asterisk.chat_messages m ON m.id = a.message_id
         WHERE a.id = ? LIMIT 1`,
        [Number(attachmentId)],
    );
    if (!rows.length) throw httpError(404, 'Attachment not found.', 'chat_attachment_not_found');
    const row = rows[0];
    if (row.message_id == null) {
        if (String(row.uploader_extension) !== ext) throw httpError(403, 'Attachment is not available.', 'chat_forbidden');
    } else if (!(await isParticipant(pool, row.conversation_id, ext))) {
        throw httpError(403, 'Attachment is not available.', 'chat_forbidden');
    }
    return row;
}

async function recordAdminAudit(pool, adminUser, action, details) {
    await pool.query(
        'INSERT INTO asterisk.chat_admin_audit (admin_user, action, conversation_id, message_id, attachment_id, details) VALUES (?, ?, ?, ?, ?, ?)',
        [
            String(adminUser || 'dashboard'),
            String(action || 'view'),
            details && details.conversationId ? Number(details.conversationId) : null,
            details && details.messageId ? Number(details.messageId) : null,
            details && details.attachmentId ? Number(details.attachmentId) : null,
            details && details.details ? String(details.details).slice(0, 2000) : null,
        ],
    );
}


// ── Dashboard / admin transcript access ───────────────────────────────────

async function listAdminConversations(pool, options) {
    const search = asText(options && options.search).slice(0, 120);
    const limit = Math.min(200, Math.max(1, Number(options && options.limit) || 100));
    const like = `%${search}%`;
    const [rows] = await pool.query(
        `SELECT c.id, c.type, c.title, c.created_by, c.created_at, c.updated_at, c.last_message_at,
                (SELECT COUNT(*) FROM asterisk.chat_messages mc WHERE mc.conversation_id = c.id) AS message_count,
                lm.id AS last_message_id, lm.sender_extension AS last_sender, lm.type AS last_type,
                lm.body AS last_body, lm.created_at AS last_created_at
         FROM asterisk.chat_conversations c
         LEFT JOIN asterisk.chat_messages lm ON lm.id = (
             SELECT m2.id FROM asterisk.chat_messages m2
             WHERE m2.conversation_id = c.id ORDER BY m2.id DESC LIMIT 1
         )
         WHERE (? = ''
                OR EXISTS (SELECT 1 FROM asterisk.chat_participants p
                           WHERE p.conversation_id = c.id AND p.extension LIKE ?)
                OR EXISTS (SELECT 1 FROM asterisk.chat_messages sm
                           WHERE sm.conversation_id = c.id AND sm.body LIKE ?))
         ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
         LIMIT ?`,
        [search, like, like, limit],
    );
    const participants = await listParticipants(pool, rows.map((row) => Number(row.id)));
    return rows.map((row) => ({
        id: Number(row.id),
        type: row.type,
        title: row.title || null,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_message_at: row.last_message_at,
        message_count: Number(row.message_count || 0),
        participants: participants.get(Number(row.id)) || [],
        last_message: row.last_message_id == null ? null : {
            id: Number(row.last_message_id),
            sender_extension: String(row.last_sender || ''),
            type: String(row.last_type || 'text'),
            body: String(row.last_body || ''),
            created_at: row.last_created_at,
        },
    }));
}

async function getAdminMessages(pool, conversationId, beforeId, limit) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const params = [Number(conversationId)];
    let where = 'conversation_id = ?';
    if (Number(beforeId) > 0) {
        where += ' AND id < ?';
        params.push(Number(beforeId));
    }
    params.push(safeLimit + 1);
    const [rows] = await pool.query(
        `SELECT id, conversation_id, sender_extension, type, body, metadata_json, client_id,
                created_at, deleted_at
         FROM asterisk.chat_messages WHERE ${where} ORDER BY id DESC LIMIT ?`,
        params,
    );
    const page = rows.slice(0, safeLimit).reverse();
    const attachments = await listAttachmentsForMessages(pool, page.map((row) => Number(row.id)));
    return {
        messages: page.map((row) => serializeMessage(row, attachments.get(Number(row.id)) || [])),
        has_more: rows.length > safeLimit,
    };
}

async function getAdminAttachment(pool, attachmentId) {
    const [rows] = await pool.query(
        `SELECT id, message_id, uploader_extension, original_name, stored_name, mime,
                size_bytes, sha256, kind, created_at
         FROM asterisk.chat_attachments WHERE id = ? LIMIT 1`,
        [Number(attachmentId)],
    );
    if (!rows.length) throw httpError(404, 'Attachment not found.', 'chat_attachment_not_found');
    return rows[0];
}

async function exportAdminMessages(pool, options) {
    const from = asText(options && options.from) || '1970-01-01 00:00:00';
    const to = asText(options && options.to) || '2999-12-31 23:59:59';
    const extension = normalizeExtension(options && options.extension);
    const [rows] = await pool.query(
        `SELECT m.id, m.conversation_id, m.created_at, m.sender_extension, m.type, m.body,
                m.metadata_json,
                (SELECT GROUP_CONCAT(a.original_name SEPARATOR ' | ')
                   FROM asterisk.chat_attachments a WHERE a.message_id = m.id) AS attachment_names
         FROM asterisk.chat_messages m
         WHERE m.created_at BETWEEN ? AND ?
           AND (? = ''
                OR m.sender_extension = ?
                OR EXISTS (SELECT 1 FROM asterisk.chat_participants p
                           WHERE p.conversation_id = m.conversation_id AND p.extension = ?))
         ORDER BY m.id ASC
         LIMIT 50000`,
        [from, to, extension, extension, extension],
    );
    return rows || [];
}

module.exports = {
    ensureChatSchema,
    extensionExists,
    isParticipant,
    findOrCreateDirect,
    getConversationSummary,
    listConversations,
    getMessages,
    getMessageById,
    sendMessage,
    markRead,
    getUnread,
    createAttachment,
    getAttachment,
    recordAdminAudit,
    listAdminConversations,
    getAdminMessages,
    getAdminAttachment,
    exportAdminMessages,
    listChatExtensions,
    httpError,
    MAX_BODY,
    MAX_CONTACT,
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_BYTES,
    MAX_IMAGE_BYTES,
};
