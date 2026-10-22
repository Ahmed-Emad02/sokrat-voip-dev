/**
 * Network manager.
 *
 * Reads and changes the IP assignment mode (DHCP / static) of the host's
 * physical network interfaces through NetworkManager (nmcli).
 *
 * Safety model - this code puts the PBX network at risk, so:
 *   - every command runs through execFile with an argument array (never a
 *     shell), so nothing in a profile value can turn into a command;
 *   - only physical interfaces are editable (ethernet / wireless): tunnels,
 *     bridges, docker, ZeroTier and Tailscale are never touched;
 *   - the interface that carries the default route is flagged "protected" and
 *     needs an explicit force, because changing it can cut the admin's own
 *     session (and with it the way back into the box);
 *   - a change is a transaction: the current profile is snapshotted first,
 *     then applied and re-activated, and if the interface does not come back
 *     with an address the snapshot is restored automatically.
 */

const { execFile } = require('child_process');

const NMCLI = process.env.NMCLI_BIN || '/usr/bin/nmcli';
const IP = process.env.IP_BIN || '/usr/sbin/ip';

/**
 * Only these connection types can be changed. Everything else (tun, bridge,
 * vlan, bond, team, docker, the overlay VPNs) belongs to another tool.
 */
const EDITABLE_TYPES = ['802-3-ethernet', '802-11-wireless', 'gpon'];

/**
 * The IP assignment modes this manager offers.
 */
const METHODS = ['auto', 'manual', 'disabled'];

/**
 * How long to wait for the interface to come back up with an address.
 */
const APPLY_TIMEOUT_MS = 30000;
const APPLY_POLL_MS = 1000;

/**
 * The last profile of every connection we changed, so it can be restored.
 */
const snapshots = new Map();

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the "key: value" lines of an nmcli report.
 */
function parseReport(output) {
    const result = {};
    const lines = String(output || '').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf(':');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        if (!key) continue;
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            // Repeated keys (IP4.ADDRESS[1], IP4.ADDRESS[2], ...) are collected.
            if (!Array.isArray(result[key])) result[key] = [result[key]];
            result[key].push(value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

function asList(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    return String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * Parse "nmcli -f UUID,TYPE,DEVICE,STATE,ACTIVE con show".
 */
function parseConnectionList(output) {
    const connections = [];
    for (const line of String(output || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || /^--/.test(trimmed)) continue;
        const parts = trimmed.split(':');
        if (parts.length < 4) continue;
        const [uuid, type, device, state] = parts;
        if (!uuid || !type) continue;
        connections.push({
            uuid: uuid.trim(),
            type: type.trim(),
            device: (device || '').trim(),
            state: (state || '').trim(),
            active: (parts[4] || '').trim() === 'yes'
        });
    }
    return connections;
}

/**
 * Parse the DHCP options of an active device (nmcli -f DHCP4.OPTION dev show).
 */
function parseDhcpInfo(report) {
    const info = { server: '', leaseTime: 0, expiresAt: 0 };
    const options = [];
    for (const key of Object.keys(report || {})) {
        if (!/^DHCP4\.OPTION/.test(key)) continue;
        const values = asList(report[key]);
        for (const value of values) {
            options.push(value);
            const m = value.match(/^([^=]+)\s*=\s*(.*)$/);
            if (!m) continue;
            const name = m[1].trim().toLowerCase();
            const val = m[2].trim();
            if (name === 'dhcp_server_identifier') info.server = val;
            else if (name === 'dhcp_lease_time') info.leaseTime = parseInt(val, 10) || 0;
            else if (name === 'expiry') info.expiresAt = parseInt(val, 10) || 0;
        }
    }
    return info;
}

/**
 * Parse the IPv4 profile of a connection.
 */
function parseProfile(report) {
    const addresses = [];
    for (const key of Object.keys(report || {})) {
        if (!/^ipv4\.addresses/.test(key)) continue;
        for (const value of asList(report[key])) {
            if (value === '--') continue;
            addresses.push(value);
        }
    }
    const method = (report['ipv4.method'] || '').trim();
    const gateway = (report['ipv4.gateway'] || '').trim();
    const dns = [];
    for (const key of Object.keys(report || {})) {
        if (!/^ipv4\.dns/.test(key)) continue;
        for (const value of asList(report[key])) {
            if (value === '--') continue;
            dns.push(value);
        }
    }
    return {
        method: method === '--' ? '' : method,
        addresses,
        gateway: gateway === '--' ? '' : gateway,
        dns,
        routeMetric: (report['ipv4.route-metric'] || '').trim(),
        autoconnect: (report['connection.autoconnect'] || '').trim()
    };
}

/**
 * Is this a valid IPv4 address?
 */
function isValidIPv4(value) {
    const parts = String(value || '').trim().split('.');
    if (parts.length !== 4) return false;
    return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

/**
 * Is this a valid CIDR prefix (0-32)?
 */
function isValidPrefix(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 32;
}

/**
 * Check a profile before it is applied. Returns the list of problems.
 */
function validateProfile(profile = {}) {
    const errors = [];
    const method = String(profile.method || '').trim();
    if (!METHODS.includes(method)) {
        errors.push(`Unsupported method "${method}" (use ${METHODS.join(', ')})`);
        return errors;
    }
    if (method === 'manual') {
        const address = String(profile.address || '').trim();
        if (!isValidIPv4(address)) errors.push('The IPv4 address is not valid');
        if (!isValidPrefix(profile.prefix)) errors.push('The prefix length must be between 0 and 32');
        const gateway = String(profile.gateway || '').trim();
        if (gateway && !isValidIPv4(gateway)) errors.push('The gateway is not a valid IPv4 address');
        if (gateway && isValidIPv4(address) && isValidPrefix(profile.prefix)) {
            // The gateway is normally inside the same subnet; a gateway outside
            // it is legal but worth a warning, so it is reported separately.
            const toInt = (ip) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
            const mask = profile.prefix === 0 ? 0 : (0xffffffff << (32 - Number(profile.prefix))) >>> 0;
            if ((toInt(address) & mask) !== (toInt(gateway) & mask)) {
                errors.push('WARNING: the gateway is outside the subnet of the address');
            }
        }
    }
    for (const dns of asList(profile.dns)) {
        if (!isValidIPv4(dns)) errors.push(`"${dns}" is not a valid DNS server`);
    }
    return errors;
}

/**
 * The devices that carry the default route, with their metric.
 */
function parseDefaultRoutes(output) {
    const routes = [];
    for (const line of String(output || '').split('\n')) {
        const m = line.match(/^default\s+(?:via\s+(\S+)\s+)?dev\s+(\S+)(?:\s+.*?metric\s+(\d+))?/);
        if (!m) continue;
        routes.push({ gateway: m[1] || '', device: m[2], metric: m[3] ? parseInt(m[3], 10) : 0 });
    }
    return routes;
}

/**
 * The connection profiles of the editable interfaces.
 *
 * options.localAddress is the address the request came in on: the interface
 * that carries it is protected as well, because changing it cuts the very
 * session the admin is using.
 */
async function listConnections(options = {}) {
    const exec = options.exec || execFileAsync;
    const localAddress = String(options.localAddress || '').replace(/^::ffff:/, '');
    const listOut = await exec(NMCLI, ['-t', '-f', 'UUID,TYPE,DEVICE,STATE,ACTIVE', 'con', 'show']);
    const connections = parseConnectionList(listOut.stdout);

    let defaultRoutes = [];
    try {
        const routeOut = await exec(IP, ['route', 'show', 'default']);
        defaultRoutes = parseDefaultRoutes(routeOut.stdout);
    } catch (err) {
        defaultRoutes = [];
    }
    const primaryDevice = defaultRoutes.length
        ? defaultRoutes.slice().sort((a, b) => a.metric - b.metric)[0].device
        : '';

    const result = [];
    for (const connection of connections) {
        const editable = EDITABLE_TYPES.includes(connection.type);
        let profile = { method: '', addresses: [], gateway: '', dns: [], routeMetric: '', autoconnect: '' };
        let dhcp = null;
        if (connection.uuid) {
            const profileOut = await exec(NMCLI, [
                '-f',
                'connection.type,connection.interface-name,ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns,ipv4.route-metric,connection.autoconnect',
                'con',
                'show',
                connection.uuid
            ]);
            const report = parseReport(profileOut.stdout);
            profile = parseProfile(report);
            profile.device = (report['connection.interface-name'] || connection.device || '').trim();
            if (profile.device && connection.active) {
                try {
                    const devOut = await exec(NMCLI, [
                        '-f', 'GENERAL.STATE,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS,DHCP4.OPTION',
                        'dev', 'show', profile.device
                    ]);
                    const devReport = parseReport(devOut.stdout);
                    const info = parseDhcpInfo(devReport);
                    if (info.server || info.leaseTime) dhcp = info;
                    // A DHCP connection has no address in its profile: the
                    // leased address lives on the device.
                    if (!profile.addresses.length) {
                        const deviceAddresses = [];
                        for (const key of Object.keys(devReport)) {
                            if (!/^IP4\.ADDRESS/.test(key)) continue;
                            for (const value of asList(devReport[key])) {
                                if (value && value !== '--') deviceAddresses.push(value);
                            }
                        }
                        if (deviceAddresses.length) profile.addresses = deviceAddresses;
                    }
                    if (!profile.gateway) {
                        for (const key of Object.keys(devReport)) {
                            if (!/^IP4\.GATEWAY/.test(key)) continue;
                            const value = asList(devReport[key])[0];
                            if (value && value !== '--') profile.gateway = value;
                        }
                    }
                    if (!profile.dns.length) {
                        for (const key of Object.keys(devReport)) {
                            if (!/^IP4\.DNS/.test(key)) continue;
                            for (const value of asList(devReport[key])) {
                                if (value && value !== '--') profile.dns.push(value);
                            }
                        }
                    }
                } catch (err) {
                    dhcp = null;
                }
            }
        }
        const device = profile.device || connection.device;
        const carriesSession = !!localAddress && profile.addresses.some((addr) => {
            const ip = String(addr).split('/')[0];
            return ip === localAddress;
        });
        result.push({
            uuid: connection.uuid,
            name: connection.device || profile.device || connection.uuid,
            type: connection.type,
            device,
            state: connection.state,
            active: connection.active,
            editable,
            protected: editable && (!!primaryDevice && device === primaryDevice || carriesSession),
            method: profile.method || 'disabled',
            addresses: profile.addresses,
            gateway: profile.gateway,
            dns: profile.dns,
            routeMetric: profile.routeMetric,
            autoconnect: profile.autoconnect,
            dhcp
        });
    }
    return result;
}

/**
 * The current profile of a connection (used for the rollback snapshot).
 */
async function snapshotConnection(uuid, exec = execFileAsync) {
    const out = await exec(NMCLI, [
        '-f', 'ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns,ipv4.route-metric',
        'con', 'show', uuid
    ]);
    const profile = parseProfile(parseReport(out.stdout));
    return {
        method: profile.method,
        addresses: profile.addresses,
        gateway: profile.gateway,
        dns: profile.dns,
        routeMetric: profile.routeMetric
    };
}

/**
 * Write a profile to a connection (without activating it).
 *
 * The profile is either a new one (address + prefix) or a snapshot
 * (addresses[]), so a rollback restores exactly what was there before.
 */
async function applyProfile(uuid, profile, exec = execFileAsync) {
    const args = ['con', 'mod', uuid, 'ipv4.method', profile.method];
    if (profile.method === 'manual') {
        let address = String(profile.address || '').trim();
        let prefix = profile.prefix;
        if (!address && Array.isArray(profile.addresses) && profile.addresses.length) {
            const parts = String(profile.addresses[0]).split('/');
            address = parts[0] || '';
            prefix = parts[1] !== undefined ? parts[1] : prefix;
        }
        args.push('ipv4.addresses', `${address}/${prefix}`);
        args.push('ipv4.gateway', String(profile.gateway || '').trim());
        const dns = asList(profile.dns);
        args.push('ipv4.dns', dns.length ? dns.join(',') : '');
    } else {
        // DHCP or disabled: clear the static values so nothing is left over.
        args.push('ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '');
    }
    await exec(NMCLI, args);
}

/**
 * The device (interface) a connection is bound to.
 */
async function connectionDevice(uuid, exec = execFileAsync) {
    const out = await exec(NMCLI, ['-g', 'connection.interface-name', 'con', 'show', uuid]);
    return String(out.stdout || '').trim();
}

/**
 * Does the device have an address again?
 */
async function connectionHasAddress(device, exec = execFileAsync) {
    const out = await exec(NMCLI, ['-t', '-f', 'GENERAL.STATE,IP4.ADDRESS', 'dev', 'show', device]);
    const state = String(out.stdout || '').trim();
    const activated = /\b100\b/.test(state) || /activated/i.test(state);
    const hasAddress = /(\d{1,3}\.){3}\d{1,3}\/\d{1,2}/.test(state);
    return activated && hasAddress;
}

/**
 * Change the IP assignment of a connection.
 *
 * Returns { applied, rolledBack, snapshot, error }. When the interface does
 * not come back with an address the previous profile is restored and
 * rolledBack is true.
 */
async function configureConnection(uuid, profile, options = {}) {
    const exec = options.exec || execFileAsync;
    const errors = validateProfile(profile);
    const blocking = errors.filter((e) => !/^WARNING/.test(e));
    if (blocking.length) {
        const err = new Error(blocking.join('; '));
        err.code = 'INVALID_PROFILE';
        throw err;
    }

    const snapshot = await snapshotConnection(uuid, exec);
    snapshots.set(uuid, snapshot);

    const device = await connectionDevice(uuid, exec);
    await applyProfile(uuid, profile, exec);
    try {
        await exec(NMCLI, ['con', 'up', uuid], { timeout: 90000 });
    } catch (err) {
        // The activation itself failed - put the old profile back.
        await restoreSnapshot(uuid, snapshot, exec);
        return { applied: false, rolledBack: true, snapshot, error: String(err.stderr || err.message || '').trim() };
    }

    const deadline = Date.now() + (options.timeoutMs || APPLY_TIMEOUT_MS);
    let up = false;
    while (Date.now() < deadline) {
        try {
            up = device ? await connectionHasAddress(device, exec) : false;
        } catch (err) {
            up = false;
        }
        if (up) break;
        await sleep(options.pollMs || APPLY_POLL_MS);
    }
    if (!up) {
        await restoreSnapshot(uuid, snapshot, exec);
        return {
            applied: false,
            rolledBack: true,
            snapshot,
            error: 'The interface did not come back with an address - the previous settings were restored'
        };
    }
    return { applied: true, rolledBack: false, snapshot, warnings: errors };
}

/**
 * Put a snapshot back and re-activate the connection.
 */
async function restoreSnapshot(uuid, snapshot, exec = execFileAsync) {
    try {
        await applyProfile(uuid, snapshot, exec);
        await exec(NMCLI, ['con', 'up', uuid], { timeout: 90000 });
    } catch (err) {
        // Nothing else we can do here - the caller reports the failure.
    }
}

/**
 * Restore the profile of the last change of a connection.
 */
async function rollbackConnection(uuid, options = {}) {
    const exec = options.exec || execFileAsync;
    const snapshot = snapshots.get(uuid);
    if (!snapshot) {
        const err = new Error('There is no stored profile for this connection');
        err.code = 'NO_SNAPSHOT';
        throw err;
    }
    await restoreSnapshot(uuid, snapshot, exec);
    snapshots.delete(uuid);
    return { rolledBack: true, snapshot };
}

/**
 * Re-activate a connection without changing it.
 */
async function activateConnection(uuid, options = {}) {
    const exec = options.exec || execFileAsync;
    await exec(NMCLI, ['con', 'up', uuid], { timeout: 90000 });
    return { activated: true };
}

module.exports = {
    NMCLI,
    EDITABLE_TYPES,
    METHODS,
    parseReport,
    parseConnectionList,
    parseProfile,
    parseDhcpInfo,
    parseDefaultRoutes,
    isValidIPv4,
    isValidPrefix,
    validateProfile,
    listConnections,
    snapshotConnection,
    applyProfile,
    connectionDevice,
    connectionHasAddress,
    configureConnection,
    rollbackConnection,
    activateConnection
};
