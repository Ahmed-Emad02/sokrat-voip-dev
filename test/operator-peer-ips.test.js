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

test('views/operator.ejs renders extension cards without peer IP badges', async () => {
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

    assert.equal(html.includes('id="ipText-'), false, 'Should not render any IP badge elements');
    const card101 = html.match(/<article id="card-101"[\s\S]*?<\/article>/);
    assert.ok(card101, 'Should still render extension 101 card');
    assert.equal(card101[0].includes('192.168.1.101'), false, 'Should not display the peer IP address on the card');
    assert.ok(html.includes('id="card-102"'), 'Should still render extension 102 card');
    assert.ok(html.includes('employee-ip-badge'), 'Agent-status badge styling should remain available');
});

test('views/operator.ejs keeps agent-status badge styling but has no IP-specific selectors', () => {
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    assert.ok(content.includes('.employee-ip-badge'), 'Should keep the shared badge CSS class for agent status');
    assert.ok(content.includes('.state-idle .employee-ip-badge'), 'Should keep state-aware status badge styling');
    assert.equal(content.includes('[id^="ipText-"]'), false, 'Should not define IP-specific selectors');
});

test('views/operator.ejs client script no longer listens to peerIPs or updates IP text', () => {
    const content = fs.readFileSync(operatorEjsPath, 'utf8');

    assert.equal(content.includes("socket.on('peerIPs'"), false, 'Should not listen to the peerIPs event');
    assert.equal(content.includes("getElementById('ipText-' + ext)"), false, 'Should not look up IP badge elements');
    assert.equal(content.includes('ipText.classList'), false, 'Should not toggle IP badge visibility');
});
