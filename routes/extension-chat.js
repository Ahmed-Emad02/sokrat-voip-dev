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

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;

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
    let mime = '';
    let kind = '';

    if (hex.startsWith('ffd8ff')) {
        mime = 'image/jpeg';
        kind = 'image';
    } else if (hex.startsWith('89504e470d0a1a0a')) {
        mime = 'image/png';
        kind = 'image';
    } else if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
        mime = 'image/gif';
        kind = 'image';
    } else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
        mime = 'image/webp';
        kind = 'image';
    } else if (ascii.startsWith('%PDF')) {
        mime = 'application/pdf';
        kind = 'pdf';
    } else if (hex.startsWith('d0cf11e0a1b11ae1')) {
        mime = 'application/vnd.ms-excel';
        kind = 'excel';
    } else if (hex.startsWith('504b0304')) {
        if (ext === '.xlsx') {
            mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            kind = 'excel';
        }
    }

    if (!kind) {
        throw chatStore.httpError(400, 'Unsupported file type. Allowed: images, PDF, XLS, XLSX.', 'chat_attachment_type');
    }
    if (kind === 'image' && buffer.length > MAX_IMAGE_BYTES) {
        throw chatStore.httpError(413, 'Images must be 2 MB or smaller.', 'chat_attachment_too_large');
    }
    if (kind !== 'image' && buffer.length > MAX_DOC_BYTES) {
        throw chatStore.httpError(413, 'Documents must be 10 MB or smaller.', 'chat_attachment_too_large');
    }
    if (kind === 'image' && ext && !['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
        throw chatStore.httpError(400, 'Image extension does not match the file content.', 'chat_attachment_type');
    }
    if (kind === 'pdf' && ext !== '.pdf') {
        throw chatStore.httpError(400, 'PDF extension does not match the file content.', 'chat_attachment_type');
    }
    if (kind === 'excel' && !['.xls', '.xlsx'].includes(ext)) {
        throw chatStore.httpError(400, 'Excel extension does not match the file content.', 'chat_attachment_type');
    }
    // Keep the reported MIME for diagnostics but serve the detected one.
    void reportedMime;
    return { mime, kind };
}

module.exports = function createExtensionChatRouter(pool, options) {
    const router = express.Router();
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
                return sendError(res, chatStore.httpError(413, 'Documents must be 10 MB or smaller.', 'chat_attachment_too_large'));
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
