'use strict';

/**
 * Internal extension chat API.
 *
 * Authenticated exactly like the address-book API: HMAC-SHA256 over the
 * extension password. Conversations and messages are stored server-side by
 * `lib/chat/store.js`; attachments are written outside the web root and are
 * only served through this authenticated route.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { requireExtensionSignature } = require('../lib/extension-auth');
const chatStore = require('../lib/chat/store');
const { notifyChatMessage } = require('../lib/chat/notify');
const { issueChatToken } = require('../lib/chat/token');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

function sendError(res, err, fallback) {
    const status = Number(err && err.statusCode) || 500;
    if (status >= 500) console.error('[extension-chat]', err && err.stack || err);
    return res.status(status).json({
        success: false,
        error: (err && err.message) || fallback || 'Chat request failed.',
        code: (err && err.code) || 'chat_error',
    });
}

function safeOriginalName(value) {
    return String(value || 'file')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .slice(0, 255) || 'file';
}

function safeExtension(value) {
    const ext = path.extname(String(value || '')).toLowerCase();
    return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

function detectAttachment(buffer, originalName, reportedMime) {
    const ext = safeExtension(originalName);
    const hex = buffer.subarray(0, 16).toString('hex');
    const ascii = buffer.subarray(0, 16).toString('ascii');
    const allowed = {
        '.jpg': { mime: 'image/jpeg', kind: 'image' },
        '.jpeg': { mime: 'image/jpeg', kind: 'image' },
        '.png': { mime: 'image/png', kind: 'image' },
        '.gif': { mime: 'image/gif', kind: 'image' },
        '.webp': { mime: 'image/webp', kind: 'image' },
        '.pdf': { mime: 'application/pdf', kind: 'pdf' },
        '.doc': { mime: 'application/msword', kind: 'file' },
        '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'file' },
        '.xls': { mime: 'application/vnd.ms-excel', kind: 'excel' },
        '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'excel' },
        '.ppt': { mime: 'application/vnd.ms-powerpoint', kind: 'file' },
        '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'file' },
        '.csv': { mime: 'text/csv', kind: 'file' },
        '.txt': { mime: 'text/plain', kind: 'file' },
        '.zip': { mime: 'application/zip', kind: 'file' },
        '.m4a': { mime: 'audio/mp4', kind: 'audio' },
        '.mp4': { mime: 'audio/mp4', kind: 'audio' },
        '.webm': { mime: 'audio/webm', kind: 'audio' },
        '.weba': { mime: 'audio/webm', kind: 'audio' },
        '.ogg': { mime: 'audio/ogg', kind: 'audio' },
        '.oga': { mime: 'audio/ogg', kind: 'audio' },
        '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
        '.wav': { mime: 'audio/wav', kind: 'audio' },
    };
    const expected = allowed[ext];
    if (!expected) {
        throw chatStore.httpError(400, 'Unsupported file type.', 'chat_attachment_type');
    }

    let mime = expected.mime;
    let kind = expected.kind;
    if (['.jpg', '.jpeg'].includes(ext) && !hex.startsWith('ffd8ff')) {
        throw chatStore.httpError(400, 'Image content does not match its extension.', 'chat_attachment_type');
    }
    if (ext === '.png' && !hex.startsWith('89504e470d0a1a0a')) {
        throw chatStore.httpError(400, 'Image content does not match its extension.', 'chat_attachment_type');
    }
    if (ext === '.gif' && !(ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'))) {
        throw chatStore.httpError(400, 'Image content does not match its extension.', 'chat_attachment_type');
    }
    if (ext === '.webp' && !(ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')) {
        throw chatStore.httpError(400, 'Image content does not match its extension.', 'chat_attachment_type');
    }
    if (ext === '.pdf' && !ascii.startsWith('%PDF')) {
        throw chatStore.httpError(400, 'PDF content does not match its extension.', 'chat_attachment_type');
    }
    if (ext === '.wav' && !(ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE')) {
        throw chatStore.httpError(400, 'Audio content does not match its extension.', 'chat_attachment_type');
    }
    if (ext === '.webm' || ext === '.weba') {
        if (!hex.startsWith('1a45dfa3')) throw chatStore.httpError(400, 'Audio content does not match its extension.', 'chat_attachment_type');
    }
    if (ext === '.ogg' || ext === '.oga') {
        if (!ascii.startsWith('OggS')) throw chatStore.httpError(400, 'Audio content does not match its extension.', 'chat_attachment_type');
    }
    if (ext === '.mp3') {
        if (!(ascii.startsWith('ID3') || ['fffb', 'fff3', 'fff2'].some(prefix => hex.startsWith(prefix)))) {
            throw chatStore.httpError(400, 'Audio content does not match its extension.', 'chat_attachment_type');
        }
    }
    if (ext === '.m4a' || ext === '.mp4') {
        if (!(ascii.slice(4, 8) === 'ftyp' && ['M4A ', 'M4B ', 'mp42', 'isom'].includes(ascii.slice(8, 12)))) {
            throw chatStore.httpError(400, 'Audio content does not match its extension.', 'chat_attachment_type');
        }
    }
    if (['.doc', '.xls', '.ppt'].includes(ext) && !hex.startsWith('d0cf11e0a1b11ae1')) {
        throw chatStore.httpError(400, 'Document content does not match its extension.', 'chat_attachment_type');
    }
    if (['.docx', '.xlsx', '.pptx', '.zip'].includes(ext) && !hex.startsWith('504b0304')) {
        throw chatStore.httpError(400, 'Archive content does not match its extension.', 'chat_attachment_type');
    }
    if (['.csv', '.txt'].includes(ext) && buffer.includes(0)) {
        throw chatStore.httpError(400, 'Text file contains binary data.', 'chat_attachment_type');
    }

    if (kind === 'image' && buffer.length > MAX_IMAGE_BYTES) {
        throw chatStore.httpError(413, 'Images must be 10 MB or smaller.', 'chat_attachment_too_large');
    }
    if (kind === 'audio' && buffer.length > MAX_AUDIO_BYTES) {
        throw chatStore.httpError(413, 'Audio notes must be 50 MB or smaller.', 'chat_attachment_too_large');
    }
    if (kind !== 'image' && kind !== 'audio' && buffer.length > MAX_DOC_BYTES) {
        throw chatStore.httpError(413, 'Files must be 50 MB or smaller.', 'chat_attachment_too_large');
    }
    void reportedMime;
    return { mime, kind };
}

module.exports = function createExtensionChatRouter(pool, options) {
    const router = express.Router();
    const chat = options && options.chat;
    const uploadDir = path.resolve(
        (options && options.uploadDir)
        || process.env.CHAT_UPLOAD_DIR
        || '/var/lib/sokrat-voip/chat-uploads',
    );
    fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir),
        filename: (_req, file, cb) => {
            cb(null, `${crypto.randomUUID()}${safeExtension(file.originalname)}`);
        },
    });
    const upload = multer({
        storage,
        limits: { fileSize: MAX_DOC_BYTES, files: 1 },
    });
    function uploadOne(req, res, next) {
        upload.single('file')(req, res, (err) => {
            if (!err) return next();
            if (err.code === 'LIMIT_FILE_SIZE') {
                return sendError(res, chatStore.httpError(413, 'Files must be 50 MB or smaller.', 'chat_attachment_too_large'));
            }
            return sendError(res, chatStore.httpError(400, err.message || 'Invalid upload.', 'chat_attachment_invalid'));
        });
    }

    let schemaReady = null;
    router.use((req, res, next) => {
        if (!schemaReady) schemaReady = chatStore.ensureChatSchema(pool);
        schemaReady.then(() => next()).catch((err) => sendError(res, err, 'Chat is not ready.'));
    });
    router.use(requireExtensionSignature(pool));

    router.post('/session', (req, res) => {
        try {
            const issued = issueChatToken(req.sokratExtension);
            return res.json({
                success: true,
                ...issued,
                socket_path: '/chat',
            });
        } catch (err) {
            return sendError(res, err, 'Failed to create the chat session.');
        }
    });

    router.get('/extensions', async (req, res) => {
        try {
            const online = new Set(chat && typeof chat.onlineExtensions === 'function'
                ? chat.onlineExtensions()
                : []);
            const extensions = (await chatStore.listChatExtensions(pool)).map((item) => ({
                ...item,
                online: online.has(String(item.extension)),
            }));
            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, extensions });
        } catch (err) {
            return sendError(res, err, 'Failed to load extensions.');
        }
    });

    router.get('/conversations', async (req, res) => {
        try {
            const conversations = await chatStore.listConversations(pool, req.sokratExtension);
            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, conversations });
        } catch (err) {
            return sendError(res, err, 'Failed to load conversations.');
        }
    });

    router.post('/conversations', async (req, res) => {
        try {
            const other = String((req.body && req.body.extension) || '').trim();
            const id = await chatStore.findOrCreateDirect(pool, req.sokratExtension, other);
            const conversation = await chatStore.getConversationSummary(pool, id);
            if (chat) chat.notifyConversation(conversation);
            return res.status(201).json({ success: true, conversation });
        } catch (err) {
            return sendError(res, err, 'Failed to create the conversation.');
        }
    });

    router.get('/conversations/:id/messages', async (req, res) => {
        try {
            const result = await chatStore.getMessages(
                pool,
                Number(req.params.id),
                req.sokratExtension,
                req.query.before_id || req.query.before,
                req.query.limit,
            );
            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, ...result });
        } catch (err) {
            return sendError(res, err, 'Failed to load messages.');
        }
    });

    router.post('/conversations/:id/messages', async (req, res) => {
        try {
            const message = await chatStore.sendMessage(
                pool,
                Number(req.params.id),
                req.sokratExtension,
                req.body || {},
            );
            if (chat) void chat.notifyMessage(Number(req.params.id), message);
            void notifyChatMessage(pool, Number(req.params.id), message);
            return res.status(201).json({ success: true, message });
        } catch (err) {
            return sendError(res, err, 'Failed to send the message.');
        }
    });

    router.post('/conversations/:id/read', async (req, res) => {
        try {
            const result = await chatStore.markRead(
                pool,
                Number(req.params.id),
                req.sokratExtension,
                req.body && (req.body.message_id || req.body.last_message_id),
            );
            if (chat) void chat.notifyRead(Number(req.params.id), req.sokratExtension, result.last_read_message_id);
            return res.json({ success: true, ...result });
        } catch (err) {
            return sendError(res, err, 'Failed to update the read state.');
        }
    });

    router.get('/unread', async (req, res) => {
        try {
            const result = await chatStore.getUnread(pool, req.sokratExtension);
            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, ...result });
        } catch (err) {
            return sendError(res, err, 'Failed to load unread counts.');
        }
    });

    router.post('/attachments', uploadOne, async (req, res) => {
        if (!req.file) return sendError(res, chatStore.httpError(400, 'A file is required.', 'chat_attachment_required'));
        try {
            const buffer = fs.readFileSync(req.file.path);
            const detected = detectAttachment(buffer, req.file.originalname, req.file.mimetype);
            const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
            const attachment = await chatStore.createAttachment(pool, req.sokratExtension, req.file, {
                originalName: safeOriginalName(req.file.originalname),
                storedName: path.basename(req.file.filename),
                mime: detected.mime,
                kind: detected.kind,
                sizeBytes: req.file.size,
                sha256,
            });
            return res.status(201).json({ success: true, attachment });
        } catch (err) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
            return sendError(res, err, 'Failed to upload the attachment.');
        }
    });

    router.get('/attachments/:id', async (req, res) => {
        try {
            const attachment = await chatStore.getAttachment(pool, req.params.id, req.sokratExtension);
            const filePath = path.join(uploadDir, path.basename(attachment.stored_name));
            if (!fs.existsSync(filePath)) {
                throw chatStore.httpError(404, 'Attachment file is missing.', 'chat_attachment_missing');
            }
            res.set('Cache-Control', 'private, max-age=0');
            res.set('X-Content-Type-Options', 'nosniff');
            if (attachment.kind === 'image') {
                res.set('Content-Type', attachment.mime);
                return res.sendFile(filePath);
            }
            res.set('Content-Type', attachment.mime);
            return res.download(filePath, attachment.original_name);
        } catch (err) {
            return sendError(res, err, 'Failed to download the attachment.');
        }
    });

    return router;
};
