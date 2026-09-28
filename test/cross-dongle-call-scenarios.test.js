const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync, exec } = require('child_process');

function execAsterisk(cmd) {
    try {
        return execSync(`/usr/sbin/asterisk -rx ${JSON.stringify(cmd)}`, { encoding: 'utf8', timeout: 20000 });
    } catch (err) {
        return err.stdout ? err.stdout.toString() : '';
    }
}

function getDongleDevices() {
    const output = execAsterisk('dongle show devices');
    const lines = output.trim().split('\n').slice(1);
    const devices = {};
    for (const line of lines) {
        const tokens = line.trim().split(/\s+/);
        if (tokens[0] && tokens[0].startsWith('dongle')) {
            devices[tokens[0]] = {
                id: tokens[0],
                state: tokens[2],
                number: tokens[tokens.length - 1]
            };
        }
    }
    return devices;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFree(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const devices = getDongleDevices();
        if (devices.dongle0 && devices.dongle1) {
            if (devices.dongle0.state === 'Free' && devices.dongle1.state === 'Free') {
                return true;
            }
        }
        await sleep(1000);
    }
    return false;
}

test('Cross-Dongle Test Suite: Prerequisites & Device Detection', async (t) => {
    const devices = getDongleDevices();
    assert.ok(devices.dongle0, 'dongle0 must be configured');
    assert.ok(devices.dongle1, 'dongle1 must be configured');

    const isFree = await waitForFree(15000);
    assert.ok(isFree, `Both dongle0 (${devices.dongle0?.state}) and dongle1 (${devices.dongle1?.state}) must be in Free state`);
});

test('Scenario 1: Full Inbound Voice Call (dongle0 -> dongle1)', async (t) => {
    const devices = getDongleDevices();
    const targetNum = devices.dongle1.number.replace(/^\+2/, '').replace(/^\+/, '');

    // Ensure verbose is enabled for logging
    execAsterisk('core set verbose 3');

    // Originate call asynchronously from dongle0 to dongle1
    exec(`/usr/sbin/asterisk -rx "channel originate Dongle/dongle0/${targetNum} application Wait 6"`);

    // Poll for dongle1 entering Ring or Incoming state
    let ringDetected = false;
    for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const curr = getDongleDevices();
        if (curr.dongle1 && (curr.dongle1.state === 'Ring' || curr.dongle1.state === 'Incoming')) {
            ringDetected = true;
            break;
        }
    }
    assert.ok(ringDetected, 'dongle1 must receive incoming call and transition to Ring/Incoming state');

    // Wait for call to complete and verify modems recover
    const recovered = await waitForFree(35000);
    assert.ok(recovered, 'Both modems must cleanly return to Free state after call completion');

    // Settling time for cellular carrier radio bearer
    await sleep(5000);
});

test('Scenario 2: Reverse Inbound Voice Call (dongle1 -> dongle0)', async (t) => {
    const devices = getDongleDevices();
    const targetNum = devices.dongle0.number.replace(/^\+2/, '').replace(/^\+/, '');

    exec(`/usr/sbin/asterisk -rx "channel originate Dongle/dongle1/${targetNum} application Wait 6"`);

    let ringDetected = false;
    for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const curr = getDongleDevices();
        if (curr.dongle0 && (curr.dongle0.state === 'Ring' || curr.dongle0.state === 'Incoming')) {
            ringDetected = true;
            break;
        }
    }
    assert.ok(ringDetected, 'dongle0 must receive incoming call and transition to Ring/Incoming state');

    const recovered = await waitForFree(35000);
    assert.ok(recovered, 'Both modems must cleanly return to Free state after call completion');

    await sleep(5000);
});

test('Scenario 3: Early Cancel before Answer (dongle0 -> dongle1)', async (t) => {
    const devices = getDongleDevices();
    const targetNum = devices.dongle1.number.replace(/^\+2/, '').replace(/^\+/, '');

    exec(`/usr/sbin/asterisk -rx "channel originate Dongle/dongle0/${targetNum} application Wait 30"`);

    let aborted = false;
    for (let i = 0; i < 12; i++) {
        await sleep(1000);
        const curr = getDongleDevices();
        if (curr.dongle1 && (curr.dongle1.state === 'Ring' || curr.dongle1.state === 'Incoming')) {
            const channelsOutput = execAsterisk('core show channels concise');
            const lines = channelsOutput.split('\n');
            const outLine = lines.find(l => l.startsWith('Dongle/dongle0'));
            if (outLine) {
                const chan = outLine.split('!')[0];
                execAsterisk(`channel request hangup ${chan}`);
                aborted = true;
                break;
            }
        }
    }
    assert.ok(aborted, 'Early hangup request must be issued while callee is ringing');

    const recovered = await waitForFree(15000);
    assert.ok(recovered, 'Both modems must immediately return to Free state without freezing');

    await sleep(5000);
});

test('Scenario 4: SMS Transmission & Carrier Delivery', async (t) => {
    const devices = getDongleDevices();
    const targetNum = devices.dongle1.number.replace(/^\+2/, '').replace(/^\+/, '');
    const marker = `node-test-${Date.now()}`;

    const sendRes = execAsterisk(`dongle sms dongle0 ${targetNum} "${marker}"`);
    assert.match(sendRes, /queued for send/i, 'SMS must be queued for send');

    // Poll full log for reception on dongle1
    let received = false;
    for (let i = 0; i < 20; i++) {
        await sleep(1000);
        try {
            const logTail = execSync(`grep -E "SMS-RECEIVE.*dongle1.*${marker}" /var/log/asterisk/full 2>/dev/null`, { encoding: 'utf8' });
            if (logTail.includes(marker)) {
                received = true;
                break;
            }
        } catch {
            // grep non-zero exit when not found yet
        }
    }
    assert.ok(received, 'dongle1 must receive and parse the SMS over the cellular network');
    await waitForFree(10000);
});

test('Scenario 5: USSD Query Execution & Response Capture', async (t) => {
    execAsterisk('core set verbose 3');

    const ussdRes = execAsterisk('dongle ussd dongle0 *100#');
    assert.match(ussdRes, /queued for send/i, 'USSD command must be queued');

    let captured = false;
    for (let i = 0; i < 15; i++) {
        await sleep(1000);
        try {
            const logTail = execSync(`grep -i "Got USSD type" /var/log/asterisk/full 2>/dev/null | tail -n 1`, { encoding: 'utf8' });
            if (logTail.includes('Got USSD type')) {
                captured = true;
                break;
            }
        } catch {
            // grep non-zero exit when not found
        }
    }
    assert.ok(captured, 'Asterisk must receive and log the USSD response from the carrier');

    const recovered = await waitForFree(15000);
    assert.ok(recovered, 'dongle0 must return to Free state after USSD query');
});
