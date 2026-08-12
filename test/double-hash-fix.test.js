const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyEmbedSession, hashSecret } = require('../lib/integration-auth');

test('verifyEmbedSession succeeds for raw token and returns null for pre-hashed token', async () => {
    const rawToken = 'ses_raw_token_xyz_123456789';
    const sessionHash = hashSecret(rawToken);

    const mockPool = {
        async query(sql, params) {
            const sqlStr = String(sql).trim();
            if (sqlStr.includes('dashboard_crm_embed_tickets')) {
                const tokenHash = params[0];
                if (tokenHash === sessionHash) {
                    return [[{
                        id: 1,
                        client_id: 'crm_123',
                        crm_user_id: '42',
                        crm_user_name: 'John',
                        supervisor_extension: '101',
                        effective_scopes: '["live:read", "live:listen"]',
                        session_token_hash: sessionHash,
                        session_expires_at: new Date(Date.now() + 60000)
                    }]];
                }
                return [[]];
            }
            if (sqlStr.includes('dashboard_crm_clients')) {
                return [[{ client_id: 'crm_123', allowed_origin: 'http://localhost:8000', revoked_at: null }]];
            }
            return [[]];
        }
    };

    // 1. Verify with raw token -> returns session
    const validSession = await verifyEmbedSession(mockPool, rawToken);
    assert.notEqual(validSession, null);
    assert.equal(validSession.crm_user_id, '42');

    // 2. Verify with already-hashed value (session.session_token_hash) -> returns null
    const hashedValue = validSession.session_token_hash;
    const doubleHashResult = await verifyEmbedSession(mockPool, hashedValue);
    assert.equal(doubleHashResult, null);
});
