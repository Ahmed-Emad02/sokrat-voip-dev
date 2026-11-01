const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

test('Dialplan Override: sub-record-check records without gain clipping', () => {
    const overridePath = '/etc/asterisk/extensions_override_issabel.conf';
    assert.ok(fs.existsSync(overridePath), `${overridePath} must exist`);
    const content = fs.readFileSync(overridePath, 'utf8');

    assert.ok(content.includes('[sub-record-check]'), 'extensions_override_issabel.conf must define [sub-record-check]');
    assert.ok(!content.includes('v(3)V(-1)'), 'sub-record-check must not apply 3x recording gain');
    assert.ok(content.includes('v(1)V(1)'), 'sub-record-check must use neutral recording gain');
    assert.ok(content.includes('MixMonitor(${MIXMON_DIR}${YEAR}/${MONTH}/${DAY}/${CALLFILENAME}.${MIXMON_FORMAT},${MIXMON_OPTS},${MIXMON_POST})'),
        'sub-record-check record extension must pass ${MIXMON_OPTS} to MixMonitor');
});

test('Asterisk Live Core: sub-record-check uses neutral recording gain', () => {
    try {
        const out = execSync('asterisk -rx "dialplan show sub-record-check"', { encoding: 'utf8' });
        assert.ok(out.includes("Context 'sub-record-check'"), 'Asterisk must have active sub-record-check context');
        assert.ok(out.includes('v(1)V(1)'), 'Asterisk sub-record-check must show neutral v(1)V(1)');
        assert.ok(!out.includes('v(3)V(-1)'), 'Asterisk sub-record-check must not show 3x recording gain');
        assert.ok(out.includes('extensions_override_issabel.conf'), 'sub-record-check must originate from extensions_override_issabel.conf');
    } catch (e) {
        assert.fail('Failed to query Asterisk dialplan for sub-record-check: ' + e.message);
    }
});

test('ChanSpy Listening: extensions_custom.conf and extensions_sokrat_callcodes.conf use qv(2) gain boost', () => {
    const customConf = fs.readFileSync('/etc/asterisk/extensions_custom.conf', 'utf8');
    assert.ok(customConf.includes('ChanSpy(${spyee_dial},qv(2))'), 'Listen mode in extensions_custom.conf must use qv(2)');
    assert.ok(customConf.includes('ChanSpy(${spyee_dial},qwv(2))'), 'Whisper mode in extensions_custom.conf must use qwv(2)');
    assert.ok(customConf.includes('ChanSpy(${spyee_dial},qBv(2))'), 'Barge mode in extensions_custom.conf must use qBv(2)');

    const callCodesConf = '/etc/asterisk/extensions_sokrat_callcodes.conf';
    if (fs.existsSync(callCodesConf)) {
        const codesContent = fs.readFileSync(callCodesConf, 'utf8');
        assert.ok(codesContent.includes('ChanSpy(${spyee_dial},qv(2))'), 'extensions_sokrat_callcodes.conf must use qv(2)');
    }
});

test('Multi-Installer Synchronization: recording gain is neutral and ChanSpy qv(2) is retained', () => {
    const installSh = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
    const offlineSh = fs.readFileSync(path.join(__dirname, '../installer-bundle/install-sokrat.sh'), 'utf8');
    const safeUpgradeSh = fs.readFileSync(path.join(__dirname, '../scripts/safe-upgrade.sh'), 'utf8');

    for (const [name, content] of [['install.sh', installSh], ['install-sokrat.sh', offlineSh], ['safe-upgrade.sh', safeUpgradeSh]]) {
        assert.ok(content.includes('v(1)V(1)'), `${name} must use neutral v(1)V(1) in sub-record-check override`);
        assert.ok(!content.includes('v(3)V(-1)'), `${name} must not apply 3x recording gain`);
        assert.ok(content.includes('qv(2)'), `${name} must include qv(2) in ChanSpy configuration`);
    }
});
