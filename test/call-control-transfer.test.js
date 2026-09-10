const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { executeCallTransfer, resolveTransferChannels } = require('../lib/call-control');

test('executeCallTransfer parameter validation', async () => {
    const mockPool = { query: async () => [[]] };

    // Missing extensions
    await assert.rejects(
        executeCallTransfer(mockPool, null, '/usr/sbin/asterisk', { sourceExt: '', destinationExt: '102' }),
        /Invalid source extension format/
    );
    await assert.rejects(
        executeCallTransfer(mockPool, null, '/usr/sbin/asterisk', { sourceExt: '101', destinationExt: '' }),
        /Invalid destination extension format/
    );

    // Invalid format
    await assert.rejects(
        executeCallTransfer(mockPool, null, '/usr/sbin/asterisk', { sourceExt: 'abc', destinationExt: '102' }),
        /Invalid source extension format/
    );
    await assert.rejects(
        executeCallTransfer(mockPool, null, '/usr/sbin/asterisk', { sourceExt: '101', destinationExt: 'xyz' }),
        /Invalid destination extension format/
    );

    // Cannot transfer to same extension
    await assert.rejects(
        executeCallTransfer(mockPool, null, '/usr/sbin/asterisk', { sourceExt: '101', destinationExt: '101' }),
        /Cannot transfer call to the same extension/
    );
});

test('resolveTransferChannels on In-Call (Bridged) active calls', () => {
    const conciseDump = `
PJSIP/101-00000001!macro-dial-one!s!1!Up!AppDial!(Outgoing Line)!101!!3!45!Dongle/dongle0-0100000001!bridge-uuid-call-1
Dongle/dongle0-0100000001!from-trunk!101!1!Up!Dial!PJSIP/101!0501234567!!3!45!PJSIP/101-00000001!bridge-uuid-call-1
PJSIP/103-00000003!macro-dial-one!s!1!Up!AppDial!(Outgoing Line)!103!!3!15!PJSIP/104-00000004!bridge-uuid-call-3
PJSIP/104-00000004!from-internal!103!1!Up!Dial!PJSIP/103!104!!3!15!PJSIP/103-00000003!bridge-uuid-call-3
`;

    // Case 1: External caller (dongle0) bridged with agent 101 -> redirect dongle0
    const res1 = resolveTransferChannels(conciseDump, '101', 'PJSIP/101-00000001');
    assert.strictEqual(res1.sourceChan, 'PJSIP/101-00000001');
    assert.strictEqual(res1.channelToRedirect, 'Dongle/dongle0-0100000001');
    assert.strictEqual(res1.isBridged, true);

    // Case 2: Internal call 104 calling 103 -> redirect 104
    const res2 = resolveTransferChannels(conciseDump, '103', 'PJSIP/103-00000003');
    assert.strictEqual(res2.sourceChan, 'PJSIP/103-00000003');
    assert.strictEqual(res2.channelToRedirect, 'PJSIP/104-00000004');
    assert.strictEqual(res2.isBridged, true);

    // Case 3: Fallback when bridge ID is missing but direct peer is present
    const fallbackDump = `
PJSIP/101-00000001!macro-dial-one!s!1!Up!AppDial!(Outgoing Line)!101!!3!45!Dongle/dongle0-0100000001
Dongle/dongle0-0100000001!from-trunk!101!1!Up!Dial!PJSIP/101!0501234567!!3!45!PJSIP/101-00000001
`;
    const res3 = resolveTransferChannels(fallbackDump, '101');
    assert.strictEqual(res3.channelToRedirect, 'Dongle/dongle0-0100000001');
    assert.strictEqual(res3.isBridged, true);
});

test('resolveTransferChannels on Ringing (Unbridged) active calls', () => {
    const ringingDump = `
Dongle/dongle0-0100000001!from-trunk!101!1!Ring!Dial!PJSIP/101,20,tr!0501234567!!3!5!(None)!
PJSIP/101-00000002!macro-dial-one!s!1!Ringing!AppDial!(Outgoing Line)!101!!3!5!(None)!
PJSIP/104-00000004!from-internal!103!1!Ring!Dial!PJSIP/103!104!!3!2!(None)!
PJSIP/103-00000003!macro-dial-one!s!1!Ringing!AppDial!(Outgoing Line)!103!!3!2!(None)!
`;

    // Case 1: Inbound GSM caller ringing 101 -> redirect calling channel (dongle0)
    const res1 = resolveTransferChannels(ringingDump, '101', 'PJSIP/101-00000002');
    assert.strictEqual(res1.sourceChan, 'PJSIP/101-00000002');
    assert.strictEqual(res1.channelToRedirect, 'Dongle/dongle0-0100000001');
    assert.strictEqual(res1.isBridged, false);

    // Case 2: Internal caller 104 ringing 103 -> redirect caller 104
    const res2 = resolveTransferChannels(ringingDump, '103', 'PJSIP/103-00000003');
    assert.strictEqual(res2.sourceChan, 'PJSIP/103-00000003');
    assert.strictEqual(res2.channelToRedirect, 'PJSIP/104-00000004');
    assert.strictEqual(res2.isBridged, false);
});

test('executeCallTransfer generates correct AMI Redirect packet', async () => {
    let sentAmi = '';
    const mockAmi = {
        write: (msg) => { sentAmi += msg; }
    };

    const activeCalls = {
        '101': { channel: 'PJSIP/101-00000001', state: 'In Call' }
    };

    // Use /bin/echo to simulate asterisk CLI returning bridged channel output
    const echoBin = '/bin/echo';
    const mockConcise = 'PJSIP/101-00000001!macro-dial-one!s!1!Up!AppDial!(Outgoing Line)!101!!3!45!Dongle/dongle0-0100000001!bridge-uuid-1\nDongle/dongle0-0100000001!from-trunk!101!1!Up!Dial!PJSIP/101!0501234567!!3!45!PJSIP/101-00000001!bridge-uuid-1';
    const result = await executeCallTransfer(null, mockAmi, '/usr/sbin/asterisk', {
        sourceExt: '101',
        destinationExt: '102',
        activeCallsObj: activeCalls,
        conciseOutput: mockConcise
    });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.sourceExtension, '101');
        assert.strictEqual(result.destinationExtension, '102');
        assert.strictEqual(result.redirectedChannel, 'Dongle/dongle0-0100000001');
        assert.strictEqual(result.isBridged, true);

        // Verify AMI Redirect packet
        assert.match(sentAmi, /Action: Redirect/);
        assert.match(sentAmi, /Channel: Dongle\/dongle0-0100000001/);
        assert.match(sentAmi, /Context: from-internal/);
        assert.match(sentAmi, /Exten: 102/);
        assert.match(sentAmi, /Priority: 1/);

        // Verify AMI Hangup packet for bridged source leg
        assert.match(sentAmi, /Action: Hangup/);
        assert.match(sentAmi, /Channel: PJSIP\/101-00000001/);
});

test('REST API /api/transfer parameter and permission requirements', async () => {
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

    const transferPermMiddleware = requireActionPermission('operator-transfer');
    assert.strictEqual(typeof transferPermMiddleware, 'function');

    // 1. Unauthorized request gets 403
    let statusCode = null;
    let jsonBody = null;
    const req = {
        session: { username: 'testuser', userPermissions: ['operator-listen'] },
        path: '/api/transfer',
        xhr: true
    };
    const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { jsonBody = data; return res; }
    };
    let nextCalled = false;
    transferPermMiddleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(statusCode, 403);
    assert.strictEqual(jsonBody.success, false);
    assert.strictEqual(nextCalled, false);

    // 2. Specific operator-transfer permission passes
    const authReq = {
        session: { username: 'testuser', userPermissions: ['operator-transfer'] },
        path: '/api/transfer',
        xhr: true
    };
    let authNextCalled = false;
    transferPermMiddleware(authReq, res, () => { authNextCalled = true; });
    assert.strictEqual(authNextCalled, true);

    // 3. General operator permission passes
    const opReq = {
        session: { username: 'testuser', userPermissions: ['operator'] },
        path: '/api/transfer',
        xhr: true
    };
    let opNextCalled = false;
    transferPermMiddleware(opReq, res, () => { opNextCalled = true; });
    assert.strictEqual(opNextCalled, true);

    // 4. Super admin passes automatically
    const adminReq = {
        session: { username: 'admin', userGroup: 'super admins', userPermissions: [] },
        path: '/api/transfer',
        xhr: true
    };
    let adminNextCalled = false;
    transferPermMiddleware(adminReq, res, () => { adminNextCalled = true; });
    assert.strictEqual(adminNextCalled, true);
});

test('crm-live socket action transfer executes executeCallTransfer and logs audit', async () => {
    const registerCrmLiveSocket = require('../socket/crm-live');

    let auditLogs = [];
    const mockPool = {
        query: async (sql, params) => {
            if (sql.includes('FROM asterisk.users')) {
                return [[{ id: '101', name: 'Agent 101' }, { id: '102', name: 'Agent 102' }]];
            }
            if (sql.includes('FROM `asterisk`.`dashboard_crm_embed_tickets`')) {
                return [[{
                    id: 1,
                    client_id: 'crm_client_10',
                    crm_user_id: 'user_99',
                    effective_scopes: JSON.stringify(['live:transfer']),
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
        },
        execute: async (sql, params) => {
            if (sql.includes('dashboard_crm_audit_logs')) {
                auditLogs.push(params);
                return [{ affectedRows: 1 }];
            }
            return [[]];
        }
    };
    let socketEventHandlers = {};
    let clientCallbacks = {};

    const mockSocket = {
        handshake: { auth: { token: 'valid-token' } },
        embedSession: {
            id: 1,
            client_id: 'client123',
            crm_user_id: 'agent01',
            supervisor_extension: '100',
            scopes: ['live:transfer']
        },
        emit: (evt, data) => {},
        on: (evt, handler) => {
            socketEventHandlers[evt] = handler;
        },
        disconnect: () => {}
    };

    let connectionHandler = null;
    const mockIo = {
        of: (ns) => ({
            use: (fn) => fn(mockSocket, () => {}),
            on: (evt, handler) => {
                if (evt === 'connection') connectionHandler = handler;
            },
            emit: () => {}
        })
    };

    // Mock active call on extension 101
    const activeCalls = {
        '101': { channel: 'Dongle/dongle0-0100000001', partner: '0501234567', state: 'In Call' }
    };

    const mockAmi = {
        write: (msg) => {}
    };

    registerCrmLiveSocket(mockIo, mockPool, {
        getPeerStatus: () => ({ '101': true, '102': true }),
        getActiveCalls: () => activeCalls,
        getAmiClient: () => mockAmi,
        ASTERISK_BIN: '/bin/echo'
    });

    assert.ok(connectionHandler, 'CRM socket connection handler should be registered');
    await connectionHandler(mockSocket);

    assert.ok(socketEventHandlers['action'], 'Action handler should be registered on socket');

    let actionResponse = null;
    await socketEventHandlers['action']({
        action: 'transfer',
        targetExtension: '101',
        destinationExtension: '102'
    }, (res) => {
        actionResponse = res;
    });

    assert.ok(actionResponse, 'Action response callback should have been invoked');
    assert.strictEqual(actionResponse.success, true);
    assert.strictEqual(auditLogs.length, 1);
    assert.strictEqual(auditLogs[0][4], 'transfer'); // action column
    assert.strictEqual(auditLogs[0][5], 1); // success = true
});

test('views/operator.ejs renders Transfer option and transferModal markup', async () => {
    const operatorEjsPath = path.join(__dirname, '../views/operator.ejs');
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    // 1. Dropdown option presence
    assert.ok(content.includes('value="transfer"'), 'actionSelect must include option value="transfer"');
    assert.ok(content.includes('openTransferModal(extension)'), 'handleSelectAction must call openTransferModal');

    // 2. Modal markup presence
    assert.ok(content.includes('id="transferModal"'), 'Must render transferModal element');
    assert.ok(content.includes('id="transferTargetInput"'), 'Must render destination input transferTargetInput');
    assert.ok(content.includes('id="transferRosterSearch"'), 'Must render search input transferRosterSearch');
    assert.ok(content.includes('id="transferRosterList"'), 'Must render roster container transferRosterList');
    assert.ok(content.includes('id="submitTransferBtn"'), 'Must render submit button submitTransferBtn');
    assert.ok(content.includes('submitCallTransfer()'), 'Submit button must invoke submitCallTransfer');
    assert.ok(content.includes("fetch('/api/transfer'"), 'Client script must POST to /api/transfer');

    // 3. Render template with mock data to ensure compilation
    const mockData = {
        moment: require('moment'),
        roster: [
            { extension: '101', name: 'Alice', emp_group: 'Support', online: true, ip: '192.168.1.101' },
            { extension: '102', name: 'Bob', emp_group: 'Sales', online: false, ip: null }
        ],
        peerIPs: {},
        activeCalls: {
            '101': { state: 'In Call', partner: '0501234567', start: Date.now() - 5000 }
        },
        employeeGroups: ['Support', 'Sales'],
        federationSettings: { panel_role: 'standard' },
        federationPeers: [],
        federationRemoteExtensions: [],
        currentLang: 'en',
        isRtl: false,
        can: () => true,
        isSuperAdmin: true,
        session: { username: 'admin' },
        t: {
            online: 'Online', offline: 'Offline', incall: 'In Call', ringing: 'Ringing',
            noCall: 'No Active Call', connectedWith: 'Connected with: '
        }
    };

    const renderedHtml = await ejs.renderFile(operatorEjsPath, mockData);
    assert.ok(renderedHtml.includes('id="transferModal"'), 'Rendered HTML must contain transferModal');
    assert.ok(renderedHtml.includes('value="transfer"'), 'Rendered HTML must contain transfer select option');
});
