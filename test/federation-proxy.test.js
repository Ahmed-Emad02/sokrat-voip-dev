'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    buildPeerProxyPath,
    cookiePrefixFor,
    namespaceSetCookie,
    unnamespaceCookieHeader,
    rewriteLocationHeader,
    rewriteHtmlForProxy,
    rewriteCssForProxy,
    looksLikeHtmlDocument
} = require('../lib/federation-proxy');

const TARGET = 'https://192.168.100.92';
const BASE = '/peer/20';

test('Federation proxy: peer panels mount under a per-site prefix', () => {
    assert.equal(buildPeerProxyPath('20'), '/peer/20');
    assert.equal(buildPeerProxyPath(' 30 '), '/peer/30');
    assert.equal(buildPeerProxyPath('a/b'), '/peer/a%2Fb');
});

test('Federation proxy: peer cookies are namespaced and never leak the central session', () => {
    const prefix = cookiePrefixFor('20');
    assert.equal(prefix, '__fed_20__');

    const out = namespaceSetCookie(
        'connect.sid=s%3Aabc.def; Path=/; HttpOnly; SameSite=Lax; Secure',
        prefix
    );
    assert.equal(out.length, 1);
    assert.match(out[0], /^__fed_20__connect\.sid=/);
    assert.doesNotMatch(out[0], /;\s*secure/i, 'Secure must be stripped so HTTP access still works');
    assert.match(out[0], /Path=\//);

    const forwarded = unnamespaceCookieHeader(
        '__fed_20__connect.sid=s%3Aabc.def; connect.sid=s%3Acentral.secret; theme=dark',
        prefix
    );
    assert.equal(forwarded, 'connect.sid=s%3Aabc.def');
    assert.doesNotMatch(forwarded, /central\.secret/, 'the central session cookie must never be forwarded');
    assert.doesNotMatch(forwarded, /theme=dark/, 'cookies owned by the central panel must not be forwarded');
});

test('Federation proxy: redirects stay inside the peer prefix', () => {
    assert.equal(rewriteLocationHeader('https://192.168.100.92/', TARGET, BASE), `${BASE}/`);
    assert.equal(rewriteLocationHeader('https://192.168.100.92/cdr?x=1', TARGET, BASE), `${BASE}/cdr?x=1`);
    assert.equal(rewriteLocationHeader('/login', TARGET, BASE), `${BASE}/login`);
    assert.equal(rewriteLocationHeader('dashboard', TARGET, BASE), `${BASE}/dashboard`);
    assert.equal(rewriteLocationHeader('https://example.com/x', TARGET, BASE), 'https://example.com/x');
});

test('Federation proxy: peer HTML is rebased and the runtime bridge is injected', () => {
    const html = `<!doctype html><html><head><title>PBX</title>
        <link rel="stylesheet" href="/css/app.css">
        <script src="/socket.io/socket.io.js"></script>
        </head><body>
        <a href="/cdr">CDR</a>
        <img src="https://192.168.100.92/img/logo.png">
        <form action="/login" method="post"></form>
        </body></html>`;

    const out = rewriteHtmlForProxy(html, TARGET, BASE);

    assert.match(out, /<base href="\/peer\/20\/">/);
    assert.match(out, /id="__sokrat_fed_bridge"/);
    assert.match(out, /socket\.io WebSocket is disabled through the federation proxy/,
        'socket.io must be pinned to long-polling');
    assert.match(out, /href="\/peer\/20\/css\/app\.css"/);
    assert.match(out, /src="\/peer\/20\/socket\.io\/socket\.io\.js"/);
    assert.match(out, /href="\/peer\/20\/cdr"/);
    assert.match(out, /action="\/peer\/20\/login"/);
    assert.match(out, /src="\/peer\/20\/img\/logo\.png"/);
    assert.doesNotMatch(out, /src="https:\/\/192\.168\.100\.92/, 'absolute asset URLs must be rebased');
});

test('Federation proxy: protocol frames tagged text/html are not treated as documents', () => {
    assert.equal(looksLikeHtmlDocument('ok'), false);
    assert.equal(looksLikeHtmlDocument(''), false);
    assert.equal(looksLikeHtmlDocument('{"success":true}'), false);
    assert.equal(looksLikeHtmlDocument('<!DOCTYPE html><html>'), true);
    assert.equal(looksLikeHtmlDocument('\n  <html lang="en">'), true);
});

test('Federation proxy: peer CSS url() references are rebased', () => {
    const out = rewriteCssForProxy(
        'body{background:url("/img/bg.png")} @import url(/css/x.css); .a{background:url(https://192.168.100.92/i/a.png)}',
        TARGET,
        BASE
    );
    assert.match(out, /url\("\/peer\/20\/img\/bg\.png"\)/);
    assert.match(out, /url\(\/peer\/20\/css\/x\.css\)/);
    assert.match(out, /url\(\/peer\/20\/i\/a\.png\)/);
});

test('Federation proxy: routes are registered behind auth and gated on the central role', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /app\.all\(\['\/peer\/:siteCode', '\/peer\/:siteCode\/\*'\], requireAuth, federationPanelProxy\)/);
    assert.match(server, /panel_role === 'central'/, 'the proxy must only serve on the central node');
    assert.match(server, /const federationPanelProxy = createFederationProxy\(/);

    const proxy = fs.readFileSync(path.join(__dirname, '..', 'lib', 'federation-proxy.js'), 'utf8');
    assert.match(proxy, /getLocalAddresses\(\)\.has\(/, 'a peer pointing back at this server must be rejected');
});

test('Federation proxy: the PBX scope menu offers a per-peer open button', () => {
    const selector = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'node-scope-selector.ejs'), 'utf8');
    assert.match(selector, /const peerPanelUrl = '\/peer\/' \+ encodeURIComponent/);
    assert.match(selector, /<% if \(!node\.is_local\) \{ %>/, 'the local node must not get a proxy button');
    assert.match(selector, /target="_blank"/);
    assert.match(selector, /فتح لوحة/, 'the button must carry an Arabic label');

    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');
    assert.match(dashboard, /href="\/peer\/\$\{encodeURIComponent/);
    assert.match(dashboard, /openPanel:/);
});
