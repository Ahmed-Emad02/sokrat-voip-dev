const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

const SHARED = 'installer-bundle/collect-install-inputs.sh';

test('the installation questions live in one shared file', () => {
    const content = read(SHARED);
    assert.ok(content.includes('collect_client_name()'), 'the client name is asked');
    assert.ok(content.includes('collect_dongle_count()'), 'the dongle count is asked');
    assert.ok(content.includes('collect_default_setup()'), 'the default setup is asked');
    assert.ok(content.includes('collect_install_inputs()'), 'the three questions are asked together');
});

test('the offline setup asks the questions before the long package work', () => {
    const content = read('installer-bundle/setup-issabel-asterisk.sh');
    const collectAt = content.indexOf('collect_install_inputs');
    const installAt = content.indexOf('Installing all database, web, Asterisk 18 & Issabel 5 packages offline');
    assert.ok(collectAt > 0, 'the questions are asked');
    assert.ok(installAt > 0, 'the package work is there');
    assert.ok(collectAt < installAt, 'the questions come before the package installation');
    assert.ok(content.includes('source "$SCRIPT_DIR/collect-install-inputs.sh"'), 'it uses the shared file');
});

test('install-sokrat.sh reuses the answers of the first script', () => {
    const content = read('installer-bundle/install-sokrat.sh');
    assert.ok(content.includes('source "$SCRIPT_DIR/collect-install-inputs.sh"'), 'it sources the shared file');
    assert.ok(content.includes('collect_install_inputs'), 'it collects the inputs');
});

test('the online installer also reuses the answers', () => {
    const content = read('install.sh');
    assert.ok(content.includes('SOKRAT_INPUTS_FILE'), 'it uses the state file');
    assert.ok(content.includes('source "$SOKRAT_INPUTS_FILE"'), 'it reads the answers of an earlier step');
    assert.ok(content.includes('> "$SOKRAT_INPUTS_FILE"'), 'it stores its own answers');
});

test('every script uses the same state file', () => {
    const expected = '/var/lib/sokrat/install-inputs.env';
    for (const rel of [SHARED, 'install.sh']) {
        assert.ok(read(rel).includes(expected), `${rel} uses ${expected}`);
    }
});

test('the questions are worded the same everywhere', () => {
    const shared = read(SHARED);
    const online = read('install.sh');
    const prompts = [
        'Enter the client name for this server [default: %s]: ',
        'Enter the number of GSM dongles to activate on this server (1-25) [default: %s]: ',
        'Apply default setup (10 extensions 101-110, ring group 601, general inbound route)? [y/N]: '
    ];
    for (const prompt of prompts) {
        assert.ok(shared.includes(prompt), `the shared file has "${prompt.slice(0, 28)}..."`);
        assert.ok(online.includes(prompt), `install.sh has the same "${prompt.slice(0, 28)}..."`);
    }
});

test('the answers are only asked when they are missing', () => {
    const content = read(SHARED);
    assert.ok(content.includes('load_install_inputs'), 'the saved answers are loaded');
    assert.ok(content.includes('save_install_inputs'), 'the answers are stored');
    assert.ok(content.includes('if [[ -n "${CLIENT_NAME:-}" ]]; then'), 'an existing client name is kept');
    assert.ok(content.includes('if [[ -n "${NUM_DONGLES:-}" ]]; then'), 'an existing dongle count is kept');
    assert.ok(content.includes('if [[ -n "${DEFAULT_SETUP:-}" ]]; then'), 'an existing default setup is kept');
});
