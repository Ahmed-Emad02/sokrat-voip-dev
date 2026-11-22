const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

test('python dongle autoconfig suite passes', () => {
    const result = spawnSync('python3', [
        '-m', 'unittest', 'discover',
        '-s', 'test/dongle_autoconfig',
        '-p', 'test_*.py'
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Modem Conf exposes a root-only rollback button and client action', () => {
    const view = fs.readFileSync(path.join(ROOT, 'views/config.ejs'), 'utf8');
    const client = fs.readFileSync(path.join(ROOT, 'views/scripts/config-page.ejs'), 'utf8');
    assert.match(view, /rollbackDongleAutoconfig\(\)/);
    assert.match(view, /Rollback Autoconfig/);
    assert.match(view, /التراجع عن الإعداد التلقائي/);
    assert.match(view, /if \(\(typeof isRoot[\s\S]{0,2500}rollbackDongleAutoconfig/);
    assert.match(client, /async function rollbackDongleAutoconfig\(\)/);
    assert.match(client, /\/api\/config\/modem\/autoconfig\/rollback/);
    assert.match(client, /window\.rollbackDongleAutoconfig/);
});

test('server rollback endpoint is root-only and invokes the autoconfig CLI', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(server, /app\.post\('\/api\/config\/modem\/autoconfig\/rollback', requireAuth/);
    assert.match(server, /hasRootAccess\(req\)/);
    assert.match(server, /scripts', 'dongle-autoconfig\.py'/);
    assert.match(server, /'rollback', '--yes', '--json'/);
});

test('installers and upgrade install the autoconfig units', () => {
    for (const file of ['install.sh', 'installer-bundle/install-sokrat.sh']) {
        const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.match(text, /sokrat-dongle-autoconfig\.service/);
        assert.match(text, /sokrat-dongle-autoconfig\.timer/);
    }
    const upgrade = fs.readFileSync(path.join(ROOT, 'scripts/safe-upgrade.sh'), 'utf8');
    assert.match(upgrade, /sokrat-dongle-autoconfig\.timer/);
    const helper = fs.readFileSync(path.join(ROOT, 'scripts/install-dongle-autoconfig.sh'), 'utf8');
    assert.match(helper, /sokrat-dongle-autoconfig\.timer/);
    assert.match(helper, /--repo/);
});

test('systemd and example slot map are present and parseable', () => {
    const service = fs.readFileSync(path.join(ROOT, 'scripts/systemd/sokrat-dongle-autoconfig.service'), 'utf8');
    const timer = fs.readFileSync(path.join(ROOT, 'scripts/systemd/sokrat-dongle-autoconfig.timer'), 'utf8');
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/dongle-slots.example.json'), 'utf8'));
    assert.match(service, /reconcile --yes --auto --json/);
    assert.match(timer, /OnUnitActiveSec=60s/);
    assert.equal(example.version, 1);
    assert.ok(example.slots.dongle0.port);
});

test('bootstrap recovers from incomplete clones instead of silently continuing', () => {
    const bootstrap = fs.readFileSync(path.join(ROOT, 'bootstrap.sh'), 'utf8');
    assert.match(bootstrap, /VALID_CLONE=0/);
    assert.match(bootstrap, /rev-parse --verify HEAD/);
    assert.match(bootstrap, /incomplete checkout to \$FAILED_DIR/);
    assert.match(bootstrap, /ERROR: checkout is missing/);
    assert.doesNotMatch(bootstrap, /git -C "\$INSTALL_DIR" fetch[^\n]*\|\| true/);
    assert.doesNotMatch(bootstrap, /git -C "\$INSTALL_DIR" checkout[^\n]*\|\| true/);
});
