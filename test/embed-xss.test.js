const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('path');
const { safeJsonSerialize } = require('../lib/integration-auth');

test('safeJsonSerialize escapes script breakout tags safely', () => {
    const payload = '</script><script>globalThis.pwned=true</script>';
    const serialized = safeJsonSerialize(payload);

    assert.equal(serialized.includes('</script>'), false);
    assert.equal(serialized.includes('<script>'), false);
    assert.ok(serialized.includes('\\u003c/script\\u003e'));

    // Verify it parses cleanly back to original string in JS
    const parsed = JSON.parse(serialized);
    assert.equal(parsed, payload);
});

test('embed-live.ejs template prevents XSS script breakout on crm_user_name and sessionToken', async () => {
    const payload = '</script><script>globalThis.pwned=true</script>';
    const templatePath = path.join(__dirname, '../views/embed-live.ejs');

    const html = await ejs.renderFile(templatePath, {
        currentLang: 'en',
        sessionToken: payload,
        session: {
            crm_user_name: payload,
            supervisor_extension: '101',
            scopes: ['live:read', 'live:listen']
        },
        safeJsonSerialize
    });

    assert.equal(html.includes('</script><script>globalThis.pwned=true</script>'), false);
    assert.ok(html.includes('\\u003c/script\\u003e\\u003cscript\\u003eglobalThis.pwned=true\\u003c/script\\u003e'));
});
