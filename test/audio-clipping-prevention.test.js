'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('installers keep recording gain neutral and preserve jitter/ringback', () => {
    for (const name of ['install.sh', 'installer-bundle/install-sokrat.sh']) {
        const text = fs.readFileSync(path.join(root, name), 'utf8');
        assert.equal(text.includes('v(3)V(-1)'), false, `${name} must not apply 3x recording gain`);
        assert.match(text, /MIXMON_OPTS=.*v\(1\)V\(1\)/, `${name} must default to neutral recording gain`);
        assert.match(text, /^same => n,Set\(JITTERBUFFER\(adaptive\)=default\)$/m, `${name} must enable adaptive jitter buffer`);
        assert.match(text, /Set\(DIAL_TRUNK_OPTIONS=\$\{DIAL_TRUNK_OPTIONS\}r\)/, `${name} must enable local ringback`);
        assert.match(text, /CALLER_DENOISE=off/, `${name} must default RNNoise off`);
        assert.match(text, /CALLER_AGC=off/, `${name} must default AGC off`);
        assert.match(text, /database put AMPUSER \{ext\}\/ai_denoise off/, `${name} must default new extensions to RNNoise off`);
        assert.match(text, /database put AMPUSER \{ext\}\/vad_gate 0/, `${name} must default new extensions to VAD gate off`);
    }
});

test('safe upgrade restores adaptive jitter buffer instead of disabling it', () => {
    const text = fs.readFileSync(path.join(root, 'scripts/safe-upgrade.sh'), 'utf8');
    assert.equal(text.includes('v(3)V(-1)'), false, 'safe-upgrade must not apply 3x recording gain');
    assert.match(text, /MIXMON_OPTS=.*v\(1\)V\(1\)/, 'safe-upgrade must use neutral recording gain');
    assert.ok(!/JITTERBUFFER\(adaptive\)=default\/g' \/etc/.test(text), 'safe-upgrade must not comment out adaptive jitter buffer');
});

test('server and UI use safe audio defaults for new extensions', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(server, /denoiseVal = 'off'/, 'server extension setup must default RNNoise off');
    assert.match(server, /vadGateVal = '0'/, 'server extension setup must default VAD gate off');
    assert.match(server, /agcVal = 'off'/, 'server extension setup must default AGC off');
    assert.match(server, /agc: agcMap\[ext\.extension\] \|\| 'off'/, 'GET extensions must report AGC default off');

    const page = fs.readFileSync(path.join(root, 'views/config.ejs'), 'utf8');
    assert.match(page, /id="extDenoise"[\s\S]{0,500}<option value="off" selected>/, 'extension modal must default RNNoise off');
    assert.match(page, /id="extVadGate"[\s\S]{0,300}<option value="0" selected>/, 'extension modal must default VAD gate off');
    assert.match(page, /id="extAgc"[\s\S]{0,1000}<option value="off" selected>/, 'extension modal must default AGC off');
});
