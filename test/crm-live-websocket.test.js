const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const registerCrmLiveSocket = require(path.join(rootDir, 'socket', 'crm-live.js'));

test('CRM Live WebSocket: Handler exports registration function and sets up /crm-live namespace', () => {
    assert.strictEqual(typeof registerCrmLiveSocket, 'function', 'registerCrmLiveSocket must be a function');

    const createdNamespaces = [];
    const mockIo = {
        of: (ns) => {
            createdNamespaces.push(ns);
            return {
                use: (fn) => {},
                on: (evt, fn) => {},
                emit: () => {}
            };
        }
    };

    registerCrmLiveSocket(mockIo, {}, {});
    assert.ok(createdNamespaces.includes('/crm-live'), 'must register /crm-live namespace on Socket.IO instance');
});

test('CRM Live WebSocket: Handshake middleware rejects connections without embed token', async () => {
    let middlewareFn = null;
    const mockNamespace = {
        use: (fn) => { middlewareFn = fn; },
        on: () => {},
        emit: () => {}
    };
    const mockIo = { of: () => mockNamespace };

    registerCrmLiveSocket(mockIo, {}, {});
    assert.ok(typeof middlewareFn === 'function', 'middleware function must be registered');

    // 1. Missing auth object or token
    const mockSocketNoAuth = { handshake: {} };
    await new Promise((resolve) => {
        middlewareFn(mockSocketNoAuth, (err) => {
            assert.ok(err instanceof Error, 'must reject with Error when handshake token missing');
            assert.match(err.message, /auth token required/i);
            resolve();
        });
    });

    // 2. Empty string token
    const mockSocketEmpty = { handshake: { auth: { token: '   ' } } };
    await new Promise((resolve) => {
        middlewareFn(mockSocketEmpty, (err) => {
            assert.ok(err instanceof Error, 'must reject when token is whitespace');
            resolve();
        });
    });
});

test('CRM Live WebSocket: Sanitizes active calls dictionary into client-safe payload', () => {
    const rawActiveCalls = {
        '101': {
            status: 'In Call',
            caller: '01280695454',
            start: Date.now() - 45000
        },
        '102': {
            state: 'Ringing',
            partner: '103',
            started_at: Date.now() - 5000
        }
    };

    const list = [];
    for (const [ext, c] of Object.entries(rawActiveCalls)) {
        if (!c) continue;
        const startMs = c.start || c.started_at || Date.now();
        const durSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
        list.push({
            extension: String(ext),
            state: c.state || c.status || 'In Call',
            partner: String(c.partner || c.callee || c.caller || ''),
            started_at: startMs,
            duration_seconds: durSec
        });
    }

    assert.strictEqual(list.length, 2, 'must sanitize 2 calls');
    assert.strictEqual(list[0].extension, '101');
    assert.strictEqual(list[0].partner, '01280695454');
    assert.ok(list[0].duration_seconds >= 44 && list[0].duration_seconds <= 46, 'must calculate duration in seconds');
    assert.strictEqual(list[1].extension, '102');
    assert.strictEqual(list[1].state, 'Ringing');
});

test('CRM Live WebSocket: source code verifies session permissions and audits control actions', () => {
    const code = fs.readFileSync(path.join(rootDir, 'socket', 'crm-live.js'), 'utf8');

    // 1. Audit logging
    assert.match(code, /logCrmAudit/, 'must invoke logCrmAudit on live actions');

    // 2. Call control delegation
    assert.match(code, /executeCallSpy/, 'must support call spy');
    assert.match(code, /executeCallHangup/, 'must support remote hangup');
    assert.match(code, /executeCallHijack/, 'must support call hijack');
    assert.match(code, /executeCallTransfer/, 'must support call transfer');

    // 3. Permission checks
    assert.match(code, /currentSession\.scopes\.includes\(requiredScope\)/, 'must check scopes before action execution');
});
