'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseConfiguredState } = require('../lib/dongle-provisioning');

const ROOT = path.resolve(__dirname, '..');
const INSTALLERS = ['install.sh', 'installer-bundle/install-sokrat.sh'];
const SNAPSHOT = '20261124_120000';
const OWNED_CONFIG = '; operator settings\r\n[general]\r\ninterval=23\r\n[defaults]\r\ncallwaiting=yes\r\nu2diag=0\r\ncontext=custom-inbound\r\n[dongle1]\r\naudio=/dev/serial/by-id/audio\r\ndata=/dev/serial/by-id/control\r\nimei=123456789012345\r\nimsi=250011234567890\r\nbaud=57600\r\n';

function fixture(t, units = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-deployment-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const install = path.join(dir, 'opt/sokrat-voip');
    const etc = path.join(dir, 'etc');
    const modules = path.join(dir, 'usr/lib64/asterisk/modules');
    const bin = path.join(dir, 'bin');
    for (const sub of [bin, modules, `${install}/scripts`, `${install}/lib`, `${install}/laya`, `${install}/backups`, `${etc}/asterisk`, `${etc}/systemd/system`, `${dir}/usr/local/bin`]) {
        fs.mkdirSync(sub, { recursive: true });
    }
    fs.copyFileSync(path.join(ROOT, 'scripts/dongle-config.sh'), `${install}/scripts/dongle-config.sh`);
    fs.copyFileSync(path.join(ROOT, 'lib/dongle-provisioning.js'), `${install}/lib/dongle-provisioning.js`);
    fs.copyFileSync(path.join(ROOT, 'dongle.conf'), `${install}/dongle.conf`);
    fs.writeFileSync(`${install}/laya/engine.py`, '');
    fs.writeFileSync(`${install}/laya/cli.py`, '');
    const state = path.join(dir, 'units.json');
    const calls = path.join(dir, 'calls.log');
    fs.writeFileSync(state, JSON.stringify(units));
    fs.writeFileSync(calls, '');
    for (const unit of Object.keys(units)) fs.writeFileSync(`${etc}/systemd/system/${unit}`, '[Service]\n');
    const executable = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    executable('id', 'echo 0');
    executable('pgrep', 'echo 100; exit 0');
    executable('getent', 'exit 1');
    executable('nmcli', 'exit 0');
    executable('udevadm', 'exit 0');
    executable('mysql', 'printf "mysql %s\\n" "$*" >> "$CALL_LOG"; if [[ " $* " != *" -e "* ]]; then cat >> "$SQL_LOG"; fi');
    executable('asterisk', [
        'printf "asterisk %s\\n" "$*" >> "$CALL_LOG"',
        '[ "${CLI_UNAVAILABLE:-0}" = 0 ] || exit 1',
        'case "$2" in',
        ' "core show channels") printf "%s active channels\\n0 active calls\\n" "${ACTIVE_CHANNELS:-0}" ;;',
        ' "module show like chan_dongle.so") printf "chan_dongle.so Huawei 0 %s extended\\n" "${MODULE_STATUS:-Running}" ;;',
        ' "dongle show devices") printf "ID Group State\\ndongle0 0 Free\\ndongle1 0 Active\\n" ;;',
        ' "dongle show device state "*) printf "Tasks in queue : %s\\nCommands in queue : 0\\nCalls/Channels : 0\\n" "${QUEUED_TASKS:-0}" ;;',
        ' *) exit 0 ;;',
        'esac',
    ].join('\n'));
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!${process.execPath}\n` + String.raw`
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, 'systemctl ' + args.join(' ') + '\n');
const state = JSON.parse(fs.readFileSync(process.env.UNIT_STATE, 'utf8'));
const unit = args.find(arg => /\.(?:service|timer)$/.test(arg));
const exists = unit && (state[unit] || fs.existsSync(process.env.UNIT_DIR + '/' + unit));
if (exists && !state[unit]) state[unit] = { enabled: false, active: false };
const value = state[unit];
const save = () => fs.writeFileSync(process.env.UNIT_STATE, JSON.stringify(state));
switch (args[0]) {
case 'show': console.log(exists ? 'loaded' : 'not-found'); break;
case 'is-enabled': process.exit(value && value.enabled ? 0 : 1); break;
case 'is-active': process.exit(value && value.active ? 0 : 3); break;
case 'disable':
    if (process.env.DISABLE_FAILURE === '1') process.exit(1);
    if (value) { value.enabled = false; if (args.includes('--now')) value.active = false; save(); }
    break;
case 'enable':
    if (value) { value.enabled = true; if (args.includes('--now')) value.active = true; save(); }
    break;
case 'start': case 'restart':
    if (unit && unit.endsWith('.timer') && process.env.TIMER_FAILURE === '1') process.exit(1);
    if (value) { value.active = true; save(); }
    break;
case 'stop': if (value) { value.active = false; save(); } break;
case 'daemon-reload': break;
default: process.exit(2);
}
`, { mode: 0o755 });
    fs.writeFileSync(`${install}/scripts/enable-dongle-logging.sh`, [
        '#!/bin/bash',
        'printf "logging %s\\n" "$*" >> "$CALL_LOG"',
        '[ "${LOGGING_FAILURE:-0}" = 0 ] || exit "$LOGGING_FAILURE"',
        'printf "[Timer]\\n" > "$UNIT_DIR/sokrat-asterisk-logrotate.timer"',
        'printf "[Service]\\n" > "$UNIT_DIR/sokrat-asterisk-logrotate.service"',
        '',
    ].join('\n'), { mode: 0o755 });
    // Exercise real atomic install and idle/status primitives; activation's
    // generation/inode proof belongs to the shared module helper's own tests.
    fs.writeFileSync(`${install}/scripts/dongle-module.sh`, [
        `. ${JSON.stringify(path.join(ROOT, 'scripts/dongle-module.sh'))}`,
        'dongle_module_restart_verified() {',
        '  dongle_module_require_idle || return 1',
        '  printf "verified-daemon-restart %s\\n" "$*" >> "$CALL_LOG"',
        '  [ "${RESTART_FAILURE:-0}" = 0 ] || return 1',
        '  dongle_module_wait_running 0',
        '}',
        '',
    ].join('\n'));
    const env = {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: calls,
        SQL_LOG: path.join(dir, 'sql.log'), UNIT_STATE: state, UNIT_DIR: `${etc}/systemd/system`,
        INSTALL_DIR: install, MODULES_DIR: modules, DONGLE_HELPER: `${install}/scripts/dongle-module.sh`, NUM_DONGLES: '3',
    };
    const mapPaths = text => text
        .replaceAll('/opt/sokrat-voip', install)
        .replaceAll('/etc/', `${etc}/`)
        .replaceAll('/usr/lib64/asterisk/modules', modules)
        .replaceAll('/usr/lib/asterisk/modules', `${dir}/usr/lib/asterisk/modules`)
        .replaceAll('/usr/local/bin/', `${dir}/usr/local/bin/`);
    const run = (text, extra = {}, args = []) => spawnSync('bash', ['-c', `set -euo pipefail\n${mapPaths(text)}`, 'fixture', ...args], {
        env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000,
    });
    return {
        dir, install, etc, modules, env, run, executable,
        config: `${etc}/asterisk/dongle.conf`,
        log: () => fs.readFileSync(calls, 'utf8'),
        units: () => JSON.parse(fs.readFileSync(state, 'utf8')),
        helper: '. "$DONGLE_HELPER"; . "$INSTALL_DIR/scripts/dongle-config.sh";\n',
    };
}

// Only execute the actual deployment blocks under test, not package installers
// or any host configuration. Headings delimit shell payloads, not assertions.
function block(name, start, end) {
    const source = fs.readFileSync(path.join(ROOT, name), 'utf8');
    const from = source.indexOf(start);
    const until = source.indexOf(end, from + start.length);
    if (from < 0 || until < 0) throw new Error(`Cannot isolate ${name} deployment block`);
    return source.slice(from, until);
}

for (const name of INSTALLERS) {
    test(`${name} preserves a dongle1-only config byte for byte`, t => {
        const f = fixture(t);
        fs.writeFileSync(f.config, OWNED_CONFIG);
        const before = fs.statSync(f.config).ino;
        const result = f.run(block(name, '# 10d —', '# 10e —'));
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(f.config, 'utf8'), OWNED_CONFIG);
        assert.equal(fs.statSync(f.config).ino, before);
        assert.equal(f.log(), 'logging --no-reload\n');
    });

    test(`${name} creates only requested unassigned capacity, retaining template defaults`, t => {
        const f = fixture(t);
        const result = f.run(block(name, '# 10d —', '# 10e —'));
        assert.equal(result.status, 0, result.stderr);
        const sections = new Map([...parseConfiguredState(f.config)].filter(([name]) => /^dongle[0-9]+$/.test(name)));
        assert.deepEqual([...sections.keys()], ['dongle0', 'dongle1', 'dongle2']);
        for (const section of sections.values()) {
            for (const key of ['audio', 'data', 'imei', 'imsi', 'baud', 'initstate']) assert.equal(section[key] || '', '');
        }
        const bytes = fs.readFileSync(f.config, 'utf8');
        assert.equal((bytes.match(/^rxgain=3$/gm) || []).length, 3);
        assert.equal((bytes.match(/^txgain=3$/gm) || []).length, 3);
        const defaults = fs.readFileSync(`${f.install}/dongle.conf`, 'utf8').split('[dongle0]')[0].trimEnd();
        assert.ok(bytes.startsWith(defaults));
        assert.doesNotMatch(bytes, /\/dev\/ttyUSB/);
        assert.equal(f.log(), 'logging --no-reload\n');
    });

    test(`${name} propagates mandatory logging failure`, t => {
        const f = fixture(t);
        const result = f.run(block(name, '# 10d —', '# 10e —'), { LOGGING_FAILURE: '7' });
        assert.equal(result.status, 7, result.stderr);
    });

    for (const initial of [{}, {
        'sokrat-watchdog.service': { enabled: true, active: true },
        'sokrat-laya.service': { enabled: true, active: true },
    }]) {
        test(`${name} installs watchdog and Laya stopped/disabled (${Object.keys(initial).length ? 'existing' : 'absent'} units)`, t => {
            const f = fixture(t, initial);
            const result = f.run(f.helper + block(name, '# Provision Sokrat System Watchdog', '# Decommission Webmin'));
            assert.equal(result.status, 0, result.stderr);
            for (const unit of ['sokrat-watchdog.service', 'sokrat-laya.service']) {
                assert.deepEqual(f.units()[unit], { enabled: false, active: false });
            }
            assert.doesNotMatch(f.log(), /systemctl (?:start|restart|enable) .*sokrat-(?:watchdog|laya)/);
        });
    }
}

test('fresh capacity zero contains no phantom sections', t => {
    const f = fixture(t);
    const result = f.run(f.helper + 'dongle_config_install "$INSTALL_DIR/dongle.conf" "$1" 0', {}, [f.config]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal([...parseConfiguredState(f.config).keys()].filter(name => /^dongle[0-9]+$/.test(name)).length, 0);
});

for (const initial of [null, { enabled: false, active: false }, { enabled: true, active: false }, { enabled: false, active: true }, { enabled: true, active: true }]) {
    test(`upgrade preserves Laya enablement/activity ${JSON.stringify(initial)}`, t => {
        const f = fixture(t, initial ? { 'sokrat-laya.service': initial } : {});
        const result = f.run(f.helper + block('scripts/safe-upgrade.sh', '# Provision/refresh Laya', '# 7. Post-Upgrade Verification'));
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(f.units()['sokrat-laya.service'], initial || { enabled: false, active: false });
        const restarts = f.log().split('\n').filter(line => line === 'systemctl restart sokrat-laya.service');
        assert.equal(restarts.length, initial && initial.enabled && initial.active ? 1 : 0);
    });
}

test('upgrade hardware policy preserves config, disabled Laya and modem SMS storage', t => {
    const initial = { enabled: false, active: false };
    const f = fixture(t, { 'sokrat-laya.service': initial });
    fs.writeFileSync(f.config, OWNED_CONFIG);
    const result = f.run(f.helper + block('scripts/safe-upgrade.sh', '# Hardware Dongle Stability', '# Decommission local whisper'));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(f.config, 'utf8'), OWNED_CONFIG);
    assert.deepEqual(f.units()['sokrat-laya.service'], initial);
    assert.doesNotMatch(f.log(), /CMGD|dongle cmd/);
});

test('upgrade activation uses verified daemon restart, never module unload/load, and fails closed', t => {
    const f = fixture(t);
    const activation = f.helper + block('scripts/safe-upgrade.sh', '# 6. ', '# The media helper scripts');
    const result = f.run(activation);
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.log(), /logging --no-reload\n[\s\S]*verified-daemon-restart 20/);
    assert.equal(f.units()['sokrat-asterisk-logrotate.timer'].active, true);
    assert.doesNotMatch(f.log(), /module (?:unload|load)|dongle reload|CMGD/);
    assert.notEqual(f.run(activation, { RESTART_FAILURE: '1' }).status, 0);
    assert.equal(f.run(activation, { LOGGING_FAILURE: '7' }).status, 7);
    assert.notEqual(f.run(activation, { TIMER_FAILURE: '1' }).status, 0);
});

function restoreFixture(t, units) {
    const f = fixture(t, units);
    const backups = `${f.install}/backups`;
    fs.writeFileSync(f.config, 'current dongle config\n');
    fs.writeFileSync(`${f.etc}/asterisk/extensions_custom.conf`, 'current dialplan\n');
    fs.writeFileSync(`${backups}/dongle.conf.bak_${SNAPSHOT}`, OWNED_CONFIG);
    fs.writeFileSync(`${backups}/extensions_custom.conf.bak_${SNAPSHOT}`, 'restored dialplan\n');
    fs.writeFileSync(`${backups}/chan_dongle.so.bak_${SNAPSHOT}`, Buffer.from('\x7fELFhistorical-module'));
    fs.writeFileSync(`${f.modules}/chan_dongle.so`, Buffer.from('\x7fELFcurrent-module'));
    fs.writeFileSync(`${backups}/asterisk_pbx.bak_${SNAPSHOT}.sql`, '-- PBX snapshot\n');
    fs.writeFileSync(`${backups}/asterisk_cdr.bak_${SNAPSHOT}.sql`, '-- CDR snapshot\n');
    f.restore = extra => f.run(fs.readFileSync(path.join(ROOT, 'scripts/restore-backup.sh'), 'utf8'), extra, ['--timestamp', SNAPSHOT]);
    return f;
}

for (const watchdog of [null, { enabled: false, active: false }, { enabled: true, active: true }]) {
    test(`restore atomically activates historical binary without enabling healing (${JSON.stringify(watchdog)})`, t => {
        const laya = { enabled: false, active: false };
        const f = restoreFixture(t, { 'sokrat-laya.service': laya, ...(watchdog ? { 'sokrat-watchdog.service': watchdog } : {}) });
        const target = `${f.modules}/chan_dongle.so`;
        const mapped = `${f.dir}/mapped-old-module.so`;
        fs.linkSync(target, mapped);
        const inode = fs.statSync(target).ino;
        const result = f.restore();
        assert.equal(result.status, 0, result.stderr);
        assert.notEqual(fs.statSync(target).ino, inode);
        assert.equal(fs.readFileSync(target, 'utf8'), '\x7fELFhistorical-module');
        assert.equal(fs.readFileSync(mapped, 'utf8'), '\x7fELFcurrent-module');
        assert.equal(fs.readFileSync(f.config, 'utf8'), OWNED_CONFIG);
        assert.equal(fs.readFileSync(`${f.etc}/asterisk/extensions_custom.conf`, 'utf8'), 'restored dialplan\n');
        assert.equal(fs.readFileSync(f.env.SQL_LOG, 'utf8'), '-- PBX snapshot\n-- CDR snapshot\n');
        assert.match(f.log(), /verified-daemon-restart 20/);
        assert.equal(f.units()['sokrat-asterisk-logrotate.timer'].active, true);
        assert.doesNotMatch(f.log(), /module (?:unload|load)|dongle reload|CMGD|systemctl restart sokrat-watchdog/);
        assert.deepEqual(f.units()['sokrat-laya.service'], laya);
        assert.deepEqual(f.units()['sokrat-watchdog.service'], watchdog ? { enabled: false, active: false } : undefined);
    });
}

for (const failure of [{ ACTIVE_CHANNELS: '2' }, { CLI_UNAVAILABLE: '1' }]) {
    test(`restore refuses before config/binary/database mutation when ${JSON.stringify(failure)}`, t => {
        const f = restoreFixture(t);
        const inode = fs.statSync(`${f.modules}/chan_dongle.so`).ino;
        const result = f.restore(failure);
        assert.notEqual(result.status, 0);
        assert.equal(fs.readFileSync(f.config, 'utf8'), 'current dongle config\n');
        assert.equal(fs.readFileSync(`${f.etc}/asterisk/extensions_custom.conf`, 'utf8'), 'current dialplan\n');
        assert.equal(fs.statSync(`${f.modules}/chan_dongle.so`).ino, inode);
        assert.ok(!fs.existsSync(f.env.SQL_LOG));
        assert.doesNotMatch(f.log(), /verified-daemon-restart|systemctl disable/);
    });
}

for (const failure of [{ RESTART_FAILURE: '1' }, { MODULE_STATUS: 'Not Running' }, { LOGGING_FAILURE: '7' }]) {
    test(`restore never reports success for unverified activation ${JSON.stringify(failure)}`, t => {
        const f = restoreFixture(t);
        const result = f.restore(failure);
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /restoration completed successfully/);
    });
}

test('watchdog policy propagates disable failures instead of claiming a safe install', t => {
    const f = fixture(t, { 'sokrat-watchdog.service': { enabled: true, active: true } });
    const result = f.run(f.helper + 'dongle_deployment_disable_watchdog', { DISABLE_FAILURE: '1' });
    assert.notEqual(result.status, 0);
});

for (const watchdog of [null, { enabled: false, active: false }, { enabled: true, active: true }]) {
    test(`upgrade preflight disables watchdog without activating Laya (${JSON.stringify(watchdog)})`, t => {
        const laya = { enabled: false, active: false };
        const f = fixture(t, { 'sokrat-laya.service': laya, ...(watchdog ? { 'sokrat-watchdog.service': watchdog } : {}) });
        const result = f.run(block('scripts/safe-upgrade.sh', '# Refuse before changing', '# Federation'), {
            FCM_SOURCE: `${f.dir}/missing-fcm.json`, PUSH_GATEWAY_DIR: `${f.dir}/missing-gateway`,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(f.units()['sokrat-watchdog.service'], watchdog ? { enabled: false, active: false } : undefined);
        assert.deepEqual(f.units()['sokrat-laya.service'], laya);
        assert.doesNotMatch(f.log(), /systemctl (?:restart|start|enable)/);
        const services = f.run(block('scripts/safe-upgrade.sh', 'systemctl restart sokrat-voip.service', '# Provision/refresh the recording-only'));
        assert.equal(services.status, 0, services.stderr);
        assert.doesNotMatch(f.log(), /systemctl restart sokrat-watchdog/);
    });
}

test('restore uses its actual modules directory for binary activation', t => {
    const f = restoreFixture(t);
    const alternate = path.join(f.dir, 'usr/lib/asterisk/modules');
    fs.mkdirSync(path.dirname(alternate), { recursive: true });
    fs.renameSync(f.modules, alternate);
    const result = f.restore();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(`${alternate}/chan_dongle.so`, 'utf8'), '\x7fELFhistorical-module');
    assert.ok(f.log().includes(`verified-daemon-restart 20 asterisk ${alternate}\n`));
});

for (const name of INSTALLERS) {
    test(`${name} starts the statically installed rotation timer only in its activation phase`, t => {
        const f = fixture(t);
        const setup = f.run(block(name, '# 10d —', '# 10e —'));
        assert.equal(setup.status, 0, setup.stderr);
        assert.doesNotMatch(f.log(), /systemctl start/);
        const activate = f.helper + block(name, 'dongle_module_restart_verified 20', '# 10x');
        const result = f.run(activate);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(f.units()['sokrat-asterisk-logrotate.timer'].active, true);
        assert.notEqual(f.run(activate, { TIMER_FAILURE: '1' }).status, 0);
    });
}
