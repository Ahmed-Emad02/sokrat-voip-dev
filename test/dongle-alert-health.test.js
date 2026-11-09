'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
    isDongleUnavailable,
    isUsableImsi,
    findDongle,
    evaluateRestartHealth,
    buildImsiFailureEvent,
    buildDongleRecoveredEvent,
    updateImsiFailureStreak,
    buildImsiEscalationEvent,
    buildRestartFailedEvent,
    formatRestartAuditEntry
} = require('../lib/dongle-health');

describe('dongle health state classification', () => {
    test('treats disconnected and uninitialized states as unavailable', () => {
        for (const state of ['Not Connected', 'not connec', 'Disconnected', 'offline', 'Not Initialized', 'Not Responding']) {
            assert.equal(isDongleUnavailable(state), true, state);
        }
    });

    test('keeps connected modem states usable', () => {
        for (const state of ['Free', 'Dialing', 'Active', 'Ringing', 'GSM Not Registered']) {
            assert.equal(isDongleUnavailable(state), false, state);
        }
    });

    test('validates IMSI values', () => {
        assert.equal(isUsableImsi('602030850196542'), true);
        assert.equal(isUsableImsi(''), false);
        assert.equal(isUsableImsi('-'), false);
        assert.equal(isUsableImsi('Unknown'), false);
        assert.equal(isUsableImsi('N/A'), false);
        assert.equal(isUsableImsi('not-a-number'), false);
    });

    test('finds a dongle case-insensitively', () => {
        const devices = [{ ID: 'dongle8', State: 'Free' }, { ID: 'dongle9', State: 'Not Connected' }];
        assert.equal(findDongle(devices, 'DONGLE8').ID, 'dongle8');
        assert.equal(findDongle(devices, 'dongle9').State, 'Not Connected');
        assert.equal(findDongle(devices, 'dongle10'), null);
    });
});

describe('restart health evaluation', () => {
    test('healthy only when initialized and IMSI is readable', () => {
        assert.deepEqual(
            evaluateRestartHealth({ ID: 'dongle8', State: 'Free', IMSI: '602030850196542' }),
            { healthy: true, reason: 'ready', state: 'Free' }
        );
        assert.equal(evaluateRestartHealth({ ID: 'dongle8', State: 'Not Connected', IMSI: '602030850196542' }).healthy, false);
        assert.equal(evaluateRestartHealth({ ID: 'dongle8', State: 'Free', IMSI: '' }).reason, 'imsi_unreadable');
        assert.equal(evaluateRestartHealth(null).reason, 'not_found');
    });
});

describe('IMSI alert gating', () => {
    test('switches to dongleOffline when the dongle is disconnected', () => {
        const result = buildImsiFailureEvent({
            dongleId: 'dongle8',
            logTime: '2026-11-09 13:58:56',
            device: { ID: 'dongle8', State: 'Not Connected', IMSI: '602030850196542' }
        });
        assert.equal(result.event, 'dongleOffline');
        assert.equal(result.payload.error, 'dongle_offline');
        assert.match(result.payload.messageEn, /offline/i);
        assert.doesNotMatch(result.payload.messageEn, /properly inserted|make sure/i);
    });

    test('emits a connected IMSI failure without asserting SIM removal', () => {
        const result = buildImsiFailureEvent({
            dongleId: 'dongle8',
            logTime: '2026-11-09 13:58:56',
            device: { ID: 'dongle8', State: 'Free', IMSI: '602030850196542' }
        });
        assert.equal(result.event, 'dongleSimError');
        assert.equal(result.payload.error, 'imsi_failed');
        assert.match(result.payload.messageEn, /IMSI read failed/i);
        assert.doesNotMatch(result.payload.messageEn, /properly inserted|make sure/i);
        assert.match(result.payload.messageAr, /IMSI/);
    });

    test('builds a recovery event for clearing alerts', () => {
        assert.deepEqual(buildDongleRecoveredEvent('DONGLE8', ' 2026-11-09 14:01:41 '), {
            dongleId: 'dongle8',
            state: 'initialized',
            logTime: '2026-11-09 14:01:41'
        });
    });
});

describe('IMSI escalation streak', () => {
    test('escalates once after the threshold and remains escalated', () => {
        let streak = null;
        let escalations = 0;
        for (let i = 0; i < 6; i++) {
            const result = updateImsiFailureStreak(streak, 1000 + i * 15000, { threshold: 5, windowMs: 300000 });
            streak = result.streak;
            if (result.shouldEscalate) escalations++;
        }
        assert.equal(escalations, 1);
        assert.equal(streak.count, 6);
        assert.ok(streak.escalatedAt);
    });

    test('resets the streak after the window expires', () => {
        let result = updateImsiFailureStreak(null, 1000, { threshold: 5, windowMs: 60000 });
        result = updateImsiFailureStreak(result.streak, 20000, { threshold: 5, windowMs: 60000 });
        assert.equal(result.streak.count, 2);
        result = updateImsiFailureStreak(result.streak, 90000, { threshold: 5, windowMs: 60000 });
        assert.equal(result.streak.count, 1);
        assert.equal(result.streak.escalatedAt, null);
    });

    test('escalation and restart-failure payloads carry actionable text', () => {
        const escalation = buildImsiEscalationEvent({ dongleId: 'dongle8', count: 5, state: 'Not Connected', windowMs: 300000 });
        assert.equal(escalation.dongleId, 'dongle8');
        assert.match(escalation.messageEn, /failed IMSI initialization 5 times/i);
        assert.match(escalation.messageEn, /USB replug/i);

        const failed = buildRestartFailedEvent({ dongleId: 'dongle8', state: 'Not Connected', reason: 'dongle_unavailable', retryAfterSec: 300 });
        assert.match(failed.messageEn, /did not recover/i);
        assert.match(failed.messageEn, /paused for 5 minutes/i);
        assert.match(failed.messageAr, /USB/);
    });
});

describe('restart audit entries', () => {
    test('serializes timestamped JSON lines', () => {
        const line = formatRestartAuditEntry(
            { type: 'restart', phase: 'requested', dongleId: 'dongle8', source: 'api' },
            new Date('2026-11-09T12:00:00.000Z')
        );
        const parsed = JSON.parse(line);
        assert.equal(parsed.ts, '2026-11-09T12:00:00.000Z');
        assert.equal(parsed.type, 'restart');
        assert.equal(parsed.dongleId, 'dongle8');
        assert.equal(parsed.source, 'api');
    });
});
