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

    test('verifies server.js gates SIM alerts on live dongle state and emits recovery', () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
        assert.ok(serverCode.includes('getDevicesOutputCached'), 'server.js must load live dongle state before alerting');
        assert.ok(serverCode.includes('buildImsiFailureEvent'), 'server.js must use the shared IMSI classification');
        assert.ok(serverCode.includes("io.emit(failure.event"), 'server.js must emit the classified event');
        const healthCode = fs.readFileSync(path.join(__dirname, '../lib/dongle-health.js'), 'utf8');
        assert.ok(healthCode.includes("event: 'dongleOffline'"), 'the classifier must distinguish offline dongles');
        assert.ok(serverCode.includes("io.emit('dongleRecovered'"), 'server.js must clear alerts on initialization');
        assert.ok(serverCode.includes('DONGLE_IMSI_ESCALATION_THRESHOLD'), 'server.js must escalate repeated IMSI failures');
        assert.ok(serverCode.includes('DONGLE_RESTART_AUDIT_FILE'), 'server.js must audit restart attempts');
        assert.ok(serverCode.includes('scheduleDongleHealthCheck'), 'server.js must verify health after restart');
        assert.ok(serverCode.includes('restart_cooldown'), 'server.js must pause restarts after a failed health check');
        assert.ok(!serverCode.includes('SIM card is not connected properly on'), 'server.js must not assert SIM removal from an IMSI log line');
    });

    test('verifies views/gsm-dongles.ejs replaces and clears alerts by dongle', () => {
        const donglesCode = fs.readFileSync(path.join(__dirname, '../views/gsm-dongles.ejs'), 'utf8');
        assert.ok(donglesCode.includes('dongleSimError'), 'views/gsm-dongles.ejs must listen to dongleSimError');
        assert.ok(donglesCode.includes('dongleOffline'), 'views/gsm-dongles.ejs must listen to dongleOffline');
        assert.ok(donglesCode.includes('dongleRecovered'), 'views/gsm-dongles.ejs must listen to dongleRecovered');
        assert.ok(donglesCode.includes('dongleEscalated'), 'views/gsm-dongles.ejs must listen to dongleEscalated');
        assert.ok(donglesCode.includes('removeDongleAlerts'), 'views/gsm-dongles.ejs must remove stale alerts by dongle');
        assert.ok(donglesCode.includes('data.messageEn'), 'views/gsm-dongles.ejs must use the server-provided message');
        assert.ok(donglesCode.includes('IMSI Read Alert'), 'views/gsm-dongles.ejs must label the alert as an IMSI read issue');
        assert.ok(donglesCode.includes('فشلت قراءة IMSI'), 'views/gsm-dongles.ejs must have the corrected Arabic message');
        assert.ok(!donglesCode.includes('SIM card is not connected properly'), 'views/gsm-dongles.ejs must not claim the SIM is unplugged');
    });

    test('verifies disconnected SIM/DID/IMSI render as an em dash', () => {
        const donglesCode = fs.readFileSync(path.join(__dirname, '../views/gsm-dongles.ejs'), 'utf8');
        assert.ok(donglesCode.includes('deviceSimLabel'), 'server-rendered options must use the SIM label helper');
        assert.ok(donglesCode.includes('displayDongleNumber'), 'client render must use the SIM number helper');
        assert.ok(donglesCode.includes('displayDongleImsi'), 'client render must use the IMSI helper');
        assert.ok(donglesCode.includes("return '—'"), 'disconnected values must render as an em dash');
        assert.ok(!donglesCode.includes("'No SIM'"), 'disconnected dongles must not be labeled No SIM');
        assert.ok(!donglesCode.includes("'Unknown SIM'"), 'disconnected dongles must not be labeled Unknown SIM');
    });
});
