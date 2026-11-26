'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pinned = '7db8e75bc2b7c81b173e1bb465e376e64a70319a';
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.error, undefined, `${program}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
  return result.stdout;
}
function withoutIncludes(source) {
  return source.replace(/^\s*#\s*include[^\n]*$/gm, '');
}
function definition(source, name) {
  const masked = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    match => match.replace(/[^\n]/g, ' '));
  const signature = new RegExp(`^[^\\n;{}()]*\\b${name}\\s*\\([^;{}]*?\\)\\s*\\{`, 'm').exec(masked);
  assert.ok(signature, `Missing compiled driver definition: ${name}`);
  const start = signature.index;
  let index = masked.indexOf('{', start), depth = 1;
  for (++index; index < masked.length && depth; ++index) {
    if (masked[index] === '{') ++depth;
    if (masked[index] === '}') --depth;
  }
  assert.equal(depth, 0, `Unbalanced driver definition: ${name}`);
  return source.slice(start, index) + '\n';
}

test('shutdown joins discovery without holding discovery_lock and blocks new wakes', { timeout: 60000 }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dongle-shutdown-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  fs.mkdirSync(source);
  const origin = process.env.DONGLE_SOURCE_REPO || '/usr/src/asterisk-chan-dongle';
  assert.ok(fs.existsSync(origin), `Set DONGLE_SOURCE_REPO to a local checkout containing ${pinned}; no network or modem is used`);
  const archive = spawnSync('git', ['-C', origin, 'archive', pinned], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(archive.status, 0, archive.stderr?.toString());
  run('tar', ['-xf', '-', '-C', source], { input: archive.stdout });
  run('bash', ['-c', 'source "$1"; cd "$2"; dongle_module_apply_source_patches "$3" "$4"', 'shutdown',
    path.join(root, 'scripts/dongle-module.sh'), source,
    path.join(root, 'asterisk/chan_dongle.patch'), path.join(temp, 'patch.log')]);
  const driver = fs.readFileSync(path.join(source, 'chan_dongle.c'), 'utf8');
  const code = ['discovery_wait', 'discovery_restart', 'discovery_stop', 'pvt_stop', 'restate_name', 'pvt_time4restate', 'pvt_try_restate']
    .map(name => definition(driver, name)).join('\n');
  fs.writeFileSync(path.join(temp, 'shutdown-code.inc'), code);
  const executable = path.join(temp, 'shutdown');
  run(process.env.CC || 'cc', ['-std=gnu11', '-O1', '-g', '-pthread',
    '-Werror=implicit-function-declaration', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', temp,
    path.join(__dirname, 'fixtures/review-shutdown-positive.c'), '-o', executable]);
  const output = run(executable, [], { timeout: 15000,
    env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=1:halt_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1' } });
  assert.equal(output.trim(), 'shutdown lock cycle: ok');
});
