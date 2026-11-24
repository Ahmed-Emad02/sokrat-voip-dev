'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createDongleSlotsRouter } = require('../routes/dongle-slots');
const provisioning = require('../lib/dongle-provisioning');
const { parseConfiguredState } = provisioning;

const BASE_CONFIG = '; retained local configuration\n[general]\ninterval=15\n\n[defaults]\ncontext=from-dongle-custom\nrxgain=3\ntxgain=3\n';
const API = '/api/gsm-dongles/slots';

async function fixture(t, { content = BASE_CONFIG, devices = [], readDevices, onChanged, stop } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dongle-slots-'));
    const configPath = path.join(directory, 'dongle.conf');
    fs.writeFileSync(configPath, content, { mode: 0o640 });
    let queue = Promise.resolve();
    let locked = false;
    let runtimeReads = 0;
    const changes = [];
    const withProvisionLock = task => {
        const run = queue.then(async () => {
            assert.equal(locked, false);
            locked = true;
            try { return await task(); } finally { locked = false; }
        });
        queue = run.catch(() => {});
        return run;
    };
    const app = express();
    app.use(express.json());
    // Test-only identity injection: the production router never trusts these headers.
    app.use((req, res, next) => {
        if (req.headers['x-test-session']) req.session = JSON.parse(req.headers['x-test-session']);
        if (req.headers['x-test-api-key']) req.apiKey = JSON.parse(req.headers['x-test-api-key']);
        if (req.headers['x-test-federation']) req.isFederationAuthenticated = true;
        if (req.headers['x-test-api-auth']) req.isApiKeyAuthenticated = true;
        next();
    });
    app.use(API, createDongleSlotsRouter({
        configPath,
        withProvisionLock,
        readDevices: async () => {
            // The GET inventory is a pure read and must not queue behind the
            // provisioning lock; mutating requests still run inside it.
            runtimeReads += 1;
            return readDevices ? readDevices() : devices;
        },
        ...(stop ? { stopSlot: stop } : {}),
        onChanged: async (event, req) => {
            changes.push({ ...event, username: req.session.username });
            if (onChanged) await onChanged(event, req);
        },
    }));
    const server = http.createServer(app);
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
        configPath,
        directory,
        changes,
        runtimeReads: () => runtimeReads,
        bytes: () => fs.readFileSync(configPath, 'utf8'),
        async request(method = 'GET', suffix = '', { session = { username: 'root' }, headers = {}, body = undefined } = {}) {
            const sendsBody = method === 'POST' || (method === 'DELETE' && body !== undefined);
            const response = await fetch(`${origin}${API}${suffix}`, {
                method,
                headers: {
                    ...(session === null ? {} : { 'x-test-session': JSON.stringify(session) }),
                    ...(sendsBody ? { 'content-type': 'application/json' } : {}),
                    ...headers,
                },
                ...(sendsBody ? { body: JSON.stringify(body === undefined ? {} : body) } : {}),
            });
            return { status: response.status, body: await response.json(), headers: response.headers };
        },
    };
}

test('only the exact interactive root session can list, create, or remove slots', async t => {
    const f = await fixture(t, { content: `${BASE_CONFIG}\n[dongle0]\ntxgain=3\nrxgain=3\n` });
    const identities = [
        { session: null },
        { session: { username: 'operator' } },
        { session: { username: 'admin', isRoot: true, role: 'superadmin' } },
        { session: { username: 'Root', isRoot: true } },
        { session: { username: 'root ' } },
        { session: { isRoot: true } },
        { session: { username: 'root' }, headers: { 'x-test-api-key': '{"scopes":"*"}' } },
        { session: { username: 'root' }, headers: { 'x-test-api-auth': '1' } },
        { session: { username: 'root' }, headers: { 'x-test-federation': '{"id":1}' } },
        { session: { username: 'root' }, headers: { 'x-test-api-key': '{}', 'x-test-federation': '{}' } },
    ];
    const original = f.bytes();
    for (const identity of identities) {
        for (const [method, suffix] of [['GET', ''], ['POST', ''], ['DELETE', '/dongle0']]) {
            const response = await f.request(method, suffix, identity);
            assert.equal(response.status, 403, JSON.stringify({ identity, method }));
            assert.equal(response.body.success, false);
        }
    }
    assert.equal(f.runtimeReads(), 0);
    assert.equal(f.bytes(), original);
    assert.deepEqual(f.changes, []);
    assert.equal((await f.request()).status, 200);
});

test('root creates a persisted empty vacancy and removes it without changing defaults', async t => {
    const f = await fixture(t);
    const metadata = fs.statSync(f.configPath);
    const listed = await f.request();
    assert.deepEqual(listed.body, { success: true, slots: [], suggestedSlot: 'dongle0' });
    assert.equal(listed.headers.get('cache-control'), 'no-store');

    const created = await f.request('POST');
    assert.equal(created.status, 201);
    assert.equal(created.body.success, true);
    assert.equal(created.body.slot, 'dongle0');
    assert.deepEqual(
        created.body.slots.map(({ slot, empty, removable, state }) => ({ slot, empty, removable, state })),
        [{ slot: 'dongle0', empty: true, removable: true, state: 'empty' }]
    );
    assert.equal(fs.readFileSync(created.body.backup, 'utf8'), BASE_CONFIG);
    assert.ok(f.bytes().startsWith(BASE_CONFIG));
    assert.match(f.bytes(), /\[dongle0\]\ntxgain=3\nrxgain=3\nimei=\n/);
    const section = parseConfiguredState(f.configPath).get('dongle0');
    for (const field of ['imei', 'imsi', 'audio', 'data', 'initstate']) assert.equal(section[field], '');
    assert.doesNotMatch(f.bytes(), /initstate\s*=\s*stop/);
    const persisted = await f.request();
    assert.deepEqual(persisted.body.slots, created.body.slots);
    assert.equal(persisted.body.suggestedSlot, 'dongle1');

    const beforeRemoval = f.bytes();
    const removed = await f.request('DELETE', '/dongle0');
    assert.equal(removed.status, 200);
    assert.equal(removed.body.slot, 'dongle0');
    assert.deepEqual(removed.body.slots, []);
    assert.equal(fs.readFileSync(removed.body.backup, 'utf8'), beforeRemoval);
    assert.equal(f.bytes(), BASE_CONFIG);
    assert.equal((await f.request()).body.suggestedSlot, 'dongle0');
    const after = fs.statSync(f.configPath);
    assert.equal(after.mode & 0o7777, metadata.mode & 0o7777);
    assert.equal(after.uid, metadata.uid);
    assert.equal(after.gid, metadata.gid);
    assert.deepEqual(f.changes.map(({ action, slot, username }) => ({ action, slot, username })), [
        { action: 'create', slot: 'dongle0', username: 'root' },
        { action: 'remove', slot: 'dongle0', username: 'root' },
    ]);
});

test('atomic helper replacements retain config mode and ownership', async t => {
    const f = await fixture(t);
    // When permitted, use a different owner to exercise replacement ownership restoration.
    if (process.getuid && process.getuid() === 0) fs.chownSync(f.configPath, 1, 1);
    fs.chmodSync(f.configPath, 0o660);
    const before = fs.statSync(f.configPath);
    for (const [method, suffix, status] of [['POST', '', 201], ['DELETE', '/dongle0', 200]]) {
        assert.equal((await f.request(method, suffix)).status, status);
        const after = fs.statSync(f.configPath);
        assert.equal(after.uid, before.uid);
        assert.equal(after.gid, before.gid);
        assert.equal(after.mode & 0o7777, before.mode & 0o7777);
    }
});

test('an assigned slot whose modem is absent is listed removable and can be deleted', async t => {
    const assignments = ['imei=123456789012345', 'imsi=250011234567890', 'audio=/dev/ttyUSB1', 'data=/dev/ttyUSB2'];
    const content = BASE_CONFIG + assignments.map((value, index) => `\n[dongle${index}]\n${value}\n`).join('');
    let stopped = [];
    const f = await fixture(t, { content, stop: async slot => { stopped.push(slot); } });
    const listed = await f.request();
    assert.equal(listed.body.slots.length, assignments.length);
    assert.ok(listed.body.slots.every(slot => slot.assigned && slot.modemAbsent && slot.removable));
    for (let index = 0; index < assignments.length; index += 1) {
        assert.equal((await f.request('DELETE', `/dongle${index}`)).status, 200);
    }
    assert.deepEqual(stopped, [], 'no pvt to stop when no runtime row exists');
    assert.equal(f.changes.length, assignments.length);
    assert.doesNotMatch(f.bytes(), /\[dongle[0-3]\]/);
});

test('an assigned slot with a present modem stays protected', async t => {
    const content = `${BASE_CONFIG}\n[dongle0]\nimei=123456789012345\n`;
    for (const state of ['Free', 'Ring', 'Outgoing Call']) {
        const f = await fixture(t, { content, devices: [{ ID: 'dongle0', State: state }] });
        const listed = await f.request();
        assert.equal(listed.body.slots[0].removable, false, state);
        assert.equal((await f.request('DELETE', '/dongle0')).status, 409, state);
        assert.equal(f.bytes(), content);
        assert.deepEqual(f.changes, []);
    }
});

test('removing an assigned slot whose runtime pvt is disconnected stops only that slot', async t => {
    const content = `${BASE_CONFIG}\n[dongle0]\nimei=123456789012345\n`;
    const stopped = [];
    const f = await fixture(t, {
        content,
        devices: [{ ID: 'dongle0', State: 'Not Connected' }],
        stop: async slot => { stopped.push(slot); }
    });
    assert.equal((await f.request()).body.slots[0].removable, true);
    const res = await f.request('DELETE', '/dongle0');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stopped, ['dongle0']);
    assert.deepEqual(stopped, ['dongle0'], 'no module unload/load on removal');
    assert.doesNotMatch(f.bytes(), /\[dongle0\]/);
});

test('even an unconnected Asterisk runtime row makes an empty section nonremovable', async t => {
    const content = `${BASE_CONFIG}\n[dongle0]\nimei=\n`;
    const f = await fixture(t, { content, devices: [{ ID: 'dongle0', State: 'Not connected', IMEI: '' }] });
    const listed = await f.request();
    assert.equal(listed.body.slots[0].empty, false);
    assert.equal(listed.body.slots[0].removable, false);
    assert.equal((await f.request('DELETE', '/dongle0')).status, 409);
    assert.equal(f.bytes(), content);
    assert.deepEqual(f.changes, []);
});

test('runtime-only entries are protected while live and clearable once their modem is gone', async t => {
    const stopped = [];
    const f = await fixture(t, {
        devices: [{ ID: 'Dongle0', State: 'Free' }, { ID: 'dongle2', State: 'Stopped' }],
        stop: async slot => { stopped.push(slot); }
    });
    const listed = await f.request();
    assert.equal(listed.body.suggestedSlot, 'dongle1');
    // Driver rows without a section are not slots and must not be listed.
    assert.deepEqual(listed.body.slots, []);
    assert.equal((await f.request('DELETE', '/dongle0')).status, 409);
    const cleared = await f.request('DELETE', '/dongle2');
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.stopped, ['dongle2']);
    assert.deepEqual(stopped, ['dongle2']);
    const created = await f.request('POST');
    assert.equal(created.status, 201);
    assert.equal(created.body.slot, 'dongle1');
    assert.deepEqual([...parseConfiguredState(f.configPath).keys()], ['general', 'defaults', 'dongle1']);
});

test('runtime errors fail closed for listing and both mutations', async t => {
    const content = `${BASE_CONFIG}\n[dongle0]\nimei=\n`;
    const f = await fixture(t, { content, readDevices: async () => { throw new Error('Asterisk unavailable'); } });
    for (const [method, suffix] of [['GET', ''], ['POST', ''], ['DELETE', '/dongle0']]) {
        const response = await f.request(method, suffix);
        assert.equal(response.status, 503);
        assert.equal(response.body.success, false);
        assert.equal(f.bytes(), content);
    }
    assert.deepEqual(fs.readdirSync(f.directory), ['dongle.conf']);
    assert.deepEqual(f.changes, []);
});

test('malformed runtime inventory also fails closed rather than assuming vacancies', async t => {
    for (const devices of [null, {}, [null], [{}], [{ ID: '' }]]) {
        const f = await fixture(t, { devices });
        for (const method of ['GET', 'POST']) assert.equal((await f.request(method)).status, 503);
        assert.equal(f.bytes(), BASE_CONFIG);
        assert.deepEqual(f.changes, []);
    }
});

test('concurrent creates allocate distinct lowest names inside the shared lock', async t => {
    let reads = 0;
    const f = await fixture(t, { readDevices: async () => {
        reads += 1;
        await new Promise(resolve => setImmediate(resolve));
        return [];
    } });
    const results = await Promise.all(Array.from({ length: 8 }, () => f.request('POST')));
    assert.ok(results.every(result => result.status === 201));
    assert.deepEqual(results.map(result => result.body.slot).sort(), Array.from({ length: 8 }, (_, index) => `dongle${index}`));
    assert.equal(reads, 8);
    assert.equal(f.changes.length, 8);
    const sections = parseConfiguredState(f.configPath);
    for (let index = 0; index < 8; index += 1) {
        const section = sections.get(`dongle${index}`);
        assert.ok(section);
        for (const key of ['imei', 'imsi', 'audio', 'data', 'initstate']) assert.equal(section[key], '');
    }
});

test('invalid names, missing slots, and assignment payloads are rejected unchanged', async t => {
    const f = await fixture(t);
    for (const name of ['defaults', 'general', 'Dongle0', 'dongle-1', 'dongle0.conf', 'dongle0%0A']) {
        assert.equal((await f.request('DELETE', `/${name}`)).status, 400, name);
    }
    assert.equal((await f.request('DELETE', '/dongle42')).status, 404);
    for (const body of [{ slot: 'dongle4' }, { imei: '123456789012345' }, { audio: '/dev/ttyUSB0' }, []]) {
        assert.equal((await f.request('POST', '', { body })).status, 400);
    }
    assert.equal(f.bytes(), BASE_CONFIG);
    assert.deepEqual(fs.readdirSync(f.directory), ['dongle.conf']);
    assert.deepEqual(f.changes, []);
});

test('allocation fills the lowest hole and does not reuse existing empty placeholders', async t => {
    const content = `${BASE_CONFIG}\n[dongle0]\nimei=\n\n[dongle2]\nimei=\n`;
    const f = await fixture(t, { content });
    assert.equal((await f.request()).body.suggestedSlot, 'dongle1');
    const created = await f.request('POST');
    assert.equal(created.status, 201);
    assert.equal(created.body.slot, 'dongle1');
    assert.deepEqual(created.body.slots.map(slot => slot.slot), ['dongle0', 'dongle1', 'dongle2']);
    assert.ok(created.body.slots.every(slot => slot.empty && slot.removable));
});

test('exhaustion of names dongle0 through dongle999 returns conflict without a write', async t => {
    const content = BASE_CONFIG + Array.from({ length: 1000 }, (_, index) => `\n[dongle${index}]\nimei=\n`).join('');
    const f = await fixture(t, { content });
    const listed = await f.request();
    assert.equal(listed.body.suggestedSlot, null);
    assert.equal(listed.body.slots.length, 1000);
    const created = await f.request('POST');
    assert.equal(created.status, 409);
    assert.equal(created.body.success, false);
    assert.equal(f.bytes(), content);
    assert.deepEqual(fs.readdirSync(f.directory), ['dongle.conf']);
    assert.deepEqual(f.changes, []);
});

test('bulk creation allocates the requested count in one durable commit', async t => {
    const f = await fixture(t, { devices: [{ ID: 'dongle1', State: 'Free' }] });
    const created = await f.request('POST', '', { body: { count: 3 } });
    assert.equal(created.status, 201);
    assert.equal(created.body.success, true);
    assert.equal(created.body.slot, undefined);
    assert.deepEqual(created.body.addedSlots, ['dongle0', 'dongle2', 'dongle3']);
    assert.deepEqual(created.body.slots.map(slot => slot.slot), ['dongle0', 'dongle2', 'dongle3']);
    assert.equal(fs.readFileSync(created.body.backup, 'utf8'), BASE_CONFIG);
    assert.deepEqual([...parseConfiguredState(f.configPath).keys()], ['general', 'defaults', 'dongle0', 'dongle2', 'dongle3']);
    assert.equal(f.changes.length, 1, 'a batch notifies once');
    assert.deepEqual(f.changes[0].changedSlots, ['dongle0', 'dongle2', 'dongle3']);
    assert.equal(f.changes[0].slot, undefined);
});

test('bulk removal validates every target before one commit', async t => {
    const content = `${BASE_CONFIG}\n[dongle0]\nimei=\n\n[dongle1]\nimei=\n\n[dongle2]\nimei=123456789012345\n`;
    const f = await fixture(t, { content, devices: [{ ID: 'dongle2', State: 'Free' }] });
    const blocked = await f.request('DELETE', '', { body: { slots: ['dongle0', 'dongle2'] } });
    assert.equal(blocked.status, 409);
    assert.equal(f.bytes(), content, 'a rejected mixed batch writes nothing');
    assert.deepEqual(f.changes, []);

    const removed = await f.request('DELETE', '', { body: { slots: ['dongle0', 'dongle1'] } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.removedSlots, ['dongle0', 'dongle1']);
    assert.equal(removed.body.slot, undefined);
    assert.equal(removed.body.slots.length, 1);
    assert.equal(f.changes.length, 1);
    assert.deepEqual(f.changes[0].changedSlots, ['dongle0', 'dongle1']);
    assert.match(removed.body.backup, /bak-slots-/);
});

test('bulk removal rejects duplicates, unknown names, and occupied runtime slots', async t => {
    const content = `${BASE_CONFIG}\n[dongle0]\nimei=\n\n[dongle1]\nimei=\n`;
    const f = await fixture(t, { content, devices: [{ ID: 'dongle1', State: 'Ringing' }] });
    assert.equal((await f.request('DELETE', '', { body: { slots: ['dongle0', 'dongle0'] } })).status, 400);
    assert.equal((await f.request('DELETE', '', { body: { slots: ['dongle0', 'dongle9'] } })).status, 404);
    assert.equal((await f.request('DELETE', '', { body: { slots: ['dongle0', 'dongle1'] } })).status, 409);
    assert.equal((await f.request('DELETE', '', { body: { slots: [] } })).status, 400);
    assert.equal((await f.request('DELETE', '', { body: {} })).status, 400);
    assert.equal(f.bytes(), content);
    assert.deepEqual(f.changes, []);
});

test('mixed bulk deletion removes configured sections and stops runtime-only ghosts', async t => {
    const stopped = [];
    const content = `${BASE_CONFIG}\n[dongle0]\nimei=123456789012345\n\n[dongle1]\nimei=\n`;
    const f = await fixture(t, {
        content,
        devices: [{ ID: 'dongle0', State: 'Disconnected' }, { ID: 'dongle9', State: 'Stopped' }],
        stop: async slot => { stopped.push(slot); }
    });
    const rejected = await f.request('DELETE', '', { body: { slots: ['dongle0', 'dongle9', 'dongle8'] } });
    assert.equal(rejected.status, 404);
    assert.equal(f.bytes(), content);
    assert.deepEqual(stopped, []);
    const removed = await f.request('DELETE', '', { body: { slots: ['dongle0', 'dongle9', 'dongle1'] } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.removedSlots, ['dongle0', 'dongle9', 'dongle1']);
    assert.deepEqual(removed.body.stopped, ['dongle0', 'dongle9']);
    assert.deepEqual(removed.body.stopFailures, []);
    assert.deepEqual(stopped, ['dongle0', 'dongle9']);
    assert.deepEqual([...parseConfiguredState(f.configPath).keys()], ['general', 'defaults']);
    assert.equal(f.changes.length, 1);
    assert.match(removed.body.backup, /bak-slots-/);
});

test('orphan-only batch does not rewrite config and reports a failed stop', async t => {
    const f = await fixture(t, {
        devices: [{ ID: 'dongle7', State: 'Stopped' }, { ID: 'dongle8', State: 'Disconnected' }],
        stop: async slot => { if (slot === 'dongle8') throw new Error('Stop rejected'); }
    });
    const removed = await f.request('DELETE', '', { body: { slots: ['dongle7', 'dongle8'] } });
    assert.equal(removed.status, 200);
    assert.equal(f.bytes(), BASE_CONFIG);
    assert.equal(removed.body.backup, null);
    assert.deepEqual(removed.body.stopped, ['dongle7']);
    assert.deepEqual(removed.body.stopFailures, [{ slot: 'dongle8', error: 'Stop rejected' }]);
});

test('bulk creation rejects invalid counts and unknown fields without writing', async t => {
    const f = await fixture(t);
    for (const body of [{ count: 0 }, { count: 33 }, { count: 1.5 }, { count: '3' }, { count: 2, imei: '123456789012345' }]) {
        const response = await f.request('POST', '', { body });
        assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(f.bytes(), BASE_CONFIG);
    assert.deepEqual(fs.readdirSync(f.directory), ['dongle.conf']);
    assert.deepEqual(f.changes, []);
});

test('bulk creation reports conflict when the batch exceeds free names', async t => {
    const content = BASE_CONFIG + Array.from({ length: 999 }, (_, index) => `\n[dongle${index}]\nimei=\n`).join('');
    const f = await fixture(t, { content });
    const response = await f.request('POST', '', { body: { count: 2 } });
    assert.equal(response.status, 409);
    assert.equal(f.bytes(), content);
    assert.deepEqual(f.changes, []);
});

test('provisioning rejects identical audio and data devices', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dongle-port-pair-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'dongle.conf');
    fs.writeFileSync(configPath, BASE_CONFIG + '\n[dongle0]\naudio=/dev/serial/by-path/audio-0\ndata=/dev/serial/by-path/data-0\n');
    const before = fs.readFileSync(configPath, 'utf8');
    assert.throws(
        () => provisioning.upsertSection(configPath, 'dongle0', { audio: '/dev/ttyUSB2', data: '/dev/ttyUSB2' }),
        /same device/
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'a rejected pair must not rewrite the file');
    provisioning.upsertSection(configPath, 'dongle0', { audio: '/dev/ttyUSB2', data: '/dev/ttyUSB3' });
    const section = provisioning.parseConfiguredState(configPath).get('dongle0');
    assert.equal(section.audio, '/dev/ttyUSB2');
    assert.equal(section.data, '/dev/ttyUSB3');
});
