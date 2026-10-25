'use strict';

/**
 * Socket.IO /chat namespace.
 *
 * REST owns persistence; the socket only fan-outs already-stored messages,
 * read receipts, typing and presence. Every socket authenticates with a
 * short-lived token issued by the HMAC REST API.
 */

const { verifyChatToken } = require('./token');
const chatStore = require('./store');

function attachChatSocket(io, pool) {
    const namespace = io.of('/chat');
    const online = new Map(); // extension -> Set<socket.id>

    function participantExtensions(conversationId) {
        return pool.query(
            'SELECT extension FROM asterisk.chat_participants WHERE conversation_id = ?',
            [Number(conversationId)],
        ).then(([rows]) => (rows || []).map((row) => String(row.extension)));
    }

    function emitToExtensions(extensions, event, payload) {
        for (const ext of extensions || []) {
            namespace.to(`ext:${ext}`).emit(event, payload);
        }
    }

    namespace.use((socket, next) => {
        const auth = socket.handshake && socket.handshake.auth ? socket.handshake.auth : {};
        const token = auth.token || (socket.handshake.query && socket.handshake.query.token);
        const extension = verifyChatToken(token);
        if (!extension) return next(new Error('unauthorized'));
        socket.data.extension = extension;
        return next();
    });

    namespace.on('connection', (socket) => {
        const extension = String(socket.data.extension || '');
        if (!extension) return socket.disconnect(true);

        if (!online.has(extension)) online.set(extension, new Set());
        online.get(extension).add(socket.id);
        socket.join(`ext:${extension}`);

        socket.emit('chat:ready', {
            extension,
            online: Array.from(online.keys()),
        });
        namespace.emit('chat:presence', { extension, online: true });

        socket.on('chat:typing', async (payload) => {
            try {
                const conversationId = Number(payload && payload.conversation_id);
                if (!conversationId || !(await chatStore.isParticipant(pool, conversationId, extension))) return;
                const recipients = (await participantExtensions(conversationId)).filter((ext) => ext !== extension);
                emitToExtensions(recipients, 'chat:typing', {
                    conversation_id: conversationId,
                    extension,
                    typing: Boolean(payload && payload.typing),
                });
            } catch (_) { /* typing is best-effort */ }
        });

        socket.on('disconnect', () => {
            const sockets = online.get(extension);
            if (sockets) {
                sockets.delete(socket.id);
                if (sockets.size === 0) {
                    online.delete(extension);
                    namespace.emit('chat:presence', { extension, online: false });
                }
            }
        });
    });

    return {
        async notifyMessage(conversationId, message) {
            try {
                const recipients = await participantExtensions(conversationId);
                emitToExtensions(recipients, 'chat:message', {
                    conversation_id: Number(conversationId),
                    message,
                });
            } catch (err) {
                console.error('[chat-socket] notifyMessage:', err.message);
            }
        },

        async notifyRead(conversationId, extension, lastReadMessageId) {
            try {
                const recipients = await participantExtensions(conversationId);
                emitToExtensions(recipients, 'chat:read', {
                    conversation_id: Number(conversationId),
                    extension: String(extension),
                    last_read_message_id: Number(lastReadMessageId),
                });
            } catch (err) {
                console.error('[chat-socket] notifyRead:', err.message);
            }
        },

        notifyConversation(conversation) {
            try {
                const recipients = (conversation && conversation.participants || []).map((p) => p.extension);
                emitToExtensions(recipients, 'chat:conversation', { conversation });
            } catch (err) {
                console.error('[chat-socket] notifyConversation:', err.message);
            }
        },

        onlineExtensions() {
            return Array.from(online.keys());
        },
    };
}

module.exports = { attachChatSocket };
