const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const gsmDonglesEjs = fs.readFileSync(path.join(__dirname, '../views/gsm-dongles.ejs'), 'utf8');

test('selectDevice does not auto-scroll into view unless explicitly requested', () => {
    // Must NOT scroll by default or when options is missing/falsy
    assert.ok(
        !gsmDonglesEjs.includes('if (!options || !options.noScroll)'),
        'selectDevice must not default to scrollIntoView when noScroll is omitted'
    );
    assert.ok(
        gsmDonglesEjs.includes('if (options && options.scrollIntoView)'),
        'selectDevice must only scrollIntoView when explicitly requested via scrollIntoView: true'
    );
});

test('refreshDevicesList captures and restores scroll position across DOM re-render', () => {
    assert.ok(
        gsmDonglesEjs.includes('const prevScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;'),
        'refreshDevicesList must capture scroll position before rendering cards'
    );
    assert.ok(
        gsmDonglesEjs.includes('scrollContainer.scrollTop = prevScrollTop;'),
        'refreshDevicesList must restore scroll position after rendering cards'
    );
    assert.ok(
        gsmDonglesEjs.includes('noScroll: true'),
        'refreshDevicesList must pass noScroll: true when selecting next device'
    );
});

test('Hash navigation on page load scrolls smoothly to target section', () => {
    assert.ok(
        gsmDonglesEjs.includes('if (window.location.hash)'),
        'gsm-dongles must support direct hash navigation on page load'
    );
    assert.ok(
        gsmDonglesEjs.includes("target.scrollIntoView({ behavior: 'smooth', block: 'start' })"),
        'target section must be scrolled into view when a hash is present'
    );
});
