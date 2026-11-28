const test = require('node:test');
const assert = require('node:assert/strict');

const { hasWebrtcEndpoint, withWebrtcFork, ensureWebrtcDialFork } = require('../lib/webrtc-dial');

const CONF = [
    '; BEGIN WEBRTC EXTENSION 111',
    '[111]',
    'type = endpoint',
    '; END WEBRTC EXTENSION 111',
    '; BEGIN WEBRTC EXTENSION 1120',
    '[1120]',
    '; END WEBRTC EXTENSION 1120',
    ''
].join('\n');

test('forks a chan_sip dial string when the extension has a CRM WebRTC endpoint', () => {
    assert.equal(withWebrtcFork('111', 'SIP/111', CONF), 'SIP/111&PJSIP/111');
});

test('keeps SIP first so macro-dial-one does not run pjsipdial on the forked string', () => {
    assert.match(withWebrtcFork('111', 'SIP/111', CONF), /^SIP\//);
});

test('leaves extensions without a WebRTC block alone, even when a longer number shares the prefix', () => {
    assert.equal(withWebrtcFork('112', 'SIP/112', CONF), 'SIP/112');
    assert.equal(hasWebrtcEndpoint('112', CONF), false);
});

test('leaves PJSIP, custom and already-forked dial strings unchanged', () => {
    assert.equal(withWebrtcFork('111', 'PJSIP/111', CONF), 'PJSIP/111');
    assert.equal(withWebrtcFork('111', 'SIP/111&PJSIP/111', CONF), 'SIP/111&PJSIP/111');
    assert.equal(withWebrtcFork('111', 'SIP/222', CONF), 'SIP/222');
});

test('rejects non-numeric extensions', () => {
    assert.equal(hasWebrtcEndpoint('abc', CONF), false);
    assert.equal(withWebrtcFork('', 'SIP/', CONF), 'SIP/');
});

test('ensureWebrtcDialFork only writes AstDB when the dial string changes', async () => {
    const calls = [];
    const fakeExec = (stdout) => async (_bin, args) => {
        calls.push(args[1]);
        return { stdout: args[1].startsWith('database get') ? stdout : '' };
    };
    // Extension without a WebRTC block on this machine: read only, no write.
    calls.length = 0;
    const result = await ensureWebrtcDialFork('99999', fakeExec('Value: SIP/99999\n'), '/usr/sbin/asterisk');
    assert.equal(result, 'SIP/99999');
    assert.deepEqual(calls, ['database get DEVICE/99999 dial']);
    // Missing AstDB key: nothing to fork.
    calls.length = 0;
    assert.equal(await ensureWebrtcDialFork('99999', fakeExec('Database entry not found.\n'), '/usr/sbin/asterisk'), null);
    assert.equal(await ensureWebrtcDialFork('not-a-number', fakeExec(''), '/usr/sbin/asterisk'), null);
});

// ChanSpy accepts one channel prefix, so a forked "SIP/<ext>&PJSIP/<ext>"
// dial string must be reduced to the leg that is actually in a call.
const fs = require('fs');
const path = require('path');
const SPY_NORMALISE = (e) => [
    `ExecIf($["\${CHANNELS(^PJSIP/\${${e}}-)}" != "" & "\${spyee_dial}" != "\${CUT(spyee_dial,&,1)}"]?Set(spyee_dial=PJSIP/\${${e}}))`,
    'Set(spyee_dial=${CUT(spyee_dial,&,1)})'
];

function assertNormalisedBeforeEveryChanSpy(text, label) {
    const lines = text.split('\n');
    const spyLines = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('ChanSpy(${spyee_dial},'));
    assert.ok(spyLines.length >= 3, `${label}: expected listen/whisper/barge ChanSpy lines`);
    for (const [line, i] of spyLines) {
        const offset = (lines.slice(Math.max(0, i - 4), i).join('\n').match(/DEVICE\/\$\{(EXTEN(?::\d+)?)\}\/dial/) || [])[1];
        assert.ok(offset, `${label}: no DEVICE dial lookup before line ${i + 1}`);
        const [execIf, cut] = SPY_NORMALISE(offset);
        assert.ok(lines[i - 2].endsWith(execIf), `${label}: line ${i - 1} must pick the active WebRTC leg; got ${lines[i - 2]}`);
        assert.ok(lines[i - 1].endsWith(cut), `${label}: line ${i} must cut the dial string; got ${lines[i - 1]}`);
        assert.ok(line.includes('ChanSpy('), label);
    }
}

test('installers normalise forked dial strings before ChanSpy', () => {
    for (const rel of ['install.sh', 'installer-bundle/install-sokrat.sh']) {
        assertNormalisedBeforeEveryChanSpy(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), rel);
    }
});

test('generated call-code spy dialplan normalises forked dial strings before ChanSpy', async () => {
    const callCodes = require('../lib/call-codes');
    const rows = ['spy_listen', 'spy_whisper', 'spy_barge'].map((id, n) => ({
        id, code: `55${n}[Ext]`, default_code: `22${n + 2}[Ext]`, enabled: 1, backend_type: 'dialplan', backend_feature: null
    }));
    const pool = { query: async () => [rows] };
    const originalWrite = fs.writeFileSync;
    let written = null;
    fs.writeFileSync = (file, content, ...rest) => {
        if (String(file).endsWith('extensions_sokrat_callcodes.conf')) { written = content; return; }
        return originalWrite.call(fs, file, content, ...rest);
    };
    try {
        await callCodes.syncSokratCallCodesDialplan(pool);
    } finally {
        fs.writeFileSync = originalWrite;
    }
    assert.ok(written, 'dialplan was generated');
    assertNormalisedBeforeEveryChanSpy(written, 'extensions_sokrat_callcodes.conf');
});
