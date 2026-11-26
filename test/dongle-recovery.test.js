'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const provisioning = require('../lib/dongle-provisioning');
const { readDongleSections, slotIntentionallyDisabled, recoveryEligible, createDongleRuntime } = require('../lib/dongle-recovery');

const CONFIG = '[general]\ninterval=15\n[defaults]\ncontext=from-dongle-custom\n\n[dongle0]\nimei=123456789012345\nimsi=111111111111111\naudio=/dev/ttyUSB1\ndata=/dev/ttyUSB2\n\n[dongle1]\nimei=987654321098765\nimsi=222222222222222\naudio=/dev/ttyUSB4\ndata=/dev/ttyUSB5\n';
const healthy = state => /^(free|ready|registered|idle)\b/i.test(String(state || ''));
const inCall = state => /outgoing|incoming|active|dialing|ring|waiting|held|busy/i.test(String(state || ''));
// Recovery-behaviour tests opt in explicitly; the production default is manual.
const AUTONOMOUS_POLICY = { mode: 'autonomous', autonomousRecovery: true, maxRecoveryAttempts: 4, backoffBaseMs: 60000, backoffMaxMs: 1800000, recoveryPauseMs: 1800000 };

function stateOutput(slot, state, overrides = {}) {
    return Object.entries({
        Device: slot, State: state, 'Current device state': state === 'Stopped' ? 'stop' : 'start',
        'Desired device state': state === 'Stopped' ? 'stop' : 'start',
        'Calls/Channels': 0, Active: 0, Held: 0, Dialing: 0, Alerting: 0,
        Incoming: 0, Waiting: 0, Releasing: 0, Initializing: 0,
        'Tasks in queue': 0, 'Commands in queue': 0, ...overrides
    }).map(([key, value]) => `  ${key} : ${value}`).join('\n');
}

function fixture(t, content = CONFIG) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dongle-recovery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'dongle.conf');
    fs.writeFileSync(configPath, content);
    const f = {
        configPath, commands: [], audit: [], usb: [], time: 0,
        states: new Map([['dongle0', 'Not connected'], ['dongle1', 'Free']]),
        details: new Map(), channels: '0 active channels\n0 active calls\n',
        beforeCommand: null, commandResult: null, inventoryError: false,
        bytes: () => fs.readFileSync(configPath, 'utf8'),
        setConfig: value => fs.writeFileSync(configPath, value),
        mutations: () => f.commands.filter(command => !/^(core show|dongle show)/.test(command)),
        async tick(ms = 0, supplied = f.states) {
            f.time += ms;
            await f.runtime.watchdog(new Map(supplied));
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
        lifecyclePolicy: AUTONOMOUS_POLICY
    });
    return f;
}

for (const policy of ['initstate=stop', 'initstate=remove', 'disable=yes']) {
    test(`watchdog preserves ${policy}, empty placeholders and runtime ghosts`, async t => {
        const f = fixture(t, `[defaults]\n[dongle0]\nimei=123456789012345\n${policy}\n[dongle1]\nimei=\n`);
        f.states.set('dongle9', 'Not initialized');
        f.states.set('dongle1', 'Not connected');
        await f.tick();
        await f.tick(100000);
        await f.tick(200000);
        assert.deepEqual(f.mutations(), []);
        assert.deepEqual(f.usb, []);
    });
}

test('default lifecycle policy is inherited but explicit slot start overrides it', t => {
    const f = fixture(t, '[defaults]\ninitstate=stop\n[dongle0]\nimei=123456789012345\n[dongle1]\nimei=987654321098765\ninitstate=start\n');
    const sections = readDongleSections(f.configPath);
    assert.equal(recoveryEligible(sections.get('dongle0')), false);
    assert.equal(recoveryEligible(sections.get('dongle1')), true);
});

for (const replacement of ['[defaults]\n', '[defaults]\n[dongle0]\nimei=123456789012345\ninitstate=stop\n']) {
    test('removing or stopping a slot clears a partially completed recovery', async t => {
        const f = fixture(t);
        await f.tick();
        await f.tick(90001);
        assert.deepEqual(f.mutations(), ['dongle restart gracefully dongle0']);
        f.setConfig(replacement);
        await f.tick(120001);
        assert.deepEqual(f.usb, []);
        f.setConfig(CONFIG);
        await f.tick();
        assert.equal(f.mutations().length, 1, 'restored config gets a fresh grace period');
        await f.tick(90001);
        assert.equal(f.mutations().length, 2);
        assert.deepEqual(f.usb, []);
    });
}

test('watchdog recovers a configured unhealthy slot and a lost runtime row', async t => {
    const f = fixture(t);
    f.states.delete('dongle0');
    await f.tick();
    await f.tick(90001);
    assert.deepEqual(f.mutations(), ['dongle restart gracefully dongle0']);
    await f.tick(120001);
    assert.deepEqual(f.usb, ['/fake/usb/dongle0']);
    assert.equal(f.audit.filter(entry => entry.phase === 'restart').length, 1);
});

for (const busy of ['pbx', 'radio', 'sms', 'queue', 'unknown', 'inventory']) {
    test(`watchdog defers ${busy} state without a restart or USB rebind`, async t => {
        const f = fixture(t);
        await f.tick();
        if (busy === 'pbx') f.channels = 'Dongle/dongle1-0001 Up AppDial\n1 active channel\n';
        if (busy === 'radio') f.details.set('dongle0', stateOutput('dongle0', 'Not connected', { Releasing: 1 }));
        if (busy === 'sms') f.details.set('dongle1', stateOutput('dongle1', 'Outgoing SMS'));
        if (busy === 'queue') f.details.set('dongle0', stateOutput('dongle0', 'Not connected', { 'Tasks in queue': 1 }));
        if (busy === 'unknown') f.details.set('dongle0', 'Device: dongle0\nState: Not connected\n');
        if (busy === 'inventory') f.inventoryError = true;
        await f.tick(90001);
        await f.tick(120001);
        assert.deepEqual(f.mutations(), []);
        assert.deepEqual(f.usb, []);
        assert.ok(f.audit.some(entry => entry.phase === 'deferred'));
    });
}

test('USB stage rechecks live channels and operator intent rather than the old table', async t => {
    const f = fixture(t);
    await f.tick();
    await f.tick(90001);
    f.channels = 'Dongle/dongle1-0001 Up AppDial\n1 active channel\n';
    await f.tick(120001);
    assert.deepEqual(f.usb, []);
    f.channels = '0 active channels\n';
    f.beforeCommand = command => {
        if (command === 'dongle show device state dongle1') f.setConfig(CONFIG.replace('[dongle0]\n', '[dongle0]\ninitstate=stop\n'));
    };
    await f.tick();
    assert.deepEqual(f.usb, []);
    assert.equal(f.mutations().length, 1);
});

test('runtime desired stop is respected even with an unhealthy table label', async t => {
    const f = fixture(t);
    await f.tick();
    f.details.set('dongle0', stateOutput('dongle0', 'Not connected', { 'Desired device state': 'stop' }));
    await f.tick(90001);
    assert.deepEqual(f.mutations(), []);
});

test('failed restart acknowledgements never advance or log a successful recovery', async t => {
    const f = fixture(t);
    f.commandResult = command => command.startsWith('dongle restart') ? '[dongle0] Device not found\n' : undefined;
    await f.tick();
    await f.tick(90001);
    await f.tick(120001);
    assert.deepEqual(f.usb, []);
    assert.equal(f.audit.some(entry => entry.phase === 'restart'), false);
    assert.ok(f.audit.some(entry => entry.phase === 'failed' && /not found/.test(entry.error)));
});

test('rollback restores only affected fields and never unloads or stops another slot', async t => {
    const f = fixture(t);
    const other = f.bytes().slice(f.bytes().indexOf('[dongle1]'));
    const result = await f.runtime.rollbackSlot({ slot: 'dongle0', previous: { imsi: '333333333333333' }, source: 'test' });
    assert.equal(result.success, true);
    assert.equal(readDongleSections(f.configPath).get('dongle0').imsi, '333333333333333');
    assert.equal(f.bytes().slice(f.bytes().indexOf('[dongle1]')), other);
    assert.deepEqual(f.mutations(), ['dongle stop gracefully dongle0', 'module reload chan_dongle.so']);
    assert.equal(f.states.get('dongle1'), 'Free');
});

test('busy rollback remains pending, preserves config, then retries only its slot when idle', async t => {
    const f = fixture(t);
    f.details.set('dongle1', stateOutput('dongle1', 'Free', { Active: 1 }));
    const before = f.bytes();
    const result = await f.runtime.rollbackSlot({ slot: 'dongle0', previous: null, source: 'test' });
    assert.equal(result.pending, true);
    assert.equal(f.bytes(), before);
    assert.deepEqual(f.mutations(), []);
    f.details.clear();
    const retried = await f.runtime.retryPendingRollbacks();
    assert.equal(retried[0].success, true);
    assert.equal(readDongleSections(f.configPath).has('dongle0'), false);
    assert.equal(f.states.get('dongle0'), 'Stopped', 'a ghost may remain until natural daemon restart');
    assert.equal(f.states.get('dongle1'), 'Free');
    assert.deepEqual(f.mutations(), ['dongle stop gracefully dongle0', 'module reload chan_dongle.so']);
});

for (const failure of ['stop', 'reload', 'throw']) {
    test(`rollback surfaces ${failure} command failures without a success audit`, async t => {
        const f = fixture(t);
        f.commandResult = command => {
            if (failure === 'stop' && command.startsWith('dongle stop')) return '[dongle0] Device not found\n';
            if (failure === 'reload' && command.startsWith('module reload')) return "Module 'chan_dongle.so' could not be reloaded.\n";
            if (failure === 'throw' && command.startsWith('dongle stop')) throw new Error('CLI unavailable');
        };
        const result = await f.runtime.rollbackSlot({ slot: 'dongle0', previous: { imsi: '333333333333333' }, source: 'test' });
        assert.equal(result.success, false);
        assert.ok(result.error);
        assert.equal(f.audit.some(entry => entry.phase === 'slot_rolled_back'), false);
        if (failure !== 'reload') assert.equal(f.bytes(), CONFIG);
        assert.equal(f.audit.some(entry => entry.phase === 'conf_reloaded'), false);
        assert.equal(f.states.get('dongle1'), 'Free');
    });
}

test('a call appearing after the stop acknowledgement defers the actual config mutation', async t => {
    const f = fixture(t);
    f.beforeCommand = command => {
        if (command.startsWith('dongle stop')) f.channels = 'Dongle/dongle1-0001 Up AppDial\n1 active channel\n';
    };
    const result = await f.runtime.rollbackSlot({ slot: 'dongle0', previous: null, source: 'test' });
    assert.equal(result.pending, true);
    assert.equal(f.bytes(), CONFIG);
    assert.deepEqual(f.mutations(), ['dongle stop gracefully dongle0']);
});

// Execute the production adoption function in an isolated dependency context, not
// the server entry point (which would connect to databases, timers and hardware).
function adoptionPass(f, { normalize = false, reclaim = false, repair = false } = {}) {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = server.indexOf('async function runAdoptionPass(trigger) {');
    assert.ok(start >= 0, 'runAdoptionPass anchor must exist');
    const end = server.indexOf('\n/**', start);
    assert.ok(end > start, 'runAdoptionPass end anchor must exist');
    return vm.runInNewContext(`${server.slice(start, end)}\nrunAdoptionPass;`, {
        DONGLE_CONF_PATH: f.configPath,
        readDongleSections, slotIntentionallyDisabled, recoveryEligible,
        annotateCandidates: provisioning.annotateCandidates,
        planAdoption: provisioning.planAdoption,
        validateRefreshRequest: provisioning.validateRefreshRequest,
        upsertSection: provisioning.upsertSection,
        isHealthyDongleState: healthy, isCallStateValue: inCall,
        dongleRuntime: f.runtime,
        appendDongleRestartAudit: entry => f.audit.push(entry),
        scheduleAutoAdopt: () => ({ scheduledInMs: 1000 }),
        probeUnconfiguredModems: async () => normalize || repair ? [] : [{ imei: reclaim ? '555555555555555' : '123456789012345', imsi: '444444444444444' }],
        dongleStates: async () => new Map(f.states),
        findVacantSlots: () => reclaim ? ['dongle0'] : [],
        pinningFieldsFor: async () => ({}),
        repairPinningFields: async candidate => repair && candidate.slot === 'dongle0' ? { audioPort: '/dev/ttyUSB8', dataPort: '/dev/ttyUSB9' } : {},
        normalizeConfiguredSlots: async () => {
            if (!normalize) return [];
            provisioning.upsertSection(f.configPath, 'dongle0', { audio: '/dev/ttyUSB9' });
            return [{ slot: 'dongle0', previous: { audio: '/dev/ttyUSB1' } }];
        },
        applyProvisionedSlots: async slots => {
            const result = await f.runtime.reloadConfiguration(slots, 'test:apply');
            return { reloaded: result.success, states: new Map(f.states), failed: [{ slot: 'dongle0', state: 'Not connected' }] };
        }
    });
}

for (const normalize of [false, true]) {
    test(`production adoption ${normalize ? 'normalization' : 'refresh'} rollback keeps unrelated slot intact`, async t => {
        const f = fixture(t);
        const result = await adoptionPass(f, { normalize })('test');
        assert.equal(result.success, true);
        assert.equal(result.rolledBack.length, 1);
        assert.equal(result.rolledBack[0].slot, 'dongle0');
        const section = readDongleSections(f.configPath).get('dongle0');
        assert.equal(section.imsi, '111111111111111');
        assert.equal(section.audio, '/dev/ttyUSB1');
        assert.equal(f.states.get('dongle1'), 'Free');
        assert.deepEqual(f.mutations(), ['module reload chan_dongle.so', 'dongle stop gracefully dongle0', 'module reload chan_dongle.so']);
    });
}
test('production adoption reports pending rollback when another slot becomes busy after apply', async t => {
    const f = fixture(t);
    f.beforeCommand = command => {
        if (command === 'module reload chan_dongle.so') f.details.set('dongle1', stateOutput('dongle1', 'Outgoing SMS'));
    };
    const result = await adoptionPass(f)('test');
    assert.equal(result.success, false);
    assert.equal(result.pendingRollback.length, 1);
    assert.equal(result.rolledBack.length, 0);
    assert.equal(readDongleSections(f.configPath).get('dongle0').imsi, '444444444444444');
    assert.deepEqual(f.mutations(), ['module reload chan_dongle.so']);
});

test('production reclaim failure restores the original empty reserved section', async t => {
    const f = fixture(t, CONFIG.replace(/imei=123456789012345\nimsi=111111111111111\naudio=\/dev\/ttyUSB1\ndata=\/dev\/ttyUSB2/, 'imei='));
    const result = await adoptionPass(f, { reclaim: true })('test');
    assert.equal(result.success, true);
    assert.equal(result.rolledBack.length, 1);
    const section = readDongleSections(f.configPath).get('dongle0');
    assert.ok(section);
    assert.equal(recoveryEligible(section), false);
    assert.equal(f.states.get('dongle1'), 'Free');
    assert.deepEqual(f.mutations(), ['module reload chan_dongle.so', 'dongle stop gracefully dongle0', 'module reload chan_dongle.so']);
});

test('production repair failure restores only the affected port fields', async t => {
    const f = fixture(t);
    const result = await adoptionPass(f, { repair: true })('test');
    assert.equal(result.success, true);
    assert.equal(result.rolledBack.length, 1);
    const section = readDongleSections(f.configPath).get('dongle0');
    assert.equal(section.audio, '/dev/ttyUSB1');
    assert.equal(section.data, '/dev/ttyUSB2');
    assert.equal(section.imsi, '111111111111111');
    assert.equal(f.states.get('dongle1'), 'Free');
});

test('configuration reload preserves an unrelated runtime-only stop intent', async t => {
    const f = fixture(t);
    f.states.set('dongle1', 'Stopped');
    const result = await f.runtime.reloadConfiguration(['dongle0'], 'test');
    assert.equal(result.pending, true);
    assert.match(result.reason, /stopped at runtime/);
    assert.deepEqual(f.mutations(), []);
    assert.equal(f.states.get('dongle1'), 'Stopped');
});

test('unknown detail state is not made safe by zero numeric counters', async t => {
    const f = fixture(t);
    f.details.set('dongle0', stateOutput('dongle0', 'Unknown'));
    const result = await f.runtime.safety(['dongle0']);
    assert.equal(result.safe, false);
    assert.match(result.reason, /Unknown/);
});

function manualAddHandler(f, apply) {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = server.indexOf("app.post('/api/gsm-dongles/provision/add'");
    assert.ok(start >= 0, 'provision/add anchor must exist');
    const end = server.indexOf('// API Endpoint to reload specific dongle', start);
    assert.ok(end > start, 'provision/add end anchor must exist');
    let handler;
    const auth = () => {};
    const root = () => {};
    vm.runInNewContext(server.slice(start, end), {
        app: { post(route, actualAuth, actualRoot, callback) {
            assert.equal(actualAuth, auth);
            assert.equal(actualRoot, root);
            handler = callback;
        } },
        requireAuth: auth, requireDongleRoot: root,
        DONGLE_CONF_PATH: f.configPath,
        readDongleSections,
        validateAddRequest: provisioning.validateAddRequest,
        appendSection: provisioning.appendSection,
        withProvisionLock: task => task(),
        appendDongleRestartAudit: entry => f.audit.push(entry),
        dongleRuntime: f.runtime,
        applyProvisionedSlots: apply
    });
    return handler;
}

for (const busy of [false, true]) {
    test(`manual add catch ${busy ? 'reports pending cleanup' : 'removes only its failed section'} without unloading the module`, async t => {
        const f = fixture(t);
        const handler = manualAddHandler(f, async () => {
            if (busy) f.details.set('dongle1', stateOutput('dongle1', 'Outgoing SMS'));
            throw new Error('Apply transport failed');
        });
        let response;
        const res = { status() { return this; }, json(value) { response = value; return this; } };
        await handler({ body: { slot: 'dongle2', imei: '555555555555555' } }, res);
        assert.equal(response.success, false);
        assert.match(response.error, /Apply transport failed/);
        assert.equal(readDongleSections(f.configPath).has('dongle2'), busy);
        assert.equal(response.pendingRollback.length, busy ? 1 : 0);
        assert.equal(f.states.get('dongle1'), 'Free');
        assert.deepEqual(f.mutations(), busy ? [] : ['module reload chan_dongle.so']);
    });
}

test('USB recovery also defers new SMS work and unreadable live state', async t => {
    const f = fixture(t);
    await f.tick();
    await f.tick(90001);
    f.details.set('dongle0', stateOutput('dongle0', 'Outgoing SMS'));
    await f.tick(120001);
    assert.deepEqual(f.usb, []);
    f.details.set('dongle0', 'Unknown CLI response');
    await f.tick();
    assert.deepEqual(f.usb, []);
    f.details.clear();
    await f.tick();
    assert.deepEqual(f.usb, ['/fake/usb/dongle0']);
});

test('watchdog checks config again after the last safety query before a restart', async t => {
    const f = fixture(t);
    await f.tick();
    f.beforeCommand = command => {
        if (command === 'dongle show device state dongle1') f.setConfig(CONFIG.replace('[dongle0]\n', '[dongle0]\ndisable=yes\n'));
    };
    await f.tick(90001);
    assert.deepEqual(f.mutations(), []);
    assert.deepEqual(f.usb, []);
});

test('production adoption surfaces a rejected targeted stop instead of reporting rollback success', async t => {
    const f = fixture(t);
    f.commandResult = command => command.startsWith('dongle stop') ? '[dongle0] Device not found\n' : undefined;
    const result = await adoptionPass(f)('test');
    assert.equal(result.success, false);
    assert.equal(result.rolledBack.length, 0);
    assert.equal(result.rollbackFailures.length, 1);
    assert.match(result.rollbackFailures[0].error, /not found/);
    assert.equal(f.audit.some(entry => entry.phase === 'slot_rolled_back'), false);
    assert.equal(f.states.get('dongle1'), 'Free');
});

test('operator stop cancels pending rollback without overwriting newer config intent', async t => {
    const f = fixture(t);
    f.channels = 'Dongle/dongle1-0001 Up AppDial\n1 active channel\n';
    assert.equal((await f.runtime.rollbackSlot({ slot: 'dongle0', previous: null, source: 'test' })).pending, true);
    const stopped = CONFIG.replace('[dongle0]\n', '[dongle0]\ninitstate=stop\n');
    f.setConfig(stopped);
    f.channels = '0 active channels\n';
    const result = await f.runtime.retryPendingRollbacks();
    assert.equal(result[0].skipped, true);
    assert.equal(f.bytes(), stopped);
    assert.deepEqual(f.mutations(), []);
    assert.deepEqual(await f.runtime.retryPendingRollbacks(), []);
});

test('pending deletion never deletes a replacement assignment made by the operator', async t => {
    const f = fixture(t);
    f.channels = 'Dongle/dongle1-0001 Up AppDial\n1 active channel\n';
    assert.equal((await f.runtime.rollbackSlot({ slot: 'dongle0', source: 'test' })).pending, true);
    const replacement = CONFIG.replace('imei=123456789012345', 'imei=555555555555555');
    f.setConfig(replacement);
    f.channels = '0 active channels\n';
    const result = await f.runtime.retryPendingRollbacks();
    assert.equal(result[0].skipped, true);
    assert.equal(f.bytes(), replacement);
    assert.deepEqual(f.mutations(), []);
});

test('deferred reload after committed rollback cannot repeat removal of a newly created slot', async t => {
    const f = fixture(t);
    f.beforeCommand = command => {
        if (command === 'core show channels' && !readDongleSections(f.configPath).has('dongle0')) {
            f.details.set('dongle1', stateOutput('dongle1', 'Outgoing SMS'));
        }
    };
    const result = await f.runtime.rollbackSlot({ slot: 'dongle0', source: 'test' });
    assert.equal(result.pending, true);
    assert.equal(result.configRestored, true);
    assert.equal(readDongleSections(f.configPath).has('dongle0'), false);
    const replacement = CONFIG.replace('imei=123456789012345', 'imei=555555555555555');
    f.setConfig(replacement);
    f.beforeCommand = null;
    f.details.clear();
    const retried = await f.runtime.retryPendingRollbacks();
    assert.equal(retried[0].success, true);
    assert.equal(f.bytes(), replacement);
    assert.deepEqual(f.mutations(), ['dongle stop gracefully dongle0', 'module reload chan_dongle.so']);
});

test('a disabled unrelated slot is not restarted by a config-only rollback reload', async t => {
    const f = fixture(t, CONFIG.replace('[dongle1]\n', '[dongle1]\ndisable=yes\n'));
    f.states.set('dongle1', 'Stopped');
    const result = await f.runtime.reloadConfiguration(['dongle0'], 'test');
    assert.equal(result.pending, true);
    assert.deepEqual(f.mutations(), []);
});
