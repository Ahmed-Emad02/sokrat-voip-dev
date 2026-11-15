'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseE173VoiceWarningState } = require('../lib/dongle-health');
const { explainAtCommandOutput } = require('../lib/dongle-diagnostics');

test('E173 voice warning tracks failure after three attempts and clears on init', () => {
    const log = [
        '[2026-11-15 19:00:00] WARNING[x] at_response.c: [dongle0] E173 AT^CVOICE=0 failed after 3 attempts; voice may remain disabled',
        '[2026-11-15 19:01:00] VERBOSE[x] at_response.c: [dongle0] Dongle initialized and ready',
        '[2026-11-15 19:02:00] WARNING[x] at_response.c: [dongle1] E173 AT^CVOICE=0 failed after 3 attempts; voice may remain disabled'
    ].join('\n');
    assert.deepEqual(parseE173VoiceWarningState(log), { dongle1: { attempts: 3 } });
});

test('generic voice warning matches failures from non-E173 dongles', () => {
    const log = '[2026-11-15 19:00:00] WARNING[x] at_response.c: [dongle2] AT^CVOICE=0 failed after 3 attempts; voice may remain disabled';
    assert.deepEqual(parseE173VoiceWarningState(log), { dongle2: { attempts: 3 } });
});

test('E173 voice warning clears on a successful voice-enable log', () => {
    const log = [
        '[2026-11-15 19:00:00] WARNING[x] at_response.c: [dongle0] E173 AT^CVOICE=0 failed after 3 attempts; voice may remain disabled',
        '[2026-11-15 19:00:10] VERBOSE[x] at_response.c: [dongle0] E173 voice audio enabled'
    ].join('\n');
    assert.deepEqual(parseE173VoiceWarningState(log), {});
});

test('AT^CVOICE diagnostics distinguishes enabled and disabled voice PCM', () => {
    const enabled = explainAtCommandOutput('AT^CVOICE?', '^CVOICE: 0, 8000, 16, 20');
    assert.equal(enabled.severity, 'success');
    assert.match(enabled.badge, /Enabled/);

    const disabled = explainAtCommandOutput('AT^CVOICE?', '^CVOICE: 1, 8000, 16, 20');
    assert.equal(disabled.severity, 'warning');
    assert.match(disabled.recommendation, /AT\^CVOICE=0/);
});

test('GSM dongle view exposes CVOICE shortcuts and the retry warning', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'gsm-dongles.ejs'), 'utf8');
    assert.match(view, /executeAtDiag\('AT\^CVOICE\?'\)/);
    assert.match(view, /executeAtDiag\('AT\^CVOICE=0'\)/);
    assert.match(view, /voiceEnableWarning/);
});
