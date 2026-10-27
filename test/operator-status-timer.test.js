const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const view = fs.readFileSync(path.join(rootDir, 'views', 'operator.ejs'), 'utf8');

function loadFormatter() {
    const match = view.match(/function formatStatusTimer\(totalSeconds\)\s*\{[\s\S]*?\n            \}/);
    assert.ok(match, 'formatStatusTimer must exist in views/operator.ejs');
    // eslint-disable-next-line no-new-func
    return new Function(`${match[0]}; return formatStatusTimer;`)();
}

test('agent status timer shows hours instead of a runaway minute count', () => {
    const fmt = loadFormatter();

    // Under an hour stays MM:SS so short breaks stay compact.
    assert.equal(fmt(0), '00:00');
    assert.equal(fmt(5), '00:05');
    assert.equal(fmt(59), '00:59');
    assert.equal(fmt(60), '01:00');
    assert.equal(fmt(3599), '59:59');

    // One hour and beyond switches to H:MM:SS.
    assert.equal(fmt(3600), '1:00:00');
    assert.equal(fmt(3661), '1:01:01');

    // The reported value 917:50 must render as 15:17:50, not 917:50.
    assert.equal(fmt(917 * 60 + 50), '15:17:50');

    // Multi-day presence keeps counting hours (no 24h wraparound).
    assert.equal(fmt(100 * 3600), '100:00:00');

    // Defensive: negative / non-numeric input never produces NaN.
    assert.equal(fmt(-5), '00:00');
    assert.equal(fmt(undefined), '00:00');
    assert.equal(fmt('abc'), '00:00');
});

test('the timer is wired to the same formatter used for call duration', () => {
    // Both timers must agree on the H:MM:SS convention.
    assert.match(view, /function formatDuration\(startMs\)[\s\S]*?return h > 0 \? h \+ ':' \+ mm \+ ':' \+ ss : mm \+ ':' \+ ss;/);
    assert.match(view, /function formatStatusTimer\(totalSeconds\)[\s\S]*?return h > 0 \? h \+ ':' \+ mm \+ ':' \+ ss : mm \+ ':' \+ ss;/);
});
