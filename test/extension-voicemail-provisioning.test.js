const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '../server.js');
const server = fs.readFileSync(serverPath, 'utf8');

function blockOf(source, startPattern) {
    const m = source.match(startPattern);
    return m ? m[0] : '';
}

test('editing an extension provisions the live voicemail state, not just the database', () => {
    // The extension PUT handler used to update asterisk.users and stop there.
    // The ASTDB context the dialplan reads and the mailbox entry in
    // voicemail.conf were left stale, so enabling or disabling voicemail only
    // took effect after the next service restart.
    const putHandler = blockOf(server, /app\.put\('\/api\/config\/extensions\/:extension'[\s\S]*?\n\}\);/);
    assert.ok(putHandler, 'server.js must define PUT /api/config/extensions/:extension');
    assert.match(
        putHandler,
        /applyVoicemailState\(/,
        'the extension PUT handler must provision the live voicemail state'
    );
});

test('applyVoicemailState sets the ASTDB context and the mailbox entry', () => {
    const helper = blockOf(server, /function applyVoicemailState\([\s\S]*?\n\}/);
    assert.ok(helper, 'server.js must define applyVoicemailState');
    assert.match(
        helper,
        /database put AMPUSER \$\{extNum\}\/voicemail /,
        'the helper must set the ASTDB voicemail context the dialplan reads'
    );
    assert.match(
        helper,
        /updateVoicemailConf\(/,
        'the helper must update /etc/asterisk/voicemail.conf'
    );
});

test('updateVoicemailConf adds and removes the mailbox entry', () => {
    const helper = blockOf(server, /function updateVoicemailConf\([\s\S]*?\n\}/);
    assert.ok(helper, 'server.js must define updateVoicemailConf');
    assert.match(
        helper,
        /lines = lines\.filter\(line => !line\.trim\(\)\.startsWith\(`\$\{extNum\} =>`\)\)/,
        'the helper must drop any existing mailbox entry for the extension'
    );
    assert.match(
        helper,
        /\$\{extNum\} => /,
        'the helper must add a mailbox entry for a voicemail-enabled extension'
    );
    assert.match(
        helper,
        /voicemail reload/,
        'the helper must reload the voicemail application'
    );
});

test('creating an extension still provisions the voicemail state', () => {
    const postHandler = blockOf(server, /app\.post\('\/api\/config\/extensions'[\s\S]*?\n\}\);/);
    assert.ok(postHandler, 'server.js must define POST /api/config/extensions');
    assert.match(
        postHandler,
        /setExtensionAstdbDefaults\(/,
        'the extension POST handler must provision the ASTDB defaults'
    );
});
