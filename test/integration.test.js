const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { hashSecret, timingSafeCompare, createPairingCode, verifyAndUsePairingCode, createIntegrationClient, authenticateClientToken, createEmbedTicket, consumeEmbedTicket } = require('../lib/integration-auth');
const createCrmRouter = require('../routes/crm-integration');

// Mock Database Pool for Tests
class MockPool {
    constructor() {
        this.pairingCodes = new Map();
        this.clients = new Map();
        this.tickets = new Map();
        this.auditLogs = [];
    }

    async getConnection() {
        const pool = this;
        return {
            async beginTransaction() {},
            async commit() {},
            async rollback() {},
            release() {},
            async query(sql, params = []) {
                return pool.query(sql, params);
            },
            async execute(sql, params = []) {
                return pool.query(sql, params);
            }
        };
    }

    async query(sql, params = []) {
        const sqlStr = String(sql).trim();

        if (sqlStr.includes('dashboard_crm_pairing_codes')) {
            if (sqlStr.startsWith('INSERT')) {
                const [hash, expires, createdBy] = params;
                const id = this.pairingCodes.size + 1;
                const rec = { id, code_hash: hash, expires_at: expires, used_at: null, created_by: createdBy };
                this.pairingCodes.set(hash, rec);
                return [{ insertId: id }];
            }
            if (sqlStr.startsWith('SELECT')) {
                const hash = params[0];
                const rec = this.pairingCodes.get(hash);
                return [rec ? [rec] : []];
            }
            if (sqlStr.startsWith('UPDATE')) {
                const [codeHash] = params;
                const rec = this.pairingCodes.get(codeHash);
                if (rec && !rec.used_at && new Date(rec.expires_at) > new Date()) {
                    rec.used_at = new Date();
                    return [{ affectedRows: 1 }];
                }
                return [{ affectedRows: 0 }];
            }
        }

        if (sqlStr.includes('dashboard_crm_clients')) {
            if (sqlStr.startsWith('INSERT')) {
                const [clientId, name, secretHash, origin, cc, scopesStr] = params;
                const id = this.clients.size + 1;
                const rec = { id, client_id: clientId, name, secret_hash: secretHash, allowed_origin: origin, default_country_code: cc, allowed_scopes: scopesStr, revoked_at: null };
                this.clients.set(clientId, rec);
                return [{ insertId: id }];
            }
            if (sqlStr.startsWith('SELECT')) {
                const clientId = params[0];
                const rec = this.clients.get(clientId);
                if (rec && !rec.revoked_at) {
                    return [[rec]];
                }
                return [[]];
            }
        }

        if (sqlStr.includes('dashboard_crm_embed_tickets')) {
            if (sqlStr.startsWith('INSERT')) {
                const [ticketHash, clientId, crmUserId, crmUserName, supervisorExt, effectiveScopes, expiresAt] = params;
                const id = this.tickets.size + 1;
                const rec = { id, ticket_hash: ticketHash, client_id: clientId, crm_user_id: crmUserId, crm_user_name: crmUserName, supervisor_extension: supervisorExt, effective_scopes: effectiveScopes, expires_at: expiresAt, consumed_at: null };
                this.tickets.set(ticketHash, rec);
                return [{ insertId: id }];
            }
            if (sqlStr.startsWith('SELECT')) {
                const hash = params[0];
                const rec = this.tickets.get(hash);
                if (rec) {
                    rec.allowed_origin = 'http://localhost:8000';
                }
                return [rec ? [rec] : []];
            }
            if (sqlStr.startsWith('UPDATE')) {
                const [sessionHash, sessionExpiresAt, id] = params;
                for (const rec of this.tickets.values()) {
                    if (rec.id === id && !rec.consumed_at) {
                        rec.consumed_at = new Date();
                        rec.session_token_hash = sessionHash;
                        rec.session_expires_at = sessionExpiresAt;
                        return [{ affectedRows: 1 }];
                    }
                }
                return [{ affectedRows: 0 }];
            }
        }

        if (sqlStr.includes('asteriskcdrdb.cdr')) {
            if (sqlStr.includes('COUNT(')) {
                return [[{ total: 1 }]];
            }
            if (sqlStr.includes('GROUP BY')) {
                return [[{ logical_id: '1000.1', max_date: '2026-08-12 10:00:00' }]];
            }
            return [[
                { uniqueid: '1000.1', linkedid: '1000.1', calldate: '2026-08-12 10:00:00', src: '01012345678', dst: '101', cnum: '01012345678', did: '01012345678', clid: '"Customer" <01012345678>', duration: 90, billsec: 75, disposition: 'ANSWERED', recordingfile: '2026/08/rec-1.wav' }
            ]];
        }

        if (sqlStr.includes('asterisk.users')) {
            return [[
                { id: '101', name: 'Ahmed' },
                { id: '102', name: 'Mohamed' }
            ]];
        }

        return [[]];
    }
}

test('CRM REST Router health and pairing endpoints work correctly', async () => {
    const pool = new MockPool();
    const app = express();
    app.use(express.json());
    app.use('/api/integrations/crm/v1', createCrmRouter(pool));

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/api/integrations/crm/v1`;

    try {
        // 1. Test Health (Public)
        const healthRes = await fetch(`${baseUrl}/health`);
        assert.equal(healthRes.status, 200);
        const healthData = await healthRes.json();
        assert.equal(healthData.service, 'sokrat-voip');
        assert.equal(healthData.status, 'ok');
        assert.equal(healthData.api_version, '1.0');

        // 2. Test Pairing with valid code
        const codeObj = await createPairingCode(pool, 'admin');
        const pairRes = await fetch(`${baseUrl}/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pairing_code: codeObj.rawCode,
                name: 'Laravel CRM',
                origin: 'http://localhost:8000',
                default_country_code: '20'
            })
        });

        assert.equal(pairRes.status, 200);
        const pairData = await pairRes.json();
        assert.ok(pairData.client_id);
        assert.ok(pairData.client_secret);
        assert.equal(pairData.api_version, '1.0');
        assert.equal(pairData.capabilities.call_history, true);

        // 3. Test Pairing code single-use requirement
        const pairAgain = await fetch(`${baseUrl}/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pairing_code: codeObj.rawCode,
                name: 'Laravel CRM',
                origin: 'http://localhost:8000'
            })
        });
        assert.equal(pairAgain.status, 401);

        // 4. Test Authenticated Extensions Endpoint with bearer token
        const extRes = await fetch(`${baseUrl}/extensions`, {
            headers: { 'Authorization': `Bearer ${pairData.client_secret}` }
        });
        assert.equal(extRes.status, 200);
        const extData = await extRes.json();
        assert.equal(extData.extensions.length, 2);
        assert.equal(extData.extensions[0].extension, '101');
        assert.equal(extData.extensions[0].name, 'Ahmed');
        assert.equal(extData.extensions[0].secret, undefined);

        // 5. Test Unauthenticated / Missing Bearer token
        const unauthRes = await fetch(`${baseUrl}/extensions`);
        assert.equal(unauthRes.status, 401);

        // 6. Test Customer Call History API
        const callRes = await fetch(`${baseUrl}/calls?phone=01012345678`, {
            headers: { 'Authorization': `Bearer ${pairData.client_secret}` }
        });
        assert.equal(callRes.status, 200);
        const callData = await callRes.json();
        assert.equal(callData.data.length, 1);
        assert.equal(callData.data[0].customer_number, '01012345678');
        assert.equal(callData.data[0].disposition, 'ANSWERED');
        assert.ok(callData.data[0].recording.media_id);

    } finally {
        server.close();
    }
});
