'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const jb = require('../lib/jitter-buffer');

function extractAsyncFunction(name) {
    const declaration = source.match(new RegExp('^async function ' + name + '\\([\\s\\S]*?^}', 'm'));
    assert.ok(declaration, 'Missing server function: ' + name);
    return declaration[0];
}

function response() {
    return {
        code: 200,
        body: null,
        status(code) { this.code = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('jitter-buffer validation, exact Asterisk values, and AstDB key semantics', () => {
    assert.deepEqual(jb.normalizeJitterBuffer({}), {
        mode: 'inherit', maxMs: 200, resyncMs: 1000, targetExtraMs: 40
    });
    assert.equal(jb.buildJitterBufferSet({ mode: 'adaptive', maxMs: 400, resyncMs: 2000, targetExtraMs: 80 }),
        'Set(JITTERBUFFER(adaptive)=400,2000,80)');
    assert.equal(jb.buildJitterBufferSet({ mode: 'fixed', maxMs: 400, resyncMs: 2000, targetExtraMs: 80 }),
        'Set(JITTERBUFFER(fixed)=400,2000)');
    assert.equal(jb.buildJitterBufferSet({ mode: 'off', maxMs: 400, resyncMs: 2000, targetExtraMs: 80 }), null);
    assert.equal(jb.buildJitterBufferSet({ mode: 'inherit' }), null);

    assert.deepEqual(jb.normalizeJitterBuffer({
        jbMode: 'adaptive', jbMaxMs: '400', jbResyncMs: '2000', jbTargetExtraMs: '80'
    }), { mode: 'adaptive', maxMs: 400, resyncMs: 2000, targetExtraMs: 80 });

    for (const payload of [
        { jb_mode: 'surround' },
        { jb_max_ms: 19 },
        { jb_max_ms: 1001 },
        { jb_resync_ms: 99 },
        { jb_resync_ms: 5001 },
        { jb_target_extra_ms: -1 },
        { jb_target_extra_ms: 201 },
        { jb_max_ms: 200.5 },
        { jb_max_ms: 'lots' },
        { jb_max_ms: true }
    ]) {
        assert.throws(() => jb.normalizeJitterBuffer(payload), /must be|jb_mode/);
    }

    assert.deepEqual(jb.astdbCommandsForJitterBuffer('102', { mode: 'inherit' }), [
        'database del AMPUSER 102/jb_mode',
        'database del AMPUSER 102/jb_max_ms',
        'database del AMPUSER 102/jb_resync_ms',
        'database del AMPUSER 102/jb_target_extra_ms'
    ]);
    assert.deepEqual(jb.effectiveJitterBufferFields({ mode: 'off', maxMs: 400, resyncMs: 2000, targetExtraMs: 80 }), {
        jb_mode: 'off', jb_max_ms: 400, jb_resync_ms: 2000, jb_target_extra_ms: 80
    });
});

test('AstDB parser defaults a legacy extension to inherit without writing keys', () => {
    const map = jb.parseAmpuserJitterBufferMap('/AMPUSER/102/jb_mode: adaptive\n/AMPUSER/102/jb_max_ms: 400\n/AMPUSER/102/jb_resync_ms: 2000\n/AMPUSER/102/jb_target_extra_ms: 80\n/AMPUSER/103/ai_denoise: off');
    assert.deepEqual(map['102'], { mode: 'adaptive', maxMs: 400, resyncMs: 2000, targetExtraMs: 80 });
    assert.deepEqual(jb.getJitterBufferFromAstdbMap(map, '999'), {
        mode: 'inherit', maxMs: 200, resyncMs: 1000, targetExtraMs: 40
    });
});

test('extension-list API reports jitter fields from AstDB', async () => {
    const routeMatch = source.match(/^app\.get\('\/api\/config\/extensions',[\s\S]*?^}\);$/m);
    assert.ok(routeMatch, 'Missing GET /api/config/extensions route');
    const routes = {};
    const context = vm.createContext({
        app: { get: (url, ...handlers) => { routes[url] = handlers[handlers.length - 1]; } },
        pool: {
            query: async () => [[{
                extension: '102', name: 'Demo', tech: 'pjsip', voicemail: 'novm',
                secret: 'fixture', context: 'from-internal', nat: 'yes',
                photo: null, title: null, emp_group: null, is_group_admin: 0,
                auto_answer: 'user_choice', dnd: 'user_choice', disable_outbound_ringing_cancel: 0
            }]]
        },
        execPromise: async () => ({
            stdout: '/AMPUSER/102/jb_mode: fixed\n/AMPUSER/102/jb_max_ms: 300\n/AMPUSER/102/jb_resync_ms: 1500\n/AMPUSER/102/jb_target_extra_ms: 50\n'
        }),
        tables: { users: 'users', devices: 'devices', sip: 'sip', employeeExtras: 'employee_extras' },
        ASTERISK_BIN: '/fixture/asterisk',
        requireConfigPermission: () => (req, res, next) => next(),
        ...jb,
        console: { error: () => {} }
    });
    vm.runInContext(routeMatch[0], context);
    const res = response();
    await routes['/api/config/extensions']({}, res);
    assert.equal(res.code, 200);
    const ext = res.body.extensions[0];
    assert.equal(ext.jb_mode, 'fixed');
    assert.equal(ext.jb_max_ms, 300);
    assert.equal(ext.jb_resync_ms, 1500);
    assert.equal(ext.jb_target_extra_ms, 50);
});

test('AstDB writes update explicit modes and clear all keys for inherit', async () => {
    const commands = [];
    let showOutput = '';
    const context = vm.createContext({
        ASTERISK_BIN: '/fixture/asterisk',
        execFileAsync: async (_file, args) => {
            const command = args[1];
            if (command.startsWith('database show')) return showOutput;
            commands.push(command);
            return '';
        },
        ...jb,
        console: { error: () => {} }
    });
    for (const name of ['readExtensionJitterBuffer', 'applyExtensionJitterBuffer']) {
        vm.runInContext(extractAsyncFunction(name), context);
    }

    showOutput = '/AMPUSER/102/jb_mode: adaptive\n/AMPUSER/102/jb_max_ms: 400\n/AMPUSER/102/jb_resync_ms: 2000\n/AMPUSER/102/jb_target_extra_ms: 80\n';
    const inherited = await context.applyExtensionJitterBuffer('102', { jb_mode: 'inherit' }, await context.readExtensionJitterBuffer('102'));
    assert.equal(inherited.jb_mode, 'inherit');
    assert.deepEqual(commands.slice(-4), [
        'database del AMPUSER 102/jb_mode',
        'database del AMPUSER 102/jb_max_ms',
        'database del AMPUSER 102/jb_resync_ms',
        'database del AMPUSER 102/jb_target_extra_ms'
    ]);

    commands.length = 0;
    const adaptive = await context.applyExtensionJitterBuffer('102', {
        jb_mode: 'adaptive', jb_max_ms: 400, jb_resync_ms: 2000, jb_target_extra_ms: 80
    });
    assert.deepEqual(adaptive, { jb_mode: 'adaptive', jb_max_ms: 400, jb_resync_ms: 2000, jb_target_extra_ms: 80 });
    assert.deepEqual(commands, [
        'database put AMPUSER 102/jb_mode adaptive',
        'database put AMPUSER 102/jb_max_ms 400',
        'database put AMPUSER 102/jb_resync_ms 2000',
        'database put AMPUSER 102/jb_target_extra_ms 80'
    ]);

    commands.length = 0;
    const fixed = await context.applyExtensionJitterBuffer('102', {
        jb_mode: 'fixed', jb_max_ms: 250, jb_resync_ms: 1200, jb_target_extra_ms: 99
    });
    assert.equal(fixed.jb_mode, 'fixed');
    assert.deepEqual(commands, [
        'database put AMPUSER 102/jb_mode fixed',
        'database put AMPUSER 102/jb_max_ms 250',
        'database put AMPUSER 102/jb_resync_ms 1200',
        'database put AMPUSER 102/jb_target_extra_ms 99'
    ]);

    commands.length = 0;
    const off = await context.applyExtensionJitterBuffer('102', { jb_mode: 'off' });
    assert.equal(off.jb_mode, 'off');
    assert.equal(commands[0], 'database put AMPUSER 102/jb_mode off');
    assert.equal(commands.length, 4);

    await assert.rejects(() => context.applyExtensionJitterBuffer('102', { jb_mode: 'bogus' }), /jb_mode/);
});

test('PUT extension route validates jitter mode before writes and persists adaptive/off', async () => {
    const routeMatch = source.match(/^app\.put\('\/api\/config\/extensions\/:extension',[\s\S]*?^}\);$/m);
    assert.ok(routeMatch, 'Missing PUT /api/config/extensions/:extension route');
    const commands = [];
    const sqlWrites = [];
    const routes = {};
    const context = vm.createContext({
        app: { put: (url, handler) => { routes[url] = handler; } },
        pool: {
            query: async (sql) => {
                if (sql.includes('SELECT tech')) return [[{ tech: 'sip' }]];
                if (sql.includes('SELECT voicemail')) return [[{ voicemail: 'novm', recording: 'out=always|in=always' }]];
                if (sql.includes('SELECT is_group_admin')) return [[{ is_group_admin: 0 }]];
                if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) sqlWrites.push(sql.trim().split(/\s+/)[0]);
                return [[]];
            }
        },
        execFileAsync: async (_file, args) => {
            const command = args[1];
            if (command.startsWith('database show')) {
                return '/AMPUSER/102/jb_mode: adaptive\n/AMPUSER/102/jb_max_ms: 400\n/AMPUSER/102/jb_resync_ms: 2000\n/AMPUSER/102/jb_target_extra_ms: 80\n';
            }
            commands.push(command);
            return '';
        },
        execPromise: async () => ({ stdout: '' }),
        exec: () => {},
        ASTERISK_BIN: '/fixture/asterisk',
        tables: { employeeExtras: 'employee_extras' },
        WEBRTC_SIP_OPTIONS: [], WEBRTC_SIP_OPTION_KEYS: [],
        agentStatusService: { isPjsipTech: () => false },
        applyVoicemailState: () => {},
        updatePjsipCustomConfig: () => {},
        reloadPjsip: () => {},
        reloadPbxConfigPromise: async () => {},
        syncExtensionCallPickupGroups: async () => {},
        getCurrentPjsipSecret: async () => '',
        isSuperAdmin: () => true,
        io: { emit: () => {} },
        sipPresence: {}, pjsipPresence: {}, pendingOffline: {},
        ...jb,
        console: { error: () => {} }
    });
    for (const name of ['readExtensionJitterBuffer', 'applyExtensionJitterBuffer']) {
        vm.runInContext(extractAsyncFunction(name), context);
    }
    vm.runInContext(routeMatch[0], context);

    const res = response();
    await routes['/api/config/extensions/:extension']({
        params: { extension: '102' },
        body: { name: 'Demo', tech: 'sip', jb_mode: 'adaptive', jb_max_ms: 400, jb_resync_ms: 2000, jb_target_extra_ms: 80 }
    }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.jitter_buffer, {
        jb_mode: 'adaptive', jb_max_ms: 400, jb_resync_ms: 2000, jb_target_extra_ms: 80
    });
    assert.ok(commands.includes('database put AMPUSER 102/jb_mode adaptive'));
    assert.ok(commands.includes('database put AMPUSER 102/jb_max_ms 400'));

    commands.length = 0;
    sqlWrites.length = 0;
    const invalid = response();
    await routes['/api/config/extensions/:extension']({
        params: { extension: '102' },
        body: { name: 'Demo', jb_mode: 'bogus', jb_max_ms: 400 }
    }, invalid);
    assert.equal(invalid.code, 400, JSON.stringify(invalid.body));
    assert.deepEqual(commands, [], 'invalid mode must not touch AstDB');
    assert.deepEqual(sqlWrites, [], 'invalid mode must not update extension tables');
});

test('dialplan resolver disables off, honors exact explicit values, and inherit fallback', () => {
    const context = jb.renderSokratJbContext();
    assert.match(context, /\[sokrat-jb\]/);
    assert.match(context, /GotoIf\(\$\["\$\{JB_MODE\}" = "off"\]\?done\)/);
    assert.match(context, /Set\(JITTERBUFFER\(adaptive\)=\$\{JB_VALUE\}\)/);
    assert.match(context, /Set\(JITTERBUFFER\(fixed\)=\$\{JB_VALUE\}\)/);
    assert.match(context, /dialplan_jitterbuffer_enabled/);
    assert.match(context, /CHANNEL\(name\):0:5/);
    assert.match(context, /DB_EXISTS\(AMPUSER\/\$\{JB_EXT\}\/cidname\)/);
    assert.match(context, /DONGLE_AUDIO\/\$\{JB_DONGLE\}\/jb/);
    assert.match(context, /cellular_jitterbuffer/);
    assert.match(context, /Set\(JB_VALUE=\$\{JB_MAX\},\$\{JB_RESYNC\},\$\{JB_TARGET\}\)/);
    assert.equal(context.includes('JITTERBUFFER(adaptive)=off'), false);
});

test('managed global lines are stripped without touching per-extension or dongle receive lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-jb-'));
    const file = path.join(dir, 'extensions_custom.conf');
    const fixture = `[macro-dialout-trunk-predial-hook]
exten => s,1,NoOp(trunk)
same => n,Set(JITTERBUFFER(adaptive)=400,2000,80)
[macro-dialout-one-predial-hook]
exten => s,1,NoOp(one)
same => n,Set(JITTERBUFFER(fixed)=250)
[from-dongle-custom]
same => n,Set(DONGLE_TARGET=dongle0)
[sokrat-dongle0-jb]
same => n,Set(JITTERBUFFER(fixed)=200)
[sokrat-jb]
same => n,Set(JITTERBUFFER(adaptive)=\${JB_VALUE})
`;
    fs.writeFileSync(file, fixture);
    const cleaned = jb.stripManagedJitterBufferLines(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, cleaned);
    assert.equal(jb.managedJitterBufferPresence(cleaned)['macro-dialout-trunk-predial-hook'], false);
    assert.equal(jb.managedJitterBufferPresence(cleaned)['macro-dialout-one-predial-hook'], false);
    assert.match(cleaned, /\[sokrat-dongle0-jb\][\s\S]*JITTERBUFFER\(fixed\)=200/);
    assert.match(cleaned, /\[sokrat-jb\][\s\S]*JITTERBUFFER\(adaptive\)=\$\{JB_VALUE\}/);
    assert.equal(jb.isManagedJitterBufferLine('same => n,Set(JITTERBUFFER(adaptive)=400,2000,80)'), true);
    assert.equal(jb.stripManagedJitterBufferLines(cleaned), cleaned, 'stripping must be idempotent');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('installers and safe-upgrade install the same resolver and no raw global line', () => {
    for (const name of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const text = fs.readFileSync(path.join(root, name), 'utf8');
        assert.match(text, /\[sokrat-jb\]/, `${name} must install the resolver`);
        assert.equal(text.includes('same => n,Set(JITTERBUFFER(adaptive)=default)'), false, `${name} must not install a raw global line`);
        assert.match(text, /BEGIN SOKRAT PER-EXTENSION JITTER BUFFER CALLEE HOOK/, `${name} must install the callee hook`);
        assert.match(text, /func-apply-sipheaders/, `${name} must preserve the header hook`);
    }
    const wake = fs.readFileSync(path.join(root, 'scripts/install-webrtc-wake.py'), 'utf8');
    assert.match(wake, /Gosub\(sokrat-jb,s,1\(\$\{CALLERID\(num\)\}/, 'wake hook must resolve the caller leg');
    assert.doesNotMatch(wake, /DIAL_OPTIONS=.*sokrat-jb/, 'wake hook must not inject a second Dial b option');
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(server, /const \[family, key\] = SOKRAT_DIALPLAN_JB_MARKER\.split\('\/'\)/, 'global marker writes must use separate AstDB family/key');
});

test('extension modal exposes jitter controls with explicit ranges and help', () => {
    const page = fs.readFileSync(path.join(root, 'views/config.ejs'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'views/scripts/config-page.ejs'), 'utf8');
    assert.match(page, /id="extJbMode"/);
    assert.match(page, /id="extJbMax"[^>]*min="20"[^>]*max="1000"/);
    assert.match(page, /id="extJbResync"[^>]*min="100"[^>]*max="5000"/);
    assert.match(page, /id="extJbTarget"[^>]*min="0"[^>]*max="200"/);
    assert.match(client, /window\.updateJitterBufferUi/);
    assert.match(client, /jb_mode: document\.getElementById\('extJbMode'\)\.value/);
    assert.match(client, /jb_max_ms: parseInt/);
    assert.match(client, /Inherit follows the global policy|يرث السياسة/);
});
