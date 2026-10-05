const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..');

test('Schema: backend/install_db.sql defines sokrat_camp_on_callbacks table', () => {
    const sql = fs.readFileSync(path.join(rootDir, 'backend', 'install_db.sql'), 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `sokrat_camp_on_callbacks`/);
    assert.match(sql, /`caller_ext` VARCHAR\(20\) NOT NULL/);
    assert.match(sql, /`target_ext` VARCHAR\(20\) NOT NULL/);
    assert.match(sql, /`status` ENUM\('pending'/);
});

test('Dialplan: /etc/asterisk/extensions_custom.conf defines Camp-On feature codes and hooks', () => {
    const dialplan = fs.readFileSync('/etc/asterisk/extensions_custom.conf', 'utf8');
    assert.match(dialplan, /exten => \*82,1/, 'extensions_custom.conf must define *82 feature code');
    assert.match(dialplan, /exten => \*83,1/, 'extensions_custom.conf must define *83 feature code');
    assert.match(dialplan, /\[macro-exten-vm-custom\]/, 'extensions_custom.conf must define [macro-exten-vm-custom]');
    assert.match(dialplan, /s-BUSY/, 'macro-exten-vm-custom must catch s-BUSY');
    assert.match(dialplan, /PRESSED_DIGIT.*6/, 'macro-exten-vm-custom must listen for digit 6');
    assert.match(dialplan, /\[sub-campon-activate\]/, 'extensions_custom.conf must define [sub-campon-activate]');
    assert.match(dialplan, /\[ext-campon-bridge\]/, 'extensions_custom.conf must define [ext-campon-bridge]');
    assert.match(dialplan, /\[campon-hangup-capture\]/, 'extensions_custom.conf must define [campon-hangup-capture]');
});

test('AGI Script: scripts/sokrat-campon.py is valid python and executable', () => {
    const agiPath = path.join(rootDir, 'scripts', 'sokrat-campon.py');
    assert.ok(fs.existsSync(agiPath), 'scripts/sokrat-campon.py must exist');
    assert.doesNotThrow(() => {
        execSync(`python3 -m py_compile "${agiPath}"`, { stdio: 'pipe' });
    }, 'scripts/sokrat-campon.py must compile cleanly');
});

test('Multi-Installer Parity: install.sh, install-sokrat.sh, and safe-upgrade.sh sync Camp-On', () => {
    for (const file of ['install.sh', path.join('installer-bundle', 'install-sokrat.sh'), path.join('scripts', 'safe-upgrade.sh')]) {
        const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
        assert.match(content, /sokrat-campon\.py/, `${file} must install sokrat-campon.py`);
        assert.match(content, /ext-campon-bridge/, `${file} must configure [ext-campon-bridge]`);
        assert.match(content, /\*82/, `${file} must configure *82`);
    }
});

test('Server Engine: server.js defines Camp-On state machine and REST APIs', () => {
    const server = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
    assert.match(server, /async function registerCampOnCallback/, 'server.js must define registerCampOnCallback');
    assert.match(server, /async function cancelCampOnCallback/, 'server.js must define cancelCampOnCallback');
    assert.match(server, /function checkAndExecuteCampOn/, 'server.js must define checkAndExecuteCampOn');
    assert.match(server, /executeCampOnOriginate/, 'server.js must define executeCampOnOriginate');
    assert.match(server, /\/api\/telephony\/camp-on\/dialplan-trigger/, 'server.js must define dialplan trigger API');
    assert.match(server, /\/api\/telephony\/camp-on\/request/, 'server.js must define request API');
    assert.match(server, /\/api\/telephony\/camp-on\/cancel/, 'server.js must define cancel API');
    assert.match(server, /\/api\/telephony\/camp-on\/pending/, 'server.js must define pending API');
});

test('Softphone UI: softphone-core.js and softphone-ui.js handle callBusyInternal and showCampOnPrompt', () => {
    const core = fs.readFileSync(path.join(rootDir, 'public', 'js', 'softphone-core.js'), 'utf8');
    assert.match(core, /callBusyInternal/, 'softphone-core.js must emit callBusyInternal on 486 Busy');

    const ui = fs.readFileSync(path.join(rootDir, 'public', 'js', 'softphone-ui.js'), 'utf8');
    assert.match(ui, /showCampOnPrompt/, 'softphone-ui.js must define showCampOnPrompt');
    assert.match(ui, /campOnBtn_/, 'showCampOnPrompt must generate action button');
});

test('Live Panel: views/operator.ejs defines call codes guide button and interactive modal', () => {
    const operatorView = fs.readFileSync(path.join(rootDir, 'views', 'operator.ejs'), 'utf8');
    assert.match(operatorView, /btn-call-codes-guide/, 'operator.ejs must define call codes button');
    assert.match(operatorView, /callCodesGuideModal/, 'operator.ejs must define callCodesGuideModal');
    assert.match(operatorView, /openCallCodesGuideModal/, 'operator.ejs must define openCallCodesGuideModal function');
});
