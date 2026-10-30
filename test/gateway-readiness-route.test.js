'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const express = require('express');
const tunnel = require('../lib/gateway-tunnel');

test('exact readiness POST authenticates independently; all other operational requests stay protected', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf('// --- GATEWAY INSTALLATION READINESS');
    const end = source.indexOf('// --- PRE-SESSION COOKIE SANITIZER ---', start);
    assert.ok(start > source.indexOf('app.use(express.urlencoded('));
    assert.ok(end > start && end < source.indexOf('app.use(sessionMiddleware)'));
    assert.ok(end < source.indexOf('// --- PROTECT ALL OPERATIONAL ROUTES ---'));
    assert.equal((source.match(/app\.post\('\/api\/gateway-tunnel\/readiness'/g) || []).length, 1);
    const app = express();
    app.use(express.json());
    vm.runInNewContext(source.slice(start, end), { app, require: name => {
        assert.equal(name, './lib/gateway-tunnel');
        return tunnel;
    } });
    app.use((req, res) => res.status(401).json({ error: 'session_required' }));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const originalRead = fs.readFileSync;
    const originalExists = fs.existsSync;
    const originalSocket = dgram.createSocket;
    const key = 'r'.repeat(43);
    const pbxId = 'pbx_0123456789abcdef';
    let opened = 0;
    let socket;
    fs.readFileSync = function(file, ...args) {
        if (file === '/etc/sokrat/gateway-tunnel-v2.json') return JSON.stringify({ pbxId, readinessKey: key,
            plan: { gatewayIp: '10.253.0.13', pbxIp: '10.253.0.14', slot: 3 } });
        if (file === '/etc/sokrat/gateway-hook.json') return JSON.stringify({ pbxId, token: 'fixture-token' });
        if (file === '/etc/asterisk/extensions_sokrat.conf') return '[sub-sokrat-push-send]\n/usr/local/bin/sokrat-tenant-push-hook.py';
        return originalRead.call(this, file, ...args);
    };
    fs.existsSync = function(file) {
        return file === '/usr/local/bin/sokrat-tenant-push-hook.py'
            || file === '/usr/local/bin/sokrat-webrtc-wake-dispatch.py'
            || file === '/etc/asterisk/extensions_sokrat_webrtc_wake.conf'
            || file === '/etc/frp/gateway-ca.crt'
            || originalExists.call(this, file);
    };
    dgram.createSocket = () => {
        opened++;
        socket = new EventEmitter();
        socket.bind = () => socket.emit('listening');
        socket.address = () => ({ port: 14567 });
        socket.close = () => socket.emit('close');
        return socket;
    };
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, method = 'POST', credential = '') => fetch(base + url, {
        method, headers: { 'Content-Type': 'application/json', 'X-Sokrat-Readiness': credential },
        ...(method === 'POST' ? { body: JSON.stringify({ nonce: 'a'.repeat(32) }) } : {})
    });
    try {
        for (const credential of ['', 'wrong-key']) {
            const response = await request('/api/gateway-tunnel/readiness', 'POST', credential);
            assert.equal(response.status, 403);
            assert.deepEqual(await response.json(), { ready: false });
        }
        assert.equal(opened, 0);
        const response = await request('/api/gateway-tunnel/readiness', 'POST', key);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).pbxId, pbxId);
        assert.equal(opened, 1);
        socket.close();

        // A missing scoped wake artifact must fail closed, not report ready.
        for (const missing of ['/usr/local/bin/sokrat-webrtc-wake-dispatch.py',
            '/etc/asterisk/extensions_sokrat_webrtc_wake.conf', '/etc/frp/gateway-ca.crt']) {
            const saved = fs.existsSync;
            fs.existsSync = function(file) {
                return file === missing ? false : saved.call(this, file);
            };
            try {
                const denied = await request('/api/gateway-tunnel/readiness', 'POST', key);
                assert.equal(denied.status, 403, missing + ' must fail closed');
                assert.deepEqual(await denied.json(), { ready: false });
            } finally {
                fs.existsSync = saved;
            }
        }

        // Without the legacy tenant hook the shared context is not required.
        const savedExists = fs.existsSync;
        fs.existsSync = function(file) {
            return file === '/usr/local/bin/sokrat-tenant-push-hook.py' ? false : savedExists.call(this, file);
        };
        try {
            assert.equal((await request('/api/gateway-tunnel/readiness', 'POST', key)).status, 200);
        } finally {
            fs.existsSync = savedExists;
        }
        for (const [url, method] of [['/api/settings/gateway-tunnel', 'POST'],
            ['/api/gateway-tunnel/readiness/other', 'POST'], ['/api/gateway-tunnel/readiness', 'GET']]) {
            assert.equal((await request(url, method, key)).status, 401);
        }
    } finally {
        if (socket) socket.close();
        fs.readFileSync = originalRead;
        fs.existsSync = originalExists;
        dgram.createSocket = originalSocket;
        await new Promise(resolve => server.close(resolve));
    }
});
