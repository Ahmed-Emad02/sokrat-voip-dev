'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const helper = path.resolve(__dirname, '../scripts/dongle-module.sh');

function fixture(t, mode = 'normal', queue = '0') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dongle-graceful-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    const modules = path.join(dir, 'modules');
    const proc = path.join(dir, 'proc');
    fs.mkdirSync(bin); fs.mkdirSync(modules); fs.mkdirSync(path.join(proc, '4242'), { recursive: true });
    const module = path.join(modules, 'chan_dongle.so');
    const old = path.join(modules, 'old.so');
    fs.writeFileSync(module, 'current-binary'); fs.writeFileSync(old, 'old-binary');
    const maps = path.join(proc, '4242/maps');
    const map = inode => `1000-2000 r-xp 00000000 00:01 ${inode} ${module}\n`;
    fs.writeFileSync(maps, map(fs.statSync(old).ino));
    const replacement = path.join(dir, 'new-maps');
    fs.writeFileSync(replacement, map(fs.statSync(module).ino));
    const log = path.join(dir, 'commands');
    const phase = path.join(dir, 'phase');
    fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/sh\necho 4242\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$COMMANDS"\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const ast = path.join(bin, 'asterisk');
    fs.writeFileSync(ast, `#!/bin/sh
printf '%s\n' "$2" >> "$COMMANDS"
case "$2" in
  'core show channels') printf '0 active channels\n0 active calls\n' ;;
  'module show like chan_dongle.so') printf 'chan_dongle.so Huawei 3G Dongle Channel Driver 0 Running extended\n' ;;
  'dongle show devices') printf 'ID Group State\ndongle0 0 Free\n' ;;
  'dongle show device state dongle0') printf 'Tasks in queue : %s\nCommands in queue : %s\nCalls/Channels : 0\n' "$QUEUE" "$QUEUE" ;;
  'core show uptime seconds')
    if [ -f "$PHASE" ]; then printf 'System uptime: 1\n'; else printf 'System uptime: 500\n'; fi ;;
  'core restart gracefully')
    [ "$MODE" = refused ] && { echo 'Unable to restart'; exit 0; }
    if [ "$MODE" != stale ]; then touch "$PHASE"; fi
    if [ "$MODE" = normal ]; then cp "$REPLACEMENT" "$MAPS"; fi
    echo 'Asterisk will restart gracefully.' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const result = spawnSync('bash', ['-c', '. "$1"; dongle_module_restart_verified 0 "$2" "$3"', 'bash', helper, ast, modules], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SOKRAT_PROC_ROOT: proc,
            MODE: mode, QUEUE: queue, COMMANDS: log, PHASE: phase, MAPS: maps, REPLACEMENT: replacement },
    });
    return { result, commands: fs.readFileSync(log, 'utf8') };
}

test('graceful activation succeeds on re-exec with unchanged PID and new mapped binary', t => {
    const { result, commands } = fixture(t);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(commands, /^core restart gracefully$/m);
    assert.doesNotMatch(commands, /module (unload|load)|systemctl restart/);
});

test('a restart acknowledgement from the old daemon is not proof of activation', t => {
    const { result } = fixture(t, 'stale');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not activated/);
});

test('a new daemon still mapping the old inode is rejected', t => {
    const { result } = fixture(t, 'old-map');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not activated/);
});

test('queued SMS/AT work prevents a graceful binary swap request', t => {
    const { result, commands } = fixture(t, 'normal', '1');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pending work/);
    assert.doesNotMatch(commands, /^core restart gracefully$/m);
});

test('CLI rejection cannot be reported as a successful restart', t => {
    const { result } = fixture(t, 'refused');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refused/);
});
