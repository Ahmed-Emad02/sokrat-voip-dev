const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');
const viewsDir = path.join(rootDir, 'views');

test('no view loads third-party assets from a CDN', () => {
    const offenders = [];
    for (const file of fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs'))) {
        const html = read(path.join('views', file));
        if (/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com/.test(html)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `views must vendor their assets: ${offenders.join(', ')}`);
});

test('vendored libraries are present locally', () => {
    for (const asset of [
        'public/js/echarts.min.js',
        'public/js/moment.min.js',
        'public/js/moment-ar.js',
        'public/js/xterm.js',
        'public/js/xterm-addon-fit.js',
        'public/js/anime.min.js',
        'public/js/flatpickr.min.js',
        'public/js/tailwindcss-browser.js',
        'public/css/xterm.css',
        'public/css/flatpickr.min.css'
    ]) {
        const stat = fs.statSync(path.join(rootDir, asset));
        assert.ok(stat.size > 500, `${asset} must be a real file (${stat.size} bytes)`);
    }
});

test('the font stylesheet is requested once per page', () => {
    const config = read(path.join('views', 'config.ejs'));
    const sidebar = read(path.join('views', 'sidebar.ejs'));

    // Sidebar is included inside <body>; the page <head> already loads the font.
    // Preconnect hints are fine; the stylesheet request must not be duplicated.
    assert.ok(!/fonts\.googleapis\.com\/css2/.test(sidebar), 'sidebar must not duplicate the font stylesheet');

    const matches = config.match(/https:\/\/fonts\.googleapis\.com\/css2[^"]*/g) || [];
    assert.equal(matches.length, 1, 'config.ejs must load exactly one font stylesheet');

    // Every view that renders a page uses the same canonical URL.
    const canonical = matches[0];
    for (const file of fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs'))) {
        const html = read(path.join('views', file));
        const urls = html.match(/https:\/\/fonts\.googleapis\.com\/css2[^"]*/g) || [];
        for (const url of urls) {
            assert.equal(url, canonical, `${file} must use the canonical font URL`);
        }
    }
});

test('background tabs stop polling', () => {
    const sidebar = read(path.join('views', 'sidebar.ejs'));
    assert.match(sidebar, /window\.sokratPoll = function\(fn, ms, options\)/);
    assert.match(sidebar, /visibilitychange/);
    assert.match(sidebar, /if \(document\.hidden\)/);

    const config = read(path.join('views', 'config.ejs'));
    assert.match(config, /window\.sokratPoll\(fetchIpscanStatus, 1500\)/);
    assert.match(config, /window\.sokratPoll\(fetchRtcpDiagnostics, 3000\)/);
    assert.match(config, /\.stop\(\)/, 'config must stop the wrapped poll, not clearInterval an object');

    assert.match(read(path.join('views', 'dashboard.ejs')), /window\.sokratPoll\(refresh, 10000\)/);
    assert.match(read(path.join('views', 'operator.ejs')), /window\.sokratPoll\(update, 1000\)/);
});

test('federation metrics no longer block the event loop', () => {
    const server = read('server.js');
    const fn = server.match(/async function getFederationNodeMetrics\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(fn, 'getFederationNodeMetrics must exist');
    assert.ok(!/execSync\(/.test(fn[0]), 'it must not use execSync');
    assert.match(fn[0], /await execFileAsync\(ASTERISK_BIN, \['-rx', 'core show version'\]/);
    assert.match(fn[0], /federationMetricsInFlight/, 'concurrent polls must share one probe');

    assert.match(server, /const metrics = await getFederationNodeMetrics\(\)/);
});

test('Apache tuning ships in all deployment paths', () => {
    for (const file of ['install.sh', 'installer-bundle/install-sokrat.sh']) {
        const script = read(file);
        assert.match(script, /BROTLI_COMPRESS/, `${file} must configure brotli`);
        assert.match(script, /Protocols h2 http\/1\.1/, `${file} must enable HTTP/2`);
    }
    const upgrader = read('scripts/safe-upgrade.sh');
    assert.match(upgrader, /Protocols h2 http\/1\.1/);
    assert.match(upgrader, /BROTLI_COMPRESS/);
});
