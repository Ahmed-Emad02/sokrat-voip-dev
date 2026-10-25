'use strict';

/**
 * Video conference room API.
 *
 * Media is served by LiveKit. This router only authorizes extension identities
 * and returns short-lived room tokens; the LiveKit API secret never reaches
 * the desktop client.
 */

const express = require('express');
const { requireExtensionSignature } = require('../lib/extension-auth');
const rooms = require('../lib/video/rooms');
const tokens = require('../lib/video/tokens');

function sendError(res, err, fallback) {
    const status = Number(err && err.statusCode) || 500;
    if (status >= 500) console.error('[extension-video]', err && err.stack || err);
    return res.status(status).json({
        success: false,
        error: (err && err.message) || fallback || 'Video room request failed.',
        code: (err && err.code) || 'video_room_error',
    });
}

function parseRoomId(value) {
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0) throw rooms.httpError(400, 'Invalid room id.', 'video_room_id_invalid');
    return id;
}

module.exports = function createExtensionVideoRouter(pool) {
    const router = express.Router();
    let schemaReady = null;

    router.use((req, res, next) => {
        if (!schemaReady) schemaReady = rooms.ensureVideoSchema(pool);
        schemaReady.then(() => next()).catch((err) => sendError(res, err, 'Video rooms are not ready.'));
    });
    router.use(requireExtensionSignature(pool));

    router.get('/status', (req, res) => {
        res.set('Cache-Control', 'no-store');
        return res.json({
            success: true,
            configured: tokens.isConfigured(),
            livekit_url: tokens.isConfigured() ? tokens.getConfig().url : null,
        });
    });

    router.post('/rooms', async (req, res) => {
        try {
            const room = await rooms.createRoom(pool, req.sokratExtension, req.body || {});
            return res.status(201).json({ success: true, room });
        } catch (err) {
            return sendError(res, err, 'Failed to create the video room.');
        }
    });

    router.get('/rooms', async (req, res) => {
        try {
            const list = await rooms.listRooms(pool, req.sokratExtension, {
                active: req.query.active !== '0',
            });
            return res.json({ success: true, rooms: list });
        } catch (err) {
            return sendError(res, err, 'Failed to list video rooms.');
        }
    });

    router.get('/rooms/:id', async (req, res) => {
        try {
            const room = await rooms.getRoom(pool, parseRoomId(req.params.id), req.sokratExtension);
            return res.json({ success: true, room });
        } catch (err) {
            return sendError(res, err, 'Failed to load the video room.');
        }
    });

    router.post('/rooms/:id/token', async (req, res) => {
        try {
            const roomId = parseRoomId(req.params.id);
            const { room, extension } = await rooms.getJoinInfo(pool, roomId, req.sokratExtension);
            const participant = (room.participants || []).find((item) => item.extension === extension);
            let displayName = extension;
            try {
                const [nameRows] = await pool.query(
                    'SELECT name FROM asterisk.users WHERE extension = ? LIMIT 1',
                    [extension],
                );
                if (nameRows.length && nameRows[0].name) displayName = String(nameRows[0].name);
            } catch (_) {}
            const issued = tokens.issueToken({
                roomName: room.livekit_name,
                extension,
                name: displayName,
                role: participant ? participant.role : 'member',
            });
            await rooms.markJoined(pool, roomId, extension);
            return res.json({
                success: true,
                room,
                livekit_url: issued.livekit_url,
                token: issued.token,
                expires_at: issued.expires_at,
            });
        } catch (err) {
            return sendError(res, err, 'Failed to issue the video room token.');
        }
    });

    router.post('/rooms/:id/invite', async (req, res) => {
        try {
            const room = await rooms.invite(
                pool,
                parseRoomId(req.params.id),
                req.sokratExtension,
                (req.body && req.body.extensions) || [],
            );
            return res.json({ success: true, room });
        } catch (err) {
            return sendError(res, err, 'Failed to invite participants.');
        }
    });

    router.post('/rooms/:id/leave', async (req, res) => {
        try {
            await rooms.leave(pool, parseRoomId(req.params.id), req.sokratExtension);
            return res.json({ success: true });
        } catch (err) {
            return sendError(res, err, 'Failed to leave the video room.');
        }
    });

    router.post('/rooms/:id/end', async (req, res) => {
        try {
            const room = await rooms.endRoom(pool, parseRoomId(req.params.id), req.sokratExtension);
            return res.json({ success: true, room });
        } catch (err) {
            return sendError(res, err, 'Failed to end the video room.');
        }
    });

    return router;
};
