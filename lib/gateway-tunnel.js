'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const dgram = require('node:dgram');
const net = require('node:net');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = '/etc/sokrat';
const IDENTITY = path.join(ROOT, 'gateway-tunnel-identity.json');
const SETTINGS = path.join(ROOT, 'gateway-tunnel-v2.json');
const FRPC = '/etc/frp/frpc.toml';
let connecting = false;
let readinessBusy = false;

function atomic(file, content, mode = 0o600) {
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
        if (fs.existsSync(directory)) {
            const info = fs.lstatSync(directory);
            if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022)) throw new Error('Unsafe installation directory');
        }
        if (directory === path.dirname(directory)) break;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022)) throw new Error('Unsafe installation file');
    }
    const temporary = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
    try {
        fs.writeFileSync(temporary, content, { mode, flag: 'wx' });
        fs.renameSync(temporary, file);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function pairing(value) {
    if (typeof value !== 'string' || !value.startsWith('sk_pair_v2_') || value.length > 16384) {
        throw new Error('Copy the current secure pairing code from the gateway dashboard');
    }
    let code;
    try { code = JSON.parse(Buffer.from(value.slice(11), 'base64url').toString()); }
    catch { throw new Error('Invalid secure pairing code'); }
    if (code.v !== 2 || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(code.host)
        || !Number.isInteger(code.port) || code.port < 1 || code.port > 65535
        || typeof code.ca !== 'string' || !code.ca.startsWith('-----BEGIN CERTIFICATE-----')
        || !/^[A-Za-z0-9_-]{43,128}$/.test(code.secret)) throw new Error('Invalid secure pairing code');
    new crypto.X509Certificate(code.ca);
    return code;
}

function identity() {
    if (fs.existsSync(IDENTITY)) {
        const info = fs.lstatSync(IDENTITY);
        if (!info.isFile() || info.uid !== 0 || (info.mode & 0o077)) throw new Error('Unsafe installation identity file');
        const saved = JSON.parse(fs.readFileSync(IDENTITY));
        if (!/^[a-f0-9]{32}$/.test(saved.installationId) || !/^[A-Za-z0-9_-]{43}$/.test(saved.installationSecret)) throw new Error('Invalid saved installation identity');
        return saved;
    }
    const value = { installationId: crypto.randomBytes(16).toString('hex'), installationSecret: crypto.randomBytes(32).toString('base64url') };
    atomic(IDENTITY, JSON.stringify(value) + '\n');
    return value;
}

function enroll(code, installation, name) {
    const body = JSON.stringify({ ...installation, pairingSecret: code.secret, name });
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname: code.host, port: code.port, path: '/register', method: 'POST',
            ca: code.ca, rejectUnauthorized: true, timeout: 45000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
            let data = '';
            res.on('data', chunk => {
                data += chunk;
                if (Buffer.byteLength(data) > 65536) req.destroy(new Error('Enrollment response too large'));
            });
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (res.statusCode !== 200 || result.success !== true) throw new Error('Gateway refused enrollment; check the pairing code and server approval');
                    resolve(result);
                } catch (error) { reject(error); }
            });
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('Secure enrollment timed out; retry with the same pairing code')));
        req.on('error', reject);
        req.end(body);
    });
}

function service(args) {
    return execFileSync('systemctl', args, { timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function active(unit) {
    try { return service(['is-active', unit]).trim() === 'active'; } catch { return false; }
}

function status() {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(SETTINGS)); } catch {}
    return { installed: fs.existsSync('/usr/local/bin/frpc'), configured: !!saved,
        active: !!saved && active('frpc'), mediaActive: !!saved && active(`sokrat-media-${saved.pbxId}`),
        serverAddr: saved?.serverHost || '', serverPort: saved?.tunnelPort || 7000,
        pbxId: saved?.pbxId || null, secureEnrollment: true };
}

function validateResponse(result, code, installation) {
    if (!/^pbx_[a-f0-9]{16}$/.test(result.pbxId) || result.installationId !== installation.installationId
        || result.serverHost !== code.host || result.serverName !== code.host || result.serverCa !== code.ca
        || !Number.isInteger(result.tunnelPort) || result.tunnelPort < 1 || result.tunnelPort > 65535
        || !/^[A-Za-z0-9_-]{32,200}$/.test(result.frpToken) || !/^[A-Za-z0-9_-]{32,200}$/.test(result.hookToken)
        || !/^[A-Za-z0-9_-]{43}$/.test(result.readinessKey)) throw new Error('Invalid gateway enrollment response');
    for (const kind of ['ws', 'api', 'media']) {
        if (!Number.isInteger(result.ports?.[kind]) || result.ports[kind] < 1024 || result.ports[kind] > 65535) throw new Error('Invalid scoped tunnel port');
    }
    const slot = result.plan?.slot;
    if (!Number.isInteger(slot) || slot < 0 || slot >= 155 || result.plan.pbxId !== result.pbxId
        || result.ports.ws !== 23000 + slot * 2 || result.ports.api !== 23001 + slot * 2
        || result.ports.media !== 22000 + slot) throw new Error('Media and tunnel allocation mismatch');
    // readiness() compares the echo peer against plan.gatewayIp and binds on
    // plan.pbxIp; a malformed value would make readiness fail permanently with
    // no actionable message, so reject it at enrollment time instead.
    for (const key of ['gatewayIp', 'pbxIp']) {
        if (!net.isIP(String(result.plan[key] || ''))) throw new Error('Invalid gateway plan addressing');
    }
    const url = new URL(result.gatewayUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== code.host
        || Number(url.port || 443) !== code.port || !['', '/'].includes(url.pathname)
        || url.search || url.hash) throw new Error('Invalid gateway push URL');
}

function frpcConfig(result, installation) {
    const quoted = JSON.stringify;
    let config = `serverAddr = ${quoted(result.serverHost)}\nserverPort = ${result.tunnelPort}\nuser = ${quoted(result.pbxId)}\nauth.method = "token"\nauth.token = ${quoted(result.frpToken)}\ntransport.tls.enable = true\ntransport.tls.trustedCaFile = "/etc/frp/gateway-ca.crt"\ntransport.tls.serverName = ${quoted(result.serverName)}\nmetadatas.installationSecret = ${quoted(installation.installationSecret)}\n`;
    for (const [kind, localPort] of [['ws', 8088], ['api', 8080], ['media', 17001]]) {
        config += `\n[[proxies]]\nname = ${quoted(kind)}\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = ${localPort}\nremotePort = ${result.ports[kind]}\n`;
    }
    return config;
}

function verifyOpenvpn(result) {
    // Rocky's OpenVPN 2.4 prints a valid version but returns 1 for --version.
    // Do not ignore execution failures or accept an arbitrary nonzero exit.
    const match = /^OpenVPN 2\.(\d+)\./m.exec(String(result.stdout || ''));
    if (result.error || result.signal || ![0, 1].includes(result.status)
        || !match || Number(match[1]) < 4) throw new Error('Supported OpenVPN 2.4 or newer 2.x is required');
}

async function configure(input) {
    const code = pairing(String(input.token || '').trim());
    // The pairing code is authoritative for the gateway identity. An operator
    // may still type the host as a cross-check, but a blank value must not be
    // treated as a mismatch.
    const requested = String(input.serverAddr || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (requested && requested !== code.host) throw new Error('Gateway address must match the host in the pairing code');
    if (fs.existsSync(path.join(ROOT,'gateway-hook.json')) && !fs.existsSync(IDENTITY)) {
        throw new Error('An existing gateway owns this PBX push hook; stage an explicit installation migration first');
    }
    const installer = path.join(__dirname, '../scripts/install-media-link.py');
    const sender = path.join(__dirname, '../scripts/pbx-tenant-push-hook.py');
    const hookInstaller = path.join(__dirname, '../scripts/install-tenant-push-hook.py');
    const wakeInstaller = path.join(__dirname, '../scripts/install-webrtc-wake.py');
    const wakeSender = path.join(__dirname, '../scripts/webrtc-wake-dispatch.py');
    for (const file of [installer,sender,hookInstaller,wakeInstaller,wakeSender]) {
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022)) throw new Error('Root-owned tunnel installers are required; upgrade the PBX first');
    }
    execFileSync('python3',['-c','import cryptography'],{timeout:10000,stdio:'pipe'});
    verifyOpenvpn(spawnSync('/usr/sbin/openvpn',['--version'],{timeout:10000,encoding:'utf8'}));
    if (!fs.existsSync('/usr/local/bin/frpc')) {
        const bundled = path.join(__dirname, '../installer-bundle/binaries/frpc');
        atomic('/usr/local/bin/frpc',fs.readFileSync(bundled),0o755);
    }
    const hookArgs = [hookInstaller,'--dialplan-file','/etc/asterisk/extensions_sokrat.conf',
        '--hook-script',sender,'--config',path.join(ROOT,'gateway-hook.json'),
        '--callee-var','TARGET_EXT','--caller-var','SOKRAT_CALLER_NUM','--name-var','SOKRAT_CALLER_NAME'];
    // Refuse unsupported PBXs before gateway routing changes. This installer
    // inserts only the additive push action, never routes or trunk macros.
    // Use the eventual installed sender path so idempotence checks match it.
    atomic('/usr/local/bin/sokrat-tenant-push-hook.py',fs.readFileSync(sender),0o755);
    hookArgs[hookArgs.indexOf('--hook-script')+1] = '/usr/local/bin/sokrat-tenant-push-hook.py';
    execFileSync('python3',hookArgs,{timeout:10000,stdio:'pipe'});
    const install = identity();
    const name = os.hostname().replace(/[^A-Za-z0-9_. -]/g, '-').slice(0, 64);
    const result = await enroll(code, install, name);
    validateResponse(result, code, install);
    const old = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS)) : null;
    if (old && old.pbxId !== result.pbxId) throw new Error('Existing gateway assignment differs; explicit migration is required');
    // A fresh installation must not silently steal an existing gateway's hook.
    const hookFile = path.join(ROOT, 'gateway-hook.json');
    if (fs.existsSync(hookFile)) {
        const hook = JSON.parse(fs.readFileSync(hookFile));
        if (hook.pbxId !== result.pbxId) throw new Error('An existing gateway owns this PBX push hook; migrate it explicitly first');
    }
    execFileSync('python3', [installer, '--role', 'pbx', '--start'], {
        input: JSON.stringify({ plan: result.plan, material: result.material }), timeout: 45000,
        stdio: ['pipe', 'pipe', 'pipe'] });
    fs.mkdirSync('/etc/frp', { recursive: true, mode: 0o755 });
    fs.chmodSync('/etc/frp', 0o755);
    atomic('/etc/frp/gateway-ca.crt', result.serverCa, 0o644);
    atomic('/etc/frp/frpc.candidate.toml', frpcConfig(result, install));
    execFileSync('/usr/local/bin/frpc', ['verify', '-c', '/etc/frp/frpc.candidate.toml'], { timeout: 10000, stdio: 'pipe' });
    if (fs.existsSync(FRPC) && !fs.existsSync('/etc/frp/frpc.pre-v2.toml')) atomic('/etc/frp/frpc.pre-v2.toml', fs.readFileSync(FRPC));
    fs.renameSync('/etc/frp/frpc.candidate.toml', FRPC);
    atomic(hookFile, JSON.stringify({ gatewayUrl: result.gatewayUrl, pbxId: result.pbxId,
        token: result.hookToken, caFile: '/etc/frp/gateway-ca.crt' }) + '\n', 0o640);
    const uid = Number(execFileSync('id', ['-g', 'asterisk'], { encoding: 'utf8' }).trim());
    fs.chownSync(hookFile, 0, uid);
    atomic(SETTINGS, JSON.stringify({ pbxId: result.pbxId, plan: result.plan, readinessKey: result.readinessKey,
        serverHost: result.serverHost, tunnelPort: result.tunnelPort }) + '\n');
    // Install the generic sender only. Never rewrite trunk/desktop dialplans.
    const hookResult = execFileSync('python3',[...hookArgs,'--apply'],{timeout:10000,encoding:'utf8',stdio:'pipe'});
    // Wake compilation is additive and may legitimately refuse an extension
    // template the operator has customized. Never make the whole pairing fail
    // for that: the tunnel/hook/media are still usable, and the warning is
    // surfaced to the operator for follow-up.
    let wakeResult = { changed: false };
    let wakeWarning = '';
    try {
        wakeResult = JSON.parse(execFileSync('python3', [wakeInstaller, '--apply', '--no-reload'],
            { timeout: 10000, encoding: 'utf8', stdio: 'pipe' }));
    } catch (error) {
        const detail = [error.stdout, error.stderr, error.message]
            .map(value => String(value || '').trim()).filter(Boolean).join(' ')
            .replace(/\s+/g, ' ').slice(0, 240);
        wakeWarning = detail || 'WebRTC wake compiler refused';
    }
    if (hookResult.includes('Applied.') || wakeResult.changed) execFileSync('asterisk',['-rx','dialplan reload'],{timeout:15000,stdio:'pipe'});
    if (!fs.existsSync('/etc/systemd/system/frpc.service')) {
        atomic('/etc/systemd/system/frpc.service', '[Unit]\nDescription=Sokrat Reverse TLS Client\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=/usr/local/bin/frpc -c /etc/frp/frpc.toml\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\n', 0o644);
    }
    service(['daemon-reload']);service(['enable', 'frpc']);service(['restart', 'frpc']);
    return { success: true, ...status(), ...(wakeWarning ? { warning: wakeWarning } : {}),
        message: wakeWarning
            ? 'Secure tunnel configured; push hook and media are active. WebRTC wake setup needs attention.'
            : 'Secure tunnel configured; gateway is verifying push hook and media readiness' };
}

async function connect(input) {
    if (connecting) throw new Error('Tunnel enrollment is already in progress');
    connecting = true;
    try { return await configure(input); }
    finally { connecting = false; }
}

function disconnect() {
    if (connecting) throw new Error('Tunnel enrollment is already in progress');
    let saved;
    try { saved = JSON.parse(fs.readFileSync(SETTINGS)); } catch {}
    service(['disable', '--now', 'frpc']);
    if (saved) service(['disable', '--now', `sokrat-media-${saved.pbxId}`]);
    return { success: true, active: false, mediaActive: false };
}

/**
 * Authenticate the gateway's readiness probe and confirm the live incoming-call
 * wake path is actually installed.
 *
 * The effective wake path is the scoped compiler output
 * (/etc/asterisk/extensions_sokrat_webrtc_wake.conf) plus the root-owned
 * dispatcher; the legacy blanket macros are no longer part of it. The shared
 * [sub-sokrat-push-send] context is only required while the tenant hook binary
 * is present, so a PBX without it is not reported as unready forever.
 */
function readiness(req, res) {
    let settings, hook;
    try {
        settings = JSON.parse(fs.readFileSync(SETTINGS));
        const supplied = crypto.createHash('sha256').update(String(req.get('x-sokrat-readiness') || '')).digest();
        const expected = crypto.createHash('sha256').update(settings.readinessKey).digest();
        if (!crypto.timingSafeEqual(supplied, expected)) throw new Error('Unauthorized');
        hook = JSON.parse(fs.readFileSync(path.join(ROOT, 'gateway-hook.json')));
        if (hook.pbxId !== settings.pbxId || !/^[a-f0-9]{32}$/.test(req.body?.nonce)) throw new Error('Invalid readiness request');
        if (!fs.existsSync('/usr/local/bin/sokrat-webrtc-wake-dispatch.py')
            || !fs.existsSync('/etc/asterisk/extensions_sokrat_webrtc_wake.conf')
            || !fs.existsSync('/etc/frp/gateway-ca.crt')) throw new Error('Scoped wake path is not installed');
        if (fs.existsSync('/usr/local/bin/sokrat-tenant-push-hook.py')) {
            const dialplan = fs.readFileSync('/etc/asterisk/extensions_sokrat.conf', 'utf8');
            if (!dialplan.includes('[sub-sokrat-push-send]')
                || !dialplan.includes('/usr/local/bin/sokrat-tenant-push-hook.py')) throw new Error('Push sender is not installed');
        }
    } catch { return res.status(403).json({ ready: false }); }
    if (readinessBusy) return res.status(503).json({ ready: false });
    readinessBusy = true;
    const socket = dgram.createSocket('udp4');
    const nonce = req.body.nonce;
    const timer = setTimeout(() => { readinessBusy = false; try { socket.close(); } catch {} }, 10000);
    socket.once('close', () => { clearTimeout(timer); readinessBusy = false; });
    let attempts = 0;
    socket.on('message', (data, peer) => {
        if (attempts++ > 3 || peer.address !== settings.plan.gatewayIp
            || peer.port < 50000 + settings.plan.slot * 100 || peer.port > 50099 + settings.plan.slot * 100
            || data.toString() !== nonce) return;
        socket.send(data, peer.port, peer.address, () => socket.close());
    });
    // OS chooses a free RTP-range port. Never reserve a fixed port Asterisk
    // might already be using, and never change its configured RTP range.
    let candidate = 0;
    const tryBind = () => {
        if (candidate++ >= 32) {
            readinessBusy = false;clearTimeout(timer);
            try { socket.close(); } catch {}
            return res.status(503).json({ ready: false });
        }
        const port = 10000 + crypto.randomInt(10001);
        socket.bind(port, settings.plan.pbxIp);
    };
    socket.on('error', error => {
        if (error.code === 'EADDRINUSE' && !res.headersSent) return tryBind();
        readinessBusy = false;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        if (!res.headersSent) res.status(503).json({ ready: false });
    });
    socket.once('listening', () => res.json({ ready: true, pbxId: settings.pbxId,
        hookHash: crypto.createHash('sha256').update(hook.token).digest('hex'), echoPort: socket.address().port }));
    tryBind();
}

module.exports = { pairing, frpcConfig, validateResponse, verifyOpenvpn, status, connect, disconnect, readiness };
