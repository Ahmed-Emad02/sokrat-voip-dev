const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const rootDir = path.join(__dirname, '..');
const { DEFAULT_CALL_CODES, getCallCodes, applyCallCodeBackendUpdate, resetCallCodesToDefaults } = require('../lib/call-codes');

test('Schema: backend/install_db.sql defines sokrat_call_codes table and seeds all 36 codes', () => {
    const sql = fs.readFileSync(path.join(rootDir, 'backend', 'install_db.sql'), 'utf8');

    assert.match(sql, /CREATE TABLE IF NOT EXISTS `sokrat_call_codes`/, 'install_db.sql must create sokrat_call_codes table');
    assert.match(sql, /`default_code` VARCHAR\(32\) NOT NULL/, 'install_db.sql must define default_code');
    assert.match(sql, /`backend_type` VARCHAR\(32\) NOT NULL/, 'install_db.sql must define backend_type');

    assert.equal(DEFAULT_CALL_CODES.length, 36, 'Must define exactly 36 default call codes');
    for (const codeItem of DEFAULT_CALL_CODES) {
        assert.ok(sql.includes(`'${codeItem.id}'`), `install_db.sql must seed code ID ${codeItem.id}`);
        assert.ok(sql.includes(`'${codeItem.code}'`), `install_db.sql must seed code value ${codeItem.code}`);
    }
});

test('Multi-Installer Parity: install.sh, install-sokrat.sh, and safe-upgrade.sh sync extensions_sokrat_callcodes.conf', () => {
    const installers = [
        path.join(rootDir, 'install.sh'),
        path.join(rootDir, 'installer-bundle', 'install-sokrat.sh'),
        path.join(rootDir, 'scripts', 'safe-upgrade.sh')
    ];

    for (const file of installers) {
        const content = fs.readFileSync(file, 'utf8');
        assert.match(content, /extensions_sokrat_callcodes\.conf/, `${file} must reference extensions_sokrat_callcodes.conf`);
        assert.match(content, /sokrat-call-codes-custom/, `${file} must configure [sokrat-call-codes-custom]`);
    }
});

test('Server Engine: server.js wires call codes routes and initialization', () => {
    const serverJs = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');

    assert.match(serverJs, /initSokratCallCodes/, 'server.js must call initSokratCallCodes');
    assert.match(serverJs, /app\.get\('\/api\/telephony\/call-codes'/, 'server.js must define GET /api/telephony/call-codes');
    assert.match(serverJs, /app\.put\('\/api\/telephony\/call-codes\/:id'/, 'server.js must define PUT /api/telephony/call-codes/:id');
    assert.match(serverJs, /app\.post\('\/api\/telephony\/call-codes\/reset-defaults'/, 'server.js must define POST /api/telephony/call-codes/reset-defaults');
});

test('Call Codes Engine: Database operations, dynamic updates, and factory default resets', async () => {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || 'admin',
        database: 'asterisk'
    });

    try {
        // 1. Fetch all codes
        const codes = await getCallCodes(pool);
        assert.equal(codes.length, 36, 'Must return exactly 36 call control codes');

        // Verify categories
        const categories = new Set(codes.map(c => c.cat));
        assert.ok(categories.has('incall'), 'Must include incall category');
        assert.ok(categories.has('campon'), 'Must include campon category');
        assert.ok(categories.has('spy'), 'Must include spy category');
        assert.ok(categories.has('intercom'), 'Must include intercom category');
        assert.ok(categories.has('parking'), 'Must include parking category');
        assert.ok(categories.has('forward'), 'Must include forward category');
        assert.ok(categories.has('diagnostics'), 'Must include diagnostics category');

        // 2. Test customization on a FreePBX feature code (cf_all_on: *72)
        const target = codes.find(c => c.id === 'cf_all_on');
        assert.ok(target, 'Target cf_all_on must exist');
        assert.equal(target.default_code, '*72');

        await applyCallCodeBackendUpdate(pool, target, '*75', 1);
        await pool.query('UPDATE `asterisk`.`sokrat_call_codes` SET code = ? WHERE id = ?', ['*75', target.id]);

        const [updatedRows] = await pool.query('SELECT code, enabled FROM `asterisk`.`sokrat_call_codes` WHERE id = ?', [target.id]);
        assert.equal(updatedRows[0].code, '*75');

        // Verify FreePBX table was updated
        const [fpbxRows] = await pool.query('SELECT customcode FROM `asterisk`.`featurecodes` WHERE modulename = "callforward" AND featurename = "cfon"');
        assert.equal(fpbxRows[0].customcode, '*75');

        // 3. Reset defaults
        await resetCallCodesToDefaults(pool);

        const [resetRows] = await pool.query('SELECT code, default_code FROM `asterisk`.`sokrat_call_codes` WHERE id = ?', [target.id]);
        assert.equal(resetRows[0].code, '*72');
        assert.equal(resetRows[0].default_code, '*72');

        // Verify FreePBX table was reverted
        const [revertedFpbx] = await pool.query('SELECT customcode FROM `asterisk`.`featurecodes` WHERE modulename = "callforward" AND featurename = "cfon"');
        assert.equal(revertedFpbx[0].customcode, null);
    } finally {
        await pool.end();
    }
});

test('Live Panel UI: views/operator.ejs defines dynamic guide modal, edit dialog, and switchboard hooks', () => {
    const operatorView = fs.readFileSync(path.join(rootDir, 'views', 'operator.ejs'), 'utf8');

    assert.match(operatorView, /id="callCodesGuideModal"/, 'operator.ejs must define callCodesGuideModal');
    assert.match(operatorView, /id="editCallCodeModal"/, 'operator.ejs must define editCallCodeModal');
    assert.match(operatorView, /id="btn-configure-call-codes"/, 'operator.ejs must define configure codes button');
    assert.match(operatorView, /id="btn-reset-call-codes"/, 'operator.ejs must define reset defaults button');

    // Dynamic category pill counters
    assert.match(operatorView, /id="pill-count-all"/, 'operator.ejs must define pill-count-all');
    assert.match(operatorView, /id="pill-count-incall"/, 'operator.ejs must define pill-count-incall');
    assert.match(operatorView, /id="pill-count-campon"/, 'operator.ejs must define pill-count-campon');
    assert.match(operatorView, /id="pill-count-spy"/, 'operator.ejs must define pill-count-spy');
    assert.match(operatorView, /id="pill-count-intercom"/, 'operator.ejs must define pill-count-intercom');
    assert.match(operatorView, /id="pill-count-parking"/, 'operator.ejs must define pill-count-parking');
    assert.match(operatorView, /id="pill-count-forward"/, 'operator.ejs must define pill-count-forward');
    assert.match(operatorView, /id="pill-count-diagnostics"/, 'operator.ejs must define pill-count-diagnostics');

    // Functions
    assert.match(operatorView, /fetchCallCodes/, 'operator.ejs must define fetchCallCodes');
    assert.match(operatorView, /openEditCallCodeModal/, 'operator.ejs must define openEditCallCodeModal');
    assert.match(operatorView, /saveCallCodeEdit/, 'operator.ejs must define saveCallCodeEdit');
    assert.match(operatorView, /confirmResetAllCallCodes/, 'operator.ejs must define confirmResetAllCallCodes');
    assert.match(operatorView, /window\.getSpyPrefix/, 'operator.ejs must define getSpyPrefix for switchboard');
});

test('PBX Configurations Subtab: views/config.ejs renders Call Control Codes as a dedicated subtab', () => {
    const configView = fs.readFileSync(path.join(rootDir, 'views', 'config.ejs'), 'utf8');

    assert.match(configView, /id="tab-btn-callcodes"/, 'config.ejs must define tab-btn-callcodes in subsidebar');
    assert.match(configView, /data-tab-target="callcodes"/, 'config.ejs must define callcodes pill button in top bar');
    assert.match(configView, /id="section-callcodes"/, 'config.ejs must define dedicated section-callcodes');
    assert.match(configView, /id="cfgCallCodesGrid"/, 'config.ejs must define cfgCallCodesGrid');
    assert.match(configView, /id="callCodeModal"/, 'config.ejs must define callCodeModal');
    assert.match(configView, /'callCodeModal'/, 'config.ejs must register callCodeModal in PBX_CONFIG_MODAL_IDS');

    // Functions
    assert.match(configView, /fetchConfigCallCodes/, 'config.ejs must define fetchConfigCallCodes');
    assert.match(configView, /openConfigCallCodeModal/, 'config.ejs must define openConfigCallCodeModal');
    assert.match(configView, /saveConfigCallCodeEdit/, 'config.ejs must define saveConfigCallCodeEdit');
    assert.match(configView, /confirmResetAllConfigCallCodes/, 'config.ejs must define confirmResetAllConfigCallCodes');

    // Placement: in between modemconf and connected pbx
    const subsidebarModemIdx = configView.indexOf('id="tab-btn-modem"');
    const subsidebarCallcodesIdx = configView.indexOf('id="tab-btn-callcodes"');
    const subsidebarFederationIdx = configView.indexOf('id="tab-btn-federation"');
    assert.ok(subsidebarModemIdx !== -1 && subsidebarCallcodesIdx !== -1 && subsidebarFederationIdx !== -1,
        'Subsidebar buttons for modem, callcodes, and federation must exist');
    assert.ok(subsidebarModemIdx < subsidebarCallcodesIdx && subsidebarCallcodesIdx < subsidebarFederationIdx,
        'Subsidebar: callcodes button must be located in between modem and federation');

    const topPillModemIdx = configView.indexOf('data-tab-target="modem"');
    const topPillCallcodesIdx = configView.indexOf('data-tab-target="callcodes"');
    const topPillFederationIdx = configView.indexOf('data-tab-target="federation"');
    assert.ok(topPillModemIdx !== -1 && topPillCallcodesIdx !== -1 && topPillFederationIdx !== -1,
        'Top pill buttons for modem, callcodes, and federation must exist');
    assert.ok(topPillModemIdx < topPillCallcodesIdx && topPillCallcodesIdx < topPillFederationIdx,
        'Top pills: callcodes button must be located in between modem and federation');
});
