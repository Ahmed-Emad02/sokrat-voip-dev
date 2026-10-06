const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');

test('Intercom & Paging: Dialplan in extensions_custom.conf defines auto-answer and ConfBridge contexts', () => {
    const dialplanPath = '/etc/asterisk/extensions_custom.conf';
    assert.ok(fs.existsSync(dialplanPath), 'extensions_custom.conf must exist');
    const dialplan = fs.readFileSync(dialplanPath, 'utf8');

    // 1. [from-intercom-autoanswer]
    assert.match(dialplan, /\[from-intercom-autoanswer\]/, 'must define [from-intercom-autoanswer] context');
    assert.match(dialplan, /CALLERID\(name\)=Intercom/, 'must set CallerID name to Intercom');
    assert.match(dialplan, /intercom-predial-autoanswer\^s\^1/, 'must use predial autoanswer hook');

    // 2. [intercom-predial-autoanswer] Header Injection
    assert.match(dialplan, /\[intercom-predial-autoanswer\]/, 'must define [intercom-predial-autoanswer] context');
    assert.match(dialplan, /Call-Info.*answer-after=0/, 'must inject Call-Info answer-after=0 header');
    assert.match(dialplan, /Alert-Info.*autoanswer/, 'must inject Alert-Info autoanswer header');
    assert.match(dialplan, /PJSIP_HEADER\(add,Call-Info\)/, 'must support PJSIP header injection');
    assert.match(dialplan, /SIPAddHeader\(Call-Info/, 'must support chan_sip header injection');

    // 3. [from-intercom-conf]
    assert.match(dialplan, /\[from-intercom-conf\]/, 'must define [from-intercom-conf] context');
    assert.match(dialplan, /ConfBridge\(\$\{EXTEN\}\)/, 'must bridge participants using ConfBridge');
});

test('Intercom & Paging: server.js defines POST /api/intercom/call with target availability guards', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');

    assert.match(serverCode, /app\.post\('\/api\/intercom\/call',\s*requireAuth/, 'POST /api/intercom/call must require authentication');
    assert.match(serverCode, /const\s*\{\s*callerExtension,\s*targetExtensions\s*\}\s*=\s*req\.body/, 'must parse callerExtension and targetExtensions');
    assert.match(serverCode, /\/\^\\d\{2,5\}\$\/\.test\(caller\)/, 'must validate caller extension format');

    // Target filtering and busy state checks
    assert.match(serverCode, /extStr\s*===\s*caller/, 'must exclude caller from target list');
    assert.match(serverCode, /liveCall\.state\s*===\s*'In Call'\s*\|\|\s*liveCall\.state\s*===\s*'Ringing'/, 'must filter out extensions that are in call or ringing');

    // Dynamic conference room generation & AMI Originate
    assert.match(serverCode, /const roomId = '88' \+/, 'must generate dynamic 88... conference room ID');
    assert.match(serverCode, /from-intercom-autoanswer/, 'must target from-intercom-autoanswer channel');
    assert.match(serverCode, /from-intercom-conf/, 'must bridge channels into from-intercom-conf context');
});

test('Intercom & Paging: Softphone core detects auto-answer headers and intercom caller IDs', () => {
    const softphoneCode = fs.readFileSync(path.join(rootDir, 'public', 'js', 'softphone-core.js'), 'utf8');

    // 1. Header detection
    assert.match(softphoneCode, /autoanswer\|answer-after=0\|ring-answer/i, 'must detect standard auto-answer SIP headers');

    // 2. Intercom & Spy prefix detection
    assert.match(softphoneCode, /isSpyOrIntercom/, 'must define isSpyOrIntercom flag');
    assert.match(softphoneCode, /Intercom/i, 'must recognize Intercom caller ID display name');

    // 3. Auto-answer decision
    assert.match(softphoneCode, /shouldAutoAnswer\s*=/, 'must evaluate shouldAutoAnswer for incoming session');
});
