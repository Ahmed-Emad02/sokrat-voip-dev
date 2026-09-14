const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('Sokrat MOTD Script', async (t) => {
    const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-motd-test-'));
    
    // Create a helper to write mock commands
    const writeMock = (cmd, script) => {
        const filePath = path.join(mockBinDir, cmd);
        fs.writeFileSync(filePath, `#!/bin/bash\n${script}\n`);
        fs.chmodSync(filePath, '755');
    };

    t.after(() => {
        fs.rmSync(mockBinDir, { recursive: true, force: true });
    });

    await t.test('Normal execution with all services active and dongles', async () => {
        writeMock('systemctl', `
            if [ "$1" = "is-active" ] && [ "$2" = "sokrat-voip" ]; then
                echo "active"
                exit 0
            fi
            exit 1
        `);

        writeMock('asterisk', `
            if [ "$2" = "core show version" ]; then
                echo "Asterisk 18.19.0 built by root on x86_64"
                exit 0
            elif [ "$2" = "core show channels" ]; then
                echo "2 active calls"
                exit 0
            elif [ "$2" = "dongle show devices" ]; then
                echo "ID           Group State      RSSI Mode Submode Provider Name  Model      Firmware          IMEI             IMSI             Number        "
                echo "dongle0      0     Free       18   0    0       Vodafone       E173       11.126.15.00.00   86...            ...              Unknown       "
                echo "dongle1      0     Free       23   0    0       Orange EG      E173       21.157.71.00.272  868...           ...              Unknown       "
                echo "dongle2      0     Not connec 0    0    0       NONE                                                                          Unknown       "
                exit 0
            fi
            exit 1
        `);

        const { stdout, stderr } = await execFileAsync('bash', ['scripts/sokrat-motd.sh'], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` }
        });

        assert.ok(stdout.includes('SOKRAT VOIP Enterprise PBX Dashboard'), 'Missing logo text');
        assert.ok(stdout.includes('Dashboard Access:'), 'Missing URL section');
        assert.ok(stdout.includes('\x1b[1;37mSokrat Service: \x1b[1;32m● ACTIVE'), 'Missing active service status with white label');
        assert.ok(stdout.includes('\x1b[1;37mAsterisk:       \x1b[1;32m● Asterisk 18.19.0'), 'Missing asterisk active status with white label');
        assert.ok(stdout.includes('Active Calls: \x1b[1;31m2'), 'Missing asterisk calls in red');
        assert.ok(stdout.includes('\x1b[1;37mSystem load:'), 'Missing system load label in white');
        assert.ok(stdout.includes('\x1b[1;37mMemory:         \x1b[1;37m[\x1b[1;31m'), 'Memory gauge brackets should be white and bar red');
        assert.ok(stdout.includes('\x1b[1;37mUsage on /:     \x1b[1;37m[\x1b[1;31m'), 'Usage on / gauge brackets should be white and bar red');
        assert.ok(stdout.includes('\x1b[1;37mSwap usage:     \x1b[1;31m'), 'Swap usage stat value should be red');
        assert.ok(stdout.includes('GSM Dongles'), 'Missing dongles section');
        assert.ok(stdout.includes('DEVICE     STATE          RSSI       PROVIDER          PHONE NUMBER'), 'Missing aligned table header');
        assert.ok(stdout.includes('dongle0'), 'Missing dongle0');
        assert.ok(stdout.includes('Vodafone'), 'Missing provider name');
        assert.ok(stdout.includes('dongle2'), 'Missing dongle2');
        assert.ok(stdout.includes('Not connec'), 'Missing Not connected state');
        assert.equal(stderr, '', 'Should not have any stderr output');
    });

    await t.test('Offline Asterisk and inactive systemctl', async () => {
        writeMock('systemctl', `
            if [ "$1" = "is-active" ] && [ "$2" = "sokrat-voip" ]; then
                echo "inactive"
                exit 0
            fi
            exit 1
        `);

        writeMock('asterisk', `
            if [ "$2" = "core show version" ]; then
                echo "Unable to connect to remote asterisk (does /var/run/asterisk/asterisk.ctl exist?)"
                exit 1
            fi
            exit 1
        `);

        const { stdout, stderr } = await execFileAsync('bash', ['scripts/sokrat-motd.sh'], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` }
        });

        assert.ok(stdout.includes('Sokrat Service: \x1b[1;31m○ INACTIVE'), 'Missing inactive service status');
        assert.ok(stdout.includes('Asterisk:       \x1b[1;31m○ OFFLINE'), 'Missing asterisk offline status');
        assert.ok(stdout.includes('No GSM dongles detected / Asterisk offline'), 'Missing offline dongles message');
        assert.equal(stderr, '', 'Should not have any stderr output');
    });

    await t.test('Asterisk active but no chan_dongle loaded', async () => {
        writeMock('systemctl', `echo "active"`);
        writeMock('asterisk', `
            if [ "$2" = "core show version" ]; then
                echo "Asterisk 18.19.0"
                exit 0
            elif [ "$2" = "core show channels" ]; then
                echo "0 active calls"
                exit 0
            elif [ "$2" = "dongle show devices" ]; then
                echo "No such command 'dongle show devices' (type 'core show help dongle show' for other possible commands)"
                exit 1
            fi
            exit 1
        `);

        const { stdout, stderr } = await execFileAsync('bash', ['scripts/sokrat-motd.sh'], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` }
        });

        assert.ok(stdout.includes('No GSM dongles detected / Asterisk offline'), 'Missing offline/missing dongles message');
        assert.ok(!stdout.includes('DEVICE    STATE'), 'Table should not be printed');
    });

    await t.test('chan_dongle loaded but no dongles plugged in', async () => {
        writeMock('systemctl', `echo "active"`);
        writeMock('asterisk', `
            if [ "$2" = "core show version" ]; then
                echo "Asterisk 18.19.0"
                exit 0
            elif [ "$2" = "core show channels" ]; then
                echo "0 active calls"
                exit 0
            elif [ "$2" = "dongle show devices" ]; then
                echo "ID           Group State      RSSI Mode Submode Provider Name  Model      Firmware          IMEI             IMSI             Number        "
                exit 0
            fi
            exit 1
        `);

        const { stdout, stderr } = await execFileAsync('bash', ['scripts/sokrat-motd.sh'], {
            env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` }
        });

        assert.ok(stdout.includes('No GSM dongles connected'), 'Missing no dongles message');
    });
});
