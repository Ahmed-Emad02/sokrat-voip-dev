const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    BEGIN_MARK,
    END_MARK,
    SOKRAT_OWNED_CODES,
    fetchIssabelFeatureCodes,
    fetchVoicemailDialCode,
    isVoicemailOpenAccessEnabled,
    selectArgumentCodes,
    buildFeatureCodeBlock,
    patchExtensionsCustomConf,
    patchLegacyPickupAliases,
    syncFeatureCodeHandOff
} = require('../lib/feature-code-hand-off');

const REPO = path.join(__dirname, '..');
const DIALPLAN = '/etc/asterisk/extensions_custom.conf';

function tmpDialplan(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-fc-'));
    const file = path.join(dir, 'extensions_custom.conf');
    fs.writeFileSync(file, content, 'utf8');
    return file;
}

test('feature-code hand-off keeps the Sokrat-owned pickup aliases away from Issabel', async () => {
    const pool = {
        query: async () => [[
            { code: '*97' },
            { code: '*72' },
            { code: '**' },
            { code: '*' },      // Sokrat alias -> excluded
            { code: '*1' },     // Sokrat alias -> excluded
            { code: '*8' },     // Sokrat alias -> excluded
            { code: '555' },    // not a * code -> excluded
            { code: null }
        ]]
    };
    const codes = await fetchIssabelFeatureCodes(pool);
    assert.deepEqual(codes, ['**', '*72', '*97']);
    for (const owned of SOKRAT_OWNED_CODES) {
        assert.ok(!codes.includes(owned), `${owned} stays a Sokrat pickup alias`);
    }
});

test('feature-code hand-off block declares one literal per code', () => {
    const block = buildFeatureCodeBlock(['*97', '*72']);
    assert.ok(block.startsWith(BEGIN_MARK), 'block starts with the begin marker');
    assert.ok(block.trimEnd().endsWith(END_MARK), 'block ends with the end marker');
    assert.ok(block.includes('exten => *97,1,Goto(from-internal-additional,${EXTEN},1)'), '*97 is a literal hand-off');
    assert.ok(block.includes('exten => *72,1,Goto(from-internal-additional,${EXTEN},1)'), '*72 is a literal hand-off');
    assert.ok(!block.includes('_*X.'), 'the block does not add any pickup pattern');
});

test('the Issabel argument forms are picked out of Issabel\'s dialplan', () => {
    const dialplan = [
        '[app-dialvm]',
        'exten => *98,1,Macro(user-callerid,)',
        'exten => _*98.,1,Answer',
        'exten => _*98.,n,Macro(get-vmcontext,${EXTEN:3})',
        '',
        '[app-cf-on]',
        'exten => _*72.,1,Set(EXTEN=${EXTEN:3})',
        '',
        '[app-userlogonoff]',
        'exten => _*11.,1,Macro(user-logon,${EXTEN:3},)',
        '',
        '[app-speeddial]',
        'exten => _*0.,1,Macro(user-callerid,)',
        '',
        '[app-hotelwakeup]',
        'exten => _*740101.,1,Set(toext=${EXTEN:7})',
        '',
        '[not-a-feature]',
        'exten => _*123.,1,NoOp(some other pattern)'
    ].join('\n');

    const codes = selectArgumentCodes(dialplan, ['*0', '*11', '*72', '*740', '*98', '*123']);
    assert.deepEqual(codes, ['0', '72', '98', '740101'],
        'only the enabled Issabel codes are taken, shortest first');

    assert.ok(!codes.includes('11'), '*11 is left alone: it collides with the *1 pickup alias');
    assert.ok(!codes.includes('123'), 'a pattern that is not an enabled feature code is not taken');
});

test('the argument forms keep the Sokrat pickup for a registered extension', () => {
    const block = buildFeatureCodeBlock(['*98'], ['98']);
    assert.ok(block.includes('exten => _*98.,1,NoOp('), '*98<arg> is declared as a pattern');
    assert.ok(
        block.includes('same => n,GotoIf($["${DB(DEVICE/${EXTEN:1}/dial)}" != ""]?sokrat-pickup-target,1)'),
        'a registered extension keeps the directed pickup'
    );
    assert.ok(block.includes('same => n,Goto(from-internal-additional,${EXTEN},1)'), 'anything else goes to Issabel');
    assert.ok(block.includes('exten => sokrat-pickup-target,1,NoOp('), 'the pickup fallback is declared');
    assert.ok(block.includes('same => n,Pickup('), 'the pickup fallback picks the extension up');
});

test('the block without argument forms stays exactly as before', () => {
    const block = buildFeatureCodeBlock(['*97'], []);
    assert.ok(!block.includes('sokrat-pickup-target'), 'no pickup fallback without argument codes');
    assert.ok(!block.includes('_*98.'), 'no argument pattern without argument codes');
});

test('open voicemail mode skips the passcode and the pickup check for *98', () => {
    const block = buildFeatureCodeBlock(['*97', '*98'], ['98', '72'], {
        openVoicemailAccess: true,
        voicemailCode: '*98'
    });

    assert.ok(
        block.includes('exten => *98,1,NoOp(--- Sokrat open voicemail: choose a mailbox (passcode skipped) ---)'),
        '*98 is handled by the open voicemail block'
    );
    assert.ok(block.includes('Read(MAILBOX,vm-login,,,3,2)'), '*98 still asks for a mailbox');
    assert.ok(block.includes('VoiceMailMain(${MAILBOX}@${VMCONTEXT},s)'), '*98 skips the mailbox passcode');
    assert.ok(!block.includes('exten => *98,1,Goto(from-internal-additional'), '*98 is not handed back to Issabel');

    const direct = block.slice(block.indexOf('exten => _*98.,1'), block.indexOf('exten => _*72.,1'));
    assert.ok(
        direct.includes('VoiceMailMain(${EXTEN:3}@${VMCONTEXT},s)'),
        '*98<mailbox> opens the mailbox with the passcode skipped'
    );
    assert.ok(!direct.includes('sokrat-pickup-target'), '*98<mailbox> bypasses the directed-pickup check');
    assert.ok(!direct.includes('from-internal-additional'), '*98<mailbox> is not handed back to Issabel');

    const forward = block.slice(block.indexOf('exten => _*72.,1'));
    assert.ok(forward.includes('sokrat-pickup-target'), 'other argument codes keep the directed pickup');
    assert.ok(block.includes('exten => *97,1,Goto(from-internal-additional,${EXTEN},1)'), '*97 is unchanged');
});

test('open voicemail mode declares *98<mailbox> even without Issabel argument detection', () => {
    const block = buildFeatureCodeBlock(['*98'], [], {
        openVoicemailAccess: true,
        voicemailCode: '*98'
    });
    assert.ok(block.includes('exten => _*98.,1,NoOp('), '*98<mailbox> is declared directly');
    assert.ok(block.includes('VoiceMailMain(${EXTEN:3}@${VMCONTEXT},s)'), 'the passcode is skipped');
    assert.ok(!block.includes('sokrat-pickup-target'), 'no pickup fallback is generated');
});

test('the open voicemail mode is opt-in through SOKRAT_VOICEMAIL_OPEN_ACCESS', async () => {
    assert.equal(isVoicemailOpenAccessEnabled({}), false, 'disabled by default');
    assert.equal(isVoicemailOpenAccessEnabled({ SOKRAT_VOICEMAIL_OPEN_ACCESS: 'false' }), false);
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
        assert.equal(
            isVoicemailOpenAccessEnabled({ SOKRAT_VOICEMAIL_OPEN_ACCESS: value }),
            true,
            `${value} enables open access`
        );
    }

    let captured = '';
    const pool = {
        query: async (sql) => {
            captured = sql;
            return [[{ defaultcode: '*98', customcode: null }]];
        }
    };
    assert.equal(await fetchVoicemailDialCode(pool), '*98');
    assert.ok(captured.includes("featurename = 'dialvoicemail'"), 'queries the dialvoicemail feature');
    assert.ok(captured.includes('enabled = 1'), 'only the enabled code is used');

    const customPool = {
        query: async () => [[{ defaultcode: '*98', customcode: '*199' }]]
    };
    assert.equal(await fetchVoicemailDialCode(customPool), '*199', 'a custom code wins over the default');
});

test('the sync applies open voicemail access when requested', async () => {
    const pool = {
        query: async (sql) => {
            if (sql.includes('dialvoicemail')) return [[{ defaultcode: '*98', customcode: null }]];
            return [[{ code: '*97' }, { code: '*98' }]];
        }
    };
    const custom = tmpDialplan('[from-internal-custom]\n');
    const res = await syncFeatureCodeHandOff(pool, {
        filePath: custom,
        openVoicemailAccess: true,
        issabelDialplanFile: path.join(path.dirname(custom), 'missing.conf')
    });
    assert.equal(res.voicemailCode, '*98');
    assert.equal(res.voicemailOpenActive, true);
    const content = fs.readFileSync(custom, 'utf8');
    assert.ok(content.includes('VoiceMailMain(${MAILBOX}@${VMCONTEXT},s)'), '*98 skips the passcode');
    assert.ok(content.includes('VoiceMailMain(${EXTEN:3}@${VMCONTEXT},s)'), '*98<mailbox> skips the passcode');
    fs.rmSync(path.dirname(custom), { recursive: true, force: true });
});

test('the sync reads SOKRAT_VOICEMAIL_OPEN_ACCESS from the environment', async () => {
    const previous = process.env.SOKRAT_VOICEMAIL_OPEN_ACCESS;
    process.env.SOKRAT_VOICEMAIL_OPEN_ACCESS = 'true';
    try {
        const pool = {
            query: async (sql) => {
                if (sql.includes('dialvoicemail')) return [[{ defaultcode: '*98', customcode: null }]];
                return [[{ code: '*98' }]];
            }
        };
        const custom = tmpDialplan('[from-internal-custom]\n');
        const res = await syncFeatureCodeHandOff(pool, {
            filePath: custom,
            issabelDialplanFile: path.join(path.dirname(custom), 'missing.conf')
        });
        assert.equal(res.voicemailOpenActive, true, 'the env flag enables open access');
        assert.ok(
            fs.readFileSync(custom, 'utf8').includes('VoiceMailMain(${EXTEN:3}@${VMCONTEXT},s)'),
            'the open voicemail handler is written'
        );
        fs.rmSync(path.dirname(custom), { recursive: true, force: true });
    } finally {
        if (previous === undefined) delete process.env.SOKRAT_VOICEMAIL_OPEN_ACCESS;
        else process.env.SOKRAT_VOICEMAIL_OPEN_ACCESS = previous;
    }
});

test('feature-code hand-off is written inside [from-internal-custom] and is idempotent', () => {
    const file = tmpDialplan([
        '[from-internal-custom]',
        'exten => _*X.,1,NoOp(--- Directed / Ring Group Pickup ---)',
        'same => n,Hangup()',
        '',
        '[other-context]',
        'exten => 100,1,NoOp()',
        ''
    ].join('\n'));

    const first = patchExtensionsCustomConf(file, ['*97']);
    assert.equal(first.changed, true, 'first run rewrites the dialplan');
    let content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes(BEGIN_MARK), 'generated block is present');
    assert.ok(content.includes('exten => *97,1,Goto(from-internal-additional,${EXTEN},1)'), 'literal hand-off present');
    assert.ok(content.includes('exten => _*X.,1,NoOp(--- Directed / Ring Group Pickup'), 'Sokrat pickup pattern kept');
    const ctxIdx = content.indexOf('[from-internal-custom]');
    const blockIdx = content.indexOf(BEGIN_MARK);
    assert.ok(blockIdx > ctxIdx, 'generated block lives inside [from-internal-custom]');

    const second = patchExtensionsCustomConf(file, ['*97']);
    assert.equal(second.changed, false, 'second run is a no-op');
    assert.equal(fs.readFileSync(file, 'utf8'), content, 'file content unchanged on re-run');

    // A changed code list replaces the previous block instead of duplicating it.
    const third = patchExtensionsCustomConf(file, ['*97', '*72']);
    assert.equal(third.changed, true, 'new codes rewrite the block');
    content = fs.readFileSync(file, 'utf8');
    assert.equal((content.match(new RegExp(BEGIN_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1,
        'exactly one generated block');
    assert.ok(content.includes('exten => *72,1,Goto(from-internal-additional,${EXTEN},1)'), 'new literal added');

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('feature-code hand-off creates [from-internal-custom] when it is missing', () => {
    const file = tmpDialplan('[some-other-context]\nexten => 100,1,NoOp()\n');
    const res = patchExtensionsCustomConf(file, ['*97']);
    assert.equal(res.changed, true);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('[from-internal-custom]'), 'context created');
    assert.ok(content.includes('exten => *97,1,Goto(from-internal-additional,${EXTEN},1)'), 'literal hand-off present');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

function legacyOverrideDialplan() {
    return [
        '[from-internal-custom]',
        'exten => _*1X.,1,NoOp(--- Directed Pickup Alias to * ---)',
        'same => n,PickupChan(PJSIP/${EXTEN:2}&SIP/${EXTEN:2}&Local/${EXTEN:2}@ext-local,p)',
        'same => n,Pickup(${EXTEN:2}@ext-local&${EXTEN:2}@from-internal&${EXTEN:2}@from-did-direct&${EXTEN:2}@ext-group)',
        'same => n,Hangup()',
        'exten => _*8X.,1,NoOp(--- Directed Pickup Alias to * ---)',
        'same => n,PickupChan(PJSIP/${EXTEN:2}&SIP/${EXTEN:2}&Local/${EXTEN:2}@ext-local,p)',
        'same => n,Pickup(${EXTEN:2}@ext-local&${EXTEN:2}@from-internal&${EXTEN:2}@from-did-direct&${EXTEN:2}@ext-group)',
        'same => n,Hangup()',
        ''
    ].join('\n');
}

test('the legacy pickup alias block in extensions_override_issabel.conf is migrated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-override-'));
    const override = path.join(dir, 'extensions_override_issabel.conf');
    fs.writeFileSync(override, legacyOverrideDialplan(), 'utf8');

    const first = patchLegacyPickupAliases(override);
    assert.equal(first.changed, true, 'the old block is replaced');
    const content = fs.readFileSync(override, 'utf8');
    assert.ok(content.includes('exten => _*1X.,1,Gosub(from-internal-custom,sokrat-directed-pickup,1(${EXTEN:1},${EXTEN:2}))'));
    assert.ok(content.includes('exten => _*8X.,1,Gosub(from-internal-custom,sokrat-directed-pickup,1(${EXTEN:1},${EXTEN:2}))'));
    assert.ok(!content.includes('NoOp(--- Directed Pickup Alias to * ---)'), 'old alias handler is gone');

    const second = patchLegacyPickupAliases(override);
    assert.equal(second.changed, false, 'second run is a no-op');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the sync migrates the override file when one is supplied', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-override-'));
    const custom = path.join(dir, 'extensions_custom.conf');
    const override = path.join(dir, 'extensions_override_issabel.conf');
    fs.writeFileSync(custom, '[from-internal-custom]\n', 'utf8');
    fs.writeFileSync(override, legacyOverrideDialplan(), 'utf8');

    const pool = { query: async () => [[{ code: '*97' }]] };
    const res = await syncFeatureCodeHandOff(pool, { filePath: custom, overrideFilePath: override });
    assert.equal(res.overrideChanged, true, 'override migration is reported');
    assert.equal(res.changed, true, 'a change in either file triggers a reload');
    assert.ok(fs.readFileSync(override, 'utf8').includes('sokrat-directed-pickup,1(${EXTEN:1},${EXTEN:2})'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('feature-code hand-off reads the codes from Issabel featurecodes table', async () => {
    let captured = null;
    const pool = {
        query: async (sql) => {
            captured = sql;
            return [[{ code: '*97' }]];
        }
    };
    const res = await syncFeatureCodeHandOff(pool, { filePath: tmpDialplan('[from-internal-custom]\n') });
    assert.ok(captured.includes('featurecodes'), 'queries Issabel featurecodes');
    assert.ok(captured.includes('enabled = 1'), 'only enabled feature codes are used');
    assert.deepEqual(res.codes, ['*97']);
    fs.rmSync(path.dirname(res.filePath), { recursive: true, force: true });
});

test('the sync also picks up the argument forms from Issabel\'s dialplan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-fc-'));
    const issabel = path.join(dir, 'extensions_additional.conf');
    fs.writeFileSync(issabel, [
        '[app-dialvm]',
        'exten => _*98.,1,Answer',
        'exten => _*98.,n,Macro(get-vmcontext,${EXTEN:3})'
    ].join('\n'), 'utf8');

    const pool = { query: async () => [[{ code: '*98' }]] };
    const custom = path.join(dir, 'extensions_custom.conf');
    fs.writeFileSync(custom, '[from-internal-custom]\n', 'utf8');
    const res = await syncFeatureCodeHandOff(pool, {
        filePath: custom,
        issabelDialplanFile: issabel
    });
    assert.deepEqual(res.argumentCodes, ['98'], 'the argument form is detected');
    const content = fs.readFileSync(res.filePath, 'utf8');
    assert.ok(content.includes('exten => _*98.,1,NoOp('), 'the argument form is written to the dialplan');
    assert.ok(content.includes('sokrat-pickup-target'), 'the pickup fallback is written too');

    // No Issabel dialplan yet (fresh install): the sync must not fail.
    const custom2 = path.join(dir, 'extensions_custom2.conf');
    fs.writeFileSync(custom2, '[from-internal-custom]\n', 'utf8');
    const missing = await syncFeatureCodeHandOff(pool, {
        filePath: custom2,
        issabelDialplanFile: path.join(dir, 'does-not-exist.conf')
    });
    assert.deepEqual(missing.argumentCodes, [], 'no argument forms without Issabel\'s dialplan');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('deployed dialplan hands Issabel feature codes back to Issabel', (t) => {
    if (!fs.existsSync(DIALPLAN)) {
        t.skip('extensions_custom.conf not present on this host');
        return;
    }
    const content = fs.readFileSync(DIALPLAN, 'utf8');
    const ctxStart = content.indexOf('[from-internal-custom]');
    assert.ok(ctxStart >= 0, 'extensions_custom.conf has [from-internal-custom]');
    const ctxEnd = content.indexOf('\n[', ctxStart + 1);
    const ctx = content.slice(ctxStart, ctxEnd > 0 ? ctxEnd : content.length);

    assert.ok(ctx.includes(BEGIN_MARK), 'generated hand-off block is inside [from-internal-custom]');
    for (const code of ['*97', '*72', '*78', '*99']) {
        assert.ok(
            ctx.includes(`exten => ${code},1,Goto(from-internal-additional,\${EXTEN},1)`),
            `${code} is declared as a literal so it wins over the pickup pattern`
        );
    }
    assert.ok(ctx.includes('exten => _*X.,1,NoOp(--- Directed / Ring Group Pickup'), 'Sokrat pickup pattern still present');
    assert.ok(ctx.includes('exten => _*98.,1,NoOp('), '*98<mailbox> is declared so it wins over the pickup pattern');
    assert.ok(ctx.includes('sokrat-pickup-target'), 'the directed-pickup fallback for the argument forms is present');

    if (ctx.includes('Sokrat open voicemail')) {
        assert.ok(ctx.includes('VoiceMailMain(${MAILBOX}@${VMCONTEXT},s)'), 'open *98 skips the passcode');
        assert.ok(ctx.includes('VoiceMailMain(${EXTEN:3}@${VMCONTEXT},s)'), 'open *98<mailbox> skips the passcode');
        assert.ok(!ctx.includes('exten => *98,1,Goto(from-internal-additional'), 'open *98 is not handed to Issabel');
    } else {
        assert.ok(
            ctx.includes('exten => *98,1,Goto(from-internal-additional,${EXTEN},1)'),
            '*98 is handed to Issabel when open access is off'
        );
    }
});

test('installers and safe-upgrade keep the feature-code hand-off in sync', () => {
    const targets = [
        ['install.sh', 'install.sh'],
        ['installer-bundle/install-sokrat.sh', 'installer-bundle/install-sokrat.sh'],
        ['scripts/safe-upgrade.sh', 'scripts/safe-upgrade.sh']
    ];
    for (const [label, rel] of targets) {
        const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
        assert.ok(content.includes('lib/feature-code-hand-off.js'), `${label} runs the feature-code hand-off sync`);
    }
});

test('server.js runs the feature-code hand-off on boot', () => {
    const serverCode = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    assert.ok(serverCode.includes("require('./lib/feature-code-hand-off')"), 'server.js requires the module');
    assert.ok(serverCode.includes('await syncFeatureCodeHandOff(pool)'), 'server.js syncs the hand-off on boot');
});
