const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ejs = require('ejs');

test('Asterisk func_speex.so is loaded and recognizes AGC function', () => {
    try {
        const out = execSync('asterisk -rx "core show function AGC"', { encoding: 'utf8' });
        assert.ok(out.includes('Info about function \'AGC\''), 'Asterisk CLI must recognize AGC function');
        assert.ok(out.includes('AGC(channeldirection)'), 'Syntax must show AGC(channeldirection)');
    } catch (e) {
        assert.fail('Failed to query Asterisk for AGC function: ' + e.message);
    }
});

test('views/config.ejs renders extAgc Automatic Gain Control select in extensionModal', async () => {
    const configEjsPath = path.join(__dirname, '../views/config.ejs');
    const html = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        isSuperAdmin: true,
        isRoot: true,
        user: { username: 'admin', isRoot: true },
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['extensions'],
        isTabAllowed: () => true
    });

    assert.ok(html.includes('id="extAgc"'), 'extensionModal must render extAgc select dropdown');
    assert.ok(html.includes('value="8000"'), 'extAgc must include "8000" option');
    assert.ok(html.includes('value="6000"'), 'extAgc must include "6000" option');
    assert.ok(html.includes('value="10000"'), 'extAgc must include "10000" option');
    assert.ok(html.includes('value="12000"'), 'extAgc must include "12000" option');
    assert.ok(html.includes('value="off"'), 'extAgc must include "off" option');
});

test('/etc/asterisk/extensions_custom.conf queries DB(AMPUSER/.../agc) dynamically across dialplan hooks', () => {
    const content = fs.readFileSync('/etc/asterisk/extensions_custom.conf', 'utf8');

    // Trunk hook checks caller AGC
    assert.ok(content.includes('CALLER_AGC=${DB(AMPUSER/${REALCALLERIDNUM}/agc)}'), 'Trunk hook must query REALCALLERIDNUM AGC');
    assert.ok(content.includes('CALLER_AGC=${DB(AMPUSER/${CALLERID(num)}/agc)}'), 'Trunk hook must fallback to CALLERID(num) AGC');

    // Internal call hook checks caller AGC
    assert.ok(content.includes('CALLER_AGC=${DB(AMPUSER/${CALLERID(num)}/agc)}'), 'Internal call hook must query calling extension AGC');

    // Incoming leg checks callee extension AGC
    assert.ok(content.includes('CALLEE_AGC=${DB(AMPUSER/${CALLEE_EXT}/agc)}'), 'func-apply-sipheaders-custom must query callee extension AGC');

    // AGC is applied conditionally
    assert.ok(content.includes('Set(AGC(rx)=${CALLER_AGC})'), 'Dialplan must set AGC(rx) for caller');
    assert.ok(content.includes('Set(AGC(tx)=${CALLER_AGC})'), 'Dialplan must set AGC(tx) for caller');
    assert.ok(content.includes('Set(AGC(rx)=${CALLEE_AGC})'), 'Dialplan must set AGC(rx) for callee');
    assert.ok(content.includes('Set(AGC(tx)=${CALLEE_AGC})'), 'Dialplan must set AGC(tx) for callee');
});

test('from-dongle-custom does not apply static or global AGC', () => {
    const content = fs.readFileSync('/etc/asterisk/extensions_custom.conf', 'utf8');
    const start = content.indexOf('[from-dongle-custom]');
    assert.ok(start !== -1, 'from-dongle-custom must exist');
    const next = content.slice(start + 1).search(/\n\[/);
    const dongleContext = next === -1 ? content.slice(start) : content.slice(start, start + 1 + next);

    assert.equal(dongleContext.includes('AGC(rx)='), false, 'from-dongle-custom must not set global AGC(rx)');
    assert.equal(dongleContext.includes('AGC(tx)='), false, 'from-dongle-custom must not set global AGC(tx)');
});

test('server.js supports agc in extension endpoints and defaults', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    // setExtensionAstdbDefaults includes agc
    assert.ok(serverJs.includes('database put AMPUSER ${extNum}/agc ${validAgc}'), 'setExtensionAstdbDefaults must write agc to AstDB');

    // GET /api/config/extensions looks up agc
    assert.ok(serverJs.includes('line.match(/\\/AMPUSER\\/(\\d+)\\/agc'), 'GET /api/config/extensions must parse agc from AstDB');
    assert.ok(serverJs.includes("agc: agcMap[ext.extension] || '8000'"), 'GET /api/config/extensions must enrich ext with agc');

    // PUT /api/config/extensions/:extension updates agc in AstDB
    assert.ok(serverJs.includes('database put AMPUSER ${extNum}/agc ${validAgc}'), 'PUT /api/config/extensions must update agc in AstDB');
});

test('AstDB stores and updates agc per-extension', () => {
    try {
        // Query extension 101's current agc
        const initial = execSync('asterisk -rx "database get AMPUSER 101/agc"', { encoding: 'utf8' });
        assert.ok(initial.includes('Value:'), 'Extension 101 must have an agc entry in AstDB');

        // Test updating to custom target
        execSync('asterisk -rx "database put AMPUSER 101/agc 6000"');
        const updated = execSync('asterisk -rx "database get AMPUSER 101/agc"', { encoding: 'utf8' });
        assert.ok(updated.includes('6000'), 'Extension 101 agc must be updated to 6000');

        // Restore to 8000
        execSync('asterisk -rx "database put AMPUSER 101/agc 8000"');
        const restored = execSync('asterisk -rx "database get AMPUSER 101/agc"', { encoding: 'utf8' });
        assert.ok(restored.includes('8000'), 'Extension 101 agc must be restored to 8000');
    } catch (e) {
        assert.fail('AstDB agc operation failed: ' + e.message);
    }
});
