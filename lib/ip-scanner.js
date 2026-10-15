/**
 * Sokrat VoIP — Local Network IP & Port Scanner Engine
 * Scans strictly local physical networks using nmap and parses live devices,
 * hardware vendors (via MAC OUI), hostnames, and open VoIP/web ports.
 * 
 * STRICT SECURITY INVARIANT:
 * VPN interfaces (Tailscale, ZeroTier, WireGuard, OpenVPN) and virtual container
 * bridges (Docker, veth) are permanently excluded from scanning.
 */

const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// Helper: Convert IPv4 string to 32-bit unsigned integer
function ipToNumber(ip) {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

// Helper: Convert 32-bit integer to IPv4 string
function numberToIp(num) {
    return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
}

// Helper: Convert subnet mask to CIDR prefix length
function maskToCidr(mask) {
    const num = ipToNumber(mask);
    return num.toString(2).split('1').length - 1;
}

/**
 * Discovers strictly physical Ethernet/Wi-Fi local network interfaces.
 * Drops loopback, Tailscale (100.64.0.0/10), ZeroTier, OpenVPN, WireGuard, and Docker.
 */
function getLocalPhysicalInterfaces() {
    const ifaces = os.networkInterfaces();
    const result = [];

    for (const [name, addrs] of Object.entries(ifaces)) {
        // Exclude virtual/VPN/container interfaces by name prefix
        const lower = name.toLowerCase();
        if (
            lower === 'lo' ||
            lower.startsWith('tailscale') ||
            lower.startsWith('zt') ||
            lower.startsWith('tun') ||
            lower.startsWith('tap') ||
            lower.startsWith('wg') ||
            lower.startsWith('docker') ||
            lower.startsWith('br-') ||
            lower.startsWith('veth')
        ) {
            continue;
        }

        // Must be a physical hardware NIC with a sysfs device entry
        const isPhysical = fs.existsSync('/sys/class/net/' + name + '/device');
        if (!isPhysical) {
            continue;
        }

        for (const addr of (addrs || [])) {
            if (addr.family === 'IPv4' && !addr.internal) {
                // Double-check: reject CGNAT Tailscale block 100.64.0.0/10
                const ipNum = ipToNumber(addr.address);
                if ((ipNum & 0xFFC00000) === 0x64400000) {
                    continue;
                }

                const maskNum = ipToNumber(addr.netmask);
                const cidr = maskToCidr(addr.netmask);
                const netNum = (ipNum & maskNum) >>> 0;
                const subnet = numberToIp(netNum) + '/' + cidr;

                result.push({
                    iface: name,
                    ip: addr.address,
                    netmask: addr.netmask,
                    cidr,
                    subnet,
                    netNum,
                    maskNum,
                    label: `${name} · ${subnet} (Local IP: ${addr.address})`
                });
            }
        }
    }
    return result;
}

/**
 * Validates whether a target CIDR or IP belongs strictly to one of the physical local subnets.
 * Rejects VPNs, public WAN IPs, loopback, and malformed inputs.
 */
function isTargetAllowed(targetStr, allowedInterfaces = null) {
    if (!targetStr || typeof targetStr !== 'string') return false;
    const cleanTarget = targetStr.trim();
    const ifaces = allowedInterfaces || getLocalPhysicalInterfaces();
    if (!ifaces || ifaces.length === 0) return false;

    // 1. Exact match with an allowed local subnet (e.g. 192.168.100.0/24)
    for (const lif of ifaces) {
        if (cleanTarget === lif.subnet) return true;
    }

    // 2. Single IPv4 address strictly within an allowed local subnet
    const singleIpMatch = cleanTarget.match(/^(\d{1,3}\.){3}\d{1,3}$/);
    if (singleIpMatch) {
        const tNum = ipToNumber(cleanTarget);
        for (const lif of ifaces) {
            if (((tNum & lif.maskNum) >>> 0) === lif.netNum) {
                const bcastNum = (lif.netNum | (~lif.maskNum >>> 0)) >>> 0;
                // Exclude network and broadcast addresses
                if (tNum !== lif.netNum && tNum !== bcastNum) {
                    return true;
                }
            }
        }
    }

    // 3. Local IPv4 range within an allowed local subnet (e.g. 192.168.100.1-50)
    const rangeMatch = cleanTarget.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.)(\d{1,3})-(\d{1,3})$/);
    if (rangeMatch) {
        const prefix = rangeMatch[1];
        const start = parseInt(rangeMatch[2], 10);
        const end = parseInt(rangeMatch[3], 10);
        if (start <= end && start >= 1 && end <= 254) {
            const startNum = ipToNumber(prefix + start);
            const endNum = ipToNumber(prefix + end);
            for (const lif of ifaces) {
                if (((startNum & lif.maskNum) >>> 0) === lif.netNum && ((endNum & lif.maskNum) >>> 0) === lif.netNum) {
                    return true;
                }
            }
        }
    }

    return false;
}

/**
 * Probes a specific HTTP/HTTPS port on a target IP address.
 * Follows up to 2 local redirects and extracts:
 * - Server HTTP header (e.g. Apache/2.4.37, nginx, Web-Server/3.0)
 * - HTML <title> tag (e.g. Sokrat VOIP - Login, Grandstream GXP2160, Web Image Monitor)
 */
function probeWebPort(ip, port, timeoutMs = 2500) {
    const isHttps = (port === 443 || port === 8443);
    const client = isHttps ? https : http;

    return new Promise((resolve) => {
        let resolved = false;

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(null);
            }
        }, timeoutMs);

        function doRequest(reqPath, redirectCount = 0) {
            if (redirectCount > 2) {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    resolve(null);
                }
                return;
            }

            try {
                const req = client.request({
                    hostname: ip,
                    port: port,
                    path: reqPath,
                    method: 'GET',
                    rejectUnauthorized: false,
                    timeout: timeoutMs,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Sokrat-IP-Scanner',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                    }
                }, (res) => {
                    let body = '';
                    res.on('data', (chunk) => {
                        if (body.length < 8192) body += chunk.toString();
                    });
                    res.on('end', () => {
                        if (resolved) return;

                        const serverHdr = (res.headers['server'] || '').trim();
                        const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
                        let title = titleMatch ? titleMatch[1].replace(/[\r\n\t]+/g, ' ').trim() : '';

                        // Ignore generic redirect page titles
                        const lowerTitle = title.toLowerCase();
                        if (lowerTitle.startsWith('redirecting') || lowerTitle.includes('301') || lowerTitle.includes('302') || lowerTitle.includes('moved')) {
                            title = '';
                        }

                        // Follow redirect if location header present
                        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers['location']) {
                            let loc = res.headers['location'].trim();
                            if (loc.startsWith('http://') || loc.startsWith('https://')) {
                                try {
                                    const u = new URL(loc);
                                    loc = u.pathname + (u.search || '');
                                } catch (_) {}
                            }
                            if (loc.startsWith('/')) {
                                return doRequest(loc, redirectCount + 1);
                            }
                        }

                        resolved = true;
                        clearTimeout(timer);
                        resolve({
                            port,
                            isHttps,
                            serverHdr,
                            title,
                            statusCode: res.statusCode
                        });
                    });
                });

                req.on('error', () => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timer);
                        resolve(null);
                    }
                });

                req.on('timeout', () => {
                    req.destroy();
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timer);
                        resolve(null);
                    }
                });

                req.end();
            } catch (_) {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    resolve(null);
                }
            }
        }

        doRequest('/');
    });
}

/**
 * Concurrently probes all detected open web ports across scanned hosts
 * and annotates them with httpServerName, httpServer, and httpTitle.
 */
async function enrichHostsWithWebInfo(hosts) {
    if (!Array.isArray(hosts) || hosts.length === 0) return hosts;

    const probeTasks = [];

    for (const host of hosts) {
        const webPorts = (host.ports || []).filter(p =>
            [80, 443, 8080, 8443, 8000, 8888, 3000, 5000].includes(p.port) ||
            (p.service && (p.service.includes('http') || p.service.includes('www') || p.service.includes('web')))
        );

        if (webPorts.length === 0) continue;

        // Prioritize common web ports: 80, 443, 8080, 8443
        const sortedWebPorts = [...webPorts].sort((a, b) => {
            const order = { 80: 1, 443: 2, 8080: 3, 8443: 4 };
            return (order[a.port] || 99) - (order[b.port] || 99);
        });

        // Add task for this host
        probeTasks.push((async () => {
            for (const wp of sortedWebPorts) {
                const info = await probeWebPort(host.ip, wp.port, 2500);
                if (info && (info.serverHdr || info.title || info.statusCode)) {
                    // Formulate web server name
                    let displayName = '';
                    if (info.title && info.serverHdr) {
                        displayName = `${info.title} (${info.serverHdr})`;
                    } else if (info.title) {
                        displayName = info.title;
                    } else if (info.serverHdr) {
                        displayName = info.serverHdr;
                    } else if (info.statusCode) {
                        displayName = `HTTP Web Server (${info.statusCode})`;
                    }

                    host.httpServerName = displayName;
                    host.httpServer = info.serverHdr || '';
                    host.httpTitle = info.title || '';
                    host.httpPort = info.port;

                    // Annotate port
                    wp.webServerName = displayName;

                    // If title or server identifies a VoIP phone/gateway, mark as VoIP device
                    const lowerInfo = (displayName + ' ' + (info.serverHdr || '')).toLowerCase();
                    if (
                        lowerInfo.includes('grandstream') ||
                        lowerInfo.includes('yealink') ||
                        lowerInfo.includes('cisco') ||
                        lowerInfo.includes('fanvil') ||
                        lowerInfo.includes('snom') ||
                        lowerInfo.includes('polycom') ||
                        lowerInfo.includes('avaya') ||
                        lowerInfo.includes('asterisk') ||
                        lowerInfo.includes('issabel') ||
                        lowerInfo.includes('freepbx')
                    ) {
                        host.isVoipDevice = true;
                    }

                    break; // Found primary web server on this host
                }
            }
        })());
    }

    if (probeTasks.length > 0) {
        await Promise.allSettled(probeTasks);
    }

    return hosts;
}

/**
 * Reverse proxies an HTTP/HTTPS request to an authorized local physical LAN device.
 * Strips iframe blockers (X-Frame-Options, CSP frame-ancestors), rewrites redirect Locations,
 * injects <base href="...">, and rewrites root-relative URLs in HTML responses.
 */
function handleDeviceProxy(req, res) {
    const targetIp = (req.params.targetIp || '').trim();
    const targetPort = parseInt(req.params.targetPort, 10);

    // 1. Strict Security Guard: Only physical local LAN devices are permitted
    const localIfaces = getLocalPhysicalInterfaces();
    if (!isTargetAllowed(targetIp, localIfaces)) {
        return res.status(403).send('Forbidden: Target IP is outside authorized physical local networks.');
    }

    if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
        return res.status(400).send('Invalid port number.');
    }

    const proxyBase = `/api/config/ipscan/proxy/${encodeURIComponent(targetIp)}/${encodeURIComponent(targetPort)}`;

    // If accessed without trailing slash, redirect with trailing slash for correct relative asset resolution
    if (req.params[0] === undefined && !req.path.endsWith('/')) {
        const queryStr = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        return res.redirect(302, `${proxyBase}/${queryStr}`);
    }

    const isHttps = (targetPort === 443 || targetPort === 8443 || req.query.ssl === '1');
    const client = isHttps ? https : http;

    // Determine subpath on target device
    const subPath = req.params[0] ? ('/' + String(req.params[0]).replace(/^\/+/, '')) : '/';
    // Append query string if any
    const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const targetPath = subPath + rawQuery;

    // Filter and prepare headers to send to target device
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    // Request uncompressed response so we can inspect and rewrite HTML if needed
    forwardHeaders['accept-encoding'] = 'identity';
    forwardHeaders['host'] = `${targetIp}:${targetPort}`;
    forwardHeaders['x-forwarded-host'] = req.headers.host || `${targetIp}:${targetPort}`;
    forwardHeaders['x-forwarded-proto'] = req.protocol || (req.connection && req.connection.encrypted ? 'https' : 'http');
    forwardHeaders['x-forwarded-prefix'] = proxyBase;

    const proxyReq = client.request({
        hostname: targetIp,
        port: targetPort,
        path: targetPath,
        method: req.method,
        headers: forwardHeaders,
        rejectUnauthorized: false,
        timeout: 10000
    }, (targetRes) => {
        const responseHeaders = { ...targetRes.headers };

        // Strip headers that prevent embedding in iframes
        delete responseHeaders['x-frame-options'];
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['content-security-policy-report-only'];

        // Rewrite redirects (Location header)
        if (responseHeaders['location']) {
            let loc = responseHeaders['location'].trim();
            const targetUrlPrefix = `${isHttps ? 'https' : 'http'}://${targetIp}:${targetPort}`;
            const targetUrlPrefixNoPort = `${isHttps ? 'https' : 'http'}://${targetIp}`;
            if (loc.startsWith(targetUrlPrefix)) {
                loc = loc.slice(targetUrlPrefix.length);
            } else if (loc.startsWith(targetUrlPrefixNoPort)) {
                loc = loc.slice(targetUrlPrefixNoPort.length);
            }

            if (loc.startsWith('/')) {
                responseHeaders['location'] = `${proxyBase}${loc}`;
            } else if (!loc.startsWith('http://') && !loc.startsWith('https://')) {
                responseHeaders['location'] = `${proxyBase}/${loc}`;
            }
        }

        // Rewrite Cookies (Set-Cookie)
        if (responseHeaders['set-cookie']) {
            const rawCookies = Array.isArray(responseHeaders['set-cookie'])
                ? responseHeaders['set-cookie']
                : [responseHeaders['set-cookie']];
            responseHeaders['set-cookie'] = rawCookies.map(c => {
                let cookie = c.replace(/domain=[^;]+;?/i, '');
                cookie = cookie.replace(/path=\/[^;]*/i, `path=${proxyBase}`);
                return cookie;
            });
        }

        const contentType = (responseHeaders['content-type'] || '').toLowerCase();
        const isHtml = contentType.includes('text/html');
        const isCss = contentType.includes('text/css');

        if (isHtml) {
            delete responseHeaders['content-length']; // Length will change after rewrite
            const chunks = [];
            targetRes.on('data', chunk => chunks.push(chunk));
            targetRes.on('end', () => {
                const bodyBuf = Buffer.concat(chunks);
                let html = bodyBuf.toString('utf8');

                // 1. Rewrite explicit absolute URLs to target IP and port (e.g. http://192.168.122.77:8080/...)
                const absUrlRegex = new RegExp(`https?:\\/\\/${targetIp.replace(/\\./g, '\\.')}(?::${targetPort})?`, 'gi');
                html = html.replace(absUrlRegex, proxyBase);

                // 2. Rewrite root-relative URLs in HTML attributes (href, src, action, data-url)
                html = html.replace(/\b(href|src|action|data-url)=("|')\/(?!\/|api\/config\/ipscan\/proxy)/gi, `$1=$2${proxyBase}/`);
                html = html.replace(/\bURL=\/(?!\/|api\/config\/ipscan\/proxy)/gi, `URL=${proxyBase}/`);

                // 3. Rewrite url(/...) inside style tags
                html = html.replace(/\burl\(\s*(["']?)\/(?!\/|api\/config\/ipscan\/proxy)/gi, `url($1${proxyBase}/`);

                // 4. Client-side navigation & fetch/xhr hook bridge
                const bridgeScript = `
<script id="__sokrat_proxy_bridge">
(function() {
    const PROXY_BASE = "${proxyBase}";
    const TARGET_HOST = "${targetIp}:${targetPort}";

    function toProxyUrl(url) {
        if (!url || typeof url !== 'string') return url;
        const u = url.trim();
        if (u.startsWith('#') || u.startsWith('javascript:') || u.startsWith('data:') || u.startsWith('mailto:')) return url;
        if (u.startsWith(PROXY_BASE)) return url;
        
        if (u.startsWith('http://' + TARGET_HOST) || u.startsWith('https://' + TARGET_HOST)) {
            const rel = u.replace(new RegExp('^https?:\\\\/\\\\/' + TARGET_HOST.replace(/\\./g, '\\\\.')), '');
            return PROXY_BASE + (rel.startsWith('/') ? rel : '/' + rel);
        }
        
        if (u.startsWith('/') && !u.startsWith('//')) {
            return PROXY_BASE + u;
        }
        return url;
    }

    document.addEventListener('click', function(e) {
        const a = e.target.closest('a');
        if (a) {
            const rawHref = a.getAttribute('href');
            if (rawHref && (rawHref.startsWith('/') || rawHref.includes(TARGET_HOST)) && !rawHref.startsWith(PROXY_BASE)) {
                e.preventDefault();
                window.location.href = toProxyUrl(rawHref);
            }
        }
    }, true);

    document.addEventListener('submit', function(e) {
        const form = e.target;
        if (form) {
            const action = form.getAttribute('action');
            if (action && (action.startsWith('/') || action.includes(TARGET_HOST)) && !action.startsWith(PROXY_BASE)) {
                form.action = toProxyUrl(action);
            }
        }
    }, true);

    if (window.fetch) {
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
            if (typeof input === 'string') {
                input = toProxyUrl(input);
            } else if (input instanceof Request) {
                input = new Request(toProxyUrl(input.url), input);
            }
            return origFetch.call(this, input, init);
        };
    }

    if (window.XMLHttpRequest) {
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            url = toProxyUrl(url);
            return origOpen.call(this, method, url, async, user, password);
        };
    }

    if (window.history && window.history.pushState) {
        const origPush = window.history.pushState;
        window.history.pushState = function(state, title, url) {
            if (url) url = toProxyUrl(url);
            return origPush.call(this, state, title, url);
        };
        const origHistReplace = window.history.replaceState;
        window.history.replaceState = function(state, title, url) {
            if (url) url = toProxyUrl(url);
            return origHistReplace.call(this, state, title, url);
        };
    }

    function notifyLocation() {
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({
                    type: 'sokrat_proxy_nav',
                    pathname: window.location.pathname.replace(PROXY_BASE, '') || '/',
                    search: window.location.search
                }, '*');
            }
        } catch (_) {}
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        notifyLocation();
    } else {
        document.addEventListener('DOMContentLoaded', notifyLocation);
    }
})();
</script>
`;

                // 5. Neutralize frame busters that try to break out of the iframe
                html = html.replace(/\btop\.location\b/g, 'window.location');
                html = html.replace(/\bparent\.location\b/g, 'window.location');
                html = html.replace(/\bwindow\.top\b/g, 'window.self');

                // 6. Inject <base href="..."> and bridge script into <head>
                if (/<head[^>]*>/i.test(html)) {
                    html = html.replace(/(<head[^>]*>)/i, `$1\n<base href="${proxyBase}/">\n${bridgeScript}`);
                } else {
                    html = `<base href="${proxyBase}/">\n${bridgeScript}\n` + html;
                }

                res.writeHead(targetRes.statusCode, responseHeaders);
                res.end(html);
            });
        } else if (isCss) {
            delete responseHeaders['content-length'];
            const chunks = [];
            targetRes.on('data', chunk => chunks.push(chunk));
            targetRes.on('end', () => {
                let css = Buffer.concat(chunks).toString('utf8');
                const absUrlRegex = new RegExp(`https?:\\/\\/${targetIp.replace(/\\./g, '\\.')}(?::${targetPort})?`, 'gi');
                css = css.replace(absUrlRegex, proxyBase);
                css = css.replace(/\burl\(\s*(["']?)\/(?!\/|api\/config\/ipscan\/proxy)/gi, `url($1${proxyBase}/`);
                res.writeHead(targetRes.statusCode, responseHeaders);
                res.end(css);
            });
        } else {
            // Stream binary, images, audio, js directly
            res.writeHead(targetRes.statusCode, responseHeaders);
            targetRes.pipe(res);
        }
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
            if (typeof res.status === 'function') {
                res.status(504).send(`Gateway Timeout: Device at ${targetIp}:${targetPort} did not respond within 10 seconds.`);
            } else {
                res.writeHead(504, { 'Content-Type': 'text/plain' });
                res.end(`Gateway Timeout: Device at ${targetIp}:${targetPort} did not respond within 10 seconds.`);
            }
        }
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            if (typeof res.status === 'function') {
                res.status(502).send(`Bad Gateway: Failed to connect to device at ${targetIp}:${targetPort} (${err.message})`);
            } else {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end(`Bad Gateway: Failed to connect to device at ${targetIp}:${targetPort} (${err.message})`);
            }
        }
    });

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        req.pipe(proxyReq);
    } else {
        proxyReq.end();
    }
}

/**
 * Parses Nmap XML output (-oX -) into clean, structured JSON device objects.
 */
function parseNmapXml(xml) {
    if (!xml || typeof xml !== 'string') return [];
    const hosts = [];
    const hostRegex = /<host[\s\S]*?<\/host>/gi;
    let match;

    while ((match = hostRegex.exec(xml)) !== null) {
        const hXml = match[0];

        // Status check
        const statusMatch = hXml.match(/<status\s+state="([^"]+)"/i);
        const state = statusMatch ? statusMatch[1] : 'unknown';
        if (state !== 'up') continue;

        // IPv4 address
        const ipv4Match = hXml.match(/<address\s+addr="([^"]+)"\s+addrtype="ipv4"/i);
        if (!ipv4Match) continue;
        const ip = ipv4Match[1];

        // MAC & Vendor
        const macMatch = hXml.match(/<address\s+addr="([^"]+)"\s+addrtype="mac"(?:\s+vendor="([^"]*)")?/i);
        const mac = macMatch ? macMatch[1].toUpperCase() : '';
        const vendor = macMatch && macMatch[2] ? macMatch[2].trim() : '';

        // Hostname
        const hostNameMatch = hXml.match(/<hostname\s+name="([^"]+)"/i);
        const hostname = hostNameMatch ? hostNameMatch[1].trim() : '';

        // Latency
        const timeMatch = hXml.match(/<times\s+srtt="(\d+)"/i);
        const latencyMs = timeMatch ? (parseInt(timeMatch[1], 10) / 1000).toFixed(1) : '';

        // Open Ports & Services
        const ports = [];
        const portRegex = /<port\s+protocol="([^"]+)"\s+portid="([^"]+)">([\s\S]*?)<\/port>/gi;
        let pMatch;

        while ((pMatch = portRegex.exec(hXml)) !== null) {
            const proto = pMatch[1].toLowerCase();
            const port = parseInt(pMatch[2], 10);
            const portBody = pMatch[3];

            const stateMatch = portBody.match(/<state\s+state="([^"]+)"/i);
            const pState = stateMatch ? stateMatch[1].toLowerCase() : '';

            const serviceMatch = portBody.match(/<service\s+name="([^"]+)"/i);
            const sName = serviceMatch ? serviceMatch[1].toLowerCase() : '';

            if (pState === 'open') {
                ports.push({ port, protocol: proto, state: pState, service: sName });
            }
        }

        // Detect VoIP Phone / Gateway signature
        let isVoipDevice = false;
        const vLower = (vendor + ' ' + hostname).toLowerCase();
        if (
            vLower.includes('grandstream') ||
            vLower.includes('yealink') ||
            vLower.includes('cisco') ||
            vLower.includes('fanvil') ||
            vLower.includes('snom') ||
            vLower.includes('polycom') ||
            vLower.includes('dinstar') ||
            vLower.includes('flyingvoice') ||
            ports.some(p => p.port === 5060 || p.port === 5061 || p.service === 'sip')
        ) {
            isVoipDevice = true;
        }

        hosts.push({
            ip,
            mac,
            vendor: vendor || 'Unknown Vendor',
            hostname,
            status: state,
            latencyMs,
            isVoipDevice,
            httpServerName: '',
            httpServer: '',
            httpTitle: '',
            httpPort: null,
            ports
        });
    }

    // Sort IP addresses numerically
    hosts.sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip));
    return hosts;
}

// In-Memory Scan State Management
let currentScanProcess = null;
let currentScanState = {
    scanning: false,
    target: '',
    profile: '',
    startTime: null,
    endTime: null,
    durationSec: 0,
    results: [],
    error: null
};

/**
 * Starts an asynchronous nmap scan against an authorized local network target.
 */
function startScan({ target, profile = 'voip', customPorts = '' }) {
    if (currentScanState.scanning) {
        throw new Error('A network scan is already currently in progress. Stop the current scan before starting a new one.');
    }

    const localIfaces = getLocalPhysicalInterfaces();
    if (!isTargetAllowed(target, localIfaces)) {
        throw new Error(`Target '${target}' is outside authorized physical local networks. VPN and public networks are strictly prohibited.`);
    }

    // Determine Nmap CLI arguments based on profile
    let nmapArgs = ['-oX', '-'];

    if (profile === 'quick') {
        // Fast ARP Ping discovery
        nmapArgs.push('-sn', '-PR', target);
    } else if (profile === 'ports') {
        // Fast scan of top 100 ports
        nmapArgs.push('-sS', '-T4', '-F', target);
    } else if (profile === 'custom' && customPorts) {
        // Sanitized port list
        const cleanPorts = customPorts.replace(/[^0-9,-]/g, '');
        if (!cleanPorts) throw new Error('Invalid custom port list.');
        nmapArgs.push('-sS', '-T4', '-p', cleanPorts, target);
    } else {
        // Default VoIP & Management Ports Profile (HTTP 80/443/8080/8443, SIP 5060/5061, SSH 22, AMI 5038)
        nmapArgs.push('-sS', '-T4', '-p', '22,80,443,5038,5060,5061,8080,8443', target);
    }

    currentScanState = {
        scanning: true,
        target,
        profile,
        startTime: new Date().toISOString(),
        endTime: null,
        durationSec: 0,
        results: [],
        error: null
    };

    const startTimeEpoch = Date.now();
    let stdoutBuffer = '';
    let stderrBuffer = '';

    try {
        currentScanProcess = spawn('nmap', nmapArgs);

        currentScanProcess.stdout.on('data', (chunk) => {
            stdoutBuffer += chunk.toString();
        });

        currentScanProcess.stderr.on('data', (chunk) => {
            stderrBuffer += chunk.toString();
        });

        currentScanProcess.on('close', (code) => {
            currentScanProcess = null;

            if (code === 0) {
                try {
                    const parsedHosts = parseNmapXml(stdoutBuffer);
                    // Asynchronously probe open HTTP/HTTPS ports to identify server software and page title
                    enrichHostsWithWebInfo(parsedHosts).then((enriched) => {
                        currentScanState.results = enriched;
                        currentScanState.error = null;
                        currentScanState.scanning = false;
                        currentScanState.endTime = new Date().toISOString();
                        currentScanState.durationSec = Math.round((Date.now() - startTimeEpoch) / 1000);
                    }).catch(() => {
                        currentScanState.results = parsedHosts;
                        currentScanState.error = null;
                        currentScanState.scanning = false;
                        currentScanState.endTime = new Date().toISOString();
                        currentScanState.durationSec = Math.round((Date.now() - startTimeEpoch) / 1000);
                    });
                } catch (parseErr) {
                    currentScanState.scanning = false;
                    currentScanState.endTime = new Date().toISOString();
                    currentScanState.durationSec = Math.round((Date.now() - startTimeEpoch) / 1000);
                    currentScanState.error = 'Failed to parse scan output: ' + parseErr.message;
                }
            } else {
                currentScanState.scanning = false;
                currentScanState.endTime = new Date().toISOString();
                currentScanState.durationSec = Math.round((Date.now() - startTimeEpoch) / 1000);
                currentScanState.error = stderrBuffer.trim() || `Scan exited with process code ${code}`;
            }
        });

        currentScanProcess.on('error', (err) => {
            currentScanProcess = null;
            currentScanState.scanning = false;
            currentScanState.error = err.message;
        });

        return { success: true, message: 'Scan started', state: currentScanState };
    } catch (err) {
        currentScanProcess = null;
        currentScanState.scanning = false;
        currentScanState.error = err.message;
        throw err;
    }
}

/**
 * Stops an active nmap scan cleanly.
 */
function stopScan() {
    if (currentScanProcess && currentScanState.scanning) {
        try {
            currentScanProcess.kill('SIGTERM');
        } catch (_) {}
        currentScanProcess = null;
        currentScanState.scanning = false;
        currentScanState.error = 'Scan canceled by operator.';
        return { success: true, message: 'Scan stopped' };
    }
    return { success: true, message: 'No scan in progress' };
}

/**
 * Returns the current scan state and cached results.
 */
function getScanStatus() {
    return {
        ...currentScanState,
        durationSec: currentScanState.scanning
            ? Math.round((Date.now() - new Date(currentScanState.startTime).getTime()) / 1000)
            : currentScanState.durationSec
    };
}

module.exports = {
    getLocalPhysicalInterfaces,
    isTargetAllowed,
    parseNmapXml,
    probeWebPort,
    enrichHostsWithWebInfo,
    handleDeviceProxy,
    startScan,
    stopScan,
    getScanStatus
};
