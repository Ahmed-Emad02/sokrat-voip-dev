const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const cdrEjs = fs.readFileSync(path.join(__dirname, '../views/cdr.ejs'), 'utf8');

test('canceled GSM calls are never rendered as FAILED', () => {
    assert.equal(serverJs.includes("REPLACE(c.disposition, 'CONGESTION', 'FAILED')"), false, 'CONGESTION must no longer be relabeled FAILED');
    assert.equal(serverJs.includes("REPLACE(disposition, 'CONGESTION', 'FAILED')"), false, 'Unaliased relabel must be gone too');
    // Heuristic fallback: long-ringing unanswered GSM release => honest NO ANSWER
    assert.ok(serverJs.includes("WHEN c.disposition IN ('CONGESTION', 'BUSY') AND c.duration >= 5 THEN 'NO ANSWER'"),
        'Long-ringing canceled legacy rows must be reported as NO ANSWER');
    // UI keeps a neutral badge for genuine congestion instead of failure red
    assert.ok(cdrEjs.includes("'CONGESTION':"), 'cdr view must style raw CONGESTION distinctly');
});

test('persisted hangup cause (userfield) drives authoritative dispositions', () => {
    // Q.850 cause mapping captured by the cdr-cause-capture hangup handler
    assert.ok(serverJs.includes("WHEN c.userfield = '17' OR c.userfield = '21' THEN 'BUSY'"), 'Causes 17/21 must map to BUSY');
    assert.ok(serverJs.includes("WHEN c.userfield IN ('18', '19') THEN 'NO ANSWER'"), 'Causes 18/19 must map to NO ANSWER');
    assert.ok(serverJs.includes("WHEN c.userfield IN ('34', '38', '41', '42', '44') THEN 'CONGESTION'"), 'Congestion family must map to CONGESTION');
    assert.ok(serverJs.match(/WHEN c\.billsec > 0 THEN c\.disposition/), 'Answered calls keep their raw disposition');

    // Dialplan captures causes on all monitored paths and survives reinstalls
    const confPath = '/etc/asterisk/extensions_custom.conf';
    const dialplan = fs.readFileSync(confPath, 'utf8');
    assert.equal((dialplan.match(/\[cdr-cause-capture\]/g) || []).length, 1, 'Exactly one cause-capture subroutine');
    assert.ok(dialplan.includes('Set(CDR(userfiled)=${HANGUPCAUSE})') === false && dialplan.includes('Set(CDR(userfield)=${HANGUPCAUSE})'), 'Cause must be written into CDR userfield');
    assert.ok((dialplan.match(/hangup_handler_push\)=cdr-cause-capture/g) || []).length === 3,
        'Capture handler must be pushed on outbound trunk, inbound dongle and internal call legs');

    const installer = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
    assert.ok((installer.match(/cdr-cause-capture/g) || []).length >= 4, 'Installer templates must wire the capture handler everywhere');
});

test('call history collapses multi-segment rows and hides harness noise', () => {
    const filtersCount = (serverJs.match(/CDR_HISTORY_FILTERS_SQL/g) || []).length;
    assert.ok(filtersCount >= 3, 'History filters must be defined and used by history + export queries');

    // One entry per call: keep the primary segment per shared uniqueid
    assert.ok(serverJs.includes('cx.uniqueid = c.uniqueid'), 'Dedupe must key on the shared uniqueid');
    assert.ok(serverJs.includes('cx.sequence > c.sequence'), 'Ties must keep the latest segment');
    assert.ok((serverJs.match(/NOT EXISTS \(\s*\n?\s*SELECT 1 FROM \$\{tables\.cdr\} cx/g) || []).length >= 1,
        'NOT EXISTS dedupe clause must be present');

    // Synthetic calls stay out of history
    assert.ok(serverJs.includes("AND c.dcontext NOT LIKE 'test-%'"), 'test-* contexts filtered');
    assert.ok(serverJs.includes("'*87','*88','*89'"), 'Echo-test feature codes filtered');
});

test('direction rule recognizes normalized external numbers without leading zero', () => {
    assert.ok(serverJs.includes("CDR_EXTERNAL_DST_SQL = `(c.dst REGEXP '^[0-9+]+$' AND CHAR_LENGTH(c.dst) >= 7)`"),
        'External-number test must accept any numeric/+ dial of 7+ digits');
    assert.equal((serverJs.match(/\^\[0\+\]/g) || []).length, 0, 'Old ^[0+] pattern must be fully replaced');
    // Scope stays consistent with direction via the same shared snippet
    assert.ok((serverJs.match(/NOT \$\{CDR_EXTERNAL_DST_SQL\}/g) || []).length === 1, 'Scope must negate the shared external test');
});
