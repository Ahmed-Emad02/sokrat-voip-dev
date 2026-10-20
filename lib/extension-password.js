'use strict';

/**
 * Resolve the SIP password for an extension so the Chrome extension can sign
 * address-book requests. Asterisk stores PJSIP auth passwords in
 * `asterisk.ps_auths`; older/FreePBX installs keep them in `asterisk.sip` or
 * `asterisk.users`. Results are cached briefly to keep contacts fast.
 */

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function normalizeExtension(value) {
    return String(value == null ? '' : value).trim().replace(/[^0-9*#]/g, '');
}

function readCached(extension) {
    const hit = cache.get(extension);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.password;
    return null;
}

function writeCached(extension, password) {
    if (!password) return;
    cache.set(extension, { password, at: Date.now() });
    if (cache.size > 500) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
        for (const [key] of oldest) cache.delete(key);
    }
}

async function lookupExtensionPassword(pool, extension) {
    const ext = normalizeExtension(extension);
    if (!ext) return '';

    const cached = readCached(ext);
    if (cached !== null) return cached;

    let password = '';

    try {
        const [rows] = await pool.query(
            'SELECT password FROM `asterisk`.`ps_auths` WHERE id = ? OR id = ? LIMIT 1',
            [ext, `${ext}-auth`]
        );
        if (rows && rows[0] && rows[0].password) password = String(rows[0].password).trim();
    } catch (_) {}

    if (!password) {
        try {
            const [rows] = await pool.query(
                'SELECT data FROM `asterisk`.`sip` WHERE id = ? AND keyword = "secret" LIMIT 1',
                [ext]
            );
            if (rows && rows[0] && rows[0].data) password = String(rows[0].data).trim();
        } catch (_) {}
    }

    if (!password) {
        try {
            const [rows] = await pool.query(
                'SELECT password FROM `asterisk`.`users` WHERE extension = ? LIMIT 1',
                [ext]
            );
            if (rows && rows[0] && rows[0].password) password = String(rows[0].password).trim();
        } catch (_) {}
    }

    if (password) writeCached(ext, password);
    return password;
}

module.exports = { lookupExtensionPassword, normalizeExtension, clearExtensionPasswordCache: () => cache.clear() };
