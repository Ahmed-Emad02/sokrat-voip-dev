'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/dongle-debug-bundle.sh');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-bundle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function put(name, value, mode = 0o644) {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value, { mode });
        return file;
    }
    for (const name of ['dongle.conf', 'logger.conf', 'logger_logfiles_additional.conf', 'logger_logfiles_custom.conf', 'asterisk.conf']) {
        put(`etc/asterisk/${name}`, `SECRET-subscriber-${name}\n`, 0o644);
    }
    put('etc/logrotate.d/asterisk', 'fixture rotation policy\n');
    put('usr/lib64/asterisk/modules/chan_dongle.so', 'fixture module bytes');
    put('var/log/asterisk/full', '[dongle0] WARNING fixture CLCC event\nother event\n');
    put('var/log/asterisk/messages', 'fixture messages\n');
    put('sys/bus/usb/devices/1-1/idVendor', '12d1\n');
    put('sys/bus/usb/devices/1-1/idProduct', '1001\n');
    put('sys/bus/usb/devices/1-1/product', 'fixture USB modem\n');
    put('sys/bus/usb/devices/1-1/authorized', '1\n');
    const ast = put('bin/asterisk', `#!/bin/bash
printf '%s\n' "$2" >>"$FIXTURE_AST_CALLS"
case "$2" in
  'core show version')
    if [[ "\${FIXTURE_HANG_VERSION:-}" == 1 ]]; then
      trap '' TERM
      while :; do sleep 1; done
    fi
    echo 'Asterisk fixture';;
  'module show like chan_dongle') echo 'fixture module error' >&2; exit 7;;
  'dongle show devices') printf 'ID State\ndongle0 Free\ndongle0 Free\nnot-a-device ignored\n';;
  'core show settings') echo 'fixture settings';;
  'logger show channels') echo 'fixture channels';;
  'dongle show device state dongle0'|'dongle show device settings dongle0'|'dongle show device statistics dongle0') echo 'fixture dongle0 snapshot';;
  *) echo 'Unexpected or mutating CLI command' >&2; exit 99;;
esac
`, 0o755);
    put('bin/lsusb', '#!/bin/sh\necho fixture-lsusb\n', 0o755);
    put('bin/dmesg', '#!/bin/sh\necho fixture-dmesg\n', 0o755);
    put('bin/journalctl', '#!/bin/sh\necho fixture-journal-failure >&2\nexit 9\n', 0o755);
    fs.mkdirSync(path.join(root, 'tmp'));
    const calls = path.join(root, 'ast-calls');
    const env = {
        ...process.env,
        SOKRAT_ROOT: root,
        ASTERISK_BIN: ast,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        TMPDIR: path.join(root, 'tmp'),
        FIXTURE_AST_CALLS: calls,
        FIXTURE_HANG_VERSION: '',
        DONGLE_BUNDLE_TIMEOUT: '2s',
    };
    function collect(args = [], extra = {}) {
        const result = spawnSync('bash', [SCRIPT, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 12000 });
        assert.ifError(result.error);
        return result;
    }
    return { root, env, calls, collect, put };
}

function statuses(out) {
    const rows = fs.readFileSync(path.join(out, 'collection-status.tsv'), 'utf8').trim().split('\n').slice(1);
    return Object.fromEntries(rows.map(row => {
        const [name, status] = row.split('\t');
        return [name, Number(status)];
    }));
}

test('default bundles are unique private directories with private copied configs and useful read-only snapshots', (t) => {
    const f = fixture(t);
    const first = f.collect();
    assert.equal(first.status, 0, first.stderr);
    const second = f.collect();
    assert.equal(second.status, 0, second.stderr);
    const out = first.stdout.trim();
    assert.notEqual(out, second.stdout.trim());
    assert.equal(path.dirname(out), f.env.TMPDIR);
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    assert.equal(fs.statSync(out).uid, process.getuid());
    for (const name of fs.readdirSync(out)) {
        const file = path.join(out, name);
        assert.ok(fs.lstatSync(file).isFile(), name);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600, name);
        assert.equal(fs.statSync(file).uid, process.getuid(), name);
    }
    assert.equal(fs.readFileSync(path.join(out, 'dongle.conf'), 'utf8'), 'SECRET-subscriber-dongle.conf\n');
    assert.match(fs.readFileSync(path.join(out, 'full-dongle.log'), 'utf8'), /fixture CLCC event/);
    assert.match(fs.readFileSync(path.join(out, 'usb-devices.txt'), 'utf8'), /fixture USB modem/);
    assert.match(fs.readFileSync(path.join(out, 'dongle0-state.txt'), 'utf8'), /fixture dongle0 snapshot/);
    assert.doesNotMatch(first.stdout + first.stderr, /SECRET|subscriber/);
    const commands = fs.readFileSync(f.calls, 'utf8').trim().split('\n');
    assert.equal(commands.filter(command => command === 'dongle show devices').length, 2, 'one discovery per bundle');
    assert.equal(commands.filter(command => command === 'dongle show device state dongle0').length, 2, 'duplicate IDs must not duplicate snapshots');
    for (const command of commands) assert.match(command, /^(?:core show (?:version|settings)|module show like chan_dongle|logger show channels|dongle show (?:devices|device (?:state|settings|statistics) dongle0))$/);
});

test('preexisting custom directories and symlinks cannot be reused or overwrite attacker-selected files', (t) => {
    const f = fixture(t);
    const existing = path.join(f.root, 'existing');
    fs.mkdirSync(existing);
    const victim = f.put('existing/version.txt', 'DO NOT OVERWRITE\n');
    const link = path.join(f.root, 'output-link');
    fs.symlinkSync(existing, link);
    for (const output of [existing, link]) {
        const result = f.collect([output]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /must be a new directory/);
    }
    assert.equal(fs.readFileSync(victim, 'utf8'), 'DO NOT OVERWRITE\n');
    assert.equal(fs.existsSync(f.calls), false);
    const fresh = path.join(f.root, 'fresh-output');
    const result = f.collect([fresh]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), fresh);
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
});

test('nonresponsive CLI is killed and collection continues with explicit per-command failure records', (t) => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.root, 'etc/asterisk/asterisk.conf'));
    const result = f.collect([], { FIXTURE_HANG_VERSION: '1', DONGLE_BUNDLE_TIMEOUT: '0.5s' });
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout.trim();
    const status = statuses(out);
    assert.ok([124, 137].includes(status['version.txt']), `timeout status was ${status['version.txt']}`);
    assert.equal(status['module.txt'], 7);
    assert.equal(status['journal-asterisk.txt'], 9);
    assert.notEqual(status['asterisk.conf'], 0);
    assert.equal(status['devices.txt'], 0);
    assert.equal(status['dongle0-state.txt'], 0);
    assert.equal(status['full-tail.log'], 0);
    assert.match(fs.readFileSync(path.join(out, 'module.txt'), 'utf8'), /fixture module error/);
    assert.match(fs.readFileSync(path.join(out, 'messages-tail.log'), 'utf8'), /fixture messages/);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET|subscriber/);
});

test('unsafe writable output parents are rejected for custom and default locations', (t) => {
    const f = fixture(t);
    const unsafe = path.join(f.root, 'unsafe');
    fs.mkdirSync(unsafe);
    fs.chmodSync(unsafe, 0o777);
    for (const result of [f.collect([path.join(unsafe, 'new')]), f.collect([], { TMPDIR: unsafe })]) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /parent directory is not private or sticky/);
    }
    assert.deepEqual(fs.readdirSync(unsafe), []);
    assert.equal(fs.existsSync(f.calls), false);
});

test('a zero timeout cannot silently disable collection deadlines', (t) => {
    const f = fixture(t);
    const result = f.collect([], { DONGLE_BUNDLE_TIMEOUT: '0.0s' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /timeout must be positive/);
    assert.equal(fs.existsSync(f.calls), false);
    assert.deepEqual(fs.readdirSync(f.env.TMPDIR), []);
});
