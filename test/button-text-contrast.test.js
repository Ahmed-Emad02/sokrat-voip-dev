const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

test('Global Button Contrast: views/sidebar.ejs enforces black text in light mode and white text in dark mode', () => {
    const sidebarHtml = fs.readFileSync(path.join(rootDir, 'views', 'sidebar.ejs'), 'utf8');

    // 1. Dark mode rule check: button text must be white
    assert.match(
        sidebarHtml,
        /html:not\(\.light-theme\)\s+button[\s\S]*?color:\s*#ffffff\s*!important/i,
        'Dark mode must enforce color: #ffffff !important on buttons'
    );

    // 2. White mode (light-theme) rule check: button text must be black
    assert.match(
        sidebarHtml,
        /html\.light-theme\s+button[\s\S]*?color:\s*#000000\s*!important/i,
        'Light mode must enforce color: #000000 !important on buttons'
    );

    // 3. Dark mode SVG strokes must resolve to currentColor or white
    assert.match(
        sidebarHtml,
        /html:not\(\.light-theme\)\s+button\s+svg[\s\S]*?stroke:\s*currentColor\s*!important/i,
        'Dark mode must enforce stroke: currentColor !important on button SVGs'
    );

    // 4. Light mode SVG strokes must resolve to black
    assert.match(
        sidebarHtml,
        /html\.light-theme\s+button[\s\S]*?svg[\s\S]*?stroke:\s*#000000\s*!important/i,
        'Light mode must enforce stroke: #000000 !important on button SVGs'
    );
});

test('Toast Contrast: Toast notifications have high-contrast styling and do not use black text on black background', () => {
    const configHtml = fs.readFileSync(path.join(rootDir, 'views', 'config.ejs'), 'utf8')
        + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'))
            ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '');

    // showToast in config.ejs must not use bg-slate-800 with text-white
    assert.strictEqual(
        configHtml.includes('bg-slate-800'),
        false,
        'views/config.ejs must not use bg-slate-800 for toast backgrounds'
    );

    // showToast must explicitly style text color with high contrast
    assert.match(
        configHtml,
        /function showToast[\s\S]*?textStyle[\s\S]*?toast\.style\.color/i,
        'views/config.ejs showToast must explicitly set high-contrast textStyle'
    );

    const sidebarHtml = fs.readFileSync(path.join(rootDir, 'views', 'sidebar.ejs'), 'utf8');
    assert.match(
        sidebarHtml,
        /#toast-container[\s\S]*?#toastContainer/i,
        'views/sidebar.ejs must include toastContainer styling'
    );
});
