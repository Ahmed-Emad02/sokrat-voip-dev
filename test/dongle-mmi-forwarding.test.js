const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    parseMmiCallForwarding,
    parseMmiCallForwardingDetails,
    buildCallForwardingAtCommand,
    formatCcfcResponse
} = require('../lib/dongle-call-forwarding');

test('parseMmiCallForwarding correctly parses Registration & Activation (mode 3)', () => {
    // Unconditional (CFU - 21) national
    assert.strictEqual(
        parseMmiCallForwarding('**21*01011719380#'),
        'AT+CCFC=0,3,"01011719380",129,1'
    );

    // Unconditional (CFU - 21) international
    assert.strictEqual(
        parseMmiCallForwarding('**21*+201011719380#'),
        'AT+CCFC=0,3,"+201011719380",145,1'
    );

    // Busy (CFB - 67)
    assert.strictEqual(
        parseMmiCallForwarding('**67*01011719380#'),
        'AT+CCFC=1,3,"01011719380",129,1'
    );

    // No Reply (CFNRY - 61) standard
    assert.strictEqual(
        parseMmiCallForwarding('**61*01011719380#'),
        'AT+CCFC=2,3,"01011719380",129,1'
    );

    // No Reply (CFNRY - 61) with custom delay timer (e.g. 20s)
    assert.strictEqual(
        parseMmiCallForwarding('**61*01011719380**20#'),
        'AT+CCFC=2,3,"01011719380",129,1,,,20'
    );

    // Not Reachable / Unavailable (CFNRC - 62)
    assert.strictEqual(
        parseMmiCallForwarding('**62*01011719380#'),
        'AT+CCFC=3,3,"01011719380",129,1'
    );

    // All Conditional (004)
    assert.strictEqual(
        parseMmiCallForwarding('**004*01011719380#'),
        'AT+CCFC=5,3,"01011719380",129,1'
    );

    // All Forwarding (002)
    assert.strictEqual(
        parseMmiCallForwarding('**002*01011719380#'),
        'AT+CCFC=4,3,"01011719380",129,1'
    );
});

test('parseMmiCallForwarding correctly parses Activation with number or without number (mode 1)', () => {
    // Activation with number: *21*01011719380#
    assert.strictEqual(
        parseMmiCallForwarding('*21*01011719380#'),
        'AT+CCFC=0,1,"01011719380",129,1'
    );

    // Activation without number: *21#
    assert.strictEqual(
        parseMmiCallForwarding('*21#'),
        'AT+CCFC=0,1'
    );

    // Activation busy: *67#
    assert.strictEqual(
        parseMmiCallForwarding('*67#'),
        'AT+CCFC=1,1'
    );
});

test('parseMmiCallForwarding correctly parses Interrogation / Status Query (mode 2)', () => {
    assert.strictEqual(parseMmiCallForwarding('*#21#'), 'AT+CCFC=0,2');
    assert.strictEqual(parseMmiCallForwarding('*#67#'), 'AT+CCFC=1,2');
    assert.strictEqual(parseMmiCallForwarding('*#61#'), 'AT+CCFC=2,2');
    assert.strictEqual(parseMmiCallForwarding('*#62#'), 'AT+CCFC=3,2');
    assert.strictEqual(parseMmiCallForwarding('*#004#'), 'AT+CCFC=5,2');
    assert.strictEqual(parseMmiCallForwarding('*#002#'), 'AT+CCFC=4,2');
});

test('parseMmiCallForwarding correctly parses Erasure (mode 4) and Deactivation (mode 0)', () => {
    // Erasure: ##21#
    assert.strictEqual(parseMmiCallForwarding('##21#'), 'AT+CCFC=0,4');
    assert.strictEqual(parseMmiCallForwarding('##67#'), 'AT+CCFC=1,4');
    assert.strictEqual(parseMmiCallForwarding('##61#'), 'AT+CCFC=2,4');
    assert.strictEqual(parseMmiCallForwarding('##62#'), 'AT+CCFC=3,4');
    assert.strictEqual(parseMmiCallForwarding('##004#'), 'AT+CCFC=5,4');
    assert.strictEqual(parseMmiCallForwarding('##002#'), 'AT+CCFC=4,4');

    // Deactivation: #21#
    assert.strictEqual(parseMmiCallForwarding('#21#'), 'AT+CCFC=0,0');
    assert.strictEqual(parseMmiCallForwarding('#67#'), 'AT+CCFC=1,0');
    assert.strictEqual(parseMmiCallForwarding('#61#'), 'AT+CCFC=2,0');
    assert.strictEqual(parseMmiCallForwarding('#62#'), 'AT+CCFC=3,0');
    assert.strictEqual(parseMmiCallForwarding('#004#'), 'AT+CCFC=5,0');
});

test('parseMmiCallForwarding returns null for non-call-forwarding standard USSD codes', () => {
    assert.strictEqual(parseMmiCallForwarding('*100#'), null);
    assert.strictEqual(parseMmiCallForwarding('*888#'), null);
    assert.strictEqual(parseMmiCallForwarding('*010#'), null);
    assert.strictEqual(parseMmiCallForwarding('*150#'), null);
    assert.strictEqual(parseMmiCallForwarding('*555*1#'), null);
    assert.strictEqual(parseMmiCallForwarding('123'), null);
    assert.strictEqual(parseMmiCallForwarding(''), null);
    assert.strictEqual(parseMmiCallForwarding(null), null);
});

test('parseMmiCallForwardingDetails extracts structured metadata', () => {
    const details = parseMmiCallForwardingDetails('**61*01011719380**25#');
    assert.deepStrictEqual(details, {
        atCmd: 'AT+CCFC=2,3,"01011719380",129,1,,,25',
        reason: 2,
        serviceCode: '61',
        action: 'activate',
        mode: 3,
        number: '01011719380',
        type: 129,
        delay: 25
    });

    const queryDetails = parseMmiCallForwardingDetails('*#67#');
    assert.deepStrictEqual(queryDetails, {
        atCmd: 'AT+CCFC=1,2',
        reason: 1,
        serviceCode: '67',
        action: 'query',
        mode: 2,
        number: null
    });
});

test('buildCallForwardingAtCommand handles all scenarios and actions cleanly', () => {
    // 1. Unconditional activate
    const cfu = buildCallForwardingAtCommand({
        scenario: '21',
        action: 'activate',
        number: '01011719380'
    });
    assert.strictEqual(cfu.atCmd, 'AT+CCFC=0,3,"01011719380",129,1');
    assert.strictEqual(cfu.mmiCode, '**21*01011719380#');

    // 2. Busy activate
    const cfb = buildCallForwardingAtCommand({
        scenario: '67',
        action: 'activate',
        number: '+201011719380'
    });
    assert.strictEqual(cfb.atCmd, 'AT+CCFC=1,3,"+201011719380",145,1');
    assert.strictEqual(cfb.mmiCode, '**67*+201011719380#');

    // 3. No Reply with custom timer
    const cfnry = buildCallForwardingAtCommand({
        scenario: '61',
        action: 'activate',
        number: '01011719380',
        delay: 20
    });
    assert.strictEqual(cfnry.atCmd, 'AT+CCFC=2,3,"01011719380",129,1,,,20');
    assert.strictEqual(cfnry.mmiCode, '**61*01011719380**20#');

    // 4. Not available activate
    const cfnrc = buildCallForwardingAtCommand({
        scenario: '62',
        action: 'activate',
        number: '01011719380'
    });
    assert.strictEqual(cfnrc.atCmd, 'AT+CCFC=3,3,"01011719380",129,1');

    // 5. All conditional activate
    const allCond = buildCallForwardingAtCommand({
        scenario: '004',
        action: 'activate',
        number: '01011719380'
    });
    assert.strictEqual(allCond.atCmd, 'AT+CCFC=5,3,"01011719380",129,1');

    // 6. Query status
    const query = buildCallForwardingAtCommand({
        scenario: '21',
        action: 'query'
    });
    assert.strictEqual(query.atCmd, 'AT+CCFC=0,2');
    assert.strictEqual(query.mmiCode, '*#21#');

    // 7. Cancel / Deactivate
    const cancel = buildCallForwardingAtCommand({
        scenario: '67',
        action: 'cancel'
    });
    assert.strictEqual(cancel.atCmd, 'AT+CCFC=1,4');
    assert.strictEqual(cancel.mmiCode, '##67#');

    // 8. Missing number on activate throws clear error
    assert.throws(() => {
        buildCallForwardingAtCommand({ scenario: '21', action: 'activate' });
    }, /Forwarding destination phone number is required/);
});

test('formatCcfcResponse produces clear human-readable messages for all outcomes', () => {
    // Inactive query (Orange Egypt format)
    const orangeInactive = formatCcfcResponse('+CCFC: 0,255\nOK', '21', 'query');
    assert.strictEqual(orangeInactive, 'Call Forwarding Unconditional (CFU): INACTIVE');

    // Inactive query (Vodafone Egypt format)
    const vodafoneInactive = formatCcfcResponse('+CCFC: 0,16,"",129,,,\nOK', '67', 'query');
    assert.strictEqual(vodafoneInactive, 'Call Forwarding on Busy (CFB): INACTIVE');

    // Active query with destination
    const activeQuery = formatCcfcResponse('+CCFC: 1,1,"01011719380",129\nOK', '21', 'query');
    assert.strictEqual(activeQuery, 'Call Forwarding Unconditional (CFU): ACTIVE -> 01011719380 (Voice)');

    // Successful activation
    const actOk = formatCcfcResponse('OK', '21', 'activate', '01011719380');
    assert.strictEqual(actOk, 'Call Forwarding Unconditional (CFU) registered and activated to 01011719380 (Status: OK)');

    // Successful cancellation
    const cancelOk = formatCcfcResponse('OK', '61', 'cancel');
    assert.strictEqual(cancelOk, 'Call Forwarding on No Reply (CFNRY): Deactivated / Cancelled (Status: OK)');

    // Carrier rejection error (CME ERROR)
    const cmeErr = formatCcfcResponse('+CME ERROR: network rejected request', '21', 'activate', '01011719380');
    assert.match(cmeErr, /Carrier network rejected request/, 'Should translate network rejected request');

    // Numeric CME error 257 with unsolicited RSSI prefix
    const rssiCmeErr = formatCcfcResponse('^RSSI:11\n+CME ERROR: 257', '21', 'activate', '01011719380');
    assert.match(rssiCmeErr, /Carrier network rejected request/, 'Should strip ^RSSI and translate code 257');
    assert.equal(rssiCmeErr.includes('^RSSI'), false, 'Must not include ^RSSI in error message');

    // Raw ERROR with unsolicited RSSI prefix
    const rawErr = formatCcfcResponse('^RSSI:11\nERROR', '21', 'activate', '01011719380');
    assert.match(rawErr, /Carrier network rejected request/, 'Should strip ^RSSI and provide descriptive message for raw ERROR');
    assert.equal(rawErr.includes('^RSSI'), false, 'Must not include ^RSSI in error message');
});

test('server.js exposes dedicated POST /api/gsm-dongles/call-forwarding and enhances /ussd', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    // Check call-forwarding route exists
    assert.match(serverJs, /app\.post\('\/api\/gsm-dongles\/call-forwarding'/, 'Must define POST /api/gsm-dongles/call-forwarding');
    assert.match(serverJs, /buildCallForwardingAtCommand/, 'Route must invoke buildCallForwardingAtCommand');
    assert.match(serverJs, /formatCcfcResponse/, 'Route must format response with formatCcfcResponse');
    assert.match(serverJs, /sendAtAndWait/, 'Route must send command via sendAtAndWait');

    // Check USSD route intercepts MMI codes
    assert.match(serverJs, /parseMmiCallForwardingDetails\(code\)/, 'USSD route must check parseMmiCallForwardingDetails');
});

test('views/gsm-dongles.ejs includes Call Forwarding tab, form, card action button, and toast handlers', () => {
    const viewPath = path.join(__dirname, '../views/gsm-dongles.ejs');
    const viewContent = fs.readFileSync(viewPath, 'utf8');

    // 1. Tab switcher buttons
    assert.match(viewContent, /id="tab-btn-ussd"/, 'View must render tab-btn-ussd');
    assert.match(viewContent, /id="tab-btn-forwarding"/, 'View must render tab-btn-forwarding');
    assert.match(viewContent, /switchConsoleTab\('forwarding'\)/, 'View must invoke switchConsoleTab');

    // 2. Call Forwarding Helper Form & Controls
    assert.match(viewContent, /id="forwarding-execution-form"/, 'View must render forwarding-execution-form');
    assert.match(viewContent, /id="cf-target-dongle"/, 'View must render cf-target-dongle selector');
    assert.match(viewContent, /id="cf-scenario"/, 'View must render cf-scenario selector');
    assert.match(viewContent, /value="21"/, 'Scenario must have Unconditional (21)');
    assert.match(viewContent, /value="67"/, 'Scenario must have Busy (67)');
    assert.match(viewContent, /value="61"/, 'Scenario must have No Reply (61)');
    assert.match(viewContent, /value="62"/, 'Scenario must have Not Available (62)');
    assert.match(viewContent, /value="004"/, 'Scenario must have All Conditional (004)');
    assert.match(viewContent, /value="002"/, 'Scenario must have All Forwarding (002)');

    // 3. Action and input fields
    assert.match(viewContent, /id="cf-action"/, 'View must render cf-action selector');
    assert.match(viewContent, /value="activate"/, 'Action must have activate');
    assert.match(viewContent, /value="query"/, 'Action must have query');
    assert.match(viewContent, /value="cancel"/, 'Action must have cancel');
    assert.match(viewContent, /id="cf-number-input"/, 'View must render cf-number-input');
    assert.match(viewContent, /id="cf-delay-select"/, 'View must render cf-delay-select');
    assert.match(viewContent, /id="cf-submit-btn"/, 'View must render cf-submit-btn');

    // 4. Card View action button
    assert.match(viewContent, /data-dongle-action="call-forwarding"/, 'View must render call-forwarding button on dongle cards');
    assert.match(viewContent, /openDongleCallForwarding\(id\)/, 'Click handler must invoke openDongleCallForwarding');

    // 5. Client JavaScript functions
    assert.match(viewContent, /window\.switchConsoleTab\s*=/, 'View must define window.switchConsoleTab');
    assert.match(viewContent, /window\.openDongleCallForwarding\s*=/, 'View must define window.openDongleCallForwarding');
    assert.match(viewContent, /window\.onCfScenarioChange\s*=/, 'View must define window.onCfScenarioChange');
    assert.match(viewContent, /window\.onCfActionChange\s*=/, 'View must define window.onCfActionChange');

    // 6. Endpoint dispatch and toast alerts
    assert.match(viewContent, /fetch\('\/api\/gsm-dongles\/call-forwarding'/, 'Form submission must call /api/gsm-dongles/call-forwarding');
    assert.match(viewContent, /showToast\(toastTitle[^,]*,\s*data\.message,\s*'success'\)/, 'Success must show toast notification');
    assert.match(viewContent, /showToast\(toastTitle[^,]*,\s*errText,\s*'error'\)/, 'Failure must show error toast notification');

    // 7. Dynamic Dropdown Synchronization
    assert.match(viewContent, /document\.getElementById\('cf-target-dongle'\)/, 'View must select cf-target-dongle for dynamic refresh');
    assert.match(viewContent, /populateTargetDropdown\(cfTarget/, 'refreshDevicesList must dynamically populate cfTarget dropdown');
    assert.match(viewContent, /cfTargetEl\.addEventListener\('change'/, 'cfTarget must sync device selection on change');
});

test('all client script blocks in views/gsm-dongles.ejs parse as valid JavaScript with zero syntax errors', async () => {
    const ejs = require('ejs');
    const moment = require('moment');
    const viewPath = path.join(__dirname, '../views/gsm-dongles.ejs');
    const mockDevices = [
        {
            ID: 'dongle0',
            Number: '+201284555106',
            IMSI: '602019529273999',
            IMEI: '352375040353633',
            'Provider Name': 'Orange EG',
            Model: 'E153',
            Firmware: '11.609.16.00.272',
            Mode: '0',
            Submode: '0',
            Group: '0',
            State: 'Free',
            RSSI: '12',
            audio: '/dev/ttyUSB1',
            data: '/dev/ttyUSB2'
        }
    ];

    for (const lang of ['en', 'ar']) {
        const html = await ejs.renderFile(viewPath, {
            devices: mockDevices,
            moment,
            currentLang: lang
        });

        const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        let scriptCount = 0;
        while ((match = scriptRegex.exec(html)) !== null) {
            scriptCount++;
            const code = match[1];
            assert.doesNotThrow(
                () => new Function(code),
                `Syntax error in views/gsm-dongles.ejs [${lang}] script block #${scriptCount}`
            );
        }
        assert.ok(scriptCount > 0, `Must validate at least one script block in ${lang}`);
    }
});
