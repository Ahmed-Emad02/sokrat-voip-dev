const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

const INSTALLERS = [
    'install.sh',
    'installer-bundle/install-sokrat.sh',
    'scripts/safe-upgrade.sh'
];

const FIXED_RECQ = 'exten => recq,n,MixMonitor(${MONITOR_FILENAME}.${MIXMON_FORMAT},${MIXMON_OPTS},${MIXMON_POST})';
const BROKEN_RECQ = 'exten => recq,n,MixMonitor(${MONITOR_FILENAME}.${MIXMON_FORMAT},${MIXMON_OPTS}${MONITOR_OPTIONS},${MIXMON_POST})';

function read(rel) {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function countOccurrences(haystack, needle) {
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        count++;
        idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
}

test('every installer writes the queue recording path without the bridged-only flag', () => {
    for (const installer of INSTALLERS) {
        const content = read(installer);
        assert.ok(
            content.includes(FIXED_RECQ),
            `${installer} must contain the fixed recq MixMonitor line`
        );
        // The legacy line may only survive as the string the patch step looks
        // for - it must never be the line that gets written to the dialplan.
        const legacyCount = countOccurrences(content, BROKEN_RECQ);
        assert.ok(
            legacyCount <= 1,
            `${installer} must not write the bridged-only (MONITOR_OPTIONS) recq line`
        );
    }
});

test('every installer can repair an override file that already has [sub-record-check]', () => {
    // The [sub-record-check] block is only appended when missing, so the
    // installers must also patch a pre-existing block in place.
    for (const installer of INSTALLERS) {
        const content = read(installer);
        assert.ok(
            content.includes('PY_RECQUEUE') || content.includes('_recq_old'),
            `${installer} must include the idempotent recq patch step`
        );
        assert.ok(
            content.includes(BROKEN_RECQ),
            `${installer} patch step must recognise the legacy recq line`
        );
    }
});

test('backend/install_db.sql records every call by default', () => {
    const content = read('backend/install_db.sql');

    // Queues: monitor_type drives the [sub-record-check] gate.
    assert.ok(
        content.includes("SET `monitor_type` = ''bgrnd''"),
        'install_db.sql must set queues_config.monitor_type to bgrnd'
    );
    assert.ok(
        content.includes('UPDATE `asterisk`.`ringgroups` SET `recording` = \'always\''),
        'install_db.sql must set ringgroups.recording to always'
    );
    assert.ok(
        content.includes('UPDATE `asterisk`.`users` SET `recording` = \'out=always|in=always\''),
        'install_db.sql must set users.recording to always'
    );
    // The queue table may not exist yet, so the statement must be guarded.
    assert.ok(
        content.includes("TABLE_NAME = 'queues_config'"),
        'install_db.sql must guard the queues_config migration'
    );
    // Issabel's recording gate is the `monitor-format` key in queues_details.
    assert.ok(
        content.includes("''monitor-format'', ''wav'', 0"),
        'install_db.sql must add the monitor-format key to every queue'
    );
    assert.ok(
        content.includes("d.keyword = ''monitor-format''"),
        'install_db.sql must only add monitor-format where it is missing'
    );
});

test('scripts/safe-upgrade.sh maps the same recording-default migrations', () => {
    const content = read('scripts/safe-upgrade.sh');

    assert.ok(
        content.includes('TABLE_NAME=\'queues_config\''),
        'safe-upgrade.sh must guard the queues_config migration'
    );
    assert.ok(
        /monitor_type.{0,4}bgrnd/.test(content),
        'safe-upgrade.sh must set queues_config.monitor_type to bgrnd'
    );
    assert.ok(
        /recording.{0,4}always/.test(content),
        'safe-upgrade.sh must set ringgroups.recording to always'
    );
    assert.ok(
        /recording.{0,4}out=always\|in=always/.test(content),
        'safe-upgrade.sh must set users.recording to always'
    );
    assert.ok(
        /'monitor-format', 'wav', 0/.test(content),
        'safe-upgrade.sh must add the monitor-format key to every queue'
    );
});

test('new queues are created with recording enabled', () => {
    const content = read('server.js');

    assert.ok(
        content.includes("const monitorTypeVal = isRecording === 'yes' ? 'bgrnd' : '';"),
        'server.js must default new queues to monitor_type=bgrnd'
    );
    assert.ok(
        content.includes("const isRecording = recording === 'no' ? 'no' : 'yes';"),
        'server.js must treat recording as enabled unless explicitly disabled'
    );
});

test('new extensions are provisioned with recording always', () => {
    const content = read('server.js');

    for (const key of ['recording/in/external always', 'recording/in/internal always',
                       'recording/out/external always', 'recording/out/internal always']) {
        assert.ok(content.includes(key), `server.js must provision extensions with ${key}`);
    }
});
