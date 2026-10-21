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
    buildFeatureCodeBlock,
    patchExtensionsCustomConf,
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
