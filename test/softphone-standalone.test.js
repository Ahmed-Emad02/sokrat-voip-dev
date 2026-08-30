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
    assert.ok(fs.existsSync(path.join(SOFTPHONE_DIR, 'public/js/softphone-core.js')), 'public/js/softphone-core.js must exist');
    assert.ok(fs.existsSync(path.join(SOFTPHONE_DIR, 'public/js/softphone-ui.js')), 'public/js/softphone-ui.js must exist');
    assert.ok(fs.existsSync(path.join(SOFTPHONE_DIR, 'public/css/softphone.css')), 'public/css/softphone.css must exist');
});

test('Standalone server.js enforces strict CSP and security headers', async () => {
    const serverJs = fs.readFileSync(path.join(SOFTPHONE_DIR, 'server.js'), 'utf8');
    assert.ok(serverJs.includes("Content-Security-Policy"), 'Must set Content-Security-Policy header');
    assert.ok(serverJs.includes("X-Frame-Options"), 'Must set X-Frame-Options header');
    assert.ok(serverJs.includes("X-Content-Type-Options"), 'Must set X-Content-Type-Options header');
    assert.ok(serverJs.includes("Permissions-Policy"), 'Must set Permissions-Policy header');
    assert.ok(serverJs.includes("127.0.0.1"), 'Must bind to loopback 127.0.0.1');

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

    testServer.close();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.service, 'sokrat-softphone');
    assert.strictEqual(res.body.version, '2.0.0');
    assert.ok(res.headers['content-security-policy'], 'Live response must include CSP');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
});

test('views/index.ejs renders zero external CDN dependencies and supports RTL/LTR', () => {
    const ejsContent = fs.readFileSync(path.join(SOFTPHONE_DIR, 'views/index.ejs'), 'utf8');

    // No external script tags or CDNs
    assert.ok(!ejsContent.includes('cdn.jsdelivr.net'), 'Must not include external jsdelivr CDN');
    assert.ok(!ejsContent.includes('cdnjs.cloudflare.com'), 'Must not include external cloudflare CDN');
    assert.ok(!ejsContent.includes('fonts.googleapis.com'), 'Must not include external google fonts CDN');

    // Essential UI containers
    assert.ok(ejsContent.includes('id="presetSelect"'), 'Must include preset select element');
    assert.ok(ejsContent.includes('id="passwordInput"'), 'Must include password input');
    assert.ok(ejsContent.includes('id="dialInput"'), 'Must include dial input');
    assert.ok(ejsContent.includes('id="keypadGrid"'), 'Must include keypad grid');
    assert.ok(ejsContent.includes('id="vuMeterBar"'), 'Must include VU meter bar');
    assert.ok(ejsContent.includes('id="activeCallContainer"'), 'Must include active call container');
    assert.ok(ejsContent.includes('id="callHistoryList"'), 'Must include call history list');
    assert.ok(ejsContent.includes('id="remoteAudio"'), 'Must include remote audio element');
    assert.ok(ejsContent.includes('id="takeOverOverlay"'), 'Must include multi-window take-over overlay');
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
    assert.ok(unitContent.includes('HOST=127.0.0.1'), 'Service must configure loopback host');
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

test('Client core telephony state machine exports valid DTMF and state contracts', () => {
    const coreJs = fs.readFileSync(path.join(SOFTPHONE_DIR, 'public/js/softphone-core.js'), 'utf8');

    assert.ok(coreJs.includes('class SokratSoftphoneCore'), 'Must define SokratSoftphoneCore class');
    assert.ok(coreJs.includes("status_code: 486, reason_phrase: 'Busy Here (DND)'"), 'Must reject calls with 486 when DND active');
    assert.ok(coreJs.includes("status_code: 486, reason_phrase: 'Busy Here'"), 'Must reject calls with 486 when already busy');
    assert.ok(coreJs.includes("DTMF_FREQS"), 'Must contain standard DTMF frequencies table');
    assert.ok(coreJs.includes("echoCancellation: { ideal: true }"), 'Must configure WebRTC AEC constraints');
    assert.ok(coreJs.includes("noiseSuppression: { ideal: true }"), 'Must configure WebRTC NS constraints');
    assert.ok(coreJs.includes("autoGainControl: { ideal: true }"), 'Must configure WebRTC AGC constraints');
});

test('Client UI controller enforces metadata-only preset storage and safe DOM rendering', () => {
    const uiJs = fs.readFileSync(path.join(SOFTPHONE_DIR, 'public/js/softphone-ui.js'), 'utf8');

    assert.ok(uiJs.includes('sokrat_softphone_presets_v2'), 'Must use versioned metadata preset key');
    assert.ok(uiJs.includes('sokrat_softphone_call_logs_v2'), 'Must use versioned call log key');
    assert.ok(uiJs.includes('sessionSecrets = new Map()'), 'Must use in-memory transient secret map');
    assert.ok(uiJs.includes('document.createElement'), 'Must use document.createElement for safe DOM rendering');
    assert.ok(uiJs.includes('documentPictureInPicture.requestWindow'), 'Must support Document Picture-in-Picture');
});
