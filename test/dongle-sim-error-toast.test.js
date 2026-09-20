const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Dongle SIM IMSI Error Toast Notification', () => {
    const imsiErrorPattern = /\[([^\]]+)\]\s+ERROR\[\d+\](?:\s*:\s*)?\s+at_response\.c(?::\d+)?(?::|\s+)?(?:\s*log_cmd_response_error:\s*)?\s*\[([^\]]+)\]\s+Getting IMSI number failed/i;

    test('matches exact user warning log format', () => {
        const logLine = '[2026-09-20 10:58:16] ERROR[3676199]: at_response.c:296 log_cmd_response_error: [dongle0] Getting IMSI number failed';
        const match = imsiErrorPattern.exec(logLine);
        assert.ok(match, 'Log line must match imsiErrorPattern');
        assert.strictEqual(match[1].trim(), '2026-09-20 10:58:16');
        assert.strictEqual(match[2].trim(), 'dongle0');
    });

    test('matches log format without log_cmd_response_error prefix', () => {
        const logLine = '[2026-09-16 16:45:03] ERROR[113289] at_response.c: [dongle1] Getting IMSI number failed';
        const match = imsiErrorPattern.exec(logLine);
        assert.ok(match, 'Log line without log_cmd_response_error must match');
        assert.strictEqual(match[1].trim(), '2026-09-16 16:45:03');
        assert.strictEqual(match[2].trim(), 'dongle1');
    });

    test('ignores unrelated chan_dongle logs', () => {
        const okLog = '[2026-09-20 10:58:16] VERBOSE[3676199] at_response.c: [dongle0] Got AT response: OK';
        assert.strictEqual(imsiErrorPattern.exec(okLog), null);

        const otherError = '[2026-09-20 10:58:16] ERROR[3676199] at_response.c: [dongle0] Opening port failed';
        assert.strictEqual(imsiErrorPattern.exec(otherError), null);
    });

    test('debounce mechanism suppresses duplicate alerts within 30 seconds', () => {
        const latestImsiFailAlerts = {};
        const debounceWindow = 30000;
        let emittedCount = 0;

        function handleLog(statement, fakeNow) {
            const match = imsiErrorPattern.exec(statement);
            if (match) {
                const dongleId = match[2].trim();
                const lastAlert = latestImsiFailAlerts[dongleId];
                if (!lastAlert || (fakeNow - lastAlert > debounceWindow)) {
                    latestImsiFailAlerts[dongleId] = fakeNow;
                    emittedCount++;
                }
            }
        }

        const log1 = '[2026-09-20 10:58:16] ERROR[3676199]: at_response.c:296 log_cmd_response_error: [dongle0] Getting IMSI number failed';
        const log2 = '[2026-09-20 10:58:31] ERROR[3676532]: at_response.c:296 log_cmd_response_error: [dongle0] Getting IMSI number failed';
        const log3 = '[2026-09-20 10:59:00] ERROR[3677204]: at_response.c:296 log_cmd_response_error: [dongle0] Getting IMSI number failed';

        handleLog(log1, 1000);
        assert.strictEqual(emittedCount, 1, 'First alert should emit');

        // 15 seconds later (within 30s window) -> suppressed
        handleLog(log2, 16000);
        assert.strictEqual(emittedCount, 1, 'Duplicate within 30s should be debounced');

        // 44 seconds after first alert (> 30s window) -> emits
        handleLog(log3, 45000);
        assert.strictEqual(emittedCount, 2, 'Alert after 30s window should emit');
    });

    test('verifies server.js and views/gsm-dongles.ejs contain dongleSimError handlers', () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
        assert.ok(serverCode.includes('dongleSimError'), 'server.js must emit dongleSimError');
        assert.ok(serverCode.includes('imsi_failed'), 'server.js must specify error: imsi_failed');

        const donglesCode = fs.readFileSync(path.join(__dirname, '../views/gsm-dongles.ejs'), 'utf8');
        assert.ok(donglesCode.includes('dongleSimError'), 'views/gsm-dongles.ejs must listen to dongleSimError');
        assert.ok(donglesCode.includes('top-alert-container'), 'views/gsm-dongles.ejs must have top center alert container');
        assert.ok(donglesCode.includes('بطاقة SIM غير متصلة بشكل صحيح'), 'views/gsm-dongles.ejs must have Arabic translation');
        assert.ok(donglesCode.includes('SIM card is not connected properly'), 'views/gsm-dongles.ejs must have English translation');
    });
});
