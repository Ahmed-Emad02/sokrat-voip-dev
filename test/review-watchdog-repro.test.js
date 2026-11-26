'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { readDongleSections, recoveryEligible, createDongleRuntime } = require('../lib/dongle-recovery');
const { readLifecyclePolicy, autonomousRecoveryAllowed } = require('../lib/dongle-lifecycle-policy');

const root = path.resolve(__dirname, '..');
const CONFIG = '[general]\ninterval=15\n[defaults]\ncontext=from-dongle-custom\n\n[dongle0]\nimei=123456789012345\nimsi=111111111111111\naudio=/dev/ttyUSB1\ndata=/dev/ttyUSB2\n\n[dongle1]\nimei=987654321098765\nimsi=222222222222222\naudio=/dev/ttyUSB4\ndata=/dev/ttyUSB5\n';
const healthy = state => /^(free|ready|registered|idle)\b/i.test(String(state || ''));
const inCall = state => /outgoing|incoming|active|dialing|ring|waiting|held|busy/i.test(String(state || ''));
const MANUAL = { mode: 'manual', autonomousRecovery: false, maxRecoveryAttempts: 3, backoffBaseMs: 60000, backoffMaxMs: 1800000, recoveryPauseMs: 1800000 };
const AUTONOMOUS = { mode: 'autonomous', autonomousRecovery: true, maxRecoveryAttempts: 3, backoffBaseMs: 60000, backoffMaxMs: 1800000, recoveryPauseMs: 1800000 };

function stateOutput(slot, state, overrides = {}) {
    return Object.entries({
        Device: slot, State: state, 'Current device state': state === 'Stopped' ? 'stop' : 'start',
        'Desired device state': state === 'Stopped' ? 'stop' : 'start',
        'Calls/Channels': 0, Active: 0, Held: 0, Dialing: 0, Alerting: 0,
        Incoming: 0, Waiting: 0, Releasing: 0, Initializing: 0,
        'Tasks in queue': 0, 'Commands in queue': 0, ...overrides
    }).map(([key, value]) => `  ${key} : ${value}`).join('\n');
}

function fixture(t, { policy = MANUAL, content = CONFIG } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dongle-recovery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'dongle.conf');
    fs.writeFileSync(configPath, content);
    const f = {
        configPath, commands: [], audit: [], usb: [], time: 0, policy,
        states: new Map([['dongle0', 'Not connected'], ['dongle1', 'Free']]),
        details: new Map(), channels: '0 active channels\n0 active calls\n',
        beforeCommand: null, commandResult: null, inventoryError: false,
        mutations: () => f.commands.filter(command => !/^(core show|dongle show)/.test(command)),
        async tick(ms = 0) {
            f.time += ms;
            await f.runtime.watchdog(new Map(f.states));
        }
    };
    f.run = async command => {
        f.commands.push(command);
        if (f.beforeCommand) await f.beforeCommand(command);
        if (f.commandResult) {
            const result = f.commandResult(command);
            if (result !== undefined) return result;
        }
        if (command === 'core show channels') return f.channels;
        const detail = /^dongle show device state (dongle\d+)$/.exec(command);
        if (detail) return f.details.get(detail[1]) ?? stateOutput(detail[1], f.states.get(detail[1]));
        const stop = /^dongle stop (?:now|gracefully) (dongle\d+)$/.exec(command);
        if (stop) {
            f.states.set(stop[1], 'Stopped');
            f.details.delete(stop[1]);
            return `[${stop[1]}] Stop scheduled\n`;
        }
        const restart = /^dongle restart gracefully (dongle\d+)$/.exec(command);
        if (restart) return `[${restart[1]}] Restart scheduled\n`;
        if (command === 'module reload chan_dongle.so') return "Module 'chan_dongle.so' reloaded successfully.\n";
        throw new Error(`Unexpected fake CLI command: ${command}`);
    };
    f.runtime = createDongleRuntime({
        configPath, run: f.run,
        readStates: async () => {
            if (f.inventoryError) throw new Error('Inventory unavailable');
            return new Map(f.states);
        },
        isHealthy: healthy, isCallState: inCall, now: () => f.time,
        audit: entry => f.audit.push(entry),
        usbTarget: slot => ({ device: `/fake/usb/${slot}` }),
        usbRebind: async device => { f.usb.push(device); return 'fake-rebind'; },
        lifecyclePolicy: () => f.policy
    });
    return f;
}

test('manual lifecycle policy is the persisted default and blocks every autonomous mutation', async t => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-policy-')), 'absent.json');
    t.after(() => fs.rmSync(path.dirname(missing), { recursive: true, force: true }));
    const policy = readLifecyclePolicy(missing);
    assert.equal(policy.mode, 'manual');
    assert.equal(policy.autonomousRecovery, false);
    assert.equal(autonomousRecoveryAllowed(policy), false);

    const f = fixture(t, { policy: MANUAL });
    await f.tick();
    await f.tick(90001);
    await f.tick(120001);
    await f.tick(180001);
    assert.deepEqual(f.mutations(), []);
    assert.deepEqual(f.usb, []);
    assert.ok(f.audit.some(entry => entry.phase === 'observation_only'));

    // Healthy call control remains untouched.
    for (let i = 0; i < 10; i += 1) {
        f.states.set('dongle0', 'Active');
        await f.tick(120000);
        f.states.set('dongle0', 'Free');
        await f.tick(120000);
    }
    assert.deepEqual(f.mutations(), []);
    assert.deepEqual(f.usb, []);
});

test('opt-in recovery is bounded, backs off on rejection and reaches a stop state', async t => {
    const f = fixture(t, { policy: AUTONOMOUS });
    f.commandResult = command => command.startsWith('dongle restart') ? '[dongle0] Restart failed\n' : undefined;
    await f.tick();
    await f.tick(90001);
    assert.equal(f.mutations().length, 1);
    // The 3-second scheduler ticks must not retry immediately: the failure is
    // followed by a monotonic backoff rather than five calls in 12 seconds.
    for (let i = 0; i < 4; i += 1) await f.tick(3000);
    assert.equal(f.mutations().length, 1);
    assert.ok(f.audit.some(entry => entry.phase === 'failed' && entry.retryInMs >= 60000));
    // Past the first backoff a second attempt is allowed, then backoff grows.
    await f.tick(60001);
    assert.equal(f.mutations().length, 2);
    await f.tick(120001);
    assert.equal(f.mutations().length, 3);
    assert.equal(f.audit.some(entry => entry.phase === 'stopped'), true);
    // Once stopped, no further autonomous attempt is made.
    for (let i = 0; i < 5; i += 1) await f.tick(300000);
    assert.equal(f.mutations().length, 3);
    assert.deepEqual(f.usb, []);
});

test('revoking autonomous policy during a safety query prevents the pending restart', async t => {
    const f = fixture(t, { policy: AUTONOMOUS });
    await f.tick();
    f.beforeCommand = async command => {
        if (command.startsWith('dongle show device state')) f.policy = MANUAL;
    };
    await f.tick(90001);
    assert.deepEqual(f.mutations(), []);
    assert.deepEqual(f.usb, []);
});

test('opt-in recovery still restarts and rebinds a configured unhealthy slot', async t => {
    const f = fixture(t, { policy: AUTONOMOUS });
    f.states.delete('dongle0');
    await f.tick();
    await f.tick(90001);
    assert.deepEqual(f.mutations(), ['dongle restart gracefully dongle0']);
    await f.tick(120001);
    assert.deepEqual(f.usb, ['/fake/usb/dongle0']);
    assert.equal(f.audit.filter(entry => entry.phase === 'restart').length, 1);
});

test('production scheduleAutoAdopt refuses autonomous config sync under the manual policy', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const start = server.indexOf('function scheduleAutoAdopt(trigger, options = {}) {');
    assert.ok(start >= 0, 'scheduleAutoAdopt anchor must exist');
    const end = server.indexOf("app.get('/api/gsm-dongles/provision/auto'", start);
    assert.ok(end > start, 'scheduleAutoAdopt end anchor must exist');
    const body = server.slice(start, end);
    function evaluate(policy, revoke = false) {
        let adopted = 0;
        let timer;
        const context = {
            readLifecyclePolicy: () => policy,
            autonomousRecoveryAllowed,
            readAutoAdoptConfig: () => ({ enabled: true, settleSeconds: 1 }),
            nextFireAt: ({ now }) => ({ fireAt: now + 1, deadlineAt: now + 10000 }),
            usbEnumerationPending: () => false,
            listSerialByPathLinks: () => [],
            adoptDiscoveredDongles: async () => { adopted += 1; },
            console: { log() {} },
            setTimeout: fn => { timer = fn; return { unref() {} }; },
            clearTimeout: () => {},
            Date, Math
        };
        const value = vm.runInNewContext(`let autoAdoptTimer=null, autoAdoptFireAt=0, autoAdoptDeadline=0;
const AUTO_ADOPT_CAP_MS=15000, AUTO_ADOPT_QUIET_MS=1200;
${body}
scheduleAutoAdopt('hotplug');`, context);
        if (revoke) {
            policy = MANUAL;
            timer();
        }
        return { scheduled: value, adopted };
    }
    assert.equal(evaluate(MANUAL).scheduled, null);
    assert.ok(evaluate(AUTONOMOUS).scheduled);
    assert.equal(evaluate(AUTONOMOUS, true).adopted, 0);
});

test('the independent system watchdog also refuses autonomous Asterisk restarts under the manual policy', async () => {
    const script = fs.readFileSync(path.join(root, 'scripts', 'system-watchdog.js'), 'utf8');
    assert.ok(fs.existsSync(path.join(root, 'lib', 'dongle-lifecycle-policy.js')), 'shared policy module must exist');
    assert.match(script, /require\('\.\.\/lib\/dongle-lifecycle-policy'\)/, 'system watchdog must load the shared policy module');
    const start = script.indexOf('async function attemptServiceRestart(unitName) {');
    assert.ok(start >= 0, 'attemptServiceRestart anchor must exist');
    const end = script.indexOf('\nasync function sendTelegramAlert', start);
    assert.ok(end > start, 'attemptServiceRestart end anchor must exist');
    const body = script.slice(start, end);
    async function invoke(policy, unit, missing = false) {
        const commands = [];
        const context = {
            lifecyclePolicy: missing ? null : { readLifecyclePolicy: () => policy, autonomousRecoveryAllowed },
            exec: (command, options, callback) => { commands.push(command); callback(null); },
            execSync: () => 'active\n',
            setTimeout: fn => fn(),
            Promise
        };
        const fn = vm.runInNewContext(`${body}\nattemptServiceRestart;`, context);
        const result = await fn(unit);
        return { result, commands };
    }
    assert.equal((await invoke(MANUAL, 'asterisk.service')).result.skipped, true);
    assert.deepEqual((await invoke(MANUAL, 'asterisk.service')).commands, []);
    assert.deepEqual((await invoke(MANUAL, 'sokrat-voip.service')).commands, ['systemctl restart sokrat-voip.service']);
    assert.deepEqual((await invoke(AUTONOMOUS, 'asterisk.service')).commands, ['systemctl restart asterisk.service']);
    assert.equal((await invoke(AUTONOMOUS, 'asterisk.service', true)).result.skipped, true);
    assert.deepEqual((await invoke(AUTONOMOUS, 'asterisk.service', true)).commands, []);
});

test('Laya reads the same persisted policy, stays observational by default and honors opt-in', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-policy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const policyFile = path.join(dir, 'policy.json');
    const python = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(root)})
from laya.lifecycle_policy import read_lifecycle_policy, autonomous_recovery_allowed
p = read_lifecycle_policy()
assert p['mode'] == ${JSON.stringify('manual')}, p
assert autonomous_recovery_allowed(p) is False
from laya.engine import LayaEngine
engine = LayaEngine()
r = engine.execute_scheduled_dongle_restarts(explicit=False)
assert r.get('skipped') is True and 'manual' in r.get('reason',''), r
print('ok')
`;
    const manual = spawnSync('python3', ['-c', python], {
        encoding: 'utf8', env: { ...process.env, SOKRAT_DONGLE_LIFECYCLE_POLICY: policyFile }
    });
    assert.equal(manual.status, 0, manual.stderr);

    fs.writeFileSync(policyFile, JSON.stringify({ ...AUTONOMOUS }));
    const optIn = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, ${JSON.stringify(root)})
from laya.lifecycle_policy import read_lifecycle_policy, autonomous_recovery_allowed
p = read_lifecycle_policy()
assert p['mode'] == 'autonomous' and autonomous_recovery_allowed(p) is True, p
print('ok')
`], { encoding: 'utf8', env: { ...process.env, SOKRAT_DONGLE_LIFECYCLE_POLICY: policyFile } });
    assert.equal(optIn.status, 0, optIn.stderr);
});

test('Laya recovery ladder bounds attempts and exposes a stop state', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-ladder-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const policyFile = path.join(dir, 'policy.json');
    fs.writeFileSync(policyFile, JSON.stringify({ ...AUTONOMOUS, maxRecoveryAttempts: 2 }));
    const python = `
import sys, time
sys.path.insert(0, ${JSON.stringify(root)})
import laya.healer.ladder as L
from laya.healer.ladder import RecoveryLadder
from laya.evaluator.heuristics import ANOMALY_CARRIER_DROP
L.is_call_active_on_dongle = lambda d: False
L.action_soft_at_probe = lambda d, reason: (True, 'ok')
ladder = RecoveryLadder()
ladder._cfun_allowed = lambda: False
actions = []
for _ in range(8):
    rec = ladder.get_dongle_history('dongle0')
    rec['last_action_time'] = time.time() - 10000
    name, level, ok, detail = ladder.attempt_recovery('dongle0', ANOMALY_CARRIER_DROP, 'test', {})
    actions.append(name)
assert any('Stopped' in name for name in actions), actions
print('ok')
`;
    const res = spawnSync('python3', ['-c', python], {
        encoding: 'utf8', env: { ...process.env, SOKRAT_DONGLE_LIFECYCLE_POLICY: policyFile }
    });
    assert.equal(res.status, 0, res.stderr);
});


test('Laya ladder enforces manual mode even when called without the watch-cycle gate', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-direct-policy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(root)})
import laya.healer.ladder as L
from laya.evaluator.heuristics import ANOMALY_MODEM_DEADLOCK
def forbidden(*args, **kwargs):
    raise AssertionError('manual policy reached an action or hardware probe')
L.is_call_active_on_dongle = forbidden
L.action_restart_dongle = forbidden
L.action_sysfs_usb_reset = forbidden
name, level, ok, detail = L.RecoveryLadder().attempt_recovery('dongle0', ANOMALY_MODEM_DEADLOCK, 'test', {})
assert 'Observation Only' in name and level == 0 and not ok
`;
    const result = spawnSync('python3', ['-c', script], { encoding: 'utf8',
        env: { ...process.env, SOKRAT_DONGLE_LIFECYCLE_POLICY: path.join(dir, 'missing.json') } });
    assert.equal(result.status, 0, result.stderr);
});
