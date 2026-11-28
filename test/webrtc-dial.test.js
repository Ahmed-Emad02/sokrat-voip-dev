const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    webrtcDeviceId,
    webrtcLineExtensions,
    hasWebrtcEndpoint,
    buildWebrtcLineBlock,
    setWebrtcLinePassword,
    parseAstdb,
    deviceList,
    planWebrtcDeviceSync,
    reconcileWebrtcDevices
} = require('../lib/webrtc-dial');

const CONF = [
    buildWebrtcLineBlock({ ext: '111', password: 'old111', displayName: 'shahd' }),
    buildWebrtcLineBlock({ ext: '1120', password: 'p1120', displayName: 'other' }),
    '[9999]',
    'type = endpoint',
    ''
].join('\n');

test('finds extensions with a managed WebRTC line by exact marker', () => {
    assert.deepEqual([...webrtcLineExtensions(CONF)].sort(), ['111', '1120']);
    assert.equal(hasWebrtcEndpoint('111', CONF), true);
    assert.equal(hasWebrtcEndpoint('112', CONF), false, '1120 must not match 112');
    assert.equal(hasWebrtcEndpoint('9999', CONF), false, 'unmanaged sections are ignored');
    assert.equal(hasWebrtcEndpoint('abc', CONF), false);
});

test('the WebRTC line block matches what CRM pairing provisions', () => {
    const block = buildWebrtcLineBlock({ ext: '205', password: 's3cret', displayName: 'Mona' });
    assert.match(block, /^\n; BEGIN WEBRTC EXTENSION 205\n\[205\]\ntype = endpoint\n/);
    assert.match(block, /\nwebrtc = yes\n/);
    assert.match(block, /\ncallerid = Mona <205>\n/);
    assert.match(block, /\n\[205-auth\]\ntype = auth\nauth_type = userpass\nusername = 205\npassword = s3cret\n/);
    assert.match(block, /\nmax_contacts = 10\nremove_existing = no\nremove_unavailable = yes\n/);
    assert.match(block, /; END WEBRTC EXTENSION 205\n$/);
});

test('syncs only the managed line password', () => {
    const changed = setWebrtcLinePassword(CONF, '111', 'new111');
    assert.equal(changed.changed, true);
    assert.match(changed.content, /\[111-auth\][\s\S]*?password = new111/);
    assert.match(changed.content, /\[1120-auth\][\s\S]*?password = p1120/, 'other lines untouched');
    assert.equal(changed.content.length, CONF.length + 'new111'.length - 'old111'.length);
    assert.equal(setWebrtcLinePassword(CONF, '111', 'old111').changed, false, 'same password is a no-op');
    assert.equal(setWebrtcLinePassword(CONF, '112', 'x').changed, false, 'no block, no change');
    assert.equal(setWebrtcLinePassword(CONF, '111', '').changed, false, 'empty secret ignored');
    assert.equal(setWebrtcLinePassword(CONF, '111', 'has space').changed, false, 'unsafe secret ignored');
});

test('parses AstDB show output', () => {
    const tree = parseAstdb('/AMPUSER/111/device                      : 111\n/DEVICE/111/dial : SIP/111&PJSIP/111\n2 results found.\n');
    assert.deepEqual(tree, { 'AMPUSER/111/device': '111', 'DEVICE/111/dial': 'SIP/111&PJSIP/111' });
});

test('device list adds or removes only the WebRTC device', () => {
    assert.equal(webrtcDeviceId('111'), '111-webrtc');
    assert.equal(deviceList('111', '111', true), '111&111-webrtc');
    assert.equal(deviceList('111', '111&111-webrtc', true), '111&111-webrtc');
    assert.equal(deviceList('111', '111&111-webrtc', false), '111');
    assert.equal(deviceList('111', '111&4111', true), '111&4111&111-webrtc', 'other devices keep their order');
    assert.equal(deviceList('111', '111-webrtc', false), '111', 'a lost SIP device falls back to the extension');
    assert.equal(deviceList('500', '', false), '', 'virtual extensions stay without devices');
});

function tree(entries) { return Object.fromEntries(entries); }

test('plans a second device for SIP extensions with a WebRTC line and reverts the old fork', () => {
    const commands = planWebrtcDeviceSync({
        ampuser: tree([['AMPUSER/111/device', '111'], ['AMPUSER/103/device', '103']]),
        device: tree([
            ['DEVICE/111/tech', 'sip'], ['DEVICE/111/dial', 'SIP/111&PJSIP/111'],
            ['DEVICE/103/tech', 'sip'], ['DEVICE/103/dial', 'SIP/103']
        ]),
        lineExts: new Set(['111'])
    });
    assert.deepEqual(commands, [
        'database put DEVICE/111 dial "SIP/111"',
        'database put DEVICE/111-webrtc dial "PJSIP/111"',
        'database put DEVICE/111-webrtc tech "pjsip"',
        'database put DEVICE/111-webrtc user "111"',
        'database put DEVICE/111-webrtc default_user "111"',
        'database put DEVICE/111-webrtc type "fixed"',
        'database put AMPUSER 111/device "111&111-webrtc"'
    ]);
});

test('is idempotent once in sync', () => {
    const device = tree([
        ['DEVICE/111/tech', 'sip'], ['DEVICE/111/dial', 'SIP/111'],
        ['DEVICE/111-webrtc/dial', 'PJSIP/111'], ['DEVICE/111-webrtc/tech', 'pjsip'],
        ['DEVICE/111-webrtc/user', '111'], ['DEVICE/111-webrtc/default_user', '111'], ['DEVICE/111-webrtc/type', 'fixed']
    ]);
    assert.deepEqual(planWebrtcDeviceSync({ ampuser: tree([['AMPUSER/111/device', '111&111-webrtc']]), device, lineExts: new Set(['111']) }), []);
});

test('re-adds the device after a FreePBX GUI save reset the device list', () => {
    const device = tree([
        ['DEVICE/111/tech', 'sip'], ['DEVICE/111/dial', 'SIP/111'],
        ['DEVICE/111-webrtc/dial', 'PJSIP/111'], ['DEVICE/111-webrtc/tech', 'pjsip'],
        ['DEVICE/111-webrtc/user', '111'], ['DEVICE/111-webrtc/default_user', '111'], ['DEVICE/111-webrtc/type', 'fixed']
    ]);
    assert.deepEqual(planWebrtcDeviceSync({ ampuser: tree([['AMPUSER/111/device', '111']]), device, lineExts: new Set(['111']) }),
        ['database put AMPUSER 111/device "111&111-webrtc"']);
});

test('leaves pure WebRTC extensions to FreePBX and removes stale WebRTC devices', () => {
    const commands = planWebrtcDeviceSync({
        ampuser: tree([['AMPUSER/200/device', '200&200-webrtc'], ['AMPUSER/300/device', '300&300-webrtc']]),
        device: tree([
            ['DEVICE/200/tech', 'pjsip'], ['DEVICE/200/dial', 'PJSIP/200'], ['DEVICE/200-webrtc/dial', 'PJSIP/200'],
            ['DEVICE/300/tech', 'sip'], ['DEVICE/300/dial', 'SIP/300'], ['DEVICE/300-webrtc/dial', 'PJSIP/300'],
            ['DEVICE/400-webrtc/dial', 'PJSIP/400']
        ]),
        // 200 is a WebRTC extension (rings all contacts already); 300 lost its line.
        lineExts: new Set(['200'])
    });
    assert.deepEqual(commands, [
        'database put AMPUSER 200/device "200"',
        'database deltree DEVICE/200-webrtc',
        'database put AMPUSER 300/device "300"',
        'database deltree DEVICE/300-webrtc',
        'database deltree DEVICE/400-webrtc'
    ]);
});

test('a single-extension sync touches only that extension', () => {
    const commands = planWebrtcDeviceSync({
        ampuser: tree([['AMPUSER/111/device', '111'], ['AMPUSER/112/device', '112']]),
        device: tree([['DEVICE/111/tech', 'sip'], ['DEVICE/112/tech', 'sip'], ['DEVICE/400-webrtc/dial', 'PJSIP/400']]),
        lineExts: new Set(['111', '112']),
        only: '112'
    });
    assert.ok(commands.every(c => c.includes('112')), commands.join('\n'));
    assert.ok(commands.includes('database put AMPUSER 112/device "112&112-webrtc"'));
});

test('reconcile reads AstDB once per family and applies the plan through the CLI', async () => {
    const calls = [];
    const exec = async (_bin, args) => {
        calls.push(args[1]);
        if (args[1] === 'database show AMPUSER') return { stdout: '/AMPUSER/111/device : 111\n' };
        if (args[1] === 'database show DEVICE') return '/DEVICE/111/tech : sip\n/DEVICE/111/dial : SIP/111\n';
        return { stdout: '' };
    };
    const applied = await reconcileWebrtcDevices(exec, '/usr/sbin/asterisk', { content: CONF });
    assert.equal(calls[0], 'database show AMPUSER');
    assert.equal(calls[1], 'database show DEVICE');
    assert.deepEqual(calls.slice(2), applied);
    assert.ok(applied.includes('database put AMPUSER 111/device "111&111-webrtc"'));
    assert.deepEqual(await reconcileWebrtcDevices(exec, '/x', { only: 'abc', content: CONF }), [], 'invalid extension is ignored');
});

// FreePBX's macro-dial-one walks AMPUSER/<ext>/device and expands a device
// whose dial string starts with PJSIP via PJSIP_DIAL_CONTACTS. Mirror that
// walk to show the WebRTC device rings every registered contact.
test('FreePBX dstring expansion rings the SIP phone and every WebRTC contact', () => {
    const astdb = {
        'AMPUSER/111/device': '111&111-webrtc',
        'DEVICE/111/dial': 'SIP/111',
        'DEVICE/111-webrtc/dial': 'PJSIP/111'
    };
    const contacts = { 111: 'PJSIP/111/sip:crm@10.0.0.5:5000;transport=ws&PJSIP/111/sip:mobile@10.0.0.9:6000;transport=ws' };
    const parts = astdb['AMPUSER/111/device'].split('&').map(dev => {
        let dial = astdb[`DEVICE/${dev}/dial`];
        if (dial.slice(0, 5) === 'PJSIP') dial = contacts[dial.split('/')[1]] || dial;
        return dial;
    });
    assert.equal(parts.join('&'), `SIP/111&${contacts[111]}`);
});

// ChanSpy accepts one channel prefix; the spy codes pick the WebRTC leg when
// it is the one in a call.
const SPY_NORMALISE = (e) => [
    `ExecIf($["\${CHANNELS(^PJSIP/\${${e}}-)}" != ""]?Set(spyee_dial=PJSIP/\${${e}}))`,
    'Set(spyee_dial=${CUT(spyee_dial,&,1)})'
];

function assertNormalisedBeforeEveryChanSpy(text, label) {
    const lines = text.split('\n');
    const spyLines = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('ChanSpy(${spyee_dial},'));
    assert.ok(spyLines.length >= 3, `${label}: expected listen/whisper/barge ChanSpy lines`);
    for (const [, i] of spyLines) {
        const offset = (lines.slice(Math.max(0, i - 4), i).join('\n').match(/DEVICE\/\$\{(EXTEN(?::\d+)?)\}\/dial/) || [])[1];
        assert.ok(offset, `${label}: no DEVICE dial lookup before line ${i + 1}`);
        const [execIf, cut] = SPY_NORMALISE(offset);
        assert.ok(lines[i - 2].endsWith(execIf), `${label}: line ${i - 1} must pick the active WebRTC leg; got ${lines[i - 2]}`);
        assert.ok(lines[i - 1].endsWith(cut), `${label}: line ${i} must cut the dial string; got ${lines[i - 1]}`);
    }
}

test('installers pick the active WebRTC leg before ChanSpy', () => {
    for (const rel of ['install.sh', 'installer-bundle/install-sokrat.sh']) {
        assertNormalisedBeforeEveryChanSpy(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), rel);
    }
});

test('generated call-code spy dialplan picks the active WebRTC leg before ChanSpy', async () => {
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

// server.js wiring: SIP saves keep the line instead of deleting it.
test('SIP saves keep the CRM/mobile WebRTC line; only removal deletes it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const deletes = source.match(/updatePjsipCustomConfig\([^)]*'delete'[^)]*\)/g) || [];
    assert.equal(deletes.length, 2, 'only provisioning rollback and extension removal delete the line');
    assert.match(source, /updatePjsipCustomConfig\(extNum, extSecret, displayName, 'sip', reloadPjsipConfig\)/);
    assert.match(source, /updatePjsipCustomConfig\(extNum, lineSecret, displayName \|\| extNum, 'sip', true, \{ ensureLine: wasWebrtc \}\)/);
    assert.match(source, /setInterval\(\(\) => \{ syncWebrtcLineDevices\(\); \}, 60 \* 1000\)\.unref\(\)/);
});

// Pairing used to delete every managed line whose extension appeared in
// pjsip_additional.conf. That file lags behind until the next retrieve_conf,
// so a WebRTC -> SIP conversion lost its freshly created line to any other
// user's pairing. The decision now follows FreePBX's devices table.
test('pairing only treats extensions as FreePBX PJSIP when the devices table agrees', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'crm-integration.js'), 'utf8');
    assert.match(source, /SELECT id FROM `asterisk`\.`devices` WHERE LOWER\(tech\) = 'pjsip'/);
    assert.match(source, /const isFreepbxPjsip = \(e\) => addC\.includes\(`\[\$\{e\}\]`\) && \(!pjsipDevices \|\| pjsipDevices\.has\(String\(e\)\)\)/);
    assert.match(source, /\.filter\(isFreepbxPjsip\)/, 'cleanup skips extensions FreePBX no longer defines as PJSIP');
    assert.match(source, /if \(isFreepbxPjsip\(ext\)\) \{\n\s+const requiredWebrtcParams/, 'a SIP extension gets its own line, not post-config params');
});
