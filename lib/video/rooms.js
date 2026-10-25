'use strict';

/**
 * Video conference room metadata.
 *
 * Media is handled by LiveKit; this module only owns room records, membership
 * and audit data. All access is scoped to PBX extensions.
 */

const crypto = require('crypto');

const MAX_TITLE = 120;
const MAX_INVITEES = 50;
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 50;

function httpError(statusCode, message, code) {
    const error = new Error(message || 'Video room request failed.');
    error.statusCode = statusCode;
    error.code = code || 'video_room_error';
    return error;
}

function normalizeExtension(value) {
    return String(value == null ? '' : value).trim().replace(/[^0-9A-Za-z*#._-]/g, '');
}

function asText(value, max) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeLimit(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(number)));
}

function newRoomName() {
    return 'sokrat-' + crypto.randomBytes(12).toString('hex');
}

async function ensureVideoSchema(pool) {
    await pool.query(
        `CREATE TABLE IF NOT EXISTS asterisk.video_rooms (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`livekit_name\` VARCHAR(120) NOT NULL,
            \`title\` VARCHAR(120) NOT NULL,
            \`created_by\` VARCHAR(20) NOT NULL,
            \`status\` ENUM('active','ended') NOT NULL DEFAULT 'active',
            \`max_participants\` INT NOT NULL DEFAULT 9,
            \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            \`ended_at\` TIMESTAMP NULL DEFAULT NULL,
            UNIQUE KEY \`uniq_video_livekit_name\` (\`livekit_name\`),
            KEY \`idx_video_status\` (\`status\`),
            KEY \`idx_video_created\` (\`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    );
    await pool.query(
        `CREATE TABLE IF NOT EXISTS asterisk.video_room_participants (
            \`room_id\` BIGINT NOT NULL,
            \`extension\` VARCHAR(20) NOT NULL,
            \`role\` ENUM('owner','member') NOT NULL DEFAULT 'member',
            \`invited_by\` VARCHAR(20) DEFAULT NULL,
            \`invited_at\` TIMESTAMP NULL DEFAULT NULL,
            \`joined_at\` TIMESTAMP NULL DEFAULT NULL,
            \`left_at\` TIMESTAMP NULL DEFAULT NULL,
            PRIMARY KEY (\`room_id\`,\`extension\`),
            KEY \`idx_video_participant_ext\` (\`extension\`),
            CONSTRAINT \`fk_video_participant_room\` FOREIGN KEY (\`room_id\`)
                REFERENCES asterisk.video_rooms (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    );
    await pool.query(
        `CREATE TABLE IF NOT EXISTS asterisk.video_room_audit (
            \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
            \`extension\` VARCHAR(20) NOT NULL,
            \`action\` VARCHAR(40) NOT NULL,
            \`room_id\` BIGINT DEFAULT NULL,
            \`details\` TEXT DEFAULT NULL,
            \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY \`idx_video_audit_created\` (\`created_at\`),
            KEY \`idx_video_audit_room\` (\`room_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    );
}

async function audit(pool, extension, action, roomId, details) {
    try {
        await pool.query(
            'INSERT INTO asterisk.video_room_audit (extension, action, room_id, details) VALUES (?, ?, ?, ?)',
            [extension, action, roomId || null, details ? JSON.stringify(details) : null],
        );
    } catch (error) {
        console.warn('[video] audit failed:', error.message);
    }
}

async function getRoomRow(pool, roomId) {
    const [rows] = await pool.query(
        'SELECT * FROM asterisk.video_rooms WHERE id = ? LIMIT 1',
        [Number(roomId)],
    );
    return rows[0] || null;
}

async function listParticipants(pool, roomId) {
    const [rows] = await pool.query(
        `SELECT extension, role, invited_by, invited_at, joined_at, left_at
         FROM asterisk.video_room_participants
         WHERE room_id = ?
         ORDER BY role = 'owner' DESC, extension ASC`,
        [Number(roomId)],
    );
    return rows.map((row) => ({
        extension: String(row.extension),
        role: row.role,
        invited_by: row.invited_by || null,
        invited_at: row.invited_at || null,
        joined_at: row.joined_at || null,
        left_at: row.left_at || null,
    }));
}

async function serializeRoom(pool, row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        livekit_name: row.livekit_name,
        title: row.title,
        created_by: row.created_by,
        status: row.status,
        max_participants: Number(row.max_participants),
        created_at: row.created_at,
        ended_at: row.ended_at || null,
        participants: await listParticipants(pool, row.id),
    };
}

async function requireMember(pool, roomId, extension) {
    const ext = normalizeExtension(extension);
    const [rows] = await pool.query(
        'SELECT 1 FROM asterisk.video_room_participants WHERE room_id = ? AND extension = ? LIMIT 1',
        [Number(roomId), ext],
    );
    if (!rows.length) throw httpError(403, 'You are not invited to this video room.', 'video_room_forbidden');
    return ext;
}

async function createRoom(pool, createdBy, payload) {
    const creator = normalizeExtension(createdBy);
    if (!creator) throw httpError(400, 'Extension is required.', 'video_extension_required');
    const title = asText(payload && payload.title, MAX_TITLE) || 'Video room';
    const maxParticipants = normalizeLimit(
        payload && payload.max_participants,
        9,
        MIN_PARTICIPANTS,
        MAX_PARTICIPANTS,
    );
    const invitees = Array.isArray(payload && payload.invitees)
        ? payload.invitees.map(normalizeExtension).filter((ext) => ext && ext !== creator)
        : [];
    const uniqueInvitees = Array.from(new Set(invitees)).slice(0, MAX_INVITEES);
    const livekitName = newRoomName();
    const [result] = await pool.query(
        `INSERT INTO asterisk.video_rooms
            (livekit_name, title, created_by, status, max_participants)
         VALUES (?, ?, ?, 'active', ?)`,
        [livekitName, title, creator, maxParticipants],
    );
    const roomId = Number(result.insertId);
    await pool.query(
        `INSERT INTO asterisk.video_room_participants
            (room_id, extension, role, invited_by, invited_at)
         VALUES (?, ?, 'owner', ?, NOW())`,
        [roomId, creator, creator],
    );
    for (const invitee of uniqueInvitees) {
        await pool.query(
            `INSERT INTO asterisk.video_room_participants
                (room_id, extension, role, invited_by, invited_at)
             VALUES (?, ?, 'member', ?, NOW())
             ON DUPLICATE KEY UPDATE invited_by = VALUES(invited_by), invited_at = VALUES(invited_at)`,
            [roomId, invitee, creator],
        );
    }
    await audit(pool, creator, 'create', roomId, { title, invitees: uniqueInvitees });
    return serializeRoom(pool, await getRoomRow(pool, roomId));
}

async function listRooms(pool, extension, options) {
    const ext = normalizeExtension(extension);
    const activeOnly = !options || options.active !== false;
    const [rows] = await pool.query(
        `SELECT r.*
         FROM asterisk.video_rooms r
         JOIN asterisk.video_room_participants p ON p.room_id = r.id
         WHERE p.extension = ? ${activeOnly ? "AND r.status = 'active'" : ''}
         ORDER BY r.created_at DESC
         LIMIT 50`,
        [ext],
    );
    const rooms = [];
    for (const row of rows) rooms.push(await serializeRoom(pool, row));
    return rooms;
}

async function getRoom(pool, roomId, extension) {
    const ext = normalizeExtension(extension);
    const row = await getRoomRow(pool, roomId);
    if (!row) throw httpError(404, 'Video room not found.', 'video_room_not_found');
    await requireMember(pool, roomId, ext);
    return serializeRoom(pool, row);
}

async function getJoinInfo(pool, roomId, extension) {
    const ext = normalizeExtension(extension);
    const row = await getRoomRow(pool, roomId);
    if (!row) throw httpError(404, 'Video room not found.', 'video_room_not_found');
    if (row.status !== 'active') throw httpError(410, 'This video room has ended.', 'video_room_ended');
    await requireMember(pool, roomId, ext);
    return { room: await serializeRoom(pool, row), extension: ext };
}

async function invite(pool, roomId, invitedBy, extensions) {
    const actor = normalizeExtension(invitedBy);
    const room = await getRoomRow(pool, roomId);
    if (!room) throw httpError(404, 'Video room not found.', 'video_room_not_found');
    if (room.status !== 'active') throw httpError(410, 'This video room has ended.', 'video_room_ended');
    await requireMember(pool, roomId, actor);
    const list = Array.isArray(extensions)
        ? extensions.map(normalizeExtension).filter((ext) => ext && ext !== actor)
        : [];
    const unique = Array.from(new Set(list)).slice(0, MAX_INVITEES);
    for (const ext of unique) {
        await pool.query(
            `INSERT INTO asterisk.video_room_participants
                (room_id, extension, role, invited_by, invited_at)
             VALUES (?, ?, 'member', ?, NOW())
             ON DUPLICATE KEY UPDATE invited_by = VALUES(invited_by), invited_at = VALUES(invited_at)`,
            [Number(roomId), ext, actor],
        );
    }
    await audit(pool, actor, 'invite', Number(roomId), { extensions: unique });
    return serializeRoom(pool, await getRoomRow(pool, roomId));
}

async function markJoined(pool, roomId, extension) {
    const ext = normalizeExtension(extension);
    await requireMember(pool, roomId, ext);
    await pool.query(
        `UPDATE asterisk.video_room_participants
         SET joined_at = COALESCE(joined_at, NOW()), left_at = NULL
         WHERE room_id = ? AND extension = ?`,
        [Number(roomId), ext],
    );
}

async function leave(pool, roomId, extension) {
    const ext = normalizeExtension(extension);
    await pool.query(
        'UPDATE asterisk.video_room_participants SET left_at = NOW() WHERE room_id = ? AND extension = ?',
        [Number(roomId), ext],
    );
    await audit(pool, ext, 'leave', Number(roomId), null);
}

async function endRoom(pool, roomId, extension) {
    const ext = normalizeExtension(extension);
    const row = await getRoomRow(pool, roomId);
    if (!row) throw httpError(404, 'Video room not found.', 'video_room_not_found');
    if (row.created_by !== ext) throw httpError(403, 'Only the room owner can end it.', 'video_room_forbidden');
    if (row.status === 'active') {
        await pool.query("UPDATE asterisk.video_rooms SET status = 'ended', ended_at = NOW() WHERE id = ?", [Number(roomId)]);
        await audit(pool, ext, 'end', Number(roomId), null);
    }
    return serializeRoom(pool, await getRoomRow(pool, roomId));
}

module.exports = {
    ensureVideoSchema,
    createRoom,
    listRooms,
    getRoom,
    getJoinInfo,
    invite,
    markJoined,
    leave,
    endRoom,
    normalizeExtension,
    httpError,
};
