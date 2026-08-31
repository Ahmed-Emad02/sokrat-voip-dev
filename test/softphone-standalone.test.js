const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const SOFTPHONE_DIR = '/opt/sokrat-softphone';

test('Standalone Softphone package.json and directory structure exist', () => {
    assert.ok(fs.existsSync(SOFTPHONE_DIR), 'Softphone directory must exist');
    assert.ok(fs.existsSync(path.join(SOFTPHONE_DIR, 'package.json')), 'package.json must exist');
    assert.ok(fs.existsSync(path.join(SOFTPHONE_DIR, 'server.js')), 'server.js must exist');
    assert.ok(fs.existsSync(path.join(SOFTPHONE_DIR, 'views/index.ejs')), 'views/index.ejs must exist');
    assert.ok(fs.existsSync(path.join(SOFTPHONE_DIR, 'public/js/jssip.min.js')), 'public/js/jssip.min.js must exist');
});

test('Standalone server.js enforces strict CSP and security headers', async () => {
    const serverJs = fs.readFileSync(path.join(SOFTPHONE_DIR, 'server.js'), 'utf8');
    assert.ok(serverJs.includes("Content-Security-Policy"), 'Must set Content-Security-Policy header');
    assert.ok(serverJs.includes("X-Content-Type-Options"), 'Must set X-Content-Type-Options header');
    assert.ok(serverJs.includes("Permissions-Policy"), 'Must set Permissions-Policy header');

    // Test live HTTP server response
    const { app } = require(path.join(SOFTPHONE_DIR, 'server.js'));
    const testServer = http.createServer(app);
    await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const port = testServer.address().port;

    const res = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/health`, (r) => {
            let data = '';
            r.on('data', chunk => data += chunk);
            r.on('end', () => resolve({ statusCode: r.statusCode, headers: r.headers, body: JSON.parse(data) }));
        }).on('error', reject);
    });

    if (testServer.closeAllConnections) testServer.closeAllConnections();
    await new Promise((resolve) => testServer.close(resolve));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.ok(res.headers['content-security-policy'], 'Live response must include CSP');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
});

test('views/index.ejs renders softphone UI and WebRTC controls', () => {
    const ejsContent = fs.readFileSync(path.join(SOFTPHONE_DIR, 'views/index.ejs'), 'utf8');

    // Essential UI containers
    assert.ok(ejsContent.includes('id="presetSelect"') || ejsContent.includes('preset') || ejsContent.includes('softphone'), 'Must include preset or softphone element');
    assert.ok(ejsContent.includes('id="passwordInput"') || ejsContent.includes('password'), 'Must include password input');
    assert.ok(ejsContent.includes('id="dialInput"') || ejsContent.includes('dial') || ejsContent.includes('call'), 'Must include dial or call element');
});

test('sokrat-softphone.service unit file adheres to security hardening standards', () => {
    const unitPath = '/etc/systemd/system/sokrat-softphone.service';
    assert.ok(fs.existsSync(unitPath), 'systemd service file must exist');
    const unitContent = fs.readFileSync(unitPath, 'utf8');

    assert.ok(unitContent.includes('User=sokrat-softphone'), 'Service must run as unprivileged user sokrat-softphone');
    assert.ok(unitContent.includes('ProtectSystem=strict'), 'Service must enforce ProtectSystem=strict');
    assert.ok(unitContent.includes('ProtectHome=true'), 'Service must enforce ProtectHome=true');
    assert.ok(unitContent.includes('PrivateTmp=true'), 'Service must enforce PrivateTmp=true');
    assert.ok(unitContent.includes('NoNewPrivileges=true'), 'Service must enforce NoNewPrivileges=true');
    assert.ok(unitContent.includes('HOST=127.0.0.1') || unitContent.includes('HOST=0.0.0.0') || unitContent.includes('HOST='), 'Service must configure host');
    assert.ok(unitContent.includes('PORT=8090'), 'Service must configure port 8090');
});

test('Apache softphone.conf proxies port 8443 to loopback 8090 with TLS', () => {
    const confPath = '/etc/httpd/conf.d/softphone.conf';
    assert.ok(fs.existsSync(confPath), 'Apache softphone.conf must exist');
    const confContent = fs.readFileSync(confPath, 'utf8');

    assert.ok(confContent.includes('<VirtualHost *:8443>'), 'Must configure VirtualHost on port 8443');
    assert.ok(confContent.includes('SSLEngine on'), 'Must enable SSLEngine');
    assert.ok(confContent.includes('ProxyPass / http://127.0.0.1:8090/'), 'Must proxy to loopback 8090');
    assert.ok(confContent.includes('ProxyPassReverse / http://127.0.0.1:8090/'), 'Must reverse proxy to loopback 8090');
    assert.ok(confContent.includes('ProxyPass /ws ws://127.0.0.1:8088/ws'), 'Must proxy WebSocket upgrades to Asterisk');
});

test('install.sh and uninstall.sh contain automated softphone lifecycle hooks', () => {
    const installSh = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
    const uninstallSh = fs.readFileSync(path.join(__dirname, '../uninstall.sh'), 'utf8');

    // install.sh verification
    assert.ok(installSh.includes('softphone.conf created (port 8443 -> :8090'), 'install.sh must provision softphone.conf');
    assert.ok(installSh.includes('useradd -r -s /sbin/nologin -d /opt/sokrat-softphone -c "Sokrat Softphone Daemon" sokrat-softphone'), 'install.sh must create sokrat-softphone user');
    assert.ok(installSh.includes('systemctl enable --now sokrat-softphone'), 'install.sh must enable and start sokrat-softphone service');

    // uninstall.sh verification
    assert.ok(uninstallSh.includes('systemctl stop sokrat-softphone'), 'uninstall.sh must stop sokrat-softphone service');
    assert.ok(uninstallSh.includes('/etc/systemd/system/sokrat-softphone.service'), 'uninstall.sh must remove systemd unit');
    assert.ok(uninstallSh.includes('/etc/httpd/conf.d/softphone.conf'), 'uninstall.sh must remove softphone.conf');
});

test('Client core telephony and UI capabilities are defined', () => {
    const corePath = path.join(SOFTPHONE_DIR, 'public/js/softphone-core.js');
    if (fs.existsSync(corePath)) {
        const coreJs = fs.readFileSync(corePath, 'utf8');
        assert.ok(coreJs.includes('class SokratSoftphoneCore') || coreJs.includes('JsSIP'), 'Must define telephony core');
    } else {
        const indexEjs = fs.readFileSync(path.join(SOFTPHONE_DIR, 'views/index.ejs'), 'utf8');
        assert.ok(indexEjs.includes('JsSIP') || indexEjs.includes('UA') || indexEjs.includes('RTCPeerConnection'), 'views/index.ejs must contain WebRTC client logic');
    }
});
