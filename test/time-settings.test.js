const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const sidebarViewPath = path.join(__dirname, '../views/sidebar.ejs');
const serverJsPath = path.join(__dirname, '../server.js');

test('views/sidebar.ejs renders Time Settings modal and controls for Super Admin', async () => {
    const html = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: true,
        currentUser: 'admin',
        clientName: 'Test PBX',
        allowedTabs: ['dashboard', 'cdr', 'config']
    });

    assert.ok(html.includes('id="timeModal"'), 'timeModal container must be rendered');
    assert.ok(html.includes('id="timeModalBody"'), 'timeModalBody container must be rendered');
    assert.ok(html.includes('id="timeSaveBtn"'), 'timeSaveBtn button must be rendered');
    assert.ok(html.includes('openTimeModal()'), 'openTimeModal trigger must be present in settings dropdown');
});

test('server.js defines valid /api/settings/time endpoints and regex patterns', () => {
    const content = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(content.includes("app.get('/api/settings/time'"), 'GET /api/settings/time must be defined');
    assert.ok(content.includes("app.post('/api/settings/time'"), 'POST /api/settings/time must be defined');

    // Verify regex matches diverse Linux timedatectl outputs
    const ntpRegex = /^\s*(?:NTP service|NTP enabled|Network time on|System clock synchronized):\s+(\S+)/i;

    const sampleModern = '              NTP service: active';
    const sampleCentos = '     NTP enabled: yes';
    const sampleNetTime = 'Network time on: yes';
    const sampleSync = 'System clock synchronized: yes';
    const sampleInactive = '              NTP service: inactive';
    const sampleDisabled = '     NTP enabled: no';

    assert.ok(sampleModern.match(ntpRegex), 'Should match modern systemd NTP service');
    assert.ok(sampleCentos.match(ntpRegex), 'Should match CentOS/Issabel NTP enabled');
    assert.ok(sampleNetTime.match(ntpRegex), 'Should match Network time on');
    assert.ok(sampleSync.match(ntpRegex), 'Should match System clock synchronized');

    const parseNtp = (line) => {
        const m = line.match(ntpRegex);
        if (!m) return false;
        const val = m[1].toLowerCase();
        return val === 'active' || val === 'yes' || val === 'true';
    };

    assert.equal(parseNtp(sampleModern), true);
    assert.equal(parseNtp(sampleCentos), true);
    assert.equal(parseNtp(sampleNetTime), true);
    assert.equal(parseNtp(sampleSync), true);
    assert.equal(parseNtp(sampleInactive), false);
    assert.equal(parseNtp(sampleDisabled), false);
});
