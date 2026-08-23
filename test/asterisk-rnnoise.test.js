const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

test('librnnoise shared library and header are installed on host system', () => {
    assert.ok(fs.existsSync('/usr/include/rnnoise.h'), '/usr/include/rnnoise.h must exist');
    assert.ok(fs.existsSync('/usr/lib64/librnnoise.so'), '/usr/lib64/librnnoise.so must exist');
});

test('Asterisk func_rnnoise.so module is installed and loaded in live Asterisk 18', () => {
    assert.ok(fs.existsSync('/usr/lib64/asterisk/modules/func_rnnoise.so'), '/usr/lib64/asterisk/modules/func_rnnoise.so must exist');

    try {
        const out = execSync('asterisk -rx "core show function RNNOISE"', { encoding: 'utf8' });
        assert.ok(out.includes('Info about function \'RNNOISE\''), 'Asterisk CLI must recognize RNNOISE function');
        assert.ok(out.includes('RNNOISE(direction'), 'Syntax must show RNNOISE(direction)');
    } catch (e) {
        assert.fail('Failed to query Asterisk for RNNOISE function: ' + e.message);
    }
});

test('/etc/asterisk/extensions_custom.conf contains RNNoise hooks and echo test feature codes', () => {
    const content = fs.readFileSync('/etc/asterisk/extensions_custom.conf', 'utf8');

    // Echo test feature codes *87, *88 and *89
    assert.ok(content.includes('exten => *87,1,'), 'extensions_custom.conf must declare *87 continuous echo test');
    assert.ok(content.includes('exten => *88,1,'), 'extensions_custom.conf must declare *88 live VAD echo test');
    assert.ok(content.includes('exten => *89,1,'), 'extensions_custom.conf must declare *89 baseline echo test');
    // Trunk & Dongle hooks
    assert.ok(content.includes('[from-dongle-custom]'), 'extensions_custom.conf must contain from-dongle-custom');
    assert.ok(content.includes('[macro-dialout-trunk-predial-hook]'), 'extensions_custom.conf must contain macro-dialout-trunk-predial-hook');
    assert.ok(content.includes('[macro-dialout-one-predial-hook]'), 'extensions_custom.conf must contain macro-dialout-one-predial-hook');
});

test('views/config.ejs renders extDenoise AI noise suppression control in extensionModal', async () => {
    const ejs = require('ejs');
    const path = require('path');
    const configEjsPath = path.join(__dirname, '../views/config.ejs');
    const html = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        isSuperAdmin: true,
        isRoot: true,
        user: { username: 'admin', isRoot: true },
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['extensions'],
        isTabAllowed: () => true
    });

    assert.ok(html.includes('id="extDenoise"'), 'extensionModal must render extDenoise select dropdown');
    assert.ok(html.includes('value="both"'), 'extDenoise must include "both" option');
    assert.ok(html.includes('value="rx"'), 'extDenoise must include "rx" option');
    assert.ok(html.includes('value="tx"'), 'extDenoise must include "tx" option');
    assert.ok(html.includes('value="off"'), 'extDenoise must include "off" option');
    assert.ok(html.includes('id="extVadGate"'), 'extensionModal must render extVadGate select dropdown');
});

test('/etc/asterisk/extensions_custom.conf queries DB(AMPUSER/.../ai_denoise) and vad_gate dynamically', () => {
    const content = fs.readFileSync('/etc/asterisk/extensions_custom.conf', 'utf8');
    assert.ok(content.includes('CALLER_DENOISE=${DB(AMPUSER/${CALLERID(num)}/ai_denoise)}'), 'Dialplan must check caller extension ai_denoise setting');
    assert.ok(content.includes('CALLEE_DENOISE=${DB(AMPUSER/${CALLEE_EXT}/ai_denoise)}'), 'Dialplan must check callee extension ai_denoise setting');
    assert.ok(content.includes('CALLER_VAD=${DB(AMPUSER/${CALLERID(num)}/vad_gate)}'), 'Dialplan must check caller extension vad_gate setting');
    assert.ok(content.includes('CALLEE_VAD=${DB(AMPUSER/${CALLEE_EXT}/vad_gate)}'), 'Dialplan must check callee extension vad_gate setting');
});

function readContext(contextName) {
    const content = fs.readFileSync('/etc/asterisk/extensions_custom.conf', 'utf8');
    const start = content.indexOf(`[${contextName}]`);
    if (start === -1) return '';
    const next = content.slice(start + 1).search(/\n\[/);
    return next === -1 ? content.slice(start) : content.slice(start, start + 1 + next);
}

test('RNNoise/VAD is extension-scoped: dongle contexts carry no audio-filter logic', () => {
    const dongleContext = readContext('from-dongle-custom');
    assert.ok(dongleContext.length > 0, 'from-dongle-custom must exist');
    assert.equal(dongleContext.includes('RNNOISE'), false, 'Inbound dongle context must not apply RNNOISE');
    assert.equal(dongleContext.includes('ai_denoise'), false, 'Inbound dongle context must not read per-dongle denoise keys');

    const cleanup = readContext('dongle-hangup-cleanup');
    assert.equal(cleanup.includes('RNNOISE'), false, 'Hangup cleanup must not apply RNNOISE');
});

test('outbound trunk predial hook derives filtering from the calling EXTENSION, not the dongle', () => {
    const trunkHook = readContext('macro-dialout-trunk-predial-hook');
    assert.ok(trunkHook.length > 0, 'macro-dialout-trunk-predial-hook must exist');
    assert.ok(trunkHook.includes('${DB(AMPUSER/${REALCALLERIDNUM}/ai_denoise)}'), 'Trunk hook must read calling extension denoise via REALCALLERIDNUM');
    assert.ok(trunkHook.includes('${DB(AMPUSER/${REALCALLERIDNUM}/vad_gate)}'), 'Trunk hook must read calling extension VAD gate');
    assert.ok(trunkHook.includes('RNNOISE(${CALLER_DENOISE},${VAD_OPT})=on'), 'Trunk hook must apply extension-scoped RNNoise');
    assert.equal(trunkHook.includes('DONGLE_SETTINGS'), false, 'Trunk hook must not use per-dongle settings anymore');

    const oneHook = readContext('macro-dialout-one-predial-hook');
    assert.ok(oneHook.includes('${DB(AMPUSER/${CALLERID(num)}/ai_denoise)}'), 'Internal-call hook must stay extension-scoped');
});

test('server and UI no longer expose per-dongle noise settings', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.equal(serverJs.includes('saveDongleAudioSettingsInAstdb'), false, 'Server must not persist dongle audio keys');
    assert.equal(/DONGLE_SETTINGS[^"]*\/(ai_denoise|vad_)/.test(serverJs), false, 'Server must not read/write per-dongle audio keys');

    const configHtml = fs.readFileSync(path.join(__dirname, '../views/config.ejs'), 'utf8');
    assert.equal(configHtml.includes("denoiseSelect_${id}"), false, 'Dongle card must not render an AI denoise select');
    assert.equal(configHtml.includes("vadGateSelect_${id}"), false, 'Dongle card must not render a VAD gate select');

    // Extension-scoped controls remain
    assert.ok(configHtml.includes('id="extDenoise"'), 'Extension modal keeps its AI denoise control');
    assert.ok(configHtml.includes('id="extVadGate"'), 'Extension modal keeps its VAD gate control');
});

test('universal VAD tuning is wired into every extension-scoped hook and survives reinstalls', () => {
    // Live dialplan: all three extension hooks must consume the universal threshold/hangover
    for (const ctx of ['macro-dialout-trunk-predial-hook', 'macro-dialout-one-predial-hook', 'func-apply-sipheaders-custom']) {
        const body = readContext(ctx);
        assert.ok(body.includes('${DB(AUDIO_GLOBALS/vad_threshold)}'), `${ctx} must read universal threshold`);
        assert.ok(body.includes('${DB(AUDIO_GLOBALS/vad_hangover)}'), `${ctx} must read universal hangover`);
        assert.ok(body.includes('threshold=${U_THRESH},hangover=${U_HANG}'), `${ctx} must pass universal values to RNNOISE`);
        assert.ok(body.includes('?Set(U_THRESH=0.20)'), `${ctx} must default threshold safely`);
    }

    // Dongle contexts stay free of audio logic
    assert.equal(readContext('from-dongle-custom').includes('AUDIO_GLOBALS'), false, 'Dongle inbound context must not use audio globals');

    // install.sh templates match the live dialplan so reinstalls keep the behavior
    const installer = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
    const templateMatches = installer.match(/AUDIO_GLOBALS\/vad_threshold/g) || [];
    assert.ok(templateMatches.length >= 2, 'Both predial-hook templates in install.sh must read universal threshold');
});

test('server exposes and validates /api/config/audio-globals; modem tab renders universal controls', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.ok(serverJs.includes("app.get('/api/config/audio-globals'"), 'GET endpoint must exist');
    assert.ok(serverJs.includes("app.put('/api/config/audio-globals'"), 'PUT endpoint must exist');
    assert.ok(serverJs.includes("database put AUDIO_GLOBALS vad_threshold"), 'PUT must persist to AstDB');

    const configHtml = fs.readFileSync(path.join(__dirname, '../views/config.ejs'), 'utf8');
    assert.ok(configHtml.includes("id=\"globalVadThreshold\""), 'Modem tab must render universal threshold select');
    assert.ok(configHtml.includes("id=\"globalVadHangover\""), 'Modem tab must render universal hangover select');
    assert.ok(configHtml.includes('/api/config/audio-globals'), 'Modem tab JS must call the audio-globals API');
});
