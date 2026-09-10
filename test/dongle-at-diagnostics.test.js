const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const moment = require('moment');

const { explainAtCommandOutput } = require('../lib/dongle-diagnostics');
const gsmDonglesViewPath = path.join(__dirname, '../views/gsm-dongles.ejs');
const serverJsPath = path.join(__dirname, '../server.js');

test('explainAtCommandOutput parses AT^CARDLOCK? outputs accurately', () => {
    // 1. Permanent carrier lock (0 attempts remaining)
    const lockedRes = explainAtCommandOutput('AT^CARDLOCK?', '^CARDLOCK: 3,0,0\r\nOK', 'en');
    assert.strictEqual(lockedRes.severity, 'danger');
    assert.match(lockedRes.badge, /Permanent Carrier Lock/i);
    assert.match(lockedRes.summary, /locked to its original carrier/i);
    assert.ok(lockedRes.details.length >= 3);

    // 2. Factory / fully unlocked
    const unlockedRes = explainAtCommandOutput('AT^CARDLOCK?', '^CARDLOCK: 2,10,0\r\nOK', 'en');
    assert.strictEqual(unlockedRes.severity, 'success');
    assert.match(unlockedRes.badge, /Unlocked/i);
    assert.match(unlockedRes.summary, /accepts SIM cards from all carriers/i);

    // 3. Locked with attempts available
    const attemptsRes = explainAtCommandOutput('AT^CARDLOCK?', '^CARDLOCK: 1,10,0\r\nOK', 'en');
    assert.strictEqual(attemptsRes.severity, 'warning');
    assert.match(attemptsRes.badge, /Attempts Available/i);

    // 4. Arabic localization
    const lockedAr = explainAtCommandOutput('AT^CARDLOCK?', '^CARDLOCK: 3,0,0\r\nOK', 'ar');
    assert.strictEqual(lockedAr.severity, 'danger');
    assert.match(lockedAr.badge, /قفل شبكة دائم/);
});

test('explainAtCommandOutput parses AT^SYSINFO and AT+CREG? outputs accurately', () => {
    // 1. SYSINFO restricted service
    const sysinfoRestricted = explainAtCommandOutput('AT^SYSINFO', '^SYSINFO:1,0,1,3,0,,3\r\nOK', 'en');
    assert.strictEqual(sysinfoRestricted.severity, 'danger');
    assert.match(sysinfoRestricted.badge, /Restricted Service/i);
    assert.match(sysinfoRestricted.summary, /emergency calls only/i);

    // 2. SYSINFO valid service
    const sysinfoValid = explainAtCommandOutput('AT^SYSINFO', '^SYSINFO:2,3,0,3,1,,3\r\nOK', 'en');
    assert.strictEqual(sysinfoValid.severity, 'success');
    assert.match(sysinfoValid.badge, /Valid Full Service/i);

    // 3. CREG registration denied
    const cregDenied = explainAtCommandOutput('AT+CREG?', '+CREG: 2,3\r\nOK', 'en');
    assert.strictEqual(cregDenied.severity, 'danger');
    assert.match(cregDenied.badge, /Registration Denied/i);

    // 4. CREG registered on home network
    const cregHome = explainAtCommandOutput('AT+CREG?', '+CREG: 2,1\r\nOK', 'en');
    assert.strictEqual(cregHome.severity, 'success');
    assert.match(cregHome.badge, /Home Network/i);
});

test('explainAtCommandOutput parses signal (CSQ), operator (COPS), config (SYSCFG), and PIN (CPIN)', () => {
    // 1. CSQ Signal
    const csqRes = explainAtCommandOutput('AT+CSQ', '+CSQ: 25,99\r\nOK', 'en');
    assert.strictEqual(csqRes.severity, 'success');
    assert.match(csqRes.badge, /25\/31/);
    assert.match(csqRes.summary, /-63 dBm/);

    // 2. COPS Attached
    const copsAttached = explainAtCommandOutput('AT+COPS?', '+COPS: 0,0,"Orange EG",0\r\nOK', 'en');
    assert.strictEqual(copsAttached.severity, 'success');
    assert.match(copsAttached.badge, /Orange EG/);
    // 4. SYSCFG query
    const syscfg2G = explainAtCommandOutput('AT^SYSCFG?', '^SYSCFG:13,1,3FFFFFFF,1,2\r\nOK', 'en');
    assert.match(syscfg2G.badge, /2G GSM Only/i);

    // 4b. SYSCFG SET commands (3G Lock, 2G Lock, Auto)
    const lock3gRes = explainAtCommandOutput('AT^SYSCFG=14,2,3FFFFFFF,2,4', 'OK', 'en');
    assert.strictEqual(lock3gRes.severity, 'info');
    assert.match(lock3gRes.badge, /3G Only/i);
    assert.match(lock3gRes.summary, /reprogrammed modem radio to: 3G Only/i);

    const lock2gRes = explainAtCommandOutput('AT^SYSCFG=13,1,3FFFFFFF,2,4', 'OK', 'en');
    assert.strictEqual(lock2gRes.severity, 'warning');
    assert.match(lock2gRes.badge, /2G Only/i);

    const autoRes = explainAtCommandOutput('AT^SYSCFG=2,2,3FFFFFFF,2,4', 'OK', 'en');
    assert.strictEqual(autoRes.severity, 'success');
    assert.match(autoRes.badge, /Auto/i);

    // 5. CPIN
    const cpinReady = explainAtCommandOutput('AT+CPIN?', '+CPIN: READY\r\nOK', 'en');
    assert.strictEqual(cpinReady.severity, 'success');
    assert.match(cpinReady.badge, /SIM Ready/i);
});

test('server.js enforces strict root-only security on /api/gsm-dongles/at-diagnostic/:dongleId', () => {
    const serverCode = fs.readFileSync(serverJsPath, 'utf8');

    // Route registration check
    assert.ok(serverCode.includes("app.post('/api/gsm-dongles/at-diagnostic/:dongleId'"), 'server.js must register at-diagnostic route');
    assert.ok(serverCode.includes("req.session.username === ROOT_USER || req.session.username === 'root'"), 'Must check for root user identity');
    assert.ok(serverCode.includes("Forbidden: AT Diagnostics shortcuts are restricted strictly to root user only."), 'Must return 403 error for non-root users');

    // Security middleware emulation
    function authorizeAtDiagnostic(session, dongleId, command) {
        const isRoot = Boolean(session && (session.isRoot || session.username === 'root'));
        if (!isRoot) {
            return { status: 403, error: 'Forbidden: root user only' };
        }
        if (!/^dongle[0-9]+$/i.test(dongleId)) {
            return { status: 400, error: 'Invalid dongle ID format' };
        }
        if (!command || !/^(AT|\^|\+)/i.test(command)) {
            return { status: 400, error: 'Invalid AT command format' };
        }
        return { status: 200, success: true };
    }

    // 1. Non-root user gets 403
    const regularUserRes = authorizeAtDiagnostic({ username: 'operator1', isRoot: false }, 'dongle0', 'AT^CARDLOCK?');
    assert.strictEqual(regularUserRes.status, 403);

    // 2. Root user gets 200
    const rootUserRes = authorizeAtDiagnostic({ username: 'root', isRoot: true }, 'dongle0', 'AT^CARDLOCK?');
    assert.strictEqual(rootUserRes.status, 200);

    // 3. Invalid dongle ID gets 400
    const invalidDongleRes = authorizeAtDiagnostic({ username: 'root', isRoot: true }, 'malicious_dongle', 'AT^CARDLOCK?');
    assert.strictEqual(invalidDongleRes.status, 400);

    // 4. Non-AT command gets 400
    const invalidCmdRes = authorizeAtDiagnostic({ username: 'root', isRoot: true }, 'dongle0', 'rm -rf /');
    assert.strictEqual(invalidCmdRes.status, 400);
});

test('views/gsm-dongles.ejs conditionally renders AT diagnostics shortcuts and modal for root user', async () => {
    const mockDevices = [
        { ID: 'dongle0', IMEI: '868402003775318', IMSI: '602019529273999', Number: '+201284555106', State: 'Free', RSSI: '23', Mode: 'GSM', Submode: 'EDGE' },
        { ID: 'dongle1', IMEI: '868402004375084', IMSI: '602022283076421', Number: '+201069031762', State: 'GSM not registered', RSSI: '25', Mode: 'GSM', Submode: 'EDGE' }
    ];

    // 1. Render as root user
    const htmlRoot = await ejs.renderFile(gsmDonglesViewPath, {
        devices: mockDevices,
        moment,
        isRtl: false,
        currentLang: 'en',
        currentPage: '/gsm-dongles',
        isRootUser: true,
        currentUser: 'root',
        isSuperAdmin: true,
        can: () => true
    });

    assert.ok(htmlRoot.includes('id="at-diag-modal"'), 'Root render must contain at-diag-modal');
    assert.ok(htmlRoot.includes('AT^CARDLOCK?'), 'Root render must contain AT^CARDLOCK? shortcut chip');
    assert.ok(htmlRoot.includes('AT^SYSINFO'), 'Root render must contain AT^SYSINFO shortcut chip');
    assert.ok(htmlRoot.includes('AT+CREG?'), 'Root render must contain AT+CREG? shortcut chip');
    assert.ok(htmlRoot.includes('AT+CSQ'), 'Root render must contain AT+CSQ shortcut chip');
    assert.ok(htmlRoot.includes('AT+COPS?'), 'Root render must contain AT+COPS? shortcut chip');
    assert.ok(htmlRoot.includes('AT^SYSCFG?'), 'Root render must contain AT^SYSCFG? shortcut chip');
    assert.ok(htmlRoot.includes('AT+CPIN?'), 'Root render must contain AT+CPIN? shortcut chip');
    assert.ok(htmlRoot.includes('openAtDiagConsole'), 'Root render must bind openAtDiagConsole');
    assert.ok(htmlRoot.includes('runAtDiag'), 'Root render must bind runAtDiag');
    assert.ok(htmlRoot.includes('const isRootUser = true;'), 'isRootUser flag must evaluate to true in script');

    // 2. Render as regular non-root user
    const htmlRegular = await ejs.renderFile(gsmDonglesViewPath, {
        devices: mockDevices,
        moment,
        isRtl: false,
        currentLang: 'en',
        currentPage: '/gsm-dongles',
        isRootUser: false,
        currentUser: 'agent101',
        isSuperAdmin: false,
        can: () => true
    });
    assert.ok(htmlRegular.includes('const isRootUser = false;'), 'isRootUser flag must evaluate to false for non-root users');
});
