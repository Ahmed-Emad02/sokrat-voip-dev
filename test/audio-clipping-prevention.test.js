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
        assert.equal(text.includes('same => n,Set(JITTERBUFFER(adaptive)=default)'), false, `${name} must not hardcode a global JITTERBUFFER line`);
        assert.match(text, /\[sokrat-jb\]/, `${name} must install the per-extension resolver`);
        assert.match(text, /Gosub\(sokrat-jb,s,1\(\$\{REALCALLERIDNUM\}/, `${name} must call the resolver on the outbound caller leg`);
        assert.match(text, /BEGIN SOKRAT PER-EXTENSION JITTER BUFFER CALLEE HOOK/, `${name} must install the callee PJSIP hook`);
        assert.match(text, /Set\(DIAL_TRUNK_OPTIONS=\$\{STRREPLACE\(DIAL_TRUNK_OPTIONS,r\)\}R\)/, `${name} must allow carrier early media`);
        assert.doesNotMatch(text, /^same => n,Set\(DIAL_TRUNK_OPTIONS=\$\{DIAL_TRUNK_OPTIONS\}r\)$/m, `${name} must not force ringback with lower-case r`);
        assert.match(text, /CALLER_DENOISE=off/, `${name} must default RNNoise off`);
        assert.match(text, /CALLER_AGC=off/, `${name} must default AGC off`);
        assert.match(text, /database put AMPUSER \{ext\}\/ai_denoise off/, `${name} must default new extensions to RNNoise off`);
        assert.match(text, /database put AMPUSER \{ext\}\/vad_gate 0/, `${name} must default new extensions to VAD gate off`);
    }
    const safeUpgrade = fs.readFileSync(path.join(root, 'scripts/safe-upgrade.sh'), 'utf8');
    assert.match(safeUpgrade, /Set\(DIAL_TRUNK_OPTIONS=\$\{STRREPLACE\(DIAL_TRUNK_OPTIONS,r\)\}R\)/, 'safe-upgrade must allow carrier early media');
    assert.doesNotMatch(safeUpgrade, /^same => n,Set\(DIAL_TRUNK_OPTIONS=\$\{DIAL_TRUNK_OPTIONS\}r\)$/m, 'safe-upgrade must not force ringback with lower-case r');
});

test('safe upgrade installs the per-extension jitter resolver', () => {
    const text = fs.readFileSync(path.join(root, 'scripts/safe-upgrade.sh'), 'utf8');
    assert.equal(text.includes('v(3)V(-1)'), false, 'safe-upgrade must not apply 3x recording gain');
    assert.match(text, /MIXMON_OPTS=.*v\(1\)V\(1\)/, 'safe-upgrade must use neutral recording gain');
    assert.ok(!/JITTERBUFFER\(adaptive\)=default\/g' \/etc/.test(text), 'safe-upgrade must not restore a global raw line');
    assert.match(text, /\[sokrat-jb\]/, 'safe-upgrade must install the resolver');
    assert.match(text, /dialplan_jitterbuffer_enabled/, 'safe-upgrade must preserve/initialize the global marker');
});

test('server and UI use safe audio defaults for new extensions', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(server, /denoiseVal = 'off'/, 'server extension setup must default RNNoise off');
    assert.match(server, /vadGateVal = '0'/, 'server extension setup must default VAD gate off');
    assert.match(server, /agcVal = 'off'/, 'server extension setup must default AGC off');
    assert.match(server, /agc: agcMap\[ext\.extension\] \|\| 'off'/, 'GET extensions must report AGC default off');
    assert.match(server, /effectiveJitterBufferFields\(getJitterBufferFromAstdbMap/, 'GET extensions must report jitter-buffer fields');

    const page = fs.readFileSync(path.join(root, 'views/config.ejs'), 'utf8');
    assert.match(page, /id="extDenoise"[\s\S]{0,500}<option value="off" selected>/, 'extension modal must default RNNoise off');
    assert.match(page, /id="extVadGate"[\s\S]{0,300}<option value="0" selected>/, 'extension modal must default VAD gate off');
    assert.match(page, /id="extAgc"[\s\S]{0,1000}<option value="off" selected>/, 'extension modal must default AGC off');
    assert.match(page, /id="extJbMode"/, 'extension modal must render the jitter-buffer mode');
    assert.match(page, /id="extJbMax"/, 'extension modal must render the max-size input');
    assert.match(page, /id="extJbResync"/, 'extension modal must render the resync input');
    assert.match(page, /id="extJbTarget"/, 'extension modal must render the target-extra input');
});
