'use strict';

/**
 * Best-effort gateway notification for a stored chat message.
 *
 * The PBX remains the chat source of truth. The gateway only fans the stored
 * message out to approved mobile push registrations. Hook credentials stay in
 * the root-owned gateway-hook.json and are never logged.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

function loadHook() {
    const file = path.join('/etc/sokrat', 'gateway-hook.json');
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || (stat.mode & 0o007)) return null;
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!config || typeof config.gatewayUrl !== 'string' || !config.gatewayUrl.startsWith('https://')
            || typeof config.token !== 'string' || !config.token
            || typeof config.pbxId !== 'string' || !config.pbxId) return null;
        if (config.caFile !== '/etc/frp/gateway-ca.crt') return null;
        return config;
    } catch (_) {
        return null;
    }
}

function preview(message) {
    if (message.type === 'attachment') return message.body || 'Attachment';
    const body = String(message.body || '').replace(/\s+/g, ' ').trim();
    return body.slice(0, 140) || 'New chat message';
}

async function notifyChatMessage(pool, conversationId, message) {
    const hook = loadHook();
    if (!hook || !message || !Number(conversationId)) return;
    let participants = [];
    try {
        const conversation = await require('./store').getConversationSummary(pool, Number(conversationId));
        participants = (conversation.participants || [])
            .map((row) => String(row.extension || ''))
            .filter((extension) => extension && extension !== String(message.sender_extension || ''));
    } catch (_) {
        return;
    }
    if (!participants.length) return;

    const body = JSON.stringify({
        type: 'chat-message',
        conversationId: Number(conversationId),
        recipients: participants,
        message: {
            id: Number(message.id),
            sender_extension: String(message.sender_extension || ''),
            type: String(message.type || 'text'),
            body: String(message.body || '').slice(0, 4000),
            created_at: message.created_at || null,
            preview: preview(message),
        },
    });
    const target = new URL(hook.gatewayUrl.replace(/\/+$/, '') + '/api/gateway/chat-message');
    const request = (target.protocol === 'https:' ? https : http).request({
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        timeout: 3000,
        ca: hook.caFile ? fs.readFileSync(hook.caFile) : undefined,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: 'Bearer ' + hook.token,
            'X-Sokrat-Pbx': hook.pbxId,
            'X-Sokrat-Timestamp': String(Date.now()),
            'X-Sokrat-Nonce': crypto.randomBytes(16).toString('hex'),
        },
    }, (response) => {
        response.resume();
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => {});
    request.end(body);
}

module.exports = { notifyChatMessage };
