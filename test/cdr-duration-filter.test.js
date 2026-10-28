const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function loadHelpers() {
    const start = serverSrc.indexOf('function buildDurationRangeFilterSql(');
    const end = serverSrc.indexOf('// Call History hygiene:');
    assert.ok(start > 0 && end > start, 'duration helpers must exist in server.js');
    const block = serverSrc.slice(start, end);
    const factory = new Function(block + '\nreturn { buildDurationRangeFilterSql, buildDurationFilterSql };');
    return factory();
}

const { buildDurationRangeFilterSql, buildDurationFilterSql } = loadHelpers();

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

test('buildDurationRangeFilterSql builds range clause and normalizes inverted bounds', () => {
    assert.deepEqual(
        buildDurationRangeFilterSql('15', '90'),
        { clause: ' AND (c.duration >= ? AND c.duration <= ?)', params: [15, 90] }
    );
    // User accidentally enters From > To: should auto-normalize so calls in range are matched
    assert.deepEqual(
        buildDurationRangeFilterSql('120', '30'),
        { clause: ' AND (c.duration >= ? AND c.duration <= ?)', params: [30, 120] }
    );
    // Overridable column name
    assert.deepEqual(
        buildDurationRangeFilterSql('10', '60', 'duration'),
        { clause: ' AND (duration >= ? AND duration <= ?)', params: [10, 60] }
    );
});

test('Call History applies the duration range filter to both page query and count query', () => {
    const cdrRoute = serverSrc.slice(serverSrc.indexOf("app.get('/cdr'"));
    const applied = cdrRoute.match(/const df = buildDurationRangeFilterSql\(durationMin, durationMax\);\s*\n\s*if \(df\.clause\) \{\s*\n\s*query \+= df\.clause; countQuery \+= df\.clause;[\s\S]{0,220}?countParams\.push\(\.\.\.df\.params\);/);
    assert.ok(applied, 'page and count query must both receive the duration range clause and params');
});

test('Dashboard applies the duration range filter to its stats query', () => {
    const dashRoute = serverSrc.slice(serverSrc.indexOf("app.get('/', "), serverSrc.indexOf("app.get('/cdr'"));
    const applied = dashRoute.match(/const df = buildDurationRangeFilterSql\(durationMin, durationMax\);\s*\n\s*if \(df\.clause\) \{\s*\n\s*query \+= df\.clause;[\s\S]{0,160}?queryParams\.push\(\.\.\.df\.params\);/);
    assert.ok(applied, 'dashboard stats query must receive the duration range clause and params');
});

test('CDR export applies the duration range filter to CSV generation', () => {
    const expRoute = serverSrc.slice(serverSrc.indexOf("app.get('/cdr/export'"));
    const applied = expRoute.match(/const df = buildDurationRangeFilterSql\(durationMin, durationMax\);\s*\n\s*if \(df\.clause\) \{\s*\n\s*query \+= df\.clause;[\s\S]{0,160}?queryParams\.push\(\.\.\.df\.params\);/);
    assert.ok(applied, 'cdr export query must receive the duration range clause and params');
});

test('durationMin / durationMax are accepted as explicit filters in both routes', () => {
    const explicit = serverSrc.match(/const hasExplicitFilters = Boolean\([^)]*req\.query\.durationMin[^)]*req\.query\.durationMax/g) || [];
    assert.ok(explicit.length >= 2, 'dashboard and Call History must treat durationMin/durationMax as explicit filters');
});
