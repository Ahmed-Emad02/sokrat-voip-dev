'use strict';

/**
 * AES-256-CBC secret helper for AI provider credentials.
 *
 * The web process already uses this exact format for SMTP/federation secrets:
 *   iv_hex:cipher_hex
 * The worker is a separate process, so it needs the same derivation and
 * format without importing server.js (which would start the HTTP server).
 */

const crypto = require('crypto');

function getKey() {
    let raw = process.env.ENCRYPTION_KEY;
    if (!raw || String(raw).length < 32 || String(raw).includes('change-me')) {
        throw new Error('ENCRYPTION_KEY is required to read or write AI provider credentials.');
    }
    return crypto.createHash('sha256').update(String(raw)).digest();
}

function encrypt(text) {
    if (text === null || text === undefined) return '';
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
    let encrypted = cipher.update(String(text), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
    if (!text) return '';
    try {
        const parts = String(text).split(':');
        if (parts.length < 2) return '';
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (_) {
        return '';
    }
}

module.exports = { encrypt, decrypt };
