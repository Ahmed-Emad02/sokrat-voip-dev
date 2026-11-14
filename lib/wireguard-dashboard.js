'use strict';

/**
 * Read-only WireGuard status for the root-only PBX dashboard.
 *
 * The dashboard deliberately never returns private keys or config contents.
 * Peers are reported from `wg show <interface> dump`; the first field of the
 * dump (the interface private key) is discarded.
 */

const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');

const WG = '/usr/bin/wg';
const IP = '/usr/sbin/ip';
const MANAGED_PEERS = '/var/lib/sokrat/wg-admission-managed.json';
const MAX_BUFFER = 256 * 1024;

function run(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 5000, maxBuffer: MAX_BUFFER }, (error, stdout) => {
            if (error) reject(error);
            else resolve(String(stdout || ''));
        });
    });
}

function shortKey(key) {
    const value = String(key || '');
    return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function parseManagedKeys(raw) {
    try {
        const parsed = JSON.parse(raw);
        return new Set(Array.isArray(parsed?.keys)
            ? parsed.keys.filter(key => typeof key === 'string')
            : []);
    } catch {
        return new Set();
    }
}

async function interfaceAddress(name) {
    try {
        const output = await run(IP, ['-4', '-o', 'addr', 'show', 'dev', name]);
        const match = /\binet\s+(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\b/.exec(output);
        return match ? match[1] : '';
    } catch {
        return '';
    }
}

function parseDump(name, output, managedKeys) {
    const lines = String(output || '').split('\n').filter(Boolean);
    if (!lines.length) return null;
    const iface = lines[0].split('\t');
    const now = Math.floor(Date.now() / 1000);
    const peers = lines.slice(1).map((line) => {
        const fields = line.split('\t');
        const publicKey = fields[0] || '';
        const endpoint = fields[2] || '';
        const allowedIps = String(fields[3] || '').split(',').map(value => value.trim()).filter(Boolean);
        const latestHandshake = Number(fields[4] || 0);
        const handshakeAge = latestHandshake > 0 ? Math.max(0, now - latestHandshake) : null;
        return {
            publicKey,
            shortKey: shortKey(publicKey),
            endpoint: endpoint && endpoint !== '(none)' ? endpoint : '',
            allowedIps,
            latestHandshake,
            handshakeAgeSeconds: handshakeAge,
            online: handshakeAge !== null && handshakeAge <= 180,
            rxBytes: Number(fields[5] || 0),
            txBytes: Number(fields[6] || 0),
            managed: managedKeys.has(publicKey),
        };
    });
    peers.sort((a, b) => String(a.allowedIps[0] || '').localeCompare(String(b.allowedIps[0] || '')));
    return {
        name,
        publicKey: iface[1] || '',
        listenPort: Number(iface[2] || 0),
        peers,
        peerCount: peers.length,
        managedPeerCount: peers.filter(peer => peer.managed).length,
        onlinePeerCount: peers.filter(peer => peer.online).length,
    };
}

async function listWireGuardStatus() {
    let names;
    try {
        names = (await run(WG, ['show', 'interfaces']))
            .split(/\s+/)
            .map(value => value.trim())
            .filter(Boolean);
    } catch {
        return { available: false, interfaces: [], generatedAt: new Date().toISOString() };
    }

    let managedKeys = new Set();
    try {
        managedKeys = parseManagedKeys(await fs.readFile(MANAGED_PEERS, 'utf8'));
    } catch {
        // A manually configured PBX has no admission state file.
    }

    const interfaces = [];
    for (const name of names) {
        try {
            const [dump, address] = await Promise.all([
                run(WG, ['show', name, 'dump']),
                interfaceAddress(name),
            ]);
            const parsed = parseDump(name, dump, managedKeys);
            if (parsed) interfaces.push({ ...parsed, address });
        } catch {
            // A transient wg/ip failure must not hide the other interfaces.
        }
    }
    return {
        available: true,
        interfaces,
        generatedAt: new Date().toISOString(),
    };
}

module.exports = { listWireGuardStatus };
