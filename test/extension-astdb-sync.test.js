'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const agentStatusService = require('../lib/agent-status');

const root = path.resolve(__dirname, '..');
const container = process.env.SOKRAT_EXTENSION_TEST_DB;
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function sqlValue(value) {
    if (Array.isArray(value)) return value.map(sqlValue).join(', ');
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

function query(statement, parameters = []) {
    let index = 0;
    const sql = statement.replace(/\?/g, () => sqlValue(parameters[index++]));
    assert.equal(index, parameters.length, 'SQL parameter count');
    const result = spawnSync('docker', [
        'exec', '-i', container, 'mariadb', '--batch', '--raw', '--column-names', '-uroot',
    ], { input: sql + ';', encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, 'Isolated SQL execution failed');
    const lines = result.stdout.trimEnd().split('\n');
    if (!lines[0]) return [];
    const columns = lines.shift().split('\t');
    return lines.map(line => Object.fromEntries(line.split('\t').map((value, i) => [
        columns[i], value === 'NULL' ? null : columns[i] === 'is_group_admin' ? Number(value) : value,
    ])));
}

function verifyIsolation() {
    assert.match(container, /^sokrat-extension-conversion-test-[a-f0-9]+$/);
    const result = spawnSync('docker', ['inspect', container], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, 'Disposable test container must already be running');
    const [info] = JSON.parse(result.stdout);
    assert.equal(info.Config.Labels['io.sokrat.test'], 'extension-conversion');
    assert.equal(info.HostConfig.NetworkMode, 'none');
    assert.equal(Object.keys(info.HostConfig.PortBindings || {}).length, 0);
    assert.equal(info.Mounts.some(mount => mount.Type === 'bind'), false);
}

function setupSchema() {
    query(`CREATE DATABASE IF NOT EXISTS asterisk;
        CREATE TABLE IF NOT EXISTS asterisk.users (
            extension VARCHAR(64) PRIMARY KEY, name VARCHAR(100), password VARCHAR(100),
            voicemail VARCHAR(32), ringtimer INT, noanswer VARCHAR(32), recording VARCHAR(100),
            outboundcid VARCHAR(100), sipname VARCHAR(100), mohclass VARCHAR(100));
        CREATE TABLE IF NOT EXISTS asterisk.devices (
            id VARCHAR(64) PRIMARY KEY, tech VARCHAR(32), dial VARCHAR(100), devicetype VARCHAR(32),
            user VARCHAR(64), description VARCHAR(100), emergency_cid VARCHAR(100));
        CREATE TABLE IF NOT EXISTS asterisk.sip (
            id VARCHAR(64), keyword VARCHAR(64), data VARCHAR(255), flags INT, PRIMARY KEY (id, keyword));
        CREATE TABLE IF NOT EXISTS asterisk.employee_extras (
            extension VARCHAR(64) PRIMARY KEY, is_group_admin INT, photo VARCHAR(100),
            title VARCHAR(100), emp_group VARCHAR(100));
        CREATE TABLE IF NOT EXISTS asterisk.extension_policies (
            extension VARCHAR(64) PRIMARY KEY, auto_answer VARCHAR(32), dnd VARCHAR(32),
            disable_outbound_ringing_cancel INT, updated_at DATETIME);
        CREATE TABLE IF NOT EXISTS asterisk.queues_config (extension VARCHAR(64), descr VARCHAR(100));
        CREATE TABLE IF NOT EXISTS asterisk.ringgroups (grpnum VARCHAR(64), description VARCHAR(100));`);
}

async function startNativeFixture(t) {
    const binary = process.env.WAKE_ASTERISK_BIN;
    const child = spawn('python3', [
        path.join(__dirname, 'wake-routing-harness.py'), '--asterisk', binary, '--serve',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    const closed = new Promise(resolve => child.once('close', resolve));
    t.after(async () => {
        child.stdin.end();
        await closed;
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.once('close', () => child.stdout.resume());
    const info = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.stdin.end();
            lines.close();
            reject(new Error('Isolated Asterisk startup deadline exceeded'));
        }, 15_000);
        child.once('error', error => { clearTimeout(timer); lines.close(); reject(error); });
        child.once('exit', () => {
            clearTimeout(timer);
            lines.close();
            reject(new Error('Isolated Asterisk exited before readiness: ' + stderr));
        });
        lines.once('line', line => {
            clearTimeout(timer);
            lines.close();
            try { resolve(JSON.parse(line)); } catch (error) { child.stdin.end(); reject(error); }
        });
    });
    return {
        binary,
        run(args) {
            const result = spawnSync(binary, ['-C', info.config, ...args], { encoding: 'utf8', timeout: 10_000 });
            assert.equal(result.status, 0, 'Isolated Asterisk CLI failed');
            return result.stdout;
        },
    };
}

function fixture(native = null) {
    query(`TRUNCATE asterisk.users; TRUNCATE asterisk.devices; TRUNCATE asterisk.sip;
        TRUNCATE asterisk.employee_extras; TRUNCATE asterisk.extension_policies;`);
    const routes = new Map();
    const context = vm.createContext({
        pool: { query: async (...args) => [query(...args)] }, agentStatusService,
        app: {
            put: (url, ...handlers) => routes.set('PUT ' + url, handlers.at(-1)),
            get: (url, ...handlers) => routes.set('GET ' + url, handlers.at(-1)),
        },
        requireAuth: () => {}, isSuperAdmin: () => true,
        tables: { employeeExtras: '`asterisk`.`employee_extras`' },
        ASTERISK_BIN: native ? native.binary : '/fixture/asterisk',
        execFileAsync: async (_file, args) => native ? native.run(args) : undefined,
        execPromise: async () => {},
        applyVoicemailState: () => {}, updateVoicemailConf: () => {},
        updatePjsipCustomConfig: () => {}, reloadPjsip: () => {},
        // No CRM/mobile WebRTC lines in this fixture: keep the host's real
        // pjsip_custom.conf out of the result.
        hasWebrtcEndpoint: () => false,
        webrtcDeviceList: require('../lib/webrtc-dial').deviceList,
        webrtcDeviceCommands: require('../lib/webrtc-dial').webrtcDeviceCommands,
        syncWebrtcLineDevices: async () => [],
        reloadPbxConfigPromise: async () => {}, syncExtensionCallPickupGroups: async () => {},
        io: { emit: () => {} }, sipPresence: {}, pjsipPresence: {}, pendingOffline: {},
    });
    // Load only the actual route/provisioning code, never server startup or
    // provider/file writers. Native commands can reach only the owned fixture.
    for (const name of ['WEBRTC_SIP_OPTIONS', 'WEBRTC_SIP_OPTION_KEYS']) {
        const declaration = source.match(new RegExp('^const ' + name + ' = [\\s\\S]*?;', 'm'));
        if (declaration) vm.runInContext(declaration[0], context);
    }
    for (const name of ['checkNumberCollision', 'setExtensionAstdbDefaults', 'getCurrentPjsipSecret', 'provisionExtension']) {
        const declaration = source.match(new RegExp('^async function ' + name + '\\([\\s\\S]*?^}', 'm'));
        assert.ok(declaration, 'Missing fixture function: ' + name);
        vm.runInContext(declaration[0], context);
    }
    for (const [method, url] of [['put', '/api/config/extensions/:extension'], ['get', '/api/extension-policies']]) {
        const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const route = source.match(new RegExp("^app\\." + method + "\\('" + escaped + "',[\\s\\S]*?^}\\);", 'm'));
        assert.ok(route, 'Missing fixture route: ' + url);
        vm.runInContext(route[0], context);
    }
    function response() {
        return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    }
    return {
        async create(extension, tech) {
            await context.provisionExtension({ extension, name: 'Fixture ' + extension, secret: 'fixture-only', tech }, {
                reload: false, reloadPjsip: false, reloadVoicemail: false,
            });
        },
        async edit(extension, body) {
            const res = response();
            await routes.get('PUT /api/config/extensions/:extension')({ params: { extension }, body }, res);
            assert.equal(res.code, 200, JSON.stringify(res.body));
            assert.equal(res.body.success, true);
        },
        async policies() {
            const res = response();
            await routes.get('GET /api/extension-policies')({}, res);
            assert.equal(res.code, 200);
            return Array.from(res.body.policies, row => row.extension);
        },
    };
}

function metadata(extension) {
    return Object.fromEntries(query('SELECT keyword, data FROM asterisk.sip WHERE id = ? ORDER BY keyword', [extension])
        .map(row => [row.keyword, row.data]));
}

function device(extension) {
    return query('SELECT tech, dial FROM asterisk.devices WHERE id = ?', [extension])[0];
}

function expectWebRtc(extension) {
    assert.deepEqual(device(extension), { tech: 'pjsip', dial: 'PJSIP/' + extension });
    const data = metadata(extension);
    assert.equal(data.webrtc, 'yes');
    assert.equal(data.transport, 'transport-wss');
    assert.equal(data.media_encryption, 'dtls');
    assert.equal(data.rtp_timeout, '360');
    assert.equal(data.rtp_timeout_hold, '60');
    assert.equal(data.rtp_keepalive, '5');
}

test('extension driver edits preserve and clean metadata on isolated MariaDB', {
    skip: container ? false : 'Set SOKRAT_EXTENSION_TEST_DB to an explicitly labeled disposable MariaDB fixture',
}, async t => {
    verifyIsolation();
    setupSchema();

    await t.test('omitting technology preserves a legacy WebRTC account', async () => {
        const api = fixture();
        await api.create('150', 'webrtc');
        query("UPDATE asterisk.devices SET tech = 'webrtc' WHERE id = '150'");
        await api.edit('150', { name: 'Renamed legacy account' });
        expectWebRtc('150');
        assert.deepEqual(await api.policies(), ['150']);
    });

    await t.test('WebRTC to SIP removes only managed options for the converted extension', async () => {
        const api = fixture();
        await api.create('150', 'webrtc');
        await api.create('5072', 'webrtc');
        await api.create('2401', 'sip');
        const plainSip = metadata('2401');
        const managedKeys = Object.keys(metadata('150')).filter(key => !(key in plainSip));
        const sibling = metadata('5072');
        query("INSERT INTO asterisk.sip VALUES ('150', 'operator_option', 'keep', 0), ('150', 'rtptimeout', '360', 0)");
        const before = metadata('150');
        await api.edit('150', { tech: 'sip' });
        assert.deepEqual(device('150'), { tech: 'sip', dial: 'SIP/150' });
        const after = metadata('150');
        for (const key of managedKeys) assert.equal(Object.hasOwn(after, key), false, 'Stale WebRTC option: ' + key);
        assert.equal(after.transport, 'udp');
        for (const key of ['secret', 'context', 'operator_option', 'rtptimeout']) assert.equal(after[key], before[key], key);
        assert.deepEqual(metadata('5072'), sibling);
        assert.deepEqual(await api.policies(), ['5072']);
    });

    await t.test('an unrelated SIP edit preserves existing chan_sip WebRTC and custom metadata', async () => {
        const api = fixture();
        await api.create('2401', 'sip');
        query("INSERT INTO asterisk.sip VALUES ('2401', 'webrtc', 'yes', 18), ('2401', 'dtlsenable', 'yes', 0)");
        await api.edit('2401', { name: 'Renamed SIP account' });
        assert.deepEqual(device('2401'), { tech: 'sip', dial: 'SIP/2401' });
        assert.equal(metadata('2401').webrtc, 'yes');
        assert.equal(metadata('2401').dtlsenable, 'yes');
    });

    await t.test('SIP to WebRTC establishes media metadata without dropping user settings', async () => {
        const api = fixture();
        await api.create('2401', 'sip');
        query("INSERT INTO asterisk.sip VALUES ('2401', 'operator_option', 'keep', 0)");
        const before = metadata('2401');
        await api.edit('2401', { tech: 'webrtc' });
        expectWebRtc('2401');
        assert.equal(metadata('2401').operator_option, 'keep');
        assert.equal(metadata('2401').secret, before.secret);
    });

    await t.test('a PJSIP SIP PJSIP round trip restores eligibility and timeout policy', async () => {
        const api = fixture();
        await api.create('0150', 'pjsip');
        await api.edit('0150', { tech: 'sip' });
        assert.deepEqual(await api.policies(), []);
        await api.edit('0150', { tech: 'pjsip' });
        expectWebRtc('0150');
        assert.deepEqual(await api.policies(), ['0150']);
        await api.edit('0150', { name: 'Renamed PJSIP account' });
        expectWebRtc('0150');
    });

    await t.test('conversions keep real AstDB routing targets synchronized', {
        skip: !process.env.WAKE_ASTERISK_BIN,
    }, async nativeTest => {
        const native = await startNativeFixture(nativeTest);
        const api = fixture(native);
        function expectNativeRoute(tech, dial) {
            for (const [key, expected] of [['tech', tech], ['dial', dial]]) {
                const output = native.run(['-rx', 'database get DEVICE/6200 ' + key]);
                const value = output.match(/^Value:\s*(.*)$/m);
                assert.ok(value, 'Missing private AstDB routing state: ' + key);
                assert.equal(value[1].trim(), expected);
            }
        }
        await api.create('6200', 'sip');
        expectNativeRoute('sip', 'SIP/6200');
        await api.edit('6200', { tech: 'webrtc' });
        expectWebRtc('6200');
        expectNativeRoute('pjsip', 'PJSIP/6200');
        await api.edit('6200', { tech: 'sip' });
        assert.deepEqual(device('6200'), { tech: 'sip', dial: 'SIP/6200' });
        expectNativeRoute('sip', 'SIP/6200');
    });
});
