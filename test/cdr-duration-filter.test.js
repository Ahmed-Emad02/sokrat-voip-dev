const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function loadHelpers() {
    const start = serverSrc.indexOf('function convertDurationToSeconds(');
    const end = serverSrc.indexOf('// Call History hygiene:');
    assert.ok(start > 0 && end > start, 'duration helpers must exist in server.js');
    const block = serverSrc.slice(start, end);
    const factory = new Function(block + '\nreturn { convertDurationToSeconds, buildDurationRangeFilterSql, buildDurationFilterSql };');
    return factory();
}

const { convertDurationToSeconds, buildDurationRangeFilterSql, buildDurationFilterSql } = loadHelpers();

test('convertDurationToSeconds converts seconds, minutes, and hours accurately', () => {
    // Seconds (default)
    assert.equal(convertDurationToSeconds('45', 's'), 45);
    assert.equal(convertDurationToSeconds('0', 's'), 0);
    assert.equal(convertDurationToSeconds('60'), 60);

    // Minutes
    assert.equal(convertDurationToSeconds('1', 'm'), 60);
    assert.equal(convertDurationToSeconds('5', 'm'), 300);
    assert.equal(convertDurationToSeconds('1.5', 'm'), 90);
    assert.equal(convertDurationToSeconds('0.5', 'minutes'), 30);

    // Hours
    assert.equal(convertDurationToSeconds('1', 'h'), 3600);
    assert.equal(convertDurationToSeconds('2.5', 'h'), 9000);
    assert.equal(convertDurationToSeconds('0.25', 'hour'), 900);

    // Empty / invalid
    assert.ok(isNaN(convertDurationToSeconds('', 'm')));
    assert.ok(isNaN(convertDurationToSeconds(null, 'h')));
    assert.ok(isNaN(convertDurationToSeconds('abc', 's')));
    assert.ok(isNaN(convertDurationToSeconds('-10', 'm')));
});

test('buildDurationRangeFilterSql handles empty / undefined bounds gracefully', () => {
    assert.deepEqual(buildDurationRangeFilterSql(undefined, undefined), { clause: '', params: [] });
    assert.deepEqual(buildDurationRangeFilterSql('', ''), { clause: '', params: [] });
    assert.deepEqual(buildDurationRangeFilterSql(null, null), { clause: '', params: [] });
    assert.deepEqual(buildDurationRangeFilterSql('   ', '   '), { clause: '', params: [] });
    assert.deepEqual(buildDurationRangeFilterSql('abc', 'xyz'), { clause: '', params: [] });
    assert.deepEqual(buildDurationRangeFilterSql(-10, -5), { clause: '', params: [] });
});

test('buildDurationRangeFilterSql builds min-only and max-only clauses with bound parameters', () => {
    assert.deepEqual(
        buildDurationRangeFilterSql('30', ''),
        { clause: ' AND (c.duration >= ?)', params: [30] }
    );
    assert.deepEqual(
        buildDurationRangeFilterSql('', '120'),
        { clause: ' AND (c.duration <= ?)', params: [120] }
    );
    assert.deepEqual(
        buildDurationRangeFilterSql('  45  ', null),
        { clause: ' AND (c.duration >= ?)', params: [45] }
    );
});

test('buildDurationRangeFilterSql supports seconds, minutes, and hours units', () => {
    // Minutes: 1 to 5 min -> 60 to 300 seconds
    assert.deepEqual(
        buildDurationRangeFilterSql('1', '5', 'm'),
        { clause: ' AND (c.duration >= ? AND c.duration <= ?)', params: [60, 300] }
    );

    // Hours: 0.5 to 2 hours -> 1800 to 7200 seconds
    assert.deepEqual(
        buildDurationRangeFilterSql('0.5', '2', 'h'),
        { clause: ' AND (c.duration >= ? AND c.duration <= ?)', params: [1800, 7200] }
    );

    // Inverted bounds in minutes: 10 to 2 min -> auto-normalized to [120, 600]
    assert.deepEqual(
        buildDurationRangeFilterSql('10', '2', 'm'),
        { clause: ' AND (c.duration >= ? AND c.duration <= ?)', params: [120, 600] }
    );

    // Overridable column name with unit
    assert.deepEqual(
        buildDurationRangeFilterSql('2', '4', 'm', 'duration'),
        { clause: ' AND (duration >= ? AND duration <= ?)', params: [120, 240] }
    );

    // Backwards-compatible: 3rd param as column name defaults unit to seconds
    assert.deepEqual(
        buildDurationRangeFilterSql('10', '60', 'duration'),
        { clause: ' AND (duration >= ? AND duration <= ?)', params: [10, 60] }
    );
});

test('Call History applies the duration range filter with unit to both page and count query', () => {
    const cdrRoute = serverSrc.slice(serverSrc.indexOf("app.get('/cdr'"));
    const applied = cdrRoute.match(/const df = buildDurationRangeFilterSql\(durationMin, durationMax, durationUnit\);\s*\n\s*if \(df\.clause\) \{\s*\n\s*query \+= df\.clause; countQuery \+= df\.clause;[\s\S]{0,220}?countParams\.push\(\.\.\.df\.params\);/);
    assert.ok(applied, 'page and count query must both receive the duration range clause with durationUnit and params');
});

test('Dashboard applies the duration range filter with unit to its stats query', () => {
    const dashRoute = serverSrc.slice(serverSrc.indexOf("app.get('/', "), serverSrc.indexOf("app.get('/cdr'"));
    const applied = dashRoute.match(/const df = buildDurationRangeFilterSql\(durationMin, durationMax, durationUnit\);\s*\n\s*if \(df\.clause\) \{\s*\n\s*query \+= df\.clause;[\s\S]{0,160}?queryParams\.push\(\.\.\.df\.params\);/);
    assert.ok(applied, 'dashboard stats query must receive the duration range clause with durationUnit and params');
});

test('CDR export applies the duration range filter with unit to CSV generation', () => {
    const expRoute = serverSrc.slice(serverSrc.indexOf("app.get('/cdr/export'"));
    const applied = expRoute.match(/const df = buildDurationRangeFilterSql\(durationMin, durationMax, durationUnit\);\s*\n\s*if \(df\.clause\) \{\s*\n\s*query \+= df\.clause;[\s\S]{0,160}?queryParams\.push\(\.\.\.df\.params\);/);
    assert.ok(applied, 'cdr export query must receive the duration range clause with durationUnit and params');
});
