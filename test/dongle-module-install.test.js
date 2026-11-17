'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts', 'dongle-module.sh');
const header = path.join(root, 'asterisk', 'dongle_rx_condition.h');

function sandbox(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-dongle-install-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function runHelper(script, args = [], env = {}) {
    return spawnSync('bash', ['-c', script, 'bash', ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

function sourceFixture(directory) {
    const origin = path.join(directory, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '--quiet');
    git(origin, 'config', 'user.email', 'fixture@example.invalid');
    git(origin, 'config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(origin, 'channel.c'), [
        '#include <stddef.h>',
        '#include "dongle_rx_condition.h"',
        'const char sokrat_commit_marker[] = "PINNED-COMMIT";',
        'void sokrat_test(short *samples, size_t count) { sokrat_condition_rx(samples, count, 3000); }',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(origin, 'Makefile'), [
        'chan_dongle.so: channel.c dongle_rx_condition.h',
        '\t$(CC) -std=c99 -O2 -fPIC -shared -I. channel.c -o chan_dongle.so',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(origin, 'configure'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    git(origin, 'add', '.');
    git(origin, 'commit', '--quiet', '-m', 'pinned baseline');
    const pin = git(origin, 'rev-parse', 'HEAD');

    fs.writeFileSync(path.join(origin, 'channel.c'), [
        '#include <stddef.h>',
        '#include "dongle_rx_condition.h"',
        'const char sokrat_commit_marker[] = "FLOATING-HEAD";',
        'void sokrat_test(short *samples, size_t count) { sokrat_condition_rx(samples, count, 3000); }',
        '',
    ].join('\n'));
    git(origin, 'commit', '--quiet', '-am', 'floating head');
    const head = git(origin, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(origin, 'operator-notes.txt'), 'local operator work\n');

    const patch = path.join(directory, 'chan_dongle.patch');
    fs.writeFileSync(patch, [
        '--- a/channel.c',
        '+++ b/channel.c',
        '@@ -1,4 +1,5 @@',
        ' #include <stddef.h>',
        ' #include "dongle_rx_condition.h"',
        '+/* patched marker */',
        ' const char sokrat_commit_marker[] = "PINNED-COMMIT";',
        ' void sokrat_test(short *samples, size_t count) { sokrat_condition_rx(samples, count, 3000); }',
        '',
    ].join('\n'));
    return { origin, pin, head, patch };
}

test('bundle install accepts the release-pinned module and is idempotent', t => {
    const directory = sandbox(t);
    const modules = path.join(directory, 'modules');
    const target = path.join(modules, 'chan_dongle.so');
    const release = fs.readFileSync(path.join(root, 'installer-bundle', 'binaries', 'chan_dongle.so'));
    assert.equal(release.subarray(0, 4).toString('hex'), '7f454c46', 'release bundle must be an ELF module');

    const script = '. "$1"; dongle_module_install_bundle "$2" "$3"';
    const result = runHelper(script, [helper, path.join(root, 'installer-bundle', 'binaries', 'chan_dongle.so'), modules]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(target), release);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);

    const inode = fs.statSync(target).ino;
    const repeated = runHelper(script, [helper, path.join(root, 'installer-bundle', 'binaries', 'chan_dongle.so'), modules]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(fs.statSync(target).ino, inode, 'matching release bundle must preserve the live inode');
});

test('bundle install rejects a stale valid ELF before copying and preserves the installed module', t => {
    const directory = sandbox(t);
    const modules = path.join(directory, 'modules');
    const target = path.join(modules, 'chan_dongle.so');
    fs.mkdirSync(modules);
    fs.writeFileSync(target, 'working-module');

    const release = fs.readFileSync(path.join(root, 'installer-bundle', 'binaries', 'chan_dongle.so'));
    const stale = Buffer.from(release);
    stale[stale.length - 1] ^= 0xff;
    const stalePath = path.join(directory, 'stale-chan_dongle.so');
    fs.writeFileSync(stalePath, stale);
    assert.equal(stale.subarray(0, 4).toString('hex'), '7f454c46', 'stale bundle must still look like a valid ELF module');

    const script = '. "$1"; dongle_module_install_bundle "$2" "$3"';
    const result = runHelper(script, [helper, stalePath, modules]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not the release-pinned chan_dongle module/);
    assert.match(result.stderr, /expected SHA256/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'working-module', 'installed module must survive a refused bundle');
    assert.deepEqual(fs.readdirSync(modules), ['chan_dongle.so'], 'a refused bundle must not stage or back up anything');

    const missingModules = path.join(directory, 'absent-modules');
    const absent = runHelper(script, [helper, stalePath, missingModules]);
    assert.notEqual(absent.status, 0);
    assert.equal(fs.existsSync(missingModules), false, 'a refused bundle must not create the modules directory');
});

test('authenticated source origins never print credentials', t => {
    const directory = sandbox(t);
    const { origin, pin } = sourceFixture(directory);
    const authenticated = `file://installer:TopS3cret@${origin}`;
    const script = '. "$1"; dongle_module_materialize_source "$2" "$3" "$4"';
    const assertNoCredentials = (output, label) => {
        assert.ok(!output.includes('TopS3cret'), `${label} must not echo the password`);
        assert.ok(!output.includes('installer:'), `${label} must not echo the userinfo`);
        assert.ok(output.includes('***@'), `${label} must still name the redacted origin`);
    };

    const success = runHelper(script, [helper, authenticated, pin, path.join(directory, 'materialized')]);
    assert.equal(success.status, 0, success.stderr);
    assertNoCredentials(success.stdout + success.stderr, 'successful check out');

    const missingCommit = runHelper(script, [helper, authenticated, 'deadbeef'.repeat(5), path.join(directory, 'missing')]);
    assert.notEqual(missingCommit.status, 0);
    assertNoCredentials(missingCommit.stdout + missingCommit.stderr, 'unavailable pinned commit');

    const unreachable = 'https://deploy:TopS3cret@127.0.0.1:1/unreachable.git';
    const cloneFailure = runHelper(script, [helper, unreachable, pin, path.join(directory, 'unreachable')], { GIT_TERMINAL_PROMPT: '0' });
    assert.notEqual(cloneFailure.status, 0);
    assertNoCredentials(cloneFailure.stdout + cloneFailure.stderr, 'clone failure');
});

test('fresh install copies the bundled dongle module atomically with rollback copies', t => {
    const directory = sandbox(t);
    const modules = path.join(directory, 'modules');
    const target = path.join(modules, 'chan_dongle.so');
    const bundle = path.join(directory, 'bundle-chan_dongle.so');
    fs.mkdirSync(modules);
    fs.writeFileSync(target, 'old-module');
    const bundled = Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(4096, 0x5a)]);
    fs.writeFileSync(bundle, bundled);

    const script = '. "$1"; dongle_module_install_file "$2" "$3" "bundle binary" && dongle_module_install_file "$2" "$3" "bundle binary"';
    const result = runHelper(script, [helper, bundle, modules]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(target), bundled);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(path.join(modules, 'chan_dongle.so.bak-install'), 'utf8'), 'old-module');
    const names = fs.readdirSync(modules).sort();
    assert.ok(names.some(name => /^chan_dongle\.so\.bak-\d{8}_\d{6}$/.test(name)), 'replacement must keep a timestamped rollback copy');

    const inode = fs.statSync(target).ino;
    const repeated = runHelper(script, [helper, bundle, modules]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(fs.statSync(target).ino, inode);
});

test('source materialization checks out the pinned ref without touching operator work', t => {
    const directory = sandbox(t);
    const { origin, pin, head } = sourceFixture(directory);
    const destination = path.join(directory, 'materialized');
    fs.mkdirSync(destination);
    const script = '. "$1"; dongle_module_materialize_source "$2" "$3" "$4"';
    const result = runHelper(script, [helper, origin, pin, destination]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(destination, 'rev-parse', 'HEAD'), pin);
    assert.notEqual(pin, head);
    assert.equal(git(origin, 'rev-parse', 'HEAD'), head, 'operator source HEAD must not move');
    assert.equal(fs.readFileSync(path.join(origin, 'operator-notes.txt'), 'utf8'), 'local operator work\n');
});

test('source build uses the pinned ref, requires the conditioner header, and installs the artifact', t => {
    const directory = sandbox(t);
    const { origin, pin, head, patch } = sourceFixture(directory);
    const modules = path.join(directory, 'modules');
    const script = '. "$1"; dongle_module_build_source "$2" "$3" "$4" "$5" "$6" 18.19.0';
    const result = runHelper(script, [helper, origin, pin, patch, header, modules]);
    assert.equal(result.status, 0, result.stderr);
    const built = fs.readFileSync(path.join(modules, 'chan_dongle.so'));
    assert.equal(built.subarray(0, 4).toString('hex'), '7f454c46', 'built module must be an ELF artifact');
    assert.ok(built.includes(Buffer.from('PINNED-COMMIT')), 'build must use the pinned commit');
    assert.ok(!built.includes(Buffer.from('FLOATING-HEAD')), 'build must not use the floating head');
    assert.ok(!built.equals(fs.readFileSync(path.join(root, 'installer-bundle', 'binaries', 'chan_dongle.so'))),
        'a compiler-dependent source build is installed without matching the bundled artifact');
    assert.equal(git(origin, 'rev-parse', 'HEAD'), head, 'operator source HEAD must not move');
    assert.equal(fs.existsSync(path.join(origin, 'operator-notes.txt')), true, 'operator files must survive');
});

test('source build refuses a missing conditioner header and preserves the installed module', t => {
    const directory = sandbox(t);
    const { origin, pin, patch } = sourceFixture(directory);
    const modules = path.join(directory, 'modules');
    const target = path.join(modules, 'chan_dongle.so');
    fs.mkdirSync(modules);
    fs.writeFileSync(target, 'working-module');
    const script = '. "$1"; dongle_module_build_source "$2" "$3" "$4" "$5" "$6" 18.19.0';
    const result = runHelper(script, [helper, origin, pin, patch, path.join(directory, 'missing.h'), modules]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing native conditioner header/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'working-module');
});

test('unsafe reload is refused while channels are active and fails closed when state is unknown', t => {
    const directory = sandbox(t);
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const asterisk = path.join(bin, 'asterisk');
    const writeAsterisk = body => fs.writeFileSync(asterisk, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    const script = '. "$1"; dongle_module_require_idle';
    const env = { PATH: `${bin}:${process.env.PATH}` };

    writeAsterisk('printf "0 active channels\\n0 active calls\\n"');
    assert.equal(runHelper(script, [helper], env).status, 0);

    writeAsterisk('printf "Channel Location State Application\\nPJSIP/101 s@from-internal Up AppDial\\n2 active channels\\n1 active call\\n"');
    const busy = runHelper(script, [helper], env);
    assert.notEqual(busy.status, 0);
    assert.match(busy.stderr, /2 active channel/);

    writeAsterisk('exit 1');
    const unknown = runHelper(script, [helper], env);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /cannot determine active channels/);
});

test('reload verification reports the running module and fails for a stopped one', t => {
    const directory = sandbox(t);
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'asterisk'), [
        '#!/bin/bash',
        'printf "Module                         Description                              Use Count  Status      Support Level\\n"',
        'printf "chan_dongle.so                 Huawei 3G Dongle Channel Driver          0          %s          extended\\n" "${FAKE_STATUS:-Running}"',
        'printf "1 modules loaded\\n"',
        '',
    ].join('\n'), { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const runningScript = '. "$1"; dongle_module_wait_running 0';
    const running = runHelper(runningScript, [helper], { ...env, FAKE_STATUS: 'Running' });
    assert.equal(running.status, 0, running.stderr);
    const stopped = runHelper(runningScript, [helper], { ...env, FAKE_STATUS: 'Not Running' });
    assert.notEqual(stopped.status, 0);
    assert.match(stopped.stderr, /not running after 0s/);

    const unloadedScript = '. "$1"; dongle_module_wait_stopped 0';
    const unloaded = runHelper(unloadedScript, [helper], { ...env, FAKE_STATUS: 'Not Running' });
    assert.equal(unloaded.status, 0, unloaded.stderr);
    const stillLoaded = runHelper(unloadedScript, [helper], { ...env, FAKE_STATUS: 'Running' });
    assert.notEqual(stillLoaded.status, 0);
    assert.match(stillLoaded.stderr, /still running/);
});

test('installers use the already-loaded-safe RNNoise helper', () => {
    for (const name of ['install.sh', 'installer-bundle/install-sokrat.sh']) {
        const text = fs.readFileSync(path.join(root, name), 'utf8');
        assert.match(text, /dongle_module_ensure_func_rnnoise/, `${name} must use the safe RNNoise helper`);
        assert.doesNotMatch(text, /module load func_rnnoise/, `${name} must not call module load blindly`);
        assert.doesNotMatch(text, /func_rnnoise\.so.*loaded into Asterisk/, `${name} must not claim success on a failed load`);
    }
});

test('reload verification tolerates the systemctl restart pgrep race', t => {
    const directory = sandbox(t);
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pgrep'), [
        '#!/bin/bash',
        'if [ ! -f "$PGREP_STATE" ]; then touch "$PGREP_STATE"; exit 1; fi',
        'exit 0',
        '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'asterisk'), [
        '#!/bin/bash',
        'printf "chan_dongle.so Huawei 3G Dongle Channel Driver 0 Running extended\\n"',
        '',
    ].join('\n'), { mode: 0o755 });
    const env = {
        PATH: `${bin}:${process.env.PATH}`,
        PGREP_STATE: path.join(directory, 'pgrep-state'),
    };
    const result = runHelper('. "$1"; dongle_module_wait_running 1', [helper], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /chan_dongle\.so is running/);
});

test('optional RNNoise helper treats an already-running module as success', t => {
    const directory = sandbox(t);
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    const callLog = path.join(directory, 'calls.log');
    fs.writeFileSync(path.join(bin, 'asterisk'), [
        '#!/bin/bash',
        'printf "%s\\n" "$2" >> "$CALL_LOG"',
        'case "$2" in',
        '  "module show"*) printf "func_rnnoise.so RNNoise 0 Running core\\n"; exit 0 ;;',
        '  "module load"*) exit 0 ;;',
        'esac',
        '',
    ].join('\n'), { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}`, CALL_LOG: callLog };
    const result = runHelper('. "$1"; dongle_module_ensure_func_rnnoise asterisk', [helper], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already running/);
    assert.doesNotMatch(fs.readFileSync(callLog, 'utf8'), /^module load/m);
});

test('reload verification waits for the CLI socket and fails closed if it never becomes ready', t => {
    const directory = sandbox(t);
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'asterisk'), [
        '#!/bin/bash',
        '[ "${NEVER_READY:-0}" = 1 ] && exit 1',
        'if [ ! -f "$READY_FILE" ]; then touch "$READY_FILE"; exit 1; fi',
        'printf "chan_dongle.so Huawei 3G Dongle Channel Driver 0 Running extended\\n"',
        '',
    ].join('\n'), { mode: 0o755 });
    const script = '. "$1"; dongle_module_wait_running 1';
    const env = { PATH: `${bin}:${process.env.PATH}`, READY_FILE: path.join(directory, 'cli-ready') };

    const starting = runHelper(script, [helper], env);
    assert.equal(starting.status, 0, starting.stderr);

    const unavailable = runHelper(script, [helper], { ...env, NEVER_READY: '1' });
    assert.notEqual(unavailable.status, 0);
});
