const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..');

test('Inbound Call Ring Detection: chan_dongle patch resets AT+CRC=0 and recognizes +CRING: as RES_RING', () => {
    const patchPath = path.join(rootDir, 'asterisk', 'chan_dongle.patch');
    assert.ok(fs.existsSync(patchPath), 'chan_dongle.patch must exist');
    const patch = fs.readFileSync(patchPath, 'utf8');

    // 1. AT+CRC=0 reset in modem initialization sequence
    assert.match(patch, /AT\+CRC=0/, 'chan_dongle initialization must execute AT+CRC=0 to disable Cellular Result Codes');
    assert.match(patch, /CMD_AT_CRC/, 'chan_dongle must define and handle CMD_AT_CRC');
    assert.match(patch, /AT_CRC/, 'chan_dongle AT_COMMANDS_TABLE must include AT_CRC');

    // 2. Parser recognition: map +CRING: directly to RES_RING
    assert.match(patch, /\{ RES_RING, "RING", DEF_STR\("\+CRING:"\) \}/, 'at_responses_list must map +CRING: to RES_RING');

    // 3. Precompiled binary sync
    const binPath = path.join(rootDir, 'installer-bundle', 'binaries', 'chan_dongle.so');
    assert.ok(fs.existsSync(binPath), 'installer-bundle/binaries/chan_dongle.so must exist');
    const binStat = fs.statSync(binPath);
    assert.ok(binStat.size > 200000 && binStat.size < 400000, `chan_dongle.so must be stripped and sane size (current: ${binStat.size} bytes)`);

    // Verify strings in binary
    const binBuf = fs.readFileSync(binPath);
    assert.ok(binBuf.includes(Buffer.from('AT+CRC=0\r')), 'chan_dongle.so binary must contain AT+CRC=0 command string');
    assert.ok(binBuf.includes(Buffer.from('+CRING:')), 'chan_dongle.so binary must contain +CRING: response string');
});

test('Live Hardware Verification: Connected modems have AT+CRC=0 enforced and ready for incoming RING', { timeout: 15000 }, (t) => {
    let asteriskRunning = false;
    try {
        const ping = execSync('asterisk -rx "core show version"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        if (ping.includes('Asterisk')) {
            asteriskRunning = true;
        }
    } catch {
        asteriskRunning = false;
    }

    if (!asteriskRunning) {
        t.skip('Asterisk is not running; skipping live hardware check.');
        return;
    }

    const devOut = execSync('asterisk -rx "dongle show devices"', { encoding: 'utf8' });
    const hasDongle0 = devOut.includes('dongle0') && !devOut.includes('dongle0      0     Not connec');
    const hasDongle1 = devOut.includes('dongle1') && !devOut.includes('dongle1      0     Not connec');

    if (!hasDongle0 && !hasDongle1) {
        t.skip('No active cellular dongles detected; skipping live hardware check.');
        return;
    }

    // Verify dongle0 CRC setting if online
    if (hasDongle0) {
        execSync('asterisk -rx "dongle cmd dongle0 AT+CRC?"', { stdio: ['pipe', 'pipe', 'ignore'] });
        // Give modem 1 second to respond to AT query
        execSync('sleep 1');
        const logTail = execSync('tail -n 35 /var/log/asterisk/full', { encoding: 'utf8' });
        assert.ok(logTail.includes('+CRC: 0'), 'dongle0 must report +CRC: 0 (Cellular Result Codes disabled, standard RING enabled)');
    }

    // Verify dongle1 CRC setting if online
    if (hasDongle1) {
        execSync('asterisk -rx "dongle cmd dongle1 AT+CRC?"', { stdio: ['pipe', 'pipe', 'ignore'] });
        execSync('sleep 1');
        const logTail = execSync('tail -n 35 /var/log/asterisk/full', { encoding: 'utf8' });
        assert.ok(logTail.includes('+CRC: 0'), 'dongle1 must report +CRC: 0 (Cellular Result Codes disabled, standard RING enabled)');
    }
});
