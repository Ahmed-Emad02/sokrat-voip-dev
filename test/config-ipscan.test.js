const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const rootDir = path.resolve(__dirname, '..');
const ipScanner = require(path.join(rootDir, 'lib', 'ip-scanner'));

test('Interface Isolation: getLocalPhysicalInterfaces strictly excludes VPNs and container bridges', () => {
    const ifaces = ipScanner.getLocalPhysicalInterfaces();
    assert.ok(Array.isArray(ifaces), 'Must return an array of interfaces');
    assert.ok(ifaces.length > 0, 'Must detect at least one physical local interface');

    for (const iface of ifaces) {
        const name = iface.iface.toLowerCase();
        assert.ok(!name.startsWith('tailscale'), `Tailscale VPN interface ${name} must be excluded`);
        assert.ok(!name.startsWith('zt'), `ZeroTier VPN interface ${name} must be excluded`);
        assert.ok(!name.startsWith('tun') && !name.startsWith('tap') && !name.startsWith('wg'), `VPN tunnel ${name} must be excluded`);
        assert.ok(!name.startsWith('docker') && !name.startsWith('br-') && !name.startsWith('veth'), `Container bridge ${name} must be excluded`);
        assert.notStrictEqual(name, 'lo', 'Loopback interface must be excluded');

        // Check for physical hardware device
        const hasDevice = fs.existsSync('/sys/class/net/' + iface.iface + '/device');
        assert.ok(hasDevice, `Interface ${iface.iface} must be a physical hardware NIC`);

        // Check IP format
        assert.match(iface.ip, /^(\d{1,3}\.){3}\d{1,3}$/, 'Must have valid IPv4');
        assert.match(iface.subnet, /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, 'Must have valid CIDR subnet');
    }
});

test('Security Target Guard: isTargetAllowed approves local subnets and rejects VPN / public IPs', () => {
    const localIfaces = ipScanner.getLocalPhysicalInterfaces();
    const primarySubnet = localIfaces[0].subnet;
    const primaryIp = localIfaces[0].ip;

    // 1. Allowed Local Targets
    assert.strictEqual(ipScanner.isTargetAllowed(primarySubnet, localIfaces), true, 'Primary local subnet must be allowed');
    assert.strictEqual(ipScanner.isTargetAllowed(primaryIp, localIfaces), true, 'Primary local IP must be allowed');

    // 2. Prohibited VPN Targets
    assert.strictEqual(ipScanner.isTargetAllowed('100.98.185.86', localIfaces), false, 'Tailscale VPN IP must be rejected');
    assert.strictEqual(ipScanner.isTargetAllowed('100.64.0.0/10', localIfaces), false, 'Tailscale CGNAT range must be rejected');
    assert.strictEqual(ipScanner.isTargetAllowed('10.252.63.47', localIfaces), false, 'ZeroTier IP must be rejected');
    assert.strictEqual(ipScanner.isTargetAllowed('10.200.227.0/24', localIfaces), false, 'ZeroTier subnet must be rejected');

    // 3. Prohibited Public / Loopback Targets
    assert.strictEqual(ipScanner.isTargetAllowed('8.8.8.8', localIfaces), false, 'Public WAN IP must be rejected');
    assert.strictEqual(ipScanner.isTargetAllowed('1.1.1.1', localIfaces), false, 'Public WAN IP must be rejected');
    assert.strictEqual(ipScanner.isTargetAllowed('127.0.0.1', localIfaces), false, 'Loopback must be rejected');
    assert.strictEqual(ipScanner.isTargetAllowed('0.0.0.0/0', localIfaces), false, 'Default route must be rejected');
    assert.strictEqual(ipScanner.isTargetAllowed('', localIfaces), false, 'Empty target must be rejected');
});

test('Nmap XML Parser: Accurately transforms XML into structured device and port records', () => {
    const sampleXml = `
    <nmaprun>
      <host>
        <status state="up" reason="arp-response"/>
        <address addr="192.168.100.223" addrtype="ipv4"/>
        <address addr="00:0B:82:11:22:33" addrtype="mac" vendor="Grandstream Networks"/>
        <hostnames><hostname name="GXP2160-Sales"/></hostnames>
        <times srtt="1200"/>
        <ports>
          <port protocol="tcp" portid="80"><state state="open"/><service name="http"/></port>
          <port protocol="tcp" portid="5060"><state state="open"/><service name="sip"/></port>
          <port protocol="tcp" portid="22"><state state="closed"/></port>
        </ports>
      </host>
      <host>
        <status state="down"/>
        <address addr="192.168.100.224" addrtype="ipv4"/>
      </host>
    </nmaprun>
    `;

    const parsed = ipScanner.parseNmapXml(sampleXml);
    assert.strictEqual(parsed.length, 1, 'Only hosts in state "up" should be included');

    const dev = parsed[0];
    assert.strictEqual(dev.ip, '192.168.100.223');
    assert.strictEqual(dev.mac, '00:0B:82:11:22:33');
    assert.strictEqual(dev.vendor, 'Grandstream Networks');
    assert.strictEqual(dev.hostname, 'GXP2160-Sales');
    assert.strictEqual(dev.status, 'up');
    assert.strictEqual(dev.isVoipDevice, true, 'Grandstream with SIP port must be flagged as VoIP device');
    assert.strictEqual(dev.httpServerName, '');
    assert.strictEqual(dev.ports.length, 2, 'Only open ports (80, 5060) should be included');
    assert.strictEqual(dev.ports[0].port, 80);
    assert.strictEqual(dev.ports[1].port, 5060);
});

test('HTTP/HTTPS Web Server Name Discovery: Accurately probes and detects web server banner and HTML title', async () => {
    // Probe local server (which runs Apache + Sokrat VOIP)
    const testHost = [{
        ip: '192.168.100.50',
        ports: [{ port: 80, protocol: 'tcp', state: 'open', service: 'http' }]
    }];

    const enriched = await ipScanner.enrichHostsWithWebInfo(testHost);
    assert.ok(enriched[0].httpServerName, 'Must populate httpServerName');
    assert.match(enriched[0].httpServerName, /Apache|Sokrat/i, 'Must detect web server software or page title');
    assert.strictEqual(enriched[0].httpPort, 80, 'Must record the probed web port');
});

test('UI Template Integration: views/config.ejs renders IP scan subtab and Web Server column', () => {
    const configHtml = fs.readFileSync(path.join(rootDir, 'views', 'config.ejs'), 'utf8') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '');

    // Sub-sidebar button
    assert.match(configHtml, /id="tab-btn-ipscan"/, 'Subtab button must exist in sidebar');
    assert.match(configHtml, /switchTab\('ipscan'\)/, 'Subtab button must trigger switchTab("ipscan")');

    // Top pill button
    assert.match(configHtml, /data-tab-target="ipscan"/, 'Top pill bar must include ipscan target');

    // Content section
    assert.match(configHtml, /id="section-ipscan"/, 'Main content section #section-ipscan must exist');
    assert.match(configHtml, /id="ipscan-iface-select"/, 'Must include interface selector');
    assert.match(configHtml, /id="ipscan-profile-select"/, 'Must include profile selector');
    assert.match(configHtml, /id="btn-ipscan-start"/, 'Must include start scan button');
    assert.match(configHtml, /id="ipscan-table-body"/, 'Must include results table body');
    assert.match(configHtml, /Web Server \/ HTTP Title/, 'Table header must include Web Server / HTTP Title column');
    assert.match(configHtml, /webServerHtml/, 'Client template must render webServerHtml');
    assert.match(configHtml, /fetchIpscanInterfaces/, 'Must include client-side fetchIpscanInterfaces function');

    // Built-in Web Console modal
    assert.match(configHtml, /id="deviceWebConsoleModal"/, 'Built-in device web console modal must exist');
    assert.match(configHtml, /id="deviceWebConsoleIframe"/, 'Device web console iframe must exist');
    assert.match(configHtml, /openDeviceWebConsole/, 'openDeviceWebConsole function must exist');
});

test('Proxy Security Guard: handleDeviceProxy rejects VPN and public targets with 403', () => {
    let statusCode = null;
    let sentBody = '';
    const mockRes = {
        status: (code) => { statusCode = code; return mockRes; },
        send: (msg) => { sentBody = msg; return mockRes; }
    };

    // Attempt to proxy to a Tailscale VPN address
    ipScanner.handleDeviceProxy({
        params: { targetIp: '100.98.185.86', targetPort: '80' },
        query: {},
        headers: {},
        url: '/',
        path: '/'
    }, mockRes);

    assert.strictEqual(statusCode, 403, 'Must return 403 when proxying to VPN IP');
    assert.match(sentBody, /Forbidden/i, 'Must return Forbidden message');

    // Attempt to proxy to a public WAN IP
    ipScanner.handleDeviceProxy({
        params: { targetIp: '8.8.8.8', targetPort: '80' },
        query: {},
        headers: {},
        url: '/',
        path: '/'
    }, mockRes);

    assert.strictEqual(statusCode, 403, 'Must return 403 when proxying to public IP');
});

test('API Security: /api/config/ipscan endpoints require authentication', async () => {
    const res = await makeGetRequest('/api/config/ipscan/interfaces');
    assert.strictEqual(res.statusCode, 401, 'Unauthenticated request to ipscan interfaces must return 401');

    const scanRes = await makePostRequest('/api/config/ipscan/scan', { target: '100.98.185.86' });
    assert.strictEqual(scanRes.statusCode, 401, 'Unauthenticated request to ipscan scan must return 401');

    const proxyRes = await makeGetRequest('/api/config/ipscan/proxy/192.168.100.50/80/');
    assert.strictEqual(proxyRes.statusCode, 401, 'Unauthenticated request to ipscan proxy must return 401');
});

test('Proxy Persistence & URL Rewriting: Rewrites absolute device URLs and form actions to proxy paths', async () => {
    // Test proxying localhost 192.168.100.50 port 80 /login
    const mockReq = {
        params: { targetIp: '192.168.100.50', targetPort: '80', 0: 'login' },
        query: {},
        headers: { 'user-agent': 'test-agent' },
        method: 'GET',
        url: '/api/config/ipscan/proxy/192.168.100.50/80/login',
        path: '/login'
    };

    let capturedCode = null;
    let capturedHeaders = null;
    let capturedBody = '';

    await new Promise((resolve) => {
        const mockRes = {
            status: function(code) { this.statusCode = code; return this; },
            send: function() { resolve(); },
            writeHead: function(code, headers) {
                capturedCode = code;
                capturedHeaders = headers;
            },
            end: function(chunk) {
                if (chunk) capturedBody += chunk.toString();
                resolve();
            }
        };

        ipScanner.handleDeviceProxy(mockReq, mockRes);
    });

    assert.strictEqual(capturedCode, 200, 'Must return 200 for local proxy target');
    assert.strictEqual(capturedHeaders['x-frame-options'], undefined, 'Must strip x-frame-options');
    assert.strictEqual(capturedHeaders['content-security-policy'], undefined, 'Must strip content-security-policy');
    assert.ok(capturedBody.includes('<base href="/api/config/ipscan/proxy/192.168.100.50/80/">'), 'Must inject base tag');
    assert.ok(capturedBody.includes('__sokrat_proxy_bridge'), 'Must inject client proxy bridge script');
});

test('Proxy POST Forwarding: Serializes and sends parsed req.body to prevent gateway timeouts on forms', async () => {
    const mockReq = {
        params: { targetIp: '192.168.100.50', targetPort: '80', 0: 'login' },
        query: {},
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'test-agent'
        },
        method: 'POST',
        body: { username: 'testuser', password: 'testpassword' },
        readableEnded: true,
        url: '/api/config/ipscan/proxy/192.168.100.50/80/login',
        path: '/login'
    };

    let postResCode = null;
    await new Promise((resolve) => {
        const mockRes = {
            status: function(code) { this.statusCode = code; return this; },
            send: function() { resolve(); },
            writeHead: function(code) { postResCode = code; },
            end: function() { resolve(); }
        };
        ipScanner.handleDeviceProxy(mockReq, mockRes);
    });

    assert.ok(postResCode !== null && postResCode !== 504, 'Must forward POST body without timing out');
});

test('UI Template Integration: views/config.ejs removes iframe sandbox to prevent permissions policy warnings', () => {
    const configHtml = fs.readFileSync(path.join(rootDir, 'views', 'config.ejs'), 'utf8') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '');
    assert.strictEqual(
        configHtml.includes('sandbox="allow-same-origin'),
        false,
        'Must not contain restrictive sandbox on deviceWebConsoleIframe'
    );
    assert.match(
        configHtml,
        /window\.addEventListener\('message',\s*function\(e\)/,
        'Must contain message listener for proxy navigation syncing'
    );
});

test('Server Referer Middleware: server.js catches escaped subresources from proxied consoles', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
    assert.match(
        serverCode,
        /req\.headers\.referer\.match\(\/\\\/api\\\/config\\\/ipscan\\\/proxy/i,
        'server.js must include referer catch-all middleware for proxied consoles'
    );
});

test('API Security & Scope Gating: requireConfigPermission strictly protects all ipscan endpoints', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
    assert.match(serverCode, /app\.get\('\/api\/config\/ipscan\/interfaces',\s*requireConfigPermission\('ipscan'\)/);
    assert.match(serverCode, /app\.post\('\/api\/config\/ipscan\/scan',\s*requireConfigPermission\('ipscan'\)/);
    assert.match(serverCode, /app\.get\('\/api\/config\/ipscan\/status',\s*requireConfigPermission\('ipscan'\)/);
    assert.match(serverCode, /app\.post\('\/api\/config\/ipscan\/stop',\s*requireConfigPermission\('ipscan'\)/);
    assert.match(serverCode, /app\.get\('\/api\/config\/ipscan\/export',\s*requireConfigPermission\('ipscan'\)/);
    assert.match(serverCode, /app\.all\('\/api\/config\/ipscan\/proxy\/:targetIp\/:targetPort\/\*',\s*requireConfigPermission\('ipscan'\)/);
    assert.match(serverCode, /app\.all\('\/api\/config\/ipscan\/proxy\/:targetIp\/:targetPort',\s*requireConfigPermission\('ipscan'\)/);
});

test('Agnostic Cookie Isolation & Virtualization: Namespaces target cookies and prevents session poisoning', () => {
    const scannerCode = fs.readFileSync(path.join(rootDir, 'lib', 'ip-scanner.js'), 'utf8');
    assert.match(scannerCode, /__dev_/, 'Must define device cookie prefix for virtualization');
    assert.match(scannerCode, /delete forwardHeaders\['cookie'\]|forwardHeaders\['cookie'\] = targetCookies/, 'Must isolate target cookies from host session');
    assert.match(scannerCode, /connect\.sid=;\s*Path=\$\{proxyBase\}/, 'Must clear legacy shadowed connect.sid cookies');
});

test('Pre-Session Sanitizer & Intelligent Auth: server.js cleans foreign cookies and redirects HTML navigations', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
    assert.match(serverCode, /cleanSessionCookies/, 'Must include cleanSessionCookies pre-session middleware');
    assert.match(serverCode, /isProxyBrowserRequest/, 'requireAuth must distinguish HTML browser navigations to proxy routes from JSON APIs');
});

test('Scan Completion Toast: Guarded against repeated toasts and orphaned polls', () => {
    const configScript = fs.readFileSync(path.join(rootDir, 'views', 'scripts', 'config-page.ejs'), 'utf8');
    const sidebarScript = fs.readFileSync(path.join(rootDir, 'views', 'sidebar.ejs'), 'utf8');

    // 1. Actively scanning state tracking
    assert.match(configScript, /let ipscanIsActivelyScanning\s*=\s*false;/, 'Must define ipscanIsActivelyScanning flag');
    assert.match(configScript, /let ipscanFetchingStatus\s*=\s*false;/, 'Must define in-flight fetch guard');

    // 2. Completion toast must be guarded by ipscanIsActivelyScanning
    assert.match(
        configScript,
        /if\s*\(\s*ipscanIsActivelyScanning\s*\)\s*\{[\s\S]*?ipscanIsActivelyScanning\s*=\s*false;[\s\S]*?Scan complete:/,
        'Completion toast must ONLY fire if ipscanIsActivelyScanning was true and immediately reset'
    );

    // 3. sokratPoll must cleanly unsubscribe visibilitychange on stop()
    assert.match(sidebarScript, /let isStopped\s*=\s*false;/, 'sokratPoll must maintain isStopped state');
    assert.match(sidebarScript, /document\.removeEventListener\('visibilitychange',\s*onVisibilityChange\)/, 'sokratPoll.stop() must remove visibilitychange listener');
});

function makeGetRequest(endpoint) {
    return new Promise((resolve) => {
        http.get({
            hostname: '127.0.0.1',
            port: 8080,
            path: endpoint
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }).on('error', err => resolve({ statusCode: 500, error: err.message }));
    });
}

function makePostRequest(endpoint, body) {
    return new Promise((resolve) => {
        const postData = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port: 8080,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', err => resolve({ statusCode: 500, error: err.message }));
        req.write(postData);
        req.end();
    });
}
