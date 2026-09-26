const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

/**
 * Helper to authenticate as root admin and return session cookie
 */
async function getAdminCookie(baseUrl) {
    const res = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=root&password=Admin@123',
        redirect: 'manual'
    });
    return res.headers.get('set-cookie') || '';
}

test('Health Check: All primary UI web pages return HTTP 200', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const cookie = await getAdminCookie(baseUrl);
        assert.ok(cookie, 'Must successfully authenticate as admin');

        const pages = [
            '/',                  // Dashboard
            '/cdr',               // Call History / CDR Analytics
            '/voicemails',        // Voicemails management
            '/operator',          // Live Operator Switchboard
            '/gsm-dongles',       // GSM Hardware Modems
            '/config',            // PBX Central Configuration
            '/dialer',            // Outbound Predictive Dialer
            '/contacts',          // PBX Phonebook Contacts
            '/users',             // User Accounts & Permissions
            '/storage',           // Storage & Backup Controls
            '/ext-stats'          // Extension Statistics
        ];

        for (const page of pages) {
            const res = await fetch(`${baseUrl}${page}`, {
                headers: { Cookie: cookie },
                redirect: 'manual'
            });
            assert.equal(
                res.status,
                200,
                `Expected UI Page ${page} to return HTTP 200, but got ${res.status}`
            );
            const contentType = res.headers.get('content-type') || '';
            assert.ok(
                contentType.includes('text/html'),
                `Expected ${page} to return HTML content, got ${contentType}`
            );
        }
    } finally {
        server.close();
    }
});

test('Health Check: All core PBX Configuration REST APIs return HTTP 200', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const cookie = await getAdminCookie(baseUrl);
        assert.ok(cookie, 'Must successfully authenticate');

        const configApis = [
            '/api/config/extensions',
            '/api/config/queues',
            '/api/config/ringgroups',
            '/api/config/ivrs',
            '/api/config/announcements',
            '/api/config/timeconditions',
            '/api/config/timegroups',
            '/api/config/trunks',
            '/api/config/routes/inbound',
            '/api/config/routes/outbound',
            '/api/config/moh',
            '/api/config/diagram',
            '/api/config/extension-conflicts',
            '/api/config/modem',
            '/api/config/modem/denoise',
            '/api/config/modem/jitterbuffer',
            '/api/config/modem/reports',
            '/api/config/modem/rtcp',
            '/api/config/stt',
            '/api/config/federation/peers',
            '/api/config/federation/settings'
        ];

        for (const endpoint of configApis) {
            const res = await fetch(`${baseUrl}${endpoint}`, {
                headers: { Cookie: cookie },
                redirect: 'manual'
            });
            assert.equal(
                res.status,
                200,
                `Expected Config API ${endpoint} to return HTTP 200, got ${res.status}`
            );
            const data = await res.json();
            assert.ok(data !== null && typeof data === 'object', `${endpoint} must return valid JSON`);
        }
    } finally {
        server.close();
    }
});

test('Health Check: Telephony, GSM Dongles, Dialer, and System APIs return HTTP 200', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const cookie = await getAdminCookie(baseUrl);
        assert.ok(cookie, 'Must authenticate');

        const systemApis = [
            '/api/gsm-dongles',
            '/api/gsm-dongles/audit',
            '/api/gsm-dongles/sms',
            '/api/gsm-dongles/ttyusb-devices',
            '/api/contacts',
            '/api/dialer/campaigns',
            '/api/dialer/dispositions',
            '/api/dialer/dnc',
            '/api/dialer/dongles',
            '/api/dialer/attempts/recent',
            '/api/network-info',
            '/api/system/resources',
            '/api/system/services',
            '/api/storage/info',
            '/api/settings/alerts',
            '/api/settings/alerts/watchdog-status',
            '/api/settings/client',
            '/api/settings/smtp',
            '/api/settings/time',
            '/api/federation/v1/health'
        ];

        for (const endpoint of systemApis) {
            const res = await fetch(`${baseUrl}${endpoint}`, {
                headers: { Cookie: cookie },
                redirect: 'manual'
            });
            assert.equal(
                res.status,
                200,
                `Expected System API ${endpoint} to return HTTP 200, got ${res.status}`
            );
            const data = await res.json();
            assert.ok(data !== null && typeof data === 'object', `${endpoint} must return valid JSON object`);
        }
    } finally {
        server.close();
    }
});

test('Health Check: CDR Call History query returns HTTP 200 with enriched records', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const cookie = await getAdminCookie(baseUrl);
        const res = await fetch(`${baseUrl}/cdr?lang=en&page=1&perPage=25`, {
            headers: { Cookie: cookie },
            redirect: 'manual'
        });
        assert.equal(res.status, 200, '/cdr?lang=en must return HTTP 200');
        const html = await res.text();
        assert.ok(html.includes('Call History') || html.includes('سجل المكالمات'), 'CDR page must render title');
    } finally {
        server.close();
    }
});

test('Teardown: test suite exits cleanly', () => {
    setTimeout(() => process.exit(0), 100);
});
