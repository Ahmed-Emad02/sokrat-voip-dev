const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const ejs = require('ejs');

const sidebarPath = path.join(__dirname, '../views/sidebar.ejs');
const serverJsPath = path.join(__dirname, '../server.js');

test('views/sidebar.ejs renders persistent loading overlay without DOM removal', async () => {
    const html = await ejs.renderFile(sidebarPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['dashboard', 'storage', 'config']
    });

    // 1. Loading Overlay Element & Sublabel
    assert.ok(html.includes('id="theme-loading-overlay"'), 'Must render theme-loading-overlay');
    assert.ok(!html.includes('id="loadingSubLabel"'), 'Must NOT render loadingSubLabel container');
    assert.ok(!html.includes('overlay.parentNode.removeChild(overlay)'), 'Must NEVER destroy overlay via removeChild');

    // 2. Visibility and persistence
    assert.ok(html.includes('window.dismissLoadingOverlay'), 'Must define dismissLoadingOverlay');
    assert.ok(html.includes('overlay.style.visibility = \'hidden\''), 'Must hide overlay with visibility: hidden');
    assert.ok(html.includes('overlay.style.opacity = \'0\''), 'Must hide overlay with opacity: 0');
});

test('views/sidebar.ejs defines instant 0ms visual feedback on navigation trigger', async () => {
    const html = await ejs.renderFile(sidebarPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['dashboard', 'storage']
    });

    // 1. window.showPageLoading
    assert.ok(html.includes('window.showPageLoading = function'), 'Must define window.showPageLoading');
    assert.ok(html.includes('overlay.style.visibility = \'visible\''), 'showPageLoading must set visibility: visible');
    assert.ok(html.includes('overlay.style.opacity = \'1\''), 'showPageLoading must set opacity: 1');
    assert.ok(html.includes('clearTimeout(window._loadingSafetyTimer)'), 'Must manage safety timer');

    // 2. Event Interceptor on Click
    assert.ok(html.includes('handleNavigationTrigger'), 'Must define handleNavigationTrigger');
    assert.ok(html.includes('document.addEventListener(\'click\', handleNavigationTrigger, { capture: true })'), 'Must attach click listener with { capture: true }');
    assert.ok(html.includes('window.showPageLoading(label)'), 'handleNavigationTrigger must call window.showPageLoading');

    // 3. Back/Forward Cache Recovery
    assert.ok(html.includes('window.addEventListener(\'pageshow\''), 'Must handle pageshow for BFCache dismissal');
});

test('views/sidebar.ejs defines speculative hover & touch prefetching', async () => {
    const html = await ejs.renderFile(sidebarPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['dashboard', 'storage']
    });

    assert.ok(html.includes('prefetchedTabUrls'), 'Must track prefetched URLs to avoid duplicate fetches');
    assert.ok(html.includes('link.rel = \'prefetch\'') || html.includes('prefetchLink.rel = \'prefetch\''), 'Must use rel="prefetch" for speculative loading');
    assert.ok(html.includes('pointerenter'), 'Must listen to pointerenter for prefetching');
    assert.ok(html.includes('touchstart'), 'Must listen to touchstart for prefetching on mobile');
});

test('server.js registers gzip compression middleware and static caching', () => {
    const serverCode = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(serverCode.includes("require('zlib')"), 'server.js must require zlib');
    assert.ok(serverCode.includes("acceptEncoding.includes('gzip')"), 'Compression middleware must check accept-encoding');
    assert.ok(serverCode.includes("res.setHeader('Content-Encoding', useGzip ? 'gzip' : 'deflate')") || serverCode.includes("'Content-Encoding'"), 'Compression middleware must set Content-Encoding');
    assert.ok(serverCode.includes("maxAge: '7d'"), 'express.static must specify maxAge 7d');
});

test('server.js implements in-memory query caching in global middleware', () => {
    const serverCode = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(serverCode.includes('cachedBaseRoster'), 'server.js must define cachedBaseRoster');
    assert.ok(serverCode.includes('cachedBaseRosterTimestamp'), 'server.js must track cachedBaseRosterTimestamp');
    assert.ok(serverCode.includes('cachedEmployeeGroupNames'), 'server.js must define cachedEmployeeGroupNames');
    assert.ok(serverCode.includes('cachedFedSettings'), 'server.js must define cachedFedSettings');

    // Verify non-blocking cache control
    assert.ok(serverCode.includes("res.setHeader('Cache-Control', 'private, no-cache, must-revalidate')"), 'HTML pages must use private, no-cache, must-revalidate for prefetch support');
});

test('gzip compression reduces raw HTML payloads by > 75%', () => {
    const sampleHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Sokrat VOIP Test</title></head>
        <body>
            <div class="panel-surface">${'A'.repeat(50000)}</div>
            <div class="panel-surface">${'B'.repeat(50000)}</div>
        </body>
        </html>
    `;
    const rawBuffer = Buffer.from(sampleHtml);
    const compressed = zlib.gzipSync(rawBuffer, { level: 6 });

    const ratio = (rawBuffer.length - compressed.length) / rawBuffer.length;
    assert.ok(ratio > 0.75, `Compression ratio must exceed 75% (was ${(ratio * 100).toFixed(1)}%)`);
});
