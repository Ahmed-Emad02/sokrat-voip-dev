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

test('every installer keeps the recording alive across queue hops', () => {
    // Issabel's sub-record-cancel stops the MixMonitor, DELETES the file with
    // `rm -f` and clears CDR(recordingfile) at every queue hop, which wipes
    // the audio of a call that traverses a queue chain. The override must
    // return before any of that happens.
    for (const installer of INSTALLERS) {
        const content = read(installer);
        assert.ok(
            content.includes('[sub-record-cancel]'),
            `${installer} must override [sub-record-cancel]`
        );
        assert.ok(
            content.includes('exten => s,1,Set(__REC_POLICY_MODE=${REC_POLICY_MODE_SAVE})'),
            `${installer} must restore the recording policy in [sub-record-cancel]`
        );
        assert.ok(
            !content.includes('System(rm -f ${MON_BASE}'),
            `${installer} must not delete the recording file`
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
    assert.ok(
        content.includes("callrecording_module"),
        'install_db.sql must update callrecording_module for inbound routes'
    );
    assert.ok(
        content.includes("`callrecording` = ''force''"),
        'install_db.sql must set inbound route callrecording to force'
    );
    assert.ok(
        content.includes("`maxwait` = '''' WHERE `maxwait` = ''0''"),
        'install_db.sql must normalize queue maxwait 0 to empty string'
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
    assert.ok(
        content.includes("TABLE_NAME='callrecording_module'"),
        'safe-upgrade.sh must guard callrecording_module migration'
    );
    assert.ok(
        /callrecording.{0,4}force/.test(content),
        'safe-upgrade.sh must set inbound routes callrecording to force'
    );
    assert.ok(
        /maxwait.*?=''.*?WHERE.*?maxwait.*?='0'/.test(content),
        'safe-upgrade.sh must normalize queue maxwait 0 to empty string'
    );
});

test('new queues are created with recording enabled and unlimited maxwait', () => {
    const content = read('server.js');

    assert.ok(
        content.includes("const monitorTypeVal = isRecording === 'yes' ? 'bgrnd' : '';"),
        'server.js must default new queues to monitor_type=bgrnd'
    );
    assert.ok(
        content.includes("const isRecording = recording === 'no' ? 'no' : 'yes';"),
        'server.js must treat recording as enabled unless explicitly disabled'
    );
    assert.ok(
        content.includes("String(maxwait).trim() !== '0'") && content.includes(": ''"),
        'server.js must normalize queue maxwait 0 or empty to empty string'
    );
});

test('inbound routes are provisioned with callrecording force by default', () => {
    const content = read('server.js');

    assert.ok(
        /callrecording_module[\s\S]*?callrecording[\s\S]*?force/.test(content),
        'server.js must provision inbound routes into callrecording_module'
    );
    assert.ok(
        content.includes("'force', 'did'"),
        'server.js must set inbound route callrecording to force'
    );
});

test('extension 800 alias collision is completely removed from dialplans and installers', () => {
    for (const file of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const content = read(file);
        assert.ok(
            !content.includes('exten => 800,1,Goto(*800,1)'),
            `${file} must not contain exten => 800,1,Goto(*800,1)`
        );
    }
    const customConf = fs.readFileSync('/etc/asterisk/extensions_custom.conf', 'utf8');
    assert.ok(
        !customConf.includes('exten => 800,1,Goto(*800,1)'),
        '/etc/asterisk/extensions_custom.conf must not contain exten => 800,1,Goto(*800,1)'
    );
});

test('new extensions are provisioned with recording always', () => {
    const content = read('server.js');

    for (const key of ['recording/in/external always', 'recording/in/internal always',
                       'recording/out/external always', 'recording/out/internal always']) {
        assert.ok(content.includes(key), `server.js must provision extensions with ${key}`);
    }
});

test('every installer enables Option B inbound trunk recording in [from-dongle-custom]', () => {
    for (const installer of INSTALLERS) {
        const content = read(installer);
        assert.ok(
            content.includes('Option B'),
            `${installer} must contain Option B universal trunk recording`
        );
        assert.ok(
            content.includes('__CALLFILENAME=in-${DONGLENAME}-'),
            `${installer} must define trunk recording filename`
        );
    }
});

test('every installer enforces universal always-record in [sub-record-check]', () => {
    for (const installer of INSTALLERS) {
        const content = read(installer);
        assert.ok(
            content.includes('__REC_POLICY_MODE=always'),
            `${installer} must default REC_POLICY_MODE to always`
        );
    }
});

test('every installer preserves recordingfile on hangup in [cdr-cause-capture]', () => {
    for (const installer of INSTALLERS) {
        const content = read(installer);
        assert.ok(
            content.includes('SOKRAT_REC_FILE'),
            `${installer} must retain recordingfile via SOKRAT_REC_FILE in cdr-cause-capture`
        );
    }
});

test('server.js resolves missing recordingfile from linked legs in CDR', () => {
    const content = read('server.js');
    assert.ok(
        content.includes('rowsMissingRec'),
        'server.js must detect rows missing recordingfile'
    );
    assert.ok(
        content.includes('recLegs'),
        'server.js must query linkedid/uniqueid sibling legs for recording'
    );
});
