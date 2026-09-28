const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const moment = require('moment');

const BASE_URL = 'http://127.0.0.1:8080';

const DUMMY_USER = 'dummy_filter_test_user';
const DUMMY_PASS = 'FilterPass123!';

let pool = null;

test.before(async () => {
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || 'admin',
        database: 'asterisk'
    });

    // Clean up any stale records
    await pool.query('DELETE FROM dashboard_user_preferences WHERE username = ?', [DUMMY_USER]);
    await pool.query('DELETE FROM dashboard_users WHERE username = ?', [DUMMY_USER]);

    // Fetch or create super admins group
    const [groups] = await pool.query("SELECT id FROM dashboard_groups WHERE name = 'super admins' LIMIT 1");
    const groupId = groups.length > 0 ? groups[0].id : 1;

    // Create dummy user
    const hash = await bcrypt.hash(DUMMY_PASS, 10);
    await pool.query(
        'INSERT INTO dashboard_users (username, password_hash, group_id, extension) VALUES (?, ?, ?, ?)',
        [DUMMY_USER, hash, groupId, '101,102']
    );
});

test.after(async () => {
    if (pool) {
        await pool.query('DELETE FROM dashboard_user_preferences WHERE username = ?', [DUMMY_USER]);
        await pool.query('DELETE FROM dashboard_users WHERE username = ?', [DUMMY_USER]);
        await pool.end();
    }
});

async function loginUser(username, password) {
    const res = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&lang=en`,
        redirect: 'manual'
    });
    assert.equal(res.status, 302, 'Login should redirect on success');
    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie, 'Login must set session cookie');
    return cookie;
}

test('1. Fresh dummy user GET /api/user/default-filters returns default fallback configuration', async () => {
    const cookie = await loginUser(DUMMY_USER, DUMMY_PASS);

    const res = await fetch(`${BASE_URL}/api/user/default-filters`, {
        headers: { Cookie: cookie, Accept: 'application/json' }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.filters.dashboard.datePreset, 'today');
    assert.equal(data.filters.cdr.datePreset, 'today');
    assert.equal(data.filters.cdr.perPage, 25);
});

test('2. Dummy user saves custom default filters and verifies persistence via GET', async () => {
    const cookie = await loginUser(DUMMY_USER, DUMMY_PASS);

    const customFilters = {
        dashboard: {
            datePreset: 'yesterday',
            targetExtension: ['101'],
            statusFilter: ['ANSWERED'],
            directionFilter: 'INBOUND',
            callScopeFilter: 'EXTERNAL'
        },
        cdr: {
            datePreset: 'yesterday',
            targetExtension: ['102'],
            statusFilter: ['NO ANSWER'],
            directionFilter: 'OUTBOUND',
            callScopeFilter: 'INTERNAL',
            perPage: 50
        }
    };

    const saveRes = await fetch(`${BASE_URL}/api/user/default-filters`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(customFilters)
    });
    assert.equal(saveRes.status, 200);
    const saveData = await saveRes.json();
    assert.equal(saveData.success, true);

    // Verify GET returns updated filters
    const getRes = await fetch(`${BASE_URL}/api/user/default-filters`, {
        headers: { Cookie: cookie, Accept: 'application/json' }
    });
    const getData = await getRes.json();
    assert.equal(getData.success, true);
    assert.deepEqual(getData.filters.dashboard, customFilters.dashboard);
    assert.deepEqual(getData.filters.cdr, customFilters.cdr);
});

test('3. Dummy user logs in fresh and landing pages automatically load saved default filters', async () => {
    // Perform clean login
    const cookie = await loginUser(DUMMY_USER, DUMMY_PASS);

    // 1. Visit Dashboard (/) without query parameters
    const dashRes = await fetch(`${BASE_URL}/`, {
        headers: { Cookie: cookie }
    });
    assert.equal(dashRes.status, 200, 'Dashboard must return 200 on landing');
    const dashHtml = await dashRes.text();

    const expectedYesterdayStart = moment().subtract(1, 'day').startOf('day').format('YYYY-MM-DDTHH:mm');
    const expectedYesterdayEnd = moment().subtract(1, 'day').endOf('day').format('YYYY-MM-DDTHH:mm');

    // Verify date range inputs use yesterday preset
    assert.ok(dashHtml.includes(`id="dashStartDate"`), 'Dashboard must render dashStartDate input');
    assert.ok(dashHtml.includes(expectedYesterdayStart), `Dashboard must use yesterday start: ${expectedYesterdayStart}`);
    assert.ok(dashHtml.includes(expectedYesterdayEnd), `Dashboard must use yesterday end: ${expectedYesterdayEnd}`);

    // Verify directionFilter 'INBOUND' is selected
    assert.ok(
        dashHtml.includes('value="INBOUND" selected') || dashHtml.includes('selected value="INBOUND"') || dashHtml.includes('<option value="INBOUND" selected'),
        'Dashboard directionFilter must be INBOUND'
    );

    // Verify callScopeFilter 'EXTERNAL' is selected
    assert.ok(
        dashHtml.includes('<option value="EXTERNAL" selected'),
        'Dashboard callScopeFilter must be EXTERNAL'
    );

    // 2. Visit Call History (/cdr) without query parameters
    const cdrRes = await fetch(`${BASE_URL}/cdr`, {
        headers: { Cookie: cookie }
    });
    assert.equal(cdrRes.status, 200, 'CDR must return 200 on landing');
    const cdrHtml = await cdrRes.text();

    // Verify CDR date range inputs use yesterday preset
    assert.ok(cdrHtml.includes(`id="cdrStartDate"`), 'CDR must render cdrStartDate input');
    assert.ok(cdrHtml.includes(expectedYesterdayStart), `CDR must use yesterday start: ${expectedYesterdayStart}`);
    assert.ok(cdrHtml.includes(expectedYesterdayEnd), `CDR must use yesterday end: ${expectedYesterdayEnd}`);

    // Verify directionFilter 'OUTBOUND' is selected
    assert.ok(
        cdrHtml.includes('<option value="OUTBOUND" selected'),
        'CDR directionFilter must be OUTBOUND'
    );

    // Verify callScopeFilter 'INTERNAL' is selected
    assert.ok(
        cdrHtml.includes('<option value="INTERNAL" selected'),
        'CDR callScopeFilter must be INTERNAL'
    );

    // Verify perPage is 50
    assert.ok(
        cdrHtml.includes('name="perPage" value="50"') || cdrHtml.includes("currentPerPage = '50'"),
        'CDR perPage must be 50'
    );
});

test('4. Test all date presets (this_week, last_7_days, this_month, last_30_days)', async () => {
    const cookie = await loginUser(DUMMY_USER, DUMMY_PASS);

    const presets = [
        {
            preset: 'this_week',
            start: moment().startOf('week').format('YYYY-MM-DDTHH:mm'),
            end: moment().endOf('week').format('YYYY-MM-DDTHH:mm')
        },
        {
            preset: 'last_7_days',
            start: moment().subtract(7, 'days').startOf('day').format('YYYY-MM-DDTHH:mm'),
            end: moment().endOf('day').format('YYYY-MM-DDTHH:mm')
        },
        {
            preset: 'this_month',
            start: moment().startOf('month').format('YYYY-MM-DDTHH:mm'),
            end: moment().endOf('month').format('YYYY-MM-DDTHH:mm')
        },
        {
            preset: 'last_30_days',
            start: moment().subtract(30, 'days').startOf('day').format('YYYY-MM-DDTHH:mm'),
            end: moment().endOf('day').format('YYYY-MM-DDTHH:mm')
        }
    ];

    for (const p of presets) {
        // Update default filters
        const updateRes = await fetch(`${BASE_URL}/api/user/default-filters`, {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                dashboard: {
                    datePreset: p.preset,
                    targetExtension: ['ALL'],
                    statusFilter: ['ALL'],
                    directionFilter: 'ALL',
                    callScopeFilter: 'ALL'
                },
                cdr: {
                    datePreset: p.preset,
                    targetExtension: ['ALL'],
                    statusFilter: ['ALL'],
                    directionFilter: 'ALL',
                    callScopeFilter: 'ALL',
                    perPage: 100
                }
            })
        });
        assert.equal(updateRes.status, 200);

        // Fetch Dashboard with new defaults applied
        const dashRes = await fetch(`${BASE_URL}/`, { headers: { Cookie: cookie } });
        const dashHtml = await dashRes.text();
        assert.ok(dashHtml.includes(p.start), `Dashboard must reflect ${p.preset} start: ${p.start}`);
        assert.ok(dashHtml.includes(p.end), `Dashboard must reflect ${p.preset} end: ${p.end}`);

        // Fetch CDR with new defaults applied
        const cdrRes = await fetch(`${BASE_URL}/cdr`, { headers: { Cookie: cookie } });
        const cdrHtml = await cdrRes.text();
        assert.ok(cdrHtml.includes(p.start), `CDR must reflect ${p.preset} start: ${p.start}`);
        assert.ok(cdrHtml.includes(p.end), `CDR must reflect ${p.preset} end: ${p.end}`);
        assert.ok(cdrHtml.includes("currentPerPage = '100'") || cdrHtml.includes('name="perPage" value="100"'), `CDR must reflect perPage 100`);
    }
});

test('5. Explicit query parameters properly override user default filters', async () => {
    const cookie = await loginUser(DUMMY_USER, DUMMY_PASS);

    // Even though defaults are set, explicit query params take precedence
    const overrideUrl = `${BASE_URL}/cdr?directionFilter=INBOUND&callScopeFilter=EXTERNAL&perPage=10`;
    const res = await fetch(overrideUrl, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('<option value="INBOUND" selected'), 'Explicit INBOUND must override');
    assert.ok(html.includes('<option value="EXTERNAL" selected'), 'Explicit EXTERNAL must override');
    assert.ok(html.includes("currentPerPage = '10'") || html.includes('name="perPage" value="10"'), 'Explicit perPage 10 must override');
});
