/**
 * Overlay VPN providers (ZeroTier / Tailscale).
 *
 * The app runs as root, so the provider CLIs can be driven directly - but every
 * command is executed with execFile (no shell) and every provider / action is
 * allow-listed, so a crafted request can never reach an arbitrary command.
 *
 * Status parsing is kept as pure functions so it can be unit tested without a
 * VPN installed.
 */

const { execFile } = require('child_process');
const fs = require('fs');

const PROVIDERS = {
    zerotier: {
        id: 'zerotier',
        label: 'ZeroTier',
        binary: 'zerotier-cli',
        service: 'zerotier-one',
        unit: 'zerotier-one.service',
        package: 'zerotier-one',
        // ZeroTier needs no extra repository on Rocky/RHEL.
        repo: null
    },
    tailscale: {
        id: 'tailscale',
        label: 'Tailscale',
        binary: 'tailscale',
        service: 'tailscaled',
        unit: 'tailscaled.service',
        package: 'tailscale',
        // Tailscale is not in the base Rocky/RHEL repositories.
        repo: { name: 'tailscale' }
    }
};

const PROVIDER_IDS = Object.keys(PROVIDERS);
const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable', 'enable --now'];

// Tailscale hands out several different credential types and only node auth keys
// work with `tailscale up --authkey`. Sending an API access token (or an OAuth
// client secret) makes tailscaled answer with the rather cryptic
// "invalid key: unable to validate API key", so we catch it before exec.
const TAILSCALE_AUTH_KEY_PREFIX = 'tskey-auth-';
const TAILSCALE_API_TOKEN_PREFIX = 'tskey-api-';
const TAILSCALE_CLIENT_SECRET_PREFIX = 'tskey-client-';

/**
 * Build an Error that carries an HTTP status code plus a sanitized detail string.
 * The auth key (and anything that looks like one) is scrubbed from the message so
 * it can never leak into the response or the server log.
 */
function overlayError(message, statusCode = 500, cause = null, secrets = []) {
    let text = String(message || '').trim();
    for (const secret of secrets) {
        if (secret && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
    }
    const error = new Error(text);
    error.statusCode = statusCode;
    if (cause) {
        error.code = cause.code;
        error.stdout = cause.stdout || '';
        error.stderr = String(cause.stderr || '').split('\n').map(line => {
            let out = line;
            for (const secret of secrets) {
                if (secret && secret.length >= 8) out = out.split(secret).join('[REDACTED]');
            }
            return out;
        }).join('\n');
        error.detail = String(cause.stderr || cause.message || '').trim();
        for (const secret of secrets) {
            if (secret && secret.length >= 8) error.detail = error.detail.split(secret).join('[REDACTED]');
        }
    }
    return error;
}

/**
 * Validate a pasted Tailscale credential without touching the daemon.
 * Returns { valid, error, kind }.
 */
function classifyTailscaleAuthKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) return { valid: false, kind: 'empty', error: 'A Tailscale auth key is required.' };

    if (key.startsWith(TAILSCALE_API_TOKEN_PREFIX)) {
        return {
            valid: false,
            kind: 'api-token',
            error: 'This is a Tailscale API access token, not a node auth key. Open the Tailscale admin console → Settings → Keys, generate an auth key, and paste the value that starts with tskey-auth-.'
        };
    }
    if (key.startsWith(TAILSCALE_CLIENT_SECRET_PREFIX)) {
        return {
            valid: false,
            kind: 'client-secret',
            error: 'This is a Tailscale OAuth client secret, not a node auth key. Generate an auth key in the Tailscale admin console → Settings → Keys (it starts with tskey-auth-).'
        };
    }
    if (!key.startsWith(TAILSCALE_AUTH_KEY_PREFIX)) {
        return {
            valid: false,
            kind: 'unknown',
            error: 'That does not look like a Tailscale auth key. Auth keys start with tskey-auth-. Generate one in the Tailscale admin console → Settings → Keys.'
        };
    }
    // tskey-auth-<id>-<secret>; be permissive about length but reject whitespace.
    if (/\s/.test(key)) {
        return {
            valid: false,
            kind: 'malformed',
            error: 'The Tailscale auth key contains whitespace. Copy the key again without line breaks.'
        };
    }
    if (key.length < 20) {
        return {
            valid: false,
            kind: 'malformed',
            error: 'The Tailscale auth key looks truncated. Copy the full key from the Tailscale admin console.'
        };
    }
    return { valid: true, kind: 'auth-key', error: null };
}

/**
 * Turn tailscaled's stderr into something an operator can act on.
 * Returns { message, statusCode }.
 */
function describeTailscaleJoinError(rawError) {
    const text = String((rawError && (rawError.stderr || rawError.message)) || '').trim();
    const lower = text.toLowerCase();

    if (lower.includes('unable to validate api key') || lower.includes('invalid key')) {
        return {
            statusCode: 400,
            message: 'Tailscale rejected the credential. This usually means an API access token or OAuth secret was pasted instead of a node auth key — generate a key that starts with tskey-auth- in the Tailscale admin console → Settings → Keys.'
        };
    }
    if (lower.includes('expired')) {
        return {
            statusCode: 400,
            message: 'This Tailscale auth key has expired. Generate a new key in the Tailscale admin console → Settings → Keys.'
        };
    }
    if (lower.includes('revoked')) {
        return {
            statusCode: 400,
            message: 'This Tailscale auth key was revoked. Generate a new key in the Tailscale admin console → Settings → Keys.'
        };
    }
    if (lower.includes('already used') || lower.includes('already been used')) {
        return {
            statusCode: 400,
            message: 'This Tailscale auth key is single-use and has already been used. Generate a reusable or ephemeral key, or create a fresh one.'
        };
    }
    if (lower.includes('failed to connect to local tailscaled') || lower.includes('connection refused')) {
        return {
            statusCode: 503,
            message: 'The Tailscale daemon is not reachable. Start the tailscaled service and try again.'
        };
    }
    if (lower.includes('access denied') || lower.includes('permission denied')) {
        return {
            statusCode: 403,
            message: 'Tailscale denied the operation. Make sure the Sokrat service runs as root and tailscaled is healthy.'
        };
    }
    return {
        statusCode: 400,
        message: text || 'Tailscale could not join the network.'
    };
}

function execFileAsync(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout || '';
                err.stderr = stderr || '';
                return reject(err);
            }
            resolve({ stdout: stdout || '', stderr: stderr || '' });
        });
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Translate the daemon CLIs' low-level connection errors into an actionable
 * message. Both daemons answer with cryptic text when their service is down,
 * for example ZeroTier's "missing port and zerotier-one.port not found".
 */
function describeOverlayCliError(providerId, rawError) {
    const provider = PROVIDERS[providerId] || {};
    const label = provider.label || providerId || 'overlay VPN';
    const service = provider.service || providerId || 'the service';
    const text = String((rawError && (rawError.stderr || rawError.message)) || rawError || '').trim();
    const lower = text.toLowerCase();
    if (
        lower.includes('missing port') ||
        lower.includes('zerotier-one.port') ||
        lower.includes('connection failed') ||
        lower.includes('connection refused') ||
        lower.includes('service is not running') ||
        lower.includes('failed to connect')
    ) {
        return `The ${label} service (${service}) is not running, so its networks cannot be read. Start ${service} and try again.`;
    }
    return text || `${label} did not return its status.`;
}

/**
 * Poll systemctl until the unit is active. `systemctl enable --now` returns
 * before the daemon has written its runtime files (ZeroTier's port file in
 * particular), so the first CLI call right after a start would otherwise fail.
 */
async function waitForService(unit, timeoutMs = 15000, exec = execFileAsync) {
    const deadline = Date.now() + timeoutMs;
    let state = 'unknown';
    while (true) {
        try {
            const { stdout } = await exec('systemctl', ['is-active', unit]);
            state = String(stdout).trim() || 'unknown';
        } catch (err) {
            state = String((err && (err.stdout || err.stderr)) || '').trim() || 'inactive';
        }
        if (state === 'active') return { active: true, state };
        if (Date.now() >= deadline) return { active: false, state };
        await delay(500);
    }
}

/**
 * systemctl reports ZeroTier as active before the daemon has replaced its
 * runtime port file, so the first CLI call after a restart can still fail.
 * Poll a harmless CLI command until the control socket answers.
 */
async function waitForZeroTierCli(timeoutMs = 10000, exec = execFileAsync) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        try {
            await exec('zerotier-cli', ['info']);
            return true;
        } catch (_) { /* daemon is still starting */ }
        if (Date.now() >= deadline) return false;
        await delay(500);
    }
}

/**
 * The Tailscale repository for this host (Rocky / RHEL / CentOS family).
 */
function tailscaleRepo() {
    let major = '8';
    try {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
        const m = osRelease.match(/^VERSION_ID="?([0-9]+)/m);
        if (m) major = m[1];
    } catch (_) { /* keep the default */ }
    const base = `https://pkgs.tailscale.com/stable/rhel/${major}`;
    return {
        name: 'tailscale',
        url: `${base}/tailscale.repo`,
        base,
        gpg: `${base}/tailscale.gpg`
    };
}

function binaryExists(binary) {
    const paths = ['/usr/sbin', '/usr/bin', '/usr/local/bin', '/sbin', '/bin'];
    for (const dir of paths) {
        try {
            fs.accessSync(`${dir}/${binary}`, fs.constants.X_OK);
            return true;
        } catch (_) { /* keep looking */ }
    }
    return false;
}

/**
 * Parse the output of `zerotier-cli listnetworks`.
 * Lines look like:
 *   200 listnetworks <nwid> <name> <mac> <status> <type> <dev> <ips>
 */
function parseZeroTierNetworks(output) {
    const networks = [];
    for (const rawLine of String(output || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        // Network names may contain spaces ("Higher travel"), so anchor on the
        // well-defined tail fields instead of splitting the whole line.
        // 200 listnetworks <nwid> <name with spaces> <mac> <status> <type> <dev> <ips>
        const match = line.match(
            /^\d+\s+listnetworks\s+([0-9a-fA-F]{16})\s+(.*?)\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/
        );
        if (!match) continue;
        const ips = match[7].split(',').map(s => s.trim()).filter(Boolean);
        networks.push({
            id: match[1],
            name: match[2].trim(),
            mac: match[3],
            status: match[4],
            type: match[5],
            device: match[6],
            ips
        });
    }
    return networks;
}

/**
 * Parse the output of `tailscale status --json`.
 */
function parseTailscaleStatus(json) {
    let data = {};
    try {
        data = typeof json === 'string' ? JSON.parse(json) : (json || {});
    } catch (_) {
        return { backendState: 'unknown', ips: [], hostName: '', version: '' };
    }
    const self = data.Self || {};
    return {
        backendState: data.BackendState || 'unknown',
        ips: Array.isArray(data.TailscaleIPs) ? data.TailscaleIPs : [],
        hostName: self.HostName || self.DNSName || '',
        version: data.Version || '',
        loggedIn: Boolean(data.HaveNodeKey || data.User)
    };
}

async function serviceState(unit, exec = execFileAsync) {
    try {
        const { stdout } = await exec('systemctl', ['is-active', unit]);
        const active = String(stdout).trim();
        return { active: active === 'active', raw: active };
    } catch (err) {
        const raw = String((err.stdout || '') + (err.stderr || '')).trim();
        return { active: raw === 'active', raw: raw || 'unknown' };
    }
}

async function serviceEnabled(unit, exec = execFileAsync) {
    try {
        const { stdout } = await exec('systemctl', ['is-enabled', unit]);
        const enabled = String(stdout).trim();
        return enabled === 'enabled' || enabled === 'enabled-runtime' || enabled === 'static';
    } catch (err) {
        const raw = String((err.stdout || '') + (err.stderr || '')).trim();
        return raw === 'enabled' || raw === 'enabled-runtime' || raw === 'static';
    }
}

async function providerStatus(providerId, exec = execFileAsync) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    const installed = binaryExists(provider.binary);
    const [svc, en] = await Promise.all([
        serviceState(provider.unit, exec),
        serviceEnabled(provider.unit, exec)
    ]);

    const status = {
        id: provider.id,
        label: provider.label,
        installed,
        service: provider.service,
        unit: provider.unit,
        serviceActive: svc.active,
        serviceEnabled: en,
        networks: [],
        ips: [],
        hostName: '',
        version: ''
    };

    if (!installed) return status;

    // Do not run the CLI while the daemon is down: ZeroTier then reports the
    // confusing "missing port and zerotier-one.port not found" error. The UI
    // already offers a Start button, so return a clear reason instead.
    if (!svc.active) {
        status.error = `The ${provider.label} service (${provider.service}) is stopped. Start ${provider.service} to manage networks.`;
        return status;
    }

    try {
        if (provider.id === 'zerotier') {
            await waitForZeroTierCli(3000, exec);
            const { stdout } = await exec('zerotier-cli', ['listnetworks']);
            const networks = parseZeroTierNetworks(stdout);
            status.networks = networks;
            status.ips = networks.flatMap(n => n.ips);
            try {
                const v = await exec('zerotier-cli', ['-v']);
                status.version = String(v.stdout || '').trim();
            } catch (_) { /* version is optional */ }
        } else if (provider.id === 'tailscale') {
            const { stdout } = await exec('tailscale', ['status', '--json']);
            const parsed = parseTailscaleStatus(stdout);
            status.backendState = parsed.backendState;
            status.ips = parsed.ips;
            status.hostName = parsed.hostName;
            status.version = parsed.version;
            status.networks = parsed.ips.length ? [{ id: 'self', name: parsed.hostName, ips: parsed.ips, status: parsed.backendState }] : [];
        }
    } catch (err) {
        status.error = describeOverlayCliError(provider.id, err).slice(0, 300);
    }
    return status;
}

async function overlayStatus(exec = execFileAsync) {
    const results = await Promise.all(PROVIDER_IDS.map(id => providerStatus(id, exec)));
    return { providers: results };
}

/**
 * Install the provider package (and enable + start its service).
 */
async function installProvider(providerId, exec = execFileAsync) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (binaryExists(provider.binary)) {
        await enableAndStart(provider, exec);
        return { alreadyInstalled: true, message: `${provider.label} is already installed.` };
    }

    if (provider.repo) {
        // The repository has to exist before dnf can resolve the package.
        const repo = tailscaleRepo();
        try {
            await exec('dnf', ['config-manager', '--add-repo', repo.url]);
        } catch (_) {
            // Older dnf has no config-manager; write the repo file instead.
            await writeRepoFile(repo);
        }
        await exec('dnf', ['install', '-y', 'tailscale']);
    } else {
        await exec('dnf', ['install', '-y', provider.package]);
    }

    await enableAndStart(provider, exec);
    return { alreadyInstalled: false, message: `${provider.label} installed and enabled.` };
}

async function writeRepoFile(repo) {
    const fsPromises = require('fs').promises;
    const dir = '/etc/yum.repos.d';
    const file = `${dir}/sokrat-${repo.name}.repo`;
    const body = [
        `[${repo.name}]`,
        `name=${repo.name}`,
        `baseurl=${repo.base}`,
        'enabled=1',
        'gpgcheck=1',
        'repo_gpgcheck=1',
        `gpgkey=${repo.gpg}`,
        ''
    ].join('\n');
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(file, body, 'utf8');
}

async function enableAndStart(provider, exec = execFileAsync) {
    await exec('systemctl', ['enable', provider.unit]);
    await exec('systemctl', ['start', provider.unit]);
    const ready = await waitForService(provider.unit, 15000, exec);
    if (!ready.active) {
        throw overlayError(`The ${provider.label} service (${provider.unit}) did not start (state: ${ready.state}). Check journalctl -u ${provider.unit} -n 50 for details.`, 500);
    }
    if (provider.id === 'zerotier' && !(await waitForZeroTierCli(10000, exec))) {
        throw overlayError('The ZeroTier service is running but its control socket is not ready yet. Try again in a few seconds.', 500);
    }
}

async function serviceAction(providerId, action, exec = execFileAsync) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (!SERVICE_ACTIONS.includes(action)) throw new Error(`Unsupported action: ${action}`);

    if (action === 'enable --now') {
        await exec('systemctl', ['enable', '--now', provider.unit]);
        const ready = await waitForService(provider.unit, 15000, exec);
        if (!ready.active) {
            throw overlayError(`The ${provider.label} service (${provider.unit}) did not start (state: ${ready.state}). Check journalctl -u ${provider.unit} -n 50 for details.`, 500);
        }
        if (provider.id === 'zerotier' && !(await waitForZeroTierCli(10000, exec))) {
            throw overlayError('The ZeroTier service is running but its control socket is not ready yet. Try again in a few seconds.', 500);
        }
    } else if (action === 'start' || action === 'restart') {
        await exec('systemctl', [action, provider.unit]);
        const ready = await waitForService(provider.unit, 15000, exec);
        if (!ready.active) {
            throw overlayError(`The ${provider.label} service (${provider.unit}) is not running after ${action} (state: ${ready.state}). Check journalctl -u ${provider.unit} -n 50 for details.`, 500);
        }
        if (provider.id === 'zerotier' && !(await waitForZeroTierCli(10000, exec))) {
            throw overlayError('The ZeroTier service is running but its control socket is not ready yet. Try again in a few seconds.', 500);
        }
    } else {
        await exec('systemctl', [action, provider.unit]);
    }
    return { message: `${provider.label} ${action} executed.` };
}

/**
 * Join a network.
 *  - ZeroTier: the network id (and an optional local name)
 *  - Tailscale: an auth key
 */
async function joinNetwork(providerId, options = {}, exec = execFileAsync) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    if (providerId === 'zerotier') {
        const network = String(options.network || '').trim();
        if (!network) throw overlayError('A ZeroTier network id is required.', 400);
        if (!/^[0-9a-fA-F]{16}$/.test(network)) {
            throw overlayError('A ZeroTier network id must be 16 hexadecimal characters (for example 08752e18b1faa61e).', 400);
        }
        const service = await serviceState(provider.unit, exec);
        if (!service.active) {
            throw overlayError(`The ZeroTier service (${provider.service}) is not running. Start ${provider.service} from the Overlay VPN panel and try again.`, 503);
        }
        if (!(await waitForZeroTierCli(5000, exec))) {
            throw overlayError('The ZeroTier service is running but its control socket is not ready yet. Try again in a few seconds.', 503);
        }
        const args = ['join', network];
        if (options.name) args.push(options.name);
        try {
            const { stdout } = await exec('zerotier-cli', args);
            return { message: `Joined ZeroTier network ${network}.`, output: String(stdout || '').trim() };
        } catch (error) {
            const detail = describeOverlayCliError('zerotier', error);
            throw overlayError(detail || `Could not join ZeroTier network ${network}.`, 400, error);
        }
    }

    const authKey = String(options.authKey || '').trim();
    const keyCheck = classifyTailscaleAuthKey(authKey);
    if (!keyCheck.valid) throw overlayError(keyCheck.error, 400);

    // --accept-routes=false keeps the overlay from becoming the default gateway
    // and taking the PBX traffic with it.
    try {
        const { stdout } = await exec('tailscale', ['up', `--authkey=${authKey}`, '--accept-routes=false']);
        return { message: 'Tailscale is up.', output: String(stdout || '').trim() };
    } catch (error) {
        const mapped = describeTailscaleJoinError(error);
        throw overlayError(mapped.message, mapped.statusCode, error, [authKey]);
    }
}

async function leaveNetwork(providerId, options = {}, exec = execFileAsync) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    if (providerId === 'zerotier') {
        const network = String(options.networkId || '').trim();
        if (!network) throw new Error('A ZeroTier network id is required.');
        const service = await serviceState(provider.unit, exec);
        if (!service.active) {
            throw overlayError(`The ZeroTier service (${provider.service}) is not running. Start ${provider.service} from the Overlay VPN panel and try again.`, 503);
        }
        if (!(await waitForZeroTierCli(5000, exec))) {
            throw overlayError('The ZeroTier service is running but its control socket is not ready yet. Try again in a few seconds.', 503);
        }
        try {
            const { stdout } = await exec('zerotier-cli', ['leave', network]);
            return { message: `Left ZeroTier network ${network}.`, output: String(stdout || '').trim() };
        } catch (error) {
            throw overlayError(describeOverlayCliError('zerotier', error), 400, error);
        }
    }

    const { stdout } = await exec('tailscale', ['logout']);
    return { message: 'Tailscale logged out.', output: String(stdout || '').trim() };
}

module.exports = {
    tailscaleRepo,
    PROVIDERS,
    PROVIDER_IDS,
    SERVICE_ACTIONS,
    parseZeroTierNetworks,
    parseTailscaleStatus,
    classifyTailscaleAuthKey,
    describeTailscaleJoinError,
    describeOverlayCliError,
    waitForService,
    waitForZeroTierCli,
    serviceState,
    serviceEnabled,
    providerStatus,
    overlayStatus,
    installProvider,
    serviceAction,
    joinNetwork,
    leaveNetwork,
    binaryExists
};
