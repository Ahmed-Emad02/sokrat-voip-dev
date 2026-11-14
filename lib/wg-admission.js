'use strict';

/**
 * PBX-side WireGuard admission.
 *
 * The control-plane gateway is the only caller. It authenticates with the
 * per-installation admission token kept outside the app/control store. This
 * endpoint is mounted before browser auth, so it must never expose peer data.
 *
 * Only peers previously applied through this endpoint are removed; manually
 * configured peers are left alone.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');

const CONFIG_PATH = '/etc/sokrat/wg-admission.json';
const STATE_PATH = '/var/lib/sokrat/wg-admission-managed.json';
const MAX_PEERS = 512;

let queue = Promise.resolve();

function fail(status, message) {
    const error = new Error(message);
    error.statusCode = status;
    return error;
}

function serialize(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
}

function readConfig() {
    let raw;
    try {
        raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    } catch {
        throw fail(503, 'WireGuard admission is not configured');
    }
    if (Buffer.byteLength(raw) > 16384) throw fail(503, 'WireGuard admission config is invalid');
    let config;
    try {
        config = JSON.parse(raw);
    } catch {
        throw fail(503, 'WireGuard admission config is invalid');
    }
    if (!config || typeof config !== 'object' ||
        typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token) ||
        typeof config.interface !== 'string' || !/^wg[0-9]{1,3}$/.test(config.interface)) {
        throw fail(503, 'WireGuard admission config is invalid');
    }
    return config;
}

function parseCidr(value) {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const ip = ipv4ToInt(match[1]);
    const prefix = Number(match[2]);
    if (ip === null || prefix < 8 || prefix > 30) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ip & mask) >>> 0;
    return { ip, prefix, network, broadcast: (network | (~mask >>> 0)) >>> 0 };
}

function ipv4ToInt(value) {
    const parts = String(value || '').trim().split('.');
    if (parts.length !== 4) return null;
    let result = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        result = (result * 256) + octet;
    }
    return result >>> 0;
}

function intToIpv4(value) {
    return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff).join('.');
}

function normalizeKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
        throw fail(400, 'Invalid WireGuard public key');
    }
    let bytes;
    try {
        bytes = Buffer.from(value, 'base64');
    } catch {
        throw fail(400, 'Invalid WireGuard public key');
    }
    if (bytes.length !== 32 || bytes.toString('base64') !== value) {
        throw fail(400, 'Invalid WireGuard public key');
    }
    return value;
}

function normalizeAddress(value, cidr) {
    const text = String(value || '').trim().replace(/\/32$/, '');
    const ip = ipv4ToInt(text);
    if (ip === null || !cidr || ip <= cidr.network || ip >= cidr.broadcast) {
        throw fail(400, 'Address is outside the WireGuard peer pool');
    }
    return { ip, address: `${intToIpv4(ip)}/32` };
}

function tokenMatches(expected, actual) {
    const a = Buffer.from(String(actual || ''), 'utf8');
    const b = Buffer.from(String(expected || ''), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readManaged() {
    try {
        const raw = await fsp.readFile(STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.keys)) return new Set();
        return new Set(parsed.keys.filter(key => typeof key === 'string'));
    } catch {
        return new Set();
    }
}

async function writeManaged(keys) {
    const directory = '/var/lib/sokrat';
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const tmp = `${STATE_PATH}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ keys: [...keys].sort() }), { mode: 0o600 });
    await fsp.rename(tmp, STATE_PATH);
}

function runWg(args) {
    return new Promise((resolve, reject) => {
        execFile('/usr/bin/wg', args, { timeout: 10000, maxBuffer: 65536 }, (error, stdout, stderr) => {
            if (error) {
                const detail = String(stderr || error.message || '').trim().slice(0, 160);
                reject(fail(500, detail || 'WireGuard command failed'));
                return;
            }
            resolve(stdout);
        });
    });
}

async function reconcile(payload) {
    const config = readConfig();
    const cidrs = [parseCidr(config.allowedCidr)].filter(Boolean);
    if (!cidrs.length) throw fail(503, 'WireGuard peer pool is invalid');
    const cidr = cidrs[0];
    if (!Array.isArray(payload.peers) || payload.peers.length > MAX_PEERS) {
        throw fail(400, 'Invalid peer list');
    }

    const desired = new Map();
    const usedAddresses = new Set();
    for (const peer of payload.peers) {
        if (!peer || typeof peer !== 'object') throw fail(400, 'Invalid peer');
        const key = normalizeKey(peer.publicKey);
        const { ip, address } = normalizeAddress(peer.address, cidr);
        if (desired.has(key)) throw fail(400, 'Duplicate WireGuard public key');
        if (usedAddresses.has(ip)) throw fail(400, 'Duplicate WireGuard address');
        desired.set(key, address);
        usedAddresses.add(ip);
    }

    return serialize(async () => {
        const managed = await readManaged();
        const added = [];
        const removed = [];
        for (const [key, address] of desired) {
            await runWg(['set', config.interface, 'peer', key, 'allowed-ips', address]);
            if (!managed.has(key)) added.push(key);
        }
        for (const key of managed) {
            if (desired.has(key)) continue;
            try {
                await runWg(['set', config.interface, 'peer', key, 'remove']);
                removed.push(key);
            } catch {
                // The interface may have restarted; the desired state is still
                // authoritative and a later apply will converge.
            }
        }
        await writeManaged(new Set(desired.keys()));
        if (config.persist === true) {
            try {
                await new Promise((resolve, reject) => {
                    execFile('/sbin/wg-quick', ['save', config.interface], { timeout: 15000 }, error =>
                        error ? reject(error) : resolve()
                    );
                });
            } catch {
                // Runtime admission is authoritative; persistence is best effort.
            }
        }
        return { added: added.length, removed: removed.length, peers: desired.size };
    });
}

function createWgAdmissionRouter() {
    const express = require('express');
    const router = express.Router();
    router.post('/apply', async (req, res) => {
        try {
            const config = readConfig();
            const match = /^Bearer (\S{32,200})$/.exec(req.get('Authorization') || '');
            if (!match || !tokenMatches(config.token, match[1])) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            const result = await reconcile(req.body || {});
            return res.json({ ok: true, ...result });
        } catch (error) {
            const status = error && Number.isInteger(error.statusCode) ? error.statusCode : 500;
            return res.status(status).json({ error: status === 500 ? 'WireGuard admission failed' : error.message });
        }
    });
    router.get('/health', (req, res) => {
        try {
            const config = readConfig();
            return res.json({ ok: true, interface: config.interface });
        } catch {
            return res.status(503).json({ ok: false });
        }
    });
    return router;
}

module.exports = { createWgAdmissionRouter };
