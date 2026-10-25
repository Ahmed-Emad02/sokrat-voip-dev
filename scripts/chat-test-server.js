'use strict';

/**
 * Isolated chat API test harness.
 *
 * This is NOT the production server. It mounts only the extension chat router
 * so the API can be exercised without restarting Sokrat VOIP.
 *
 *   node scripts/chat-test-server.js
 *   # listens on 127.0.0.1:18080
 */

require('dotenv').config({ path: '/opt/sokrat-voip/.env' });
const express = require('express');
const mysql = require('mysql2/promise');
const createExtensionChatRouter = require('../routes/extension-chat');
const { ensureChatSchema } = require('../lib/chat/store');

const PORT = Number(process.env.CHAT_TEST_PORT) || 18080;
const uploadDir = process.env.CHAT_TEST_UPLOAD_DIR || '/var/lib/sokrat-voip/chat-test-uploads';

(async () => {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || '',
        password: process.env.DB_PASS || '',
        database: process.env.ASTERISK_DB || 'asterisk',
        waitForConnections: true,
        connectionLimit: 5,
    });
    await ensureChatSchema(pool);
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.use('/api/extension-chat/v1', createExtensionChatRouter(pool, { uploadDir }));
    app.use((err, _req, res, _next) => {
        console.error('[chat-test] unhandled:', err);
        res.status(500).json({ success: false, error: 'Internal test error', code: 'test_error' });
    });
    app.listen(PORT, '127.0.0.1', () => {
        console.log(`chat test API on http://127.0.0.1:${PORT}`);
        console.log(`upload dir: ${uploadDir}`);
    });
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
