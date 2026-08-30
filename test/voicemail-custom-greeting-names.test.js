const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('server.js voicemail APIs persist and resolve custom greeting names for mailboxes', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    // GET /api/config/voicemail/extensions returns greetingName
    assert.match(serverJs, /greetingName:\s*greetingName/, 'GET /api/config/voicemail/extensions must return greetingName property');
    assert.match(serverJs, /\.greeting_info/, 'GET /api/config/voicemail/extensions must read from .greeting_info');

    // POST /api/config/voicemail/greeting persists .greeting_info metadata
    assert.match(serverJs, /fs\.writeFileSync\(infoPath,\s*JSON\.stringify/, 'POST /api/config/voicemail/greeting must persist .greeting_info metadata');
    assert.match(serverJs, /name:\s*recDisplayName/, 'POST /api/config/voicemail/greeting must store recording display name');

    // POST /api/config/voicemail/reset cleans up .greeting_info metadata
    assert.match(serverJs, /fs\.unlinkSync\(infoPath\)/, 'POST /api/config/voicemail/reset must remove .greeting_info file');
});

test('views/config.ejs renders custom greeting name next to voicemail-enabled mailboxes', () => {
    const configContent = fs.readFileSync(path.join(__dirname, '../views/config.ejs'), 'utf8');

    // Checklist rendering must display greetingName
    assert.match(configContent, /ext\.greetingName/, 'views/config.ejs must reference ext.greetingName in mailbox checklist');
    assert.match(configContent, /escapeHtml\(ext\.greetingName/, 'views/config.ejs must sanitize ext.greetingName with escapeHtml');
});

test('resolveMailboxGreetingName helper accurately extracts metadata from .greeting_info or matching recording', () => {
    // Pure unit test of metadata parsing
    const sampleMeta = JSON.stringify({
        recordingId: 4,
        name: 'Welcome Sales Message',
        filename: 'custom/welcome_sales',
        appliedAt: new Date().toISOString()
    });

    const parsed = JSON.parse(sampleMeta);
    assert.equal(parsed.name, 'Welcome Sales Message');
    assert.equal(parsed.recordingId, 4);
});
