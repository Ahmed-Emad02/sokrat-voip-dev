'use strict';

/**
 * Reverse proxy for peer PBX web panels.
 *
 * The central node exposes every configured peer under `/peer/<site_code>/`
 * so an operator can open a branch PBX in a new tab without knowing its
 * address, credentials, or even being able to route to it. Only the central
 * node serves these paths.
 *
 * Peer panels are ordinary Sokrat installs that assume they live at the root
 * of their own origin, so this module rewrites root-relative URLs, namespaces
 * their cookies, and injects a small runtime bridge that redirects fetch/XHR
 * and history calls back through the proxy prefix. WebSocket is disabled on
 * purpose: socket.io then falls back to long-polling, which the XHR bridge can
 * carry. That keeps the feature free of any Apache `mod_proxy_wstunnel` rule,
 * so fresh installs, the offline bundle and in-place upgrades need no web
 * server changes.
 */

const http = require('http');
const https = require('https');
const os = require('os');
const querystring = require('querystring');
const { normalizeFederationBaseUrl } = require('./federation-auth');

const PEER_CACHE_TTL_MS = 15000;
const PROXY_TIMEOUT_MS = 20000;

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

let cachedLocalAddresses = null;

function getLocalAddresses() {
    if (cachedLocalAddresses) return cachedLocalAddresses;
    const addresses = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']);
    try {
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
            for (const info of ifaces[name] || []) {
                if (info && info.address) addresses.add(String(info.address).toLowerCase());
            }
        }
    } catch (_) {}
    cachedLocalAddresses = addresses;
    return addresses;
}

function buildPeerProxyPath(siteCode) {
    return `/peer/${encodeURIComponent(String(siteCode || '').trim())}`;
}

function cookiePrefixFor(siteCode) {
    return `__fed_${String(siteCode || '').replace(/[^A-Za-z0-9_]/g, '_')}__`;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Namespace a peer Set-Cookie header so it can never overwrite the central
 * `connect.sid` session. The browser sends it back with every proxied request
 * and `unnamespaceCookieHeader` restores the original name for the peer.
 */
function namespaceSetCookie(header, prefix) {
    const raw = Array.isArray(header) ? header : [header];
    return raw.filter(Boolean).map((sc) => {
        const match = String(sc).match(/^([^=]+)=([^;]*)(.*)$/);
        if (!match) return sc;
        const name = match[1].trim();
        const value = match[2];
        let rest = match[3];

        // The browser must accept the cookie on the central origin.
        rest = rest.replace(/;\s*domain=[^;]*/i, '');
        rest = rest.replace(/;\s*path=[^;]*/i, '');
        // Peer panels run behind the same scheme as the central panel; a
        // leftover Secure flag would silently drop the cookie on plain HTTP.
        rest = rest.replace(/;\s*secure\b/gi, '');
        rest = `; Path=/${rest}`;
        return `${prefix}${name}=${value}${rest}`;
    });
}

/**
 * Keep only the cookies this peer owns and restore their original names.
 * The central panel's own session cookie is never forwarded.
 */
function unnamespaceCookieHeader(cookieHeader, prefix) {
    if (!cookieHeader || typeof cookieHeader !== 'string') return '';
    const out = [];
    for (const part of cookieHeader.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const name = trimmed.slice(0, eq).trim();
        if (!name.startsWith(prefix)) continue;
        out.push(`${name.slice(prefix.length)}=${trimmed.slice(eq + 1)}`);
    }
    return out.join('; ');
}

function rewriteLocationHeader(location, targetOrigin, proxyBase) {
    let loc = String(location || '').trim();
    if (!loc) return loc;
    const withoutPort = targetOrigin.replace(/:\d+$/, '');
    if (loc.startsWith(targetOrigin)) loc = loc.slice(targetOrigin.length);
    else if (loc.startsWith(withoutPort)) loc = loc.slice(withoutPort.length);
    if (!loc) return `${proxyBase}/`;
    if (loc.startsWith('/')) return `${proxyBase}${loc}`;
    if (/^[a-z][a-z0-9+.-]*:/i.test(loc) || loc.startsWith('//')) return loc;
    return `${proxyBase}/${loc}`;
}

function buildBridgeScript(proxyBase, targetOrigin) {
    return `
<script id="__sokrat_fed_bridge">
(function () {
    var BASE = ${JSON.stringify(proxyBase)};
    var TARGET = ${JSON.stringify(targetOrigin)};
    var TARGET_NO_PORT = TARGET.replace(/:(\\d+)$/, '');

    // Keep socket.io on long-polling: the central Apache vhost only upgrades
    // /socket.io, so a peer socket must not open a WebSocket against the
    // central origin. Other WebSocket users (the peer softphone) are untouched.
    try {
        var NativeWS = window.WebSocket;
        if (NativeWS) {
            var FedWS = function (url, protocols) {
                if (String(url || '').indexOf('/socket.io') !== -1) {
                    throw new Error('socket.io WebSocket is disabled through the federation proxy');
                }
                return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
            };
            FedWS.prototype = NativeWS.prototype;
            FedWS.CONNECTING = 0; FedWS.OPEN = 1; FedWS.CLOSING = 2; FedWS.CLOSED = 3;
            window.WebSocket = FedWS;
        }
    } catch (_) {}

    function toProxy(url) {
        if (!url || typeof url !== 'string') return url;
        var u = url.trim();
        if (!u) return url;
        if (u.charAt(0) === '#' || u.indexOf('javascript:') === 0 || u.indexOf('data:') === 0 ||
            u.indexOf('mailto:') === 0 || u.indexOf('tel:') === 0 || u.indexOf('blob:') === 0 ||
            u.indexOf('about:') === 0) return url;
        if (u.indexOf(BASE) === 0) return url;
        if (u.indexOf(TARGET) === 0) return BASE + u.slice(TARGET.length);
        if (u.indexOf(TARGET_NO_PORT + '/') === 0) return BASE + u.slice(TARGET_NO_PORT.length);
        if (u.indexOf('//') === 0) return url;
        if (u.charAt(0) === '/') return BASE + u;
        return url;
    }

    document.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a) return;
        var href = a.getAttribute('href');
        if (!href) return;
        if (a.target === '_blank') { a.href = toProxy(href); return; }
        var mapped = toProxy(href);
        if (mapped !== href) { e.preventDefault(); window.location.href = mapped; }
    }, true);

    document.addEventListener('submit', function (e) {
        var form = e.target;
        if (!form || !form.getAttribute) return;
        var action = form.getAttribute('action');
        if (action) form.action = toProxy(action);
    }, true);

    if (window.fetch) {
        var origFetch = window.fetch;
        window.fetch = function (input, init) {
            if (typeof input === 'string') input = toProxy(input);
            else if (input && input.url) input = new Request(toProxy(input.url), input);
            return origFetch.call(this, input, init);
        };
    }

    if (window.XMLHttpRequest) {
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            var args = Array.prototype.slice.call(arguments);
            args[1] = toProxy(url);
            return origOpen.apply(this, args);
        };
    }

    if (window.EventSource) {
        var OrigES = window.EventSource;
        window.EventSource = function (url, cfg) { return new OrigES(toProxy(url), cfg); };
        window.EventSource.prototype = OrigES.prototype;
    }

    if (navigator.sendBeacon) {
        var origBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) { return origBeacon(toProxy(url), data); };
    }

    if (window.open) {
        var origOpenWin = window.open;
        window.open = function (url) {
            var args = Array.prototype.slice.call(arguments);
            args[0] = toProxy(url);
            return origOpenWin.apply(window, args);
        };
    }

    ['pushState', 'replaceState'].forEach(function (fn) {
        if (!window.history || !window.history[fn]) return;
        var orig = window.history[fn];
        window.history[fn] = function (state, title, url) {
            return orig.call(this, state, title, url ? toProxy(url) : url);
        };
    });
})();
</script>`;
}

function looksLikeHtmlDocument(text) {
    return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(String(text || ''));
}

function rewriteHtmlForProxy(html, targetOrigin, proxyBase) {
    let out = String(html || '');
    let targetHost = '';
    try { targetHost = new URL(targetOrigin).host; } catch (_) { targetHost = ''; }

    if (targetHost) {
        out = out.replace(new RegExp(`(?:https?:)?//${escapeRegExp(targetHost)}`, 'gi'), proxyBase);
    }

    // Root-relative HTML attributes and CSS url() references.
    out = out.replace(/\b(href|src|action|data-url|poster)=("|')\/(?!\/|peer\/)/gi, `$1=$2${proxyBase}/`);
    out = out.replace(/\burl\(\s*(["']?)\/(?!\/|peer\/)/gi, `url($1${proxyBase}/`);

    const bridge = buildBridgeScript(proxyBase, targetOrigin);
    if (/<head[^>]*>/i.test(out)) {
        out = out.replace(/(<head[^>]*>)/i, `$1\n<base href="${proxyBase}/">\n${bridge}`);
    } else {
        out = `<base href="${proxyBase}/">\n${bridge}\n${out}`;
    }
    return out;
}

function rewriteCssForProxy(css, targetOrigin, proxyBase) {
    let out = String(css || '');
    let targetHost = '';
    try { targetHost = new URL(targetOrigin).host; } catch (_) { targetHost = ''; }
    if (targetHost) {
        out = out.replace(new RegExp(`(?:https?:)?//${escapeRegExp(targetHost)}`, 'gi'), proxyBase);
    }
    out = out.replace(/\burl\(\s*(["']?)\/(?!\/|peer\/)/gi, `url($1${proxyBase}/`);
    return out;
}

/**
 * @param {object} options
 * @param {import('mysql2/promise').Pool} options.pool
 * @param {() => boolean} [options.isCentral] returns true on the central hub
 */
function createFederationProxy({ pool, isCentral } = {}) {
    const peerCache = new Map();

    async function lookupPeer(siteCode) {
        const now = Date.now();
        const cached = peerCache.get(siteCode);
        if (cached && now - cached.at < PEER_CACHE_TTL_MS) return cached.peer;
        const [rows] = await pool.query(
            'SELECT id, node_name, host, site_code, api_base_url, status FROM `asterisk`.`sokrat_federation_peers` WHERE site_code = ? LIMIT 1',
            [siteCode]
        );
        const peer = rows && rows[0] ? rows[0] : null;
        peerCache.set(siteCode, { peer, at: now });
        return peer;
    }

    function resolveTarget(peer) {
        const base = normalizeFederationBaseUrl(peer.api_base_url || peer.host);
        let parsed;
        try {
            parsed = new URL(base);
        } catch (_) {
            return null;
        }
        if (!parsed.hostname) return null;
        if (getLocalAddresses().has(parsed.hostname.toLowerCase())) return null;
        const secure = parsed.protocol === 'https:';
        return {
            origin: parsed.origin,
            hostname: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : (secure ? 443 : 80),
            secure
        };
    }

    return async function federationProxyHandler(req, res) {
        try {
            if (typeof isCentral === 'function' && !isCentral()) {
                return res.status(404).send('Not found');
            }

            const siteCode = String(req.params.siteCode || '').trim();
            if (!/^[A-Za-z0-9_-]{1,10}$/.test(siteCode)) {
                return res.status(400).send('Invalid PBX site code.');
            }

            const peer = await lookupPeer(siteCode);
            if (!peer) {
                return res.status(404).send(`Unknown PBX site ${siteCode}.`);
            }

            const proxyBase = buildPeerProxyPath(siteCode);
            const queryIndex = req.originalUrl.indexOf('?');
            const queryString = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);

            // A trailing slash keeps the peer's relative links inside the prefix.
            if (req.path === proxyBase) {
                return res.redirect(302, `${proxyBase}/${queryString}`);
            }

            const target = resolveTarget(peer);
            if (!target) {
                return res.status(502).send(
                    `PBX site ${siteCode} is not reachable through this server. Check its host address in Multi-Server PBX Federation.`
                );
            }

            const cookiePrefix = cookiePrefixFor(siteCode);
            const subPath = req.params[0] ? `/${String(req.params[0]).replace(/^\/+/, '')}` : '/';

            const forwardHeaders = {};
            for (const [name, value] of Object.entries(req.headers)) {
                const lower = name.toLowerCase();
                if (HOP_BY_HOP_HEADERS.has(lower)) continue;
                if (lower === 'host' || lower === 'content-length' || lower === 'cookie') continue;
                forwardHeaders[lower] = value;
            }
            forwardHeaders.host = target.origin.replace(/^https?:\/\//, '');
            forwardHeaders['accept-encoding'] = 'identity';
            forwardHeaders['x-forwarded-host'] = req.headers.host || '';
            forwardHeaders['x-forwarded-proto'] = req.protocol;
            forwardHeaders['x-forwarded-prefix'] = proxyBase;

            const forwardedCookie = unnamespaceCookieHeader(req.headers.cookie, cookiePrefix);
            if (forwardedCookie) forwardHeaders.cookie = forwardedCookie;

            const client = target.secure ? https : http;
            const proxyReq = client.request({
                hostname: target.hostname,
                port: target.port,
                path: subPath + queryString,
                method: req.method,
                headers: forwardHeaders,
                rejectUnauthorized: false, // peer PBX panels use self-signed certs
                timeout: PROXY_TIMEOUT_MS
            }, (targetRes) => {
                const responseHeaders = { ...targetRes.headers };
                delete responseHeaders['content-security-policy'];
                delete responseHeaders['content-security-policy-report-only'];
                delete responseHeaders['x-frame-options'];

                if (responseHeaders.location) {
                    responseHeaders.location = rewriteLocationHeader(responseHeaders.location, target.origin, proxyBase);
                }

                const rawSetCookie = responseHeaders['set-cookie'];
                if (rawSetCookie) {
                    responseHeaders['set-cookie'] = namespaceSetCookie(rawSetCookie, cookiePrefix);
                }

                const contentType = String(responseHeaders['content-type'] || '').toLowerCase();

                if (contentType.includes('text/html')) {
                    const chunks = [];
                    targetRes.on('data', (chunk) => chunks.push(chunk));
                    targetRes.on('end', () => {
                        const raw = Buffer.concat(chunks);
                        const text = raw.toString('utf8');
                        // socket.io answers POSTs with a tiny "ok" body tagged
                        // text/html. Only real documents get rebased, otherwise
                        // the bridge would be injected into protocol frames.
                        if (!looksLikeHtmlDocument(text)) {
                            res.writeHead(targetRes.statusCode || 200, responseHeaders);
                            res.end(raw);
                            return;
                        }
                        const html = rewriteHtmlForProxy(text, target.origin, proxyBase);
                        delete responseHeaders['content-length'];
                        res.writeHead(targetRes.statusCode || 200, responseHeaders);
                        res.end(html);
                    });
                    targetRes.on('error', () => {
                        if (!res.headersSent) res.status(502).end('Bad Gateway');
                    });
                    return;
                }

                if (contentType.includes('text/css')) {
                    const chunks = [];
                    targetRes.on('data', (chunk) => chunks.push(chunk));
                    targetRes.on('end', () => {
                        const css = rewriteCssForProxy(Buffer.concat(chunks).toString('utf8'), target.origin, proxyBase);
                        delete responseHeaders['content-length'];
                        res.writeHead(targetRes.statusCode || 200, responseHeaders);
                        res.end(css);
                    });
                    targetRes.on('error', () => {
                        if (!res.headersSent) res.status(502).end('Bad Gateway');
                    });
                    return;
                }

                res.writeHead(targetRes.statusCode || 200, responseHeaders);
                targetRes.pipe(res);
            });

            proxyReq.on('timeout', () => {
                proxyReq.destroy();
                if (!res.headersSent) res.status(504).send(`Gateway Timeout: PBX ${siteCode} did not respond.`);
            });

            proxyReq.on('error', (err) => {
                if (!res.headersSent) {
                    res.status(502).send(`Bad Gateway: cannot reach PBX ${siteCode} (${err.message}).`);
                }
            });

            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
                const contentType = String(req.headers['content-type'] || '').toLowerCase();
                if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && Object.keys(req.body).length > 0) {
                    const bodyData = contentType.includes('application/json')
                        ? JSON.stringify(req.body)
                        : querystring.stringify(req.body);
                    proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                    proxyReq.end(bodyData);
                } else if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
                    proxyReq.setHeader('Content-Length', Buffer.byteLength(req.body));
                    proxyReq.end(req.body);
                } else if (!req.readableEnded) {
                    req.pipe(proxyReq);
                } else {
                    proxyReq.end();
                }
            } else {
                proxyReq.end();
            }
        } catch (err) {
            if (!res.headersSent) res.status(502).send(`Federation proxy error: ${err.message}`);
        }
    };
}

module.exports = {
    createFederationProxy,
    buildPeerProxyPath,
    cookiePrefixFor,
    namespaceSetCookie,
    unnamespaceCookieHeader,
    rewriteLocationHeader,
    rewriteHtmlForProxy,
    rewriteCssForProxy,
    looksLikeHtmlDocument,
    getLocalAddresses
};
