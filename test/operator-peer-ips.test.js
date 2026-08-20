const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const operatorEjsPath = path.join(__dirname, '../views/operator.ejs');

test('server-side peer IP normalization strips ports and protocols cleanly', () => {
    function sanitizePeerIp(ip) {
        const cleanIp = String(ip || '').trim().replace(/^sip:/i, '').split(':')[0].replace(/[^0-9.]/g, '');
        return /^\d+\.\d+\.\d+\.\d+$/.test(cleanIp) ? cleanIp : null;
    }

    assert.equal(sanitizePeerIp('192.168.1.105:5060'), '192.168.1.105');
    assert.equal(sanitizePeerIp('sip:10.0.0.42:5060'), '10.0.0.42');
    assert.equal(sanitizePeerIp('172.16.20.1'), '172.16.20.1');
    assert.equal(sanitizePeerIp('dynamic'), null);
    assert.equal(sanitizePeerIp('-none-'), null);
    assert.equal(sanitizePeerIp(''), null);
    assert.equal(sanitizePeerIp(null), null);
});

test('views/operator.ejs renders visible IP badges on extension cards when IP is present', async () => {
    const html = await ejs.renderFile(operatorEjsPath, {
        currentLang: 'en',
        isRtl: false,
        currentPage: '/operator',
        isSuperAdmin: true,
        user: { username: 'admin' },
        activeCalls: {},
        roster: [
            { extension: '101', name: 'Ahmed Emad', title: 'Tech Lead', emp_group: 'Engineering', online: true, ip: '192.168.1.101', photo: null },
            { extension: '102', name: 'Sara Mohamed', title: 'Support Agent', emp_group: 'Support', online: false, ip: null, photo: null }
        ],
        employeeGroups: ['Engineering', 'Support']
    });

    // Verify presence of employee-ip-badge class and element IDs
    assert.ok(html.includes('id="ipText-101"'), 'Should render ipText-101 element');
    assert.ok(html.includes('id="ipText-102"'), 'Should render ipText-102 element');
    assert.ok(html.includes('192.168.1.101'), 'Should display IP address text for extension 101');
    assert.ok(html.includes('employee-ip-badge'), 'Should apply employee-ip-badge class');

    // Extension with IP should NOT have hidden class on ipText-101
    const ext101Match = html.match(/id="ipText-101"[^>]*class="([^"]*)"/);
    assert.ok(ext101Match, 'Should find class attribute on ipText-101');
    assert.equal(ext101Match[1].split(/\s+/).includes('hidden'), false, 'ipText-101 should not be hidden');

    // Extension without IP SHOULD have hidden class on ipText-102
    const ext102Match = html.match(/id="ipText-102"[^>]*class="([^"]*)"/);
    assert.ok(ext102Match, 'Should find class attribute on ipText-102');
    assert.ok(ext102Match[1].split(/\s+/).includes('hidden'), 'ipText-102 should be hidden initially');
});

test('views/operator.ejs defines complete CSS styling for .employee-ip-badge across all states and themes', () => {
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    assert.ok(content.includes('.employee-ip-badge'), 'Should define .employee-ip-badge CSS class');
    assert.ok(content.includes('.state-offline .employee-ip-badge'), 'Should define offline state IP badge style');
    assert.ok(content.includes('.light-theme #switchboardGrid .panel-surface.state-offline .employee-ip-badge'), 'Should define light theme offline IP badge style');
    assert.ok(content.includes('.state-idle .employee-ip-badge'), 'Should define idle state IP badge style');
    assert.ok(content.includes('.state-ringing .employee-ip-badge'), 'Should define ringing state IP badge style');
    assert.ok(content.includes('.state-incall .employee-ip-badge'), 'Should define in-call state IP badge style');
});

test('views/operator.ejs client script dynamically updates IP text and toggles visibility on peerIPs event', () => {
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    // Assert socket event listener updates ipText element
    assert.ok(content.includes("socket.on('peerIPs'"), 'Should listen to peerIPs Socket.IO event');
    assert.ok(content.includes("document.getElementById('ipText-' + ext)"), 'Should lookup ipText element by extension');
    assert.ok(content.includes("ipText.classList.remove('hidden')"), 'Should unhide IP text badge when IP arrives');
    assert.ok(content.includes("ipText.classList.add('hidden')"), 'Should hide IP text badge when empty');
});
