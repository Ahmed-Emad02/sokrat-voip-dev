'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/enable-dongle-logging.sh');

function fixture(t, { missing = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sokrat-logging-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function put(name, content, mode = 0o640) {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, { mode });
        return file;
    }
    const ast = path.join(root, 'etc/asterisk');
    fs.mkdirSync(ast, { recursive: true });
    const db = put('db.json', JSON.stringify([
        { name: 'full', debug: 'off', error: 'on', dtmf: 'on', fax: 'on', notice: 'on', verbose: 'off', warning: 'on', security: 'on' },
        { name: 'console', debug: 'off', error: 'on', verbose: 'on', dtmf: 'off' },
        { name: 'operator', debug: 'on', security: 'on', fax: 'on' },
    ]));
    // A persistent isolated DB and the installed logfiles module API contract.
    // This executes the real shell/PHP integration, never a host PBX bootstrap.
    const bootstrap = put('etc/issabelpbx.conf', `<?php
define('DB_FETCHMODE_ASSOC', 2);
class FixtureDB {
    public function getAll($sql, $mode) {
        if ($sql === 'SELECT * FROM logfile_logfiles') return json_decode(file_get_contents(getenv('FIXTURE_DB')), true);
        if ($sql === 'SELECT * FROM logfile_settings') return array();
        throw new Exception('unexpected query');
    }
    public function query($sql) {
        if (getenv('FIXTURE_DB_FAIL')) throw new Exception('SECRET-bootstrap-password');
        if ($sql !== "DELETE FROM logfile_logfiles WHERE name = 'full'") throw new Exception('unexpected mutation');
        $rows = $this->getAll('SELECT * FROM logfile_logfiles', 2);
        file_put_contents(getenv('FIXTURE_DB'), json_encode(array_values(array_filter($rows, function($r) { return $r['name'] !== 'full'; }))));
        return true;
    }
}
$db = new FixtureDB();
$amp_conf = array('AMPWEBROOT' => getenv('FIXTURE_WEBROOT'), 'ASTVERSION' => '18.19.0');
`);
    put('web/admin/modules/logfiles/functions.inc.php', `<?php
class logfiles_conf {
    private static $obj;
    public $rows = array();
    static function create() { if (!self::$obj) self::$obj = new self(); return self::$obj; }
    function generateConf($name) {
        if ($name !== 'logger_logfiles_additional.conf') throw new Exception('unexpected generated file');
        $out = '';
        foreach ($this->rows as $row) {
            $categories = array();
            foreach ($row as $key => $value) if ($key !== 'name' && $value === 'on') $categories[] = $key === 'verbose' ? 'verbose(3)' : $key;
            $out .= $row['name'].' => '.implode(',', $categories)."\\n";
        }
        return $out;
    }
}
function logfiles_get_config($engine) {
    global $db;
    if ($engine !== 'asterisk') throw new Exception('unexpected engine');
    logfiles_conf::create()->rows = $db->getAll('SELECT * FROM logfile_logfiles', DB_FETCHMODE_ASSOC);
}
`);
    const loggerTarget = put('config-targets/logger.conf', '[general]\ndateformat = %F\n[logfiles]\n#include logger_logfiles_additional.conf\n#include logger_logfiles_custom.conf\nfull => operator_dynamic\n[unrelated]\nkeep = yes\n', 0o644);
    fs.symlinkSync(loggerTarget, path.join(ast, 'logger.conf'));
    const custom = put('etc/asterisk/logger_logfiles_custom.conf', '; operator settings\nfull => verbose(5),dtmf,custom_level\nspecial => security,warning\nfull => fax\n', 0o604);
    const astTarget = put('config-targets/asterisk.conf', '[directories]\nastlogdir => /var/log/asterisk\n[options]\nverbose = 1\ndebug = 0\n[files]\nkeep = yes\n', 0o600);
    fs.symlinkSync(astTarget, path.join(ast, 'asterisk.conf'));
    if (!missing) put('etc/asterisk/logger_logfiles_additional.conf', 'full => error,legacy_level\nconsole => error,verbose(3)\n');
    const unrelated = '/var/log/asterisk/queue_log {\n    monthly\n    rotate 8\n    create 0640 asterisk asterisk\n}\n/var/log/atftp.log {\n    monthly\n    rotate 9\n    create 0640 nobody nobody\n}\n';
    if (!missing) put('etc/logrotate.d/asterisk', '/var/log/asterisk/full {\n    daily\n    rotate 2\n    dateext\n    nocompress\n    missingok\n    postrotate\n        echo operator-hook\n    endscript\n}\n' + unrelated, 0o600);
    put('etc/systemd/system/dongle-watchdog.service', '[Service]\nExecStart=/bin/false\n');
    put('etc/systemd/system/laya.service', '[Service]\nExecStart=/bin/true\n');
    const fakeAst = put('bin/asterisk', '#!/bin/sh\nprintf "%s\\n" "$*" >>"$FIXTURE_AST_CALLS"\nexit 91\n', 0o755);
    const env = {
        ...process.env, SOKRAT_ROOT: root, PBX_BOOTSTRAP: bootstrap,
        ASTERISK_BIN: fakeAst, FIXTURE_AST_CALLS: path.join(root, 'ast-calls'),
        FIXTURE_DB: db, FIXTURE_WEBROOT: path.join(root, 'web'),
    };
    function apply(extra = {}) {
        const result = spawnSync('bash', [SCRIPT, '--no-reload'], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
        assert.ifError(result.error);
        return result;
    }
    function regenerate() {
        const result = spawnSync('php', ['-r', 'require $argv[1]; require $amp_conf["AMPWEBROOT"]."/admin/modules/logfiles/functions.inc.php"; logfiles_get_config("asterisk"); echo logfiles_conf::create()->generateConf("logger_logfiles_additional.conf");', bootstrap], { env, encoding: 'utf8', timeout: 10000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        fs.writeFileSync(path.join(ast, 'logger_logfiles_additional.conf'), result.stdout);
    }
    function channels() {
        const found = [];
        function parse(file, section = '') {
            for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
                const header = line.match(/^\s*\[([^\]]+)\]/);
                if (header) section = header[1];
                const include = line.match(/^#include\s+(\S+)/);
                if (include) {
                    const target = path.join(ast, include[1]);
                    if (fs.existsSync(target)) parse(target, section);
                }
                if (section === 'logfiles' && /^\s*full\s*=>/.test(line)) found.push(line);
            }
        }
        parse(path.join(ast, 'logger.conf'));
        return found;
    }
    return { root, ast, put, custom, loggerTarget, astTarget, unrelated, env, apply, regenerate, channels };
}

test('repeated apply and PBX regeneration retain one full channel and every operator category', (t) => {
    const f = fixture(t);
    const operatorRows = JSON.parse(fs.readFileSync(f.env.FIXTURE_DB)).filter(row => row.name !== 'full');
    const result = f.apply();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /every minute.*not a hard size cap/);
    for (const stage of ['installed', 'regenerated', 'reapplied']) {
        if (stage === 'regenerated') f.regenerate();
        if (stage === 'reapplied') assert.equal(f.apply().status, 0);
        const channels = f.channels();
        assert.equal(channels.length, 1, stage);
        for (const category of ['debug', 'error', 'notice', 'warning', 'dtmf', 'fax', 'security', 'custom_level', 'operator_dynamic', 'legacy_level', 'verbose(5)']) {
            assert.ok(channels[0].split('=>')[1].split(',').map(s => s.trim()).includes(category), `${stage}: ${category}`);
        }
        const levels = channels[0].match(/verbose(?:\([0-9]+\))?/g);
        assert.deepEqual(levels, ['verbose(5)'], 'one maximum verbosity must win; a later verbose(3) would reduce operator logging');
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(f.env.FIXTURE_DB)), operatorRows);
    assert.match(fs.readFileSync(f.custom, 'utf8'), /special => security,warning/);
    assert.match(fs.readFileSync(path.join(f.ast, 'logger_logfiles_additional.conf'), 'utf8'), /operator => debug,security,fax/);
    assert.equal(fs.existsSync(f.env.FIXTURE_AST_CALLS), false, '--no-reload must never use the CLI');
});

test('an unlimited operator verbose channel is not downgraded to verbose(3)', t => {
    const f = fixture(t);
    fs.writeFileSync(f.custom, 'full => verbose,notice\n');
    const result = f.apply();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.channels()[0].match(/verbose(?:\([0-9]+\))?/g), ['verbose']);
});

test('replacement preserves modes, ownership, symlink targets and unrelated config', (t) => {
    const f = fixture(t);
    const files = [f.loggerTarget, f.astTarget, f.custom, path.join(f.root, 'etc/logrotate.d/asterisk')];
    const before = files.map(file => fs.statSync(file));
    assert.equal(f.apply().status, 0);
    for (let i = 0; i < files.length; i++) {
        const after = fs.statSync(files[i]);
        assert.equal(after.mode & 0o7777, before[i].mode & 0o7777);
        assert.equal(after.uid, before[i].uid);
        assert.equal(after.gid, before[i].gid);
    }
    assert.ok(fs.lstatSync(path.join(f.ast, 'logger.conf')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(f.ast, 'asterisk.conf')).isSymbolicLink());
    assert.match(fs.readFileSync(f.loggerTarget, 'utf8'), /\[unrelated\]\nkeep = yes/);
    assert.match(fs.readFileSync(f.astTarget, 'utf8'), /\[options\]\nverbose = 3\ndebug = 2\n\[files\]\nkeep = yes/);
    for (const unit of ['dongle-watchdog', 'laya']) {
        assert.equal(fs.readFileSync(path.join(f.root, `etc/systemd/system/${unit}.service`), 'utf8'), `[Service]\nExecStart=/bin/${unit === 'laya' ? 'true' : 'false'}\n`);
    }
});

test('missing generated file is restored, missing includes are added inside logfiles, and absent options are created', (t) => {
    const f = fixture(t, { missing: true });
    fs.writeFileSync(f.loggerTarget, '[general]\ndateformat = %F\n[other]\nkeep = yes\n');
    fs.unlinkSync(f.custom);
    fs.writeFileSync(f.astTarget, '[directories]\nastlogdir => /var/log/asterisk\n');
    assert.equal(f.apply().status, 0);
    assert.equal(f.channels().length, 1);
    assert.match(fs.readFileSync(f.loggerTarget, 'utf8'), /\[logfiles\]\n#include logger_logfiles_custom.conf/);
    assert.match(fs.readFileSync(f.astTarget, 'utf8'), /\[options\]\nverbose = 3\ndebug = 2/);
    assert.ok(fs.existsSync(path.join(f.ast, 'logger_logfiles_additional.conf')));
    f.regenerate();
    assert.equal(f.channels().length, 1);
});

test('size checks use the global lock/state every minute and only change diagnostic retention', (t) => {
    const f = fixture(t);
    assert.equal(f.apply().status, 0);
    const policy = fs.readFileSync(path.join(f.root, 'etc/logrotate.d/asterisk'), 'utf8');
    assert.ok(policy.includes(f.unrelated), 'monthly policies must be unchanged');
    for (const log of ['full', 'messages', 'security']) {
        const block = policy.match(new RegExp(`/var/log/asterisk/${log} \\{([\\s\\S]*?)\\n\\}`))[1];
        assert.match(block, /maxsize 250M/);
        assert.match(block, /rotate 14/);
        assert.match(block, /\n    compress\n/);
        assert.match(block, /\n    nodateext\n/);
    }
    assert.match(policy, /echo operator-hook/);
    const systemd = path.join(f.root, 'etc/systemd/system');
    const timer = fs.readFileSync(path.join(systemd, 'sokrat-asterisk-logrotate.timer'), 'utf8');
    assert.match(timer, /OnUnitActiveSec=1min/);
    assert.match(timer, /AccuracySec=1s/);
    const service = fs.readFileSync(path.join(systemd, 'sokrat-asterisk-logrotate.service'), 'utf8');
    assert.match(service, /ExecStart=.*\/usr\/sbin\/logrotate \/etc\/logrotate.conf\n/);
    assert.doesNotMatch(service, /ExecStart=.*(?:--state| -s )/);
    assert.equal(fs.readlinkSync(path.join(systemd, 'timers.target.wants/sokrat-asterisk-logrotate.timer')), '../sokrat-asterisk-logrotate.timer');
});

test('mandatory DB failure is nonzero, private and does not claim success or call Asterisk', (t) => {
    const f = fixture(t);
    const before = fs.readFileSync(f.custom, 'utf8');
    const result = f.apply({ FIXTURE_DB_FAIL: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PBX logging configuration failed/);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET|password|bootstrap-password|rotation checks/);
    assert.equal(fs.readFileSync(f.custom, 'utf8'), before);
    assert.equal(fs.existsSync(f.env.FIXTURE_AST_CALLS), false);
});

test('multiline diagnostic rotation groups preserve shell hooks and do not add duplicate paths', (t) => {
    const f = fixture(t);
    const grouped = '"/var/log/asterisk/full"\n"/var/log/asterisk/messages"\n{\n    weekly\n    rotate 3\n    postrotate\n        hook() { echo preserve-this; }\n        hook\n    endscript\n}\n';
    const file = f.put('etc/logrotate.d/asterisk', grouped + f.unrelated);
    assert.equal(f.apply().status, 0);
    assert.equal(f.apply().status, 0);
    const policy = fs.readFileSync(file, 'utf8');
    for (const name of ['full', 'messages', 'security']) {
        assert.equal((policy.match(new RegExp(`/var/log/asterisk/${name}\\b`, 'g')) || []).length, 1);
    }
    assert.match(policy, /hook\(\) \{ echo preserve-this; \}/);
    assert.ok(policy.includes(f.unrelated));
    assert.equal((policy.match(/maxsize 250M/g) || []).length, 2, 'one grouped policy and one security policy');
});
