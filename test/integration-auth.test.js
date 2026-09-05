const test = require('node:test');
const assert = require('node:assert/strict');
const {
    hashSecret,
    timingSafeCompare,
    calculateEffectiveScopes,
    validateOriginUrl,
    SUPPORTED_SCOPES
} = require('../lib/integration-auth');

test('hashSecret computes consistent SHA-256 hex strings', () => {
    const h1 = hashSecret('my-secret-key');
    const h2 = hashSecret('my-secret-key');
    assert.equal(h1, h2);
    assert.equal(typeof h1, 'string');
    assert.equal(h1.length, 64);
});

test('timingSafeCompare correctly validates matching hashes and rejects non-matching', () => {
    const h1 = hashSecret('secret-123');
    const h2 = hashSecret('secret-123');
    const h3 = hashSecret('secret-456');

    assert.equal(timingSafeCompare(h1, h2), true);
    assert.equal(timingSafeCompare(h1, h3), false);
    assert.equal(timingSafeCompare(h1, 'invalid'), false);
});

test('calculateEffectiveScopes produces strict intersection of allowed, requested and supported scopes', () => {
    const clientScopes = ['extensions:read', 'calls:read', 'live:read', 'live:listen'];
    const requestedScopes = ['calls:read', 'live:listen', 'live:whisper', 'invalid:scope'];

    const effective = calculateEffectiveScopes(clientScopes, requestedScopes);
    
    assert.deepEqual(effective.sort(), ['calls:read', 'live:listen'].sort());
});

test('validateOriginUrl strictly enforces http/https origins without path, query or wildcards', () => {
    assert.equal(validateOriginUrl('http://192.168.100.216'), 'http://192.168.100.216');
    assert.equal(validateOriginUrl('https://crm.example.com:8443'), 'https://crm.example.com:8443');
    assert.equal(validateOriginUrl('http://crm.example.com/path'), null);
    assert.equal(validateOriginUrl('*'), null);
    assert.equal(validateOriginUrl('null'), null);
    assert.equal(validateOriginUrl('javascript:alert(1)'), null);
});

class TicketDb {
    constructor(record) {
        this.record = record;
        this.updateCount = 0;
    }

    async query(sql, params = []) {
        if (String(sql).trim().startsWith('SELECT')) {
            await new Promise(resolve => setImmediate(resolve));
            return [[this.record]];
        }
        if (String(sql).trim().startsWith('UPDATE')) {
            if (this.record.consumed_at || new Date(this.record.expires_at).getTime() <= Date.now()) {
                return [{ affectedRows: 0 }];
            }
            this.record.consumed_at = new Date();
            this.record.session_token_hash = params[0];
            this.record.session_expires_at = params[1];
            this.updateCount += 1;
            return [{ affectedRows: 1 }];
        }
        throw new Error('Unexpected SQL in TicketDb');
    }
}

function ticketRecord(scopes = ['softphone:use'], overrides = {}) {
    return {
        id: 7,
        client_id: 'crm_test',
        allowed_origin: 'http://crm.test:8080',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
        effective_scopes: JSON.stringify(scopes),
        ...overrides
    };
}

test('consumeEmbedTicket atomically creates one session and rejects replay', async () => {
    const { consumeEmbedTicket } = require('../lib/integration-auth');
    const db = new TicketDb(ticketRecord());

    const [first, second] = await Promise.all([
        consumeEmbedTicket(db, 'tkt_single_use', 'softphone:use'),
        consumeEmbedTicket(db, 'tkt_single_use', 'softphone:use')
    ]);
    const successful = [first, second].filter(Boolean);

    assert.equal(successful.length, 1);
    assert.equal(db.updateCount, 1);
    assert.match(successful[0].sessionToken, /^ses_/);
    assert.equal(db.record.session_token_hash, hashSecret(successful[0].sessionToken));
});

test('consumeEmbedTicket rejects expired, consumed, malformed-scope, and wrong-scope tickets without mutation', async t => {
    const { consumeEmbedTicket } = require('../lib/integration-auth');
    const cases = [
        ['expired', ticketRecord(['softphone:use'], { expires_at: new Date(Date.now() - 1_000) }), 'softphone:use'],
        ['consumed', ticketRecord(['softphone:use'], { consumed_at: new Date() }), 'softphone:use'],
        ['malformed scopes', ticketRecord([], { effective_scopes: '{bad-json' }), 'softphone:use'],
        ['wrong scope', ticketRecord(['live:read']), 'softphone:use']
    ];

    for (const [name, record, requiredScope] of cases) {
        await t.test(name, async () => {
            const db = new TicketDb(record);
            assert.equal(await consumeEmbedTicket(db, `tkt_${name}`, requiredScope), null);
            assert.equal(db.updateCount, 0);
        });
    }
});
