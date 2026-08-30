const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('views/config.ejs DestinationSelect supports External Mobile Number destination category', () => {
    const configContent = fs.readFileSync(path.join(__dirname, '../views/config.ejs'), 'utf8');

    // Category definition
    assert.match(configContent, /id:\s*'external'/, 'getCategories must include external category');
    assert.match(configContent, /External Number \/ Mobile/, 'getCategories must include English label for external');
    assert.match(configContent, /رقم خارجي \/ جوال/, 'getCategories must include Arabic label for external');

    // Dialplan string parsing
    assert.match(configContent, /dest\.startsWith\('ext-external-failover,'\)/, 'parseDialplanString must recognize ext-external-failover');

    // Rendering of external input
    // Rendering of external input & dongle select
    assert.match(configContent, /isExternal\s*=\s*this\.selectedCategory\s*===\s*'external'/, 'render must identify isExternal category');
    assert.match(configContent, /dest-external-input/, 'render must generate dest-external-input');
    assert.match(configContent, /dest-external-dongle/, 'render must generate dest-external-dongle selector');

    // Event listener for external input & dongle select
    assert.match(configContent, /updateExternalDialplan/, 'bindEvents must define updateExternalDialplan handler');
    assert.match(configContent, /ext-external-failover,\$\{rawNum\}\/\$\{dongle\},1/, 'bindEvents must generate explicit dongle failover dialplan string');
    // Formatting destination in tables and diagrams
    assert.match(configContent, /External \/ Mobile:/, 'formatDestination must format external destinations in English');
    assert.match(configContent, /رقم خارجي \/ جوال:/, 'formatDestination must format external destinations in Arabic');
});

test('/etc/asterisk/extensions_custom.conf contains ext-external-failover with direct bridging', () => {
    const customConfPath = '/etc/asterisk/extensions_custom.conf';
    assert.ok(fs.existsSync(customConfPath), 'extensions_custom.conf must exist');
    const conf = fs.readFileSync(customConfPath, 'utf8');

    // ext-external-failover context definition
    assert.match(conf, /\[ext-external-failover\]/, 'extensions_custom.conf must define [ext-external-failover]');
    assert.match(conf, /Dial\(Dongle\/\$\{EXPLICIT_DONGLE\}\/\$\{TARGET_NUM\},60\)/, 'ext-external-failover must dial explicit Dongle channel directly');
    assert.match(conf, /Dial\(Local\/\$\{TARGET_NUM\}@outbound-allroutes,60\)/, 'ext-external-failover must dial Local directly without screening whisper');
});

test('install.sh contains ext-external-failover dialplan migrations', () => {
    const installScript = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
    assert.match(installScript, /\[ext-external-failover\]/, 'install.sh must configure [ext-external-failover]');
    assert.match(installScript, /Dial\(Dongle\/\$\{EXPLICIT_DONGLE\}\/\$\{TARGET_NUM\},60\)/, 'install.sh must dial Dongle directly');
    assert.match(installScript, /Dial\(Local\/\$\{TARGET_NUM\}@outbound-allroutes,60\)/, 'install.sh must dial Local directly');
});
