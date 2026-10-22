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
        const parts = line.split(/\s+/);
        // parts[0] = status code, parts[1] = "listnetworks"
        if (parts.length < 9 || parts[1] !== 'listnetworks') continue;
        // The CLI prints its usage example first ("<nwid> <name> ...") - skip it.
        if (parts.slice(2).some(part => part.indexOf('<') !== -1)) continue;
        const ips = parts.slice(8).join(' ').split(',').map(s => s.trim()).filter(Boolean);
        networks.push({
            id: parts[2] || '',
            name: parts[3] || '',
            mac: parts[4] || '',
            status: parts[5] || '',
            type: parts[6] || '',
            device: parts[7] || '',
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

async function serviceState(unit) {
    try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', unit]);
        const active = String(stdout).trim();
        return { active: active === 'active', raw: active };
    } catch (err) {
        const raw = String((err.stdout || '') + (err.stderr || '')).trim();
        return { active: raw === 'active', raw: raw || 'unknown' };
    }
}

async function serviceEnabled(unit) {
    try {
        const { stdout } = await execFileAsync('systemctl', ['is-enabled', unit]);
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
        serviceState(provider.unit),
        serviceEnabled(provider.unit)
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

    try {
        if (provider.id === 'zerotier') {
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
        status.error = String((err.stderr || err.message || '')).trim().slice(0, 300);
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

async function enableAndStart(provider, exec) {
    await exec('systemctl', ['enable', '--now', provider.unit]);
}

async function serviceAction(providerId, action, exec = execFileAsync) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (!SERVICE_ACTIONS.includes(action)) throw new Error(`Unsupported action: ${action}`);

    if (action === 'enable --now') {
        await exec('systemctl', ['enable', '--now', provider.unit]);
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
        if (!network) throw new Error('A ZeroTier network id is required.');
        const args = ['join', network];
        if (options.name) args.push(options.name);
        const { stdout } = await exec('zerotier-cli', args);
        return { message: `Joined ZeroTier network ${network}.`, output: String(stdout || '').trim() };
    }

    const authKey = String(options.authKey || '').trim();
    if (!authKey) throw new Error('A Tailscale auth key is required.');
    // --accept-routes=false keeps the overlay from becoming the default gateway
    // and taking the PBX traffic with it.
    const { stdout } = await exec('tailscale', ['up', `--authkey=${authKey}`, '--accept-routes=false']);
    return { message: 'Tailscale is up.', output: String(stdout || '').trim() };
}

async function leaveNetwork(providerId, options = {}, exec = execFileAsync) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    if (providerId === 'zerotier') {
        const network = String(options.networkId || '').trim();
        if (!network) throw new Error('A ZeroTier network id is required.');
        const { stdout } = await exec('zerotier-cli', ['leave', network]);
        return { message: `Left ZeroTier network ${network}.`, output: String(stdout || '').trim() };
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
    providerStatus,
    overlayStatus,
    installProvider,
    serviceAction,
    joinNetwork,
    leaveNetwork,
    binaryExists
};
