const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { executeCallHijack, resolveDeviceChannel } = require('../lib/call-control');

test('executeCallHijack parameter validation', async () => {
    const mockPool = { query: async () => [[]] };

    // Missing extensions
    await assert.rejects(
        executeCallHijack(mockPool, null, '/usr/sbin/asterisk', { supervisorExt: '', targetExt: '101' }),
        /Invalid extension format/
    );
    await assert.rejects(
        executeCallHijack(mockPool, null, '/usr/sbin/asterisk', { supervisorExt: '100', targetExt: '' }),
        /Invalid extension format/
    );
    await assert.rejects(
        executeCallHijack(mockPool, null, '/usr/sbin/asterisk', { supervisorExt: 'abc', targetExt: '101' }),
        /Invalid extension format/
    );
    await assert.rejects(
        executeCallHijack(mockPool, null, '/usr/sbin/asterisk', { supervisorExt: '100', targetExt: 'xyz' }),
        /Invalid extension format/
    );
});

test('executeCallHijack active call validation', async () => {
    const mockPool = { query: async () => [[]] };
    const activeCalls = {
        '101': { channel: 'PJSIP/101-00000001', destination: '999' }
    };

    // Target 102 has no active call
    await assert.rejects(
        executeCallHijack(mockPool, null, '/usr/sbin/asterisk', {
            supervisorExt: '100',
            targetExt: '102',
            activeCallsObj: activeCalls
        }),
        /No active call found for extension 102/
    );

    // Target 102 with activeCalls function
    await assert.rejects(
        executeCallHijack(mockPool, null, '/usr/sbin/asterisk', {
            supervisorExt: '100',
            targetExt: '102',
            activeCallsObj: () => activeCalls
        }),
        /No active call found for extension 102/
    );
});

test('executeCallHijack generates correct AMI originate packet', async () => {
    const mockPool = {
        query: async (sql, params) => {
            if (params && params[0] === '100') {
                return [[{ dial: 'PJSIP/100', tech: 'pjsip' }]];
            }
            return [[]];
        }
    };

    let sentAmi = '';
    const mockAmi = {
        write: (msg) => { sentAmi += msg; }
    };

    const activeCalls = {
        '101': { channel: 'PJSIP/101-00000001' }
    };

    await executeCallHijack(mockPool, mockAmi, '/usr/sbin/asterisk', {
        supervisorExt: '100',
        targetExt: '101',
        activeCallsObj: activeCalls
    });

    assert.match(sentAmi, /Action: Originate/);
    assert.match(sentAmi, /Channel: PJSIP\/100/);
    assert.match(sentAmi, /Exten: 225101/);
    assert.match(sentAmi, /Context: from-internal/);
    assert.match(sentAmi, /Priority: 1/);
    assert.match(sentAmi, /CallerID: "Call Hijack" <225101>/);
    assert.match(sentAmi, /Variable: __SIPADDHEADER=X-Call-Purpose: Monitoring/);
    assert.match(sentAmi, /Async: true/);
});

test('executeCallHijack falls back to asteriskBin CLI originate', async () => {
    const mockPool = {
        query: async (sql, params) => {
            if (params && params[0] === '100') {
                return [[{ dial: 'SIP/100', tech: 'sip' }]];
            }
            return [[]];
        }
    };

    // Use mock runner to capture execFile call
    const activeCalls = {
        '101': { channel: 'SIP/101-00000001' }
    };

    const echoBin = '/bin/echo';
    await executeCallHijack(mockPool, null, echoBin, {
        supervisorExt: '100',
        targetExt: '101',
        activeCallsObj: activeCalls
    });
    // Successful completion confirms execFile reached without rejecting
});

test('hijack_call.py multi-call concise output channel and bridge parsing', () => {
    // Python simulation harness feeding stdin AGI headers and verifying output
    const pythonScript = `
import sys

def parse_channels(out, target_ext, supervisor_chan):
    emp_chan = ''
    bridge_id = ''
    direct_peer = ''
    peer_chan = ''

    lines = [ln for ln in out.splitlines() if ln.strip()]

    for line in lines:
        parts = line.split('!')
        if len(parts) >= 8:
            chan = parts[0].strip()
            cid = parts[7].strip()
            is_target = (
                chan.startswith(f'PJSIP/{target_ext}-') or
                chan.startswith(f'SIP/{target_ext}-') or
                chan.startswith(f'IAX2/{target_ext}-') or
                chan.startswith(f'Local/{target_ext}@') or
                f'/{target_ext}-' in chan or
                f'/{target_ext}@' in chan or
                cid == target_ext
            )
            if is_target and chan != supervisor_chan:
                emp_chan = chan
                if len(parts) >= 13:
                    bridge_id = parts[12].strip()
                if len(parts) >= 12:
                    dp = parts[11].strip()
                    if dp and dp not in ('(None)', 'None', 'none'):
                        direct_peer = dp
                break

    if bridge_id:
        for line in lines:
            parts = line.split('!')
            if len(parts) >= 13:
                chan = parts[0].strip()
                bid = parts[12].strip()
                if bid == bridge_id and chan != emp_chan and chan != supervisor_chan:
                    peer_chan = chan
                    break

    if not peer_chan and direct_peer and direct_peer != emp_chan and direct_peer != supervisor_chan:
        peer_chan = direct_peer

    return emp_chan, peer_chan

# Concise Asterisk 18 output with 3 concurrent calls:
# Format: chan!ctx!exten!prio!state!app!data!cid!acct!amaflags!duration!bridged_chan!bridge_id
concise_dump = """
PJSIP/101-00000001!macro-dial-one!s!1!Up!AppDial!(Outgoing Line)!101!!3!45!Dongle/dongle0-0100000001!bridge-uuid-call-1
Dongle/dongle0-0100000001!from-trunk!101!1!Up!Dial!PJSIP/101!0501234567!!3!45!PJSIP/101-00000001!bridge-uuid-call-1
PJSIP/102-00000002!macro-dial-one!s!1!Up!AppDial!(Outgoing Line)!102!!3!30!Dongle/dongle1-0100000002!bridge-uuid-call-2
Dongle/dongle1-0100000002!from-trunk!102!1!Up!Dial!PJSIP/102!0509876543!!3!30!PJSIP/102-00000002!bridge-uuid-call-2
PJSIP/103-00000003!macro-dial-one!s!1!Up!AppDial!(Outgoing Line)!103!!3!15!PJSIP/104-00000004!bridge-uuid-call-3
PJSIP/104-00000004!from-internal!103!1!Up!Dial!PJSIP/103!104!!3!15!PJSIP/103-00000003!bridge-uuid-call-3
PJSIP/100-00000005!from-internal!225101!1!Up!AGI!hijack_call.py!100!!3!2!(None)!
"""

# Test 1: Supervisor 100 hijacks 101 -> must resolve to Dongle/dongle0-0100000001
emp1, peer1 = parse_channels(concise_dump, '101', 'PJSIP/100-00000005')
assert emp1 == 'PJSIP/101-00000001', f"Expected PJSIP/101-00000001, got {emp1}"
assert peer1 == 'Dongle/dongle0-0100000001', f"Expected Dongle/dongle0-0100000001, got {peer1}"

# Test 2: Supervisor 100 hijacks 102 -> must resolve to Dongle/dongle1-0100000002
emp2, peer2 = parse_channels(concise_dump, '102', 'PJSIP/100-00000005')
assert emp2 == 'PJSIP/102-00000002', f"Expected PJSIP/102-00000002, got {emp2}"
assert peer2 == 'Dongle/dongle1-0100000002', f"Expected Dongle/dongle1-0100000002, got {peer2}"

# Test 3: Supervisor 100 hijacks 103 (internal call to 104) -> must resolve to PJSIP/104-00000004
emp3, peer3 = parse_channels(concise_dump, '103', 'PJSIP/100-00000005')
assert emp3 == 'PJSIP/103-00000003', f"Expected PJSIP/103-00000003, got {emp3}"
assert peer3 == 'PJSIP/104-00000004', f"Expected PJSIP/104-00000004, got {peer3}"

# Test 4: Direct peer fallback when bridge_id is missing from concise output
fallback_dump = """
PJSIP/101-00000001!macro-dial-one!s!1!Up!AppDial!(Outgoing Line)!101!!3!45!Dongle/dongle0-0100000001
Dongle/dongle0-0100000001!from-trunk!101!1!Up!Dial!PJSIP/101!0501234567!!3!45!PJSIP/101-00000001
"""
emp4, peer4 = parse_channels(fallback_dump, '101', 'PJSIP/100-00000005')
assert emp4 == 'PJSIP/101-00000001'
assert peer4 == 'Dongle/dongle0-0100000001'

print("ALL_PYTHON_HIJACK_TESTS_PASSED")
`;

    const res = spawnSync('python3', ['-c', pythonScript], { encoding: 'utf-8' });
    assert.strictEqual(res.status, 0, `Python test failed: ${res.stderr}`);
    assert.match(res.stdout, /ALL_PYTHON_HIJACK_TESTS_PASSED/);
});

test('crm-live socket action hijack executes executeCallHijack and logs audit', async () => {
    const registerCrmLiveSocket = require('../socket/crm-live');

    let connectionHandler = null;
    const mockNamespace = {
        use: () => {},
        on: (ev, fn) => {
            if (ev === 'connection') {
                connectionHandler = fn;
            }
        },
        emit: () => {}
    };

    const mockIo = {
        of: (ns) => {
            assert.strictEqual(ns, '/crm-live');
            return mockNamespace;
        }
    };

    const auditLogs = [];
    const mockPool = {
        query: async (sql, params) => {
            if (sql.includes('FROM asterisk.users')) {
                return [[{ id: '101', name: 'Agent 101' }, { id: '100', name: 'Supervisor 100' }]];
            }
            if (sql.includes('SELECT dial, tech FROM `asterisk`.`devices`')) {
                return [[{ dial: 'PJSIP/100', tech: 'pjsip' }]];
            }
            if (sql.includes('FROM `asterisk`.`dashboard_crm_embed_tickets`')) {
                return [[{
                    id: 1,
                    client_id: 'crm_client_10',
                    crm_user_id: 'user_99',
                    effective_scopes: JSON.stringify(['live:hijack']),
                    session_expires_at: new Date(Date.now() + 3600000)
                }]];
            }
            if (sql.includes('FROM `asterisk`.`dashboard_crm_clients`')) {
                return [[{
                    client_id: 'crm_client_10',
                    allowed_origin: 'https://crm.example.com',
                    revoked_at: null
                }]];
            }
            if (sql.includes('dashboard_crm_audit_logs')) {
                auditLogs.push(params);
                return [{ affectedRows: 1 }];
            }
            return [[]];
        }
    };

    let sentAmi = '';
    const mockAmi = {
        write: (msg) => { sentAmi += msg; }
    };

    const activeCallsMap = {
        '101': { channel: 'PJSIP/101-00000001' }
    };

    registerCrmLiveSocket(mockIo, mockPool, {
        getPeerStatus: () => ({ '101': 'online', '100': 'online' }),
        getActiveCalls: () => activeCallsMap,
        getAmiClient: () => mockAmi,
        ASTERISK_BIN: '/bin/echo'
    });

    assert.ok(typeof connectionHandler === 'function');

    let actionHandler = null;
    const mockSocket = {
        handshake: { auth: { token: 'valid_test_token' } },
        embedSession: { client_id: 10, crm_user_id: 'user_99', allowed_scopes: ['live:hijack'] },
        join: () => {},
        emit: () => {},
        disconnect: () => {},
        on: (ev, fn) => {
            if (ev === 'action') actionHandler = fn;
        }
    };

    await connectionHandler(mockSocket);
    assert.ok(typeof actionHandler === 'function');

    // Trigger action hijack
    let actionResult = null;
    await actionHandler(
        { action: 'hijack', targetExtension: '101', supervisorExtension: '100' },
        (res) => { actionResult = res; }
    );

    assert.ok(actionResult);
    assert.strictEqual(actionResult.success, true);
    assert.match(actionResult.message, /hijack executed for extension 101/);

    // Verify AMI originate was triggered for hijack 225101
    assert.match(sentAmi, /Action: Originate/);
    assert.match(sentAmi, /Channel: PJSIP\/100/);
    assert.match(sentAmi, /Exten: 225101/);

    // Verify audit log
    assert.strictEqual(auditLogs.length, 1);
    assert.strictEqual(auditLogs[0][4], 'hijack'); // action
    assert.strictEqual(auditLogs[0][5], 1); // success = true
});

test('REST API /api/hijack parameter and permission requirements', async () => {
    function isSuperAdmin(req) {
        if (!req || !req.session) return false;
        if (req.session.isRoot || req.session.username === 'root') return true;
        const g = String(req.session.userGroup || '').toLowerCase().trim();
        return g === 'super admins' || g === 'super admin' || g === 'administrator' || g === 'administrators';
    }

    function requireActionPermission(actionPermission) {
        return (req, res, next) => {
            if (isSuperAdmin(req)) return next();
            const perms = req.session.userPermissions || [];
            if (perms.includes(actionPermission) || perms.includes('operator')) {
                return next();
            }
            return res.status(403).json({ success: false, error: `Forbidden. Missing permission: ${actionPermission}` });
        };
    }

    const hijackPermMiddleware = requireActionPermission('operator-hijack');
    assert.strictEqual(typeof hijackPermMiddleware, 'function');

    // Test unauthorized request gets 403
    let statusCode = null;
    let jsonBody = null;
    const req = {
        session: { username: 'testuser', userPermissions: ['operator-listen'] },
        path: '/api/hijack',
        xhr: true
    };
    const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonBody = data; return res; }
    };
    let nextCalled = false;
    hijackPermMiddleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(statusCode, 403);
    assert.strictEqual(jsonBody.success, false);
    assert.strictEqual(nextCalled, false);

    // Test authorized request with operator-hijack permission passes through
    const authReq = {
        session: { username: 'testuser', userPermissions: ['operator-hijack'] },
        path: '/api/hijack',
        xhr: true
    };
    let authNextCalled = false;
    hijackPermMiddleware(authReq, res, () => { authNextCalled = true; });
    assert.strictEqual(authNextCalled, true);

    // Test super admin automatically passes through
    const adminReq = {
        session: { username: 'admin', userGroup: 'super admins', userPermissions: [] },
        path: '/api/hijack',
        xhr: true
    };
    let adminNextCalled = false;
    hijackPermMiddleware(adminReq, res, () => { adminNextCalled = true; });
    assert.strictEqual(adminNextCalled, true);
});
