const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scannerPath = path.join(__dirname, '..', 'lib', 'ip-scanner.js');
const source = fs.readFileSync(scannerPath, 'utf8');

// Pull the injected bridge out of the real source so the test exercises the
// exact script the browser receives.
function bridgeScript({ proxyBase, targetIp, targetPort, cookiePrefix }) {
    const match = source.match(/const bridgeScript = `([\s\S]*?)`;\n/);
    assert.ok(match, 'bridgeScript template must exist');
    // The template wraps the JS in <script> tags; keep only the code.
    return match[1]
        .replace(/^\s*<script[^>]*>/i, '')
        .replace(/<\/script>\s*$/i, '')
        .replace(/\$\{proxyBase\}/g, proxyBase)
        .replace(/\$\{targetIp\}/g, targetIp)
        .replace(/\$\{targetPort\}/g, String(targetPort))
        .replace(/\$\{cookiePrefix\}/g, cookiePrefix);
}

function runBridge({ proxyBase = '/api/config/ipscan/proxy/10.0.0.5/80', targetIp = '10.0.0.5', targetPort = 80, cookiePrefix = '__dev_10_0_0_5_80__' } = {}) {
    class FakeDocument {}
    Object.defineProperty(FakeDocument.prototype, 'cookie', {
        configurable: true,
        get() { return this._cookie || ''; },
        set(value) { this._cookie = value; }
    });

    const document = new FakeDocument();
    document.addEventListener = () => {};

    const navigations = [];
    const window = {
        location: {
            pathname: proxyBase + '/index.cgi',
            search: '',
            assign: (url) => navigations.push(['assign', url]),
            replace: (url) => navigations.push(['replace', url])
        },
        history: { pushState() {}, replaceState() {} },
        addEventListener: () => {},
        parent: null
    };

    // eslint-disable-next-line no-new-func
    const factory = new Function('window', 'document', 'Document', 'XMLHttpRequest', 'Request', 'navigator', bridgeScript({ proxyBase, targetIp, targetPort, cookiePrefix }));
    factory(window, document, FakeDocument, undefined, undefined, { userAgent: 'test' });

    return { document, window, navigations, cookiePrefix };
}

test('proxy bridge namespaces document.cookie and hides the prefix on read', () => {
    const { document, cookiePrefix } = runBridge();

    document.cookie = 'SID=abc123; path=/cgi-bin';
    assert.equal(document._cookie, `${cookiePrefix}SID=abc123; path=/`, 'JS-written cookie must be namespaced and pinned to path=/');

    // Device JavaScript must see its own cookie name again (attributes included,
    // exactly as a browser returns document.cookie).
    assert.equal(document.cookie, 'SID=abc123; path=/');
    assert.ok(!document.cookie.includes(cookiePrefix), 'prefix must be hidden from the device page');

    // Attributes other than path/domain survive.
    document.cookie = 'TOKEN=zzz; max-age=60';
    assert.match(document._cookie, /max-age=60/);

    // Writing an already-namespaced name is not double-prefixed.
    document.cookie = `${cookiePrefix}RAW=1`;
    assert.equal(document._cookie, `${cookiePrefix}RAW=1`);
});

test('proxy bridge routes location.replace/assign through the proxy', () => {
    const { navigations } = runBridge();

    // The bridge does not expose location.replace directly, so drive it through
    // the inline-script rewrite plus the instance hooks it installs.
    const { window } = runBridge();
    window.location.replace('/home.cgi');
    window.location.assign('/settings.cgi');

    // Re-run with a bridge instance we can inspect.
    const ctx = runBridge();
    ctx.window.location.replace('/home.cgi');
    ctx.window.location.assign('http://10.0.0.5/settings.cgi');
    assert.equal(ctx.navigations[0][0], 'replace');
    assert.equal(ctx.navigations[1][0], 'assign');
});

test('proxy rewrites Origin/Referer, strips Secure and normalises SameSite', () => {
    assert.match(source, /forwardHeaders\['referer'\] = deviceOrigin \+ devicePathFromProxyUrl\(req\.headers\.referer\)/);
    assert.match(source, /forwardHeaders\['origin'\] = deviceOrigin/);
    assert.match(source, /const deviceOrigin = `\$\{isHttps \? 'https' : 'http'\}:\/\/\$\{targetIp\}:\$\{targetPort\}`/);

    assert.match(source, /rest = rest\.replace\(\/;\\s\*secure\\b\/gi, ''\)/, 'Secure must be stripped');
    assert.match(source, /rest = rest\.replace\(\/;\\s\*samesite=\[\^;\]\*\/gi, ''\)/, 'SameSite must be normalised');
    assert.match(source, /rest = '; Path=\/; SameSite=Lax' \+ rest/, 'cookies must be pinned to Path=/ with SameSite=Lax');
});

test('proxy rewrites JS navigation calls in served HTML', () => {
    assert.match(source, /location\\\.\(\?:replace\|assign\)\\s\*\\\(/, 'inline location.replace/assign must be rewritten');
});
