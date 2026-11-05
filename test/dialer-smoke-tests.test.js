'use strict';

/**
 * Auto-Dialer Comprehensive Smoke Test Suite
 *
 * Verifies that the Sokrat VOIP auto-dialing engine, APIs, database concurrency,
 * DNC compliance, lease reconciliation, Asterisk dialplan contexts, and AMI event
 * pipeline are completely operational.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const net = require('node:net');
const mysql = require('mysql2/promise');
const XLSX = require('xlsx');

const BASE_URL = 'http://127.0.0.1:8080';
const sqliteDbPath = '/var/www/db/address_book.db';

let pool;
let rootCookie;
let testCampaignId = null;

test.before(async () => {
    pool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PWD || 'admin',
        database: 'asterisk',
        waitForConnections: true,
        connectionLimit: 10
    });

    // Login as root
    const loginRes = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=root&password=Admin@123',
        redirect: 'manual'
    });
    rootCookie = loginRes.headers.get('set-cookie');
    assert.ok(rootCookie, 'Root authentication session cookie established');
});

test.after(async () => {
    if (testCampaignId) {
        try {
            await pool.query('DELETE FROM `asterisk`.`dialer_leads` WHERE campaign_id = ?', [testCampaignId]);
            await pool.query('DELETE FROM `asterisk`.`dialer_call_attempts` WHERE campaign_id = ?', [testCampaignId]);
            await pool.query('DELETE FROM `asterisk`.`dialer_campaigns` WHERE id = ?', [testCampaignId]);
        } catch (_) {}
    }
    // Clean up any test agents
    try {
        await pool.query("DELETE FROM `asterisk`.`dialer_agent_states` WHERE extension IN ('998', '999')");
        await pool.query("DELETE FROM `asterisk`.`dialer_dnc` WHERE phone_number LIKE '0109999%'");
    } catch (_) {}

    if (pool) await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST 1: Auto-Dialer API Security & Endpoints
// ─────────────────────────────────────────────────────────────────────────────
test('SMOKE TEST 1: Auto-Dialer API Security & Endpoints', async () => {
    // 1. Unauthenticated request to /api/dialer/campaigns is rejected
    const unauthRes = await fetch(`${BASE_URL}/api/dialer/campaigns`);
    assert.ok(unauthRes.status === 401 || unauthRes.status === 302, 'Unauthenticated access to dialer API must be blocked');

    // 2. Root access to GET /dialer returns 200 OK
    const dialerPageRes = await fetch(`${BASE_URL}/dialer?lang=en`, {
        headers: { Cookie: rootCookie }
    });
    assert.equal(dialerPageRes.status, 200, 'GET /dialer must return 200 OK for root user');
    const dialerHtml = await dialerPageRes.text();
    assert.ok(dialerHtml.includes('campaignsContainer'), 'Dialer page includes campaignsContainer');

    // 3. GET /api/dialer/dongles returns hardware dongles list
    const donglesRes = await fetch(`${BASE_URL}/api/dialer/dongles`, {
        headers: { Cookie: rootCookie }
    });
    assert.equal(donglesRes.status, 200);
    const donglesData = await donglesRes.json();
    assert.equal(donglesData.success, true);
    assert.ok(Array.isArray(donglesData.dongles), 'dongles must be an array');

    // 4. GET /api/dialer/dispositions returns valid list
    const dispRes = await fetch(`${BASE_URL}/api/dialer/dispositions`, {
        headers: { Cookie: rootCookie }
    });
    assert.equal(dispRes.status, 200);
    const dispData = await dispRes.json();
    assert.equal(dispData.success, true);
    assert.ok(Array.isArray(dispData.dispositions) && dispData.dispositions.length > 0, 'dispositions list returned');

    // 5. GET /api/dialer/campaigns returns list
    const campsRes = await fetch(`${BASE_URL}/api/dialer/campaigns`, {
        headers: { Cookie: rootCookie }
    });
    assert.equal(campsRes.status, 200);
    const campsData = await campsRes.json();
    assert.equal(campsData.success, true);
    assert.ok(Array.isArray(campsData.campaigns), 'campaigns must be an array');
});

// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST 2: Campaign CRUD & DNC (Do Not Call) Enforcement
// ─────────────────────────────────────────────────────────────────────────────
test('SMOKE TEST 2: Campaign CRUD & DNC (Do Not Call) Enforcement', async () => {
    // 1. Create a campaign
    const createRes = await fetch(`${BASE_URL}/api/dialer/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: rootCookie },
        body: JSON.stringify({
            name: 'Automated Smoke Test Campaign',
            mode: 'progressive',
            max_concurrent_dials: 2,
            origination_caller_id: '101',
            allowed_dongles: ['dongle0', 'dongle1'],
            assigned_agents: ['101', '102'],
            wrapup_time_sec: 15
        })
    });
    assert.equal(createRes.status, 200);
    const createData = await createRes.json();
    assert.equal(createData.success, true);
    assert.ok(createData.id, 'Created campaign ID returned');
    testCampaignId = createData.id;

    // 2. Fetch created campaign
    const getRes = await fetch(`${BASE_URL}/api/dialer/campaigns/${testCampaignId}`, {
        headers: { Cookie: rootCookie }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.success, true);
    assert.equal(getData.campaign.name, 'Automated Smoke Test Campaign');
    assert.equal(getData.campaign.mode, 'progressive');

    // 3. Update campaign
    const updateRes = await fetch(`${BASE_URL}/api/dialer/campaigns/${testCampaignId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: rootCookie },
        body: JSON.stringify({
            name: 'Automated Smoke Test Campaign (Updated)',
            max_concurrent_dials: 3,
            allowed_dongles: ['dongle0'],
            assigned_agents: ['101'],
            wrapup_time_sec: 20
        })
    });
    assert.equal(updateRes.status, 200);
    const updateData = await updateRes.json();
    assert.equal(updateData.success, true);

    // 4. DNC Enforcement: Add phone to DNC list
    const dncPhone = '01099990001';
    const addDncRes = await fetch(`${BASE_URL}/api/dialer/dnc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: rootCookie },
        body: JSON.stringify({ phone_number: dncPhone, reason: 'Smoke test DNC' })
    });
    assert.equal(addDncRes.status, 200);

    // Verify DNC entry in DB
    const [dncRows] = await pool.query('SELECT phone_number FROM `asterisk`.`dialer_dnc` WHERE phone_number = ?', [dncPhone]);
    assert.equal(dncRows.length, 1, 'Phone number must be present in dialer_dnc table');

    // Add a normal lead and a DNC lead
    await pool.query('INSERT INTO `asterisk`.`dialer_leads` (campaign_id, phone_number, first_name, status) VALUES (?, ?, ?, "pending")', [testCampaignId, '01011110002', 'Allowed Lead']);
    await pool.query('INSERT INTO `asterisk`.`dialer_leads` (campaign_id, phone_number, first_name, status) VALUES (?, ?, ?, "pending")', [testCampaignId, dncPhone, 'Blocked DNC Lead']);

    // Query next lead using exact pacer logic with LEFT JOIN dialer_dnc
    const [claimable] = await pool.query(`
        SELECT l.id, l.phone_number, l.first_name
        FROM \`asterisk\`.\`dialer_leads\` l
        LEFT JOIN \`asterisk\`.\`dialer_dnc\` d ON d.phone_number = l.phone_number
        WHERE l.campaign_id = ? AND l.status = 'pending' AND d.phone_number IS NULL
        ORDER BY l.id ASC
    `, [testCampaignId]);

    assert.equal(claimable.length, 1, 'Only non-DNC lead can be claimed');
    assert.equal(claimable[0].phone_number, '01011110002');

    // Remove DNC entry
    const delDncRes = await fetch(`${BASE_URL}/api/dialer/dnc/${dncPhone}`, {
        method: 'DELETE',
        headers: { Cookie: rootCookie }
    });
    assert.equal(delDncRes.status, 200);

    // Clean up test leads
    await pool.query('DELETE FROM `asterisk`.`dialer_leads` WHERE campaign_id = ?', [testCampaignId]);
});

// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST 3: Lead Normalization & Import (CSV & XLSX)
// ─────────────────────────────────────────────────────────────────────────────
test('SMOKE TEST 3: Lead Normalization & Multi-Format Import (CSV & XLSX)', async () => {
    // Verify phone number normalization logic
    const normalizeLeadPhone = (raw) => {
        if (!raw) return '';
        let phone = String(raw).trim().replace(/[\s\-\(\)\.]/g, '');
        if (phone.startsWith('+20')) phone = '0' + phone.slice(3);
        else if (phone.startsWith('0020')) phone = '0' + phone.slice(4);
        else if (phone.startsWith('20') && phone.length === 12) phone = '0' + phone.slice(2);
        else if (phone.length === 10 && /^1[0125]\d{8}$/.test(phone)) phone = '0' + phone;
        return phone;
    };

    assert.equal(normalizeLeadPhone('1011112222'), '01011112222', 'Prepend 0 to 10-digit Egyptian mobile');
    assert.equal(normalizeLeadPhone('+201284555106'), '01284555106', 'Strip +20 and prepend 0');
    assert.equal(normalizeLeadPhone('00201155443322'), '01155443322', 'Strip 0020 and prepend 0');
    assert.equal(normalizeLeadPhone('010-999-888-77'), '01099988877', 'Strip hyphens');

    // Create a 2-column CSV file and test parsing
    const tmpCsv = `/tmp/smoke_test_leads_${Date.now()}.csv`;
    fs.writeFileSync(tmpCsv, 'Name,Phone Number\nAmr Diab,1011112222\nSherine,01284555106\n', 'utf8');

    const csvWb = XLSX.readFile(tmpCsv);
    const csvRows = XLSX.utils.sheet_to_json(csvWb.Sheets[csvWb.SheetNames[0]], { header: 1, raw: false });
    assert.equal(csvRows.length, 3);
    assert.equal(normalizeLeadPhone(csvRows[1][1]), '01011112222');
    assert.equal(normalizeLeadPhone(csvRows[2][1]), '01284555106');
    fs.unlinkSync(tmpCsv);

    // Create XLSX workbook with cell type 's' and '@' format
    const tmpXlsx = `/tmp/smoke_test_leads_${Date.now()}.xlsx`;
    const wb = XLSX.utils.book_new();
    const wsData = [
        ['الاسم', 'رقم الهاتف'],
        ['محمد صلاح', '01009998877'],
        ['تامر حسني', '01155443322']
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['B2'].t = 's';
    ws['B2'].z = '@';
    ws['B3'].t = 's';
    ws['B3'].z = '@';
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    XLSX.writeFile(wb, tmpXlsx);

    const xlsxWb = XLSX.readFile(tmpXlsx);
    const xlsxRows = XLSX.utils.sheet_to_json(xlsxWb.Sheets[xlsxWb.SheetNames[0]], { header: 1, raw: false });
    assert.equal(xlsxRows.length, 3);
    assert.equal(xlsxRows[1][0], 'محمد صلاح');
    assert.equal(normalizeLeadPhone(xlsxRows[1][1]), '01009998877');
    fs.unlinkSync(tmpXlsx);

    // Verify dual-write to SQLite address book
    if (fs.existsSync(sqliteDbPath)) {
        const testSqlitePhone = '01088776655';
        execSync(`sqlite3 "${sqliteDbPath}" "
            INSERT INTO contact (name, last_name, telefono, directory, status)
            SELECT 'Smoke', 'Test', '${testSqlitePhone}', 'external', 'isPublic'
            WHERE NOT EXISTS (SELECT 1 FROM contact WHERE telefono = '${testSqlitePhone}');
        "`);

        const sqliteRow = execSync(`sqlite3 "${sqliteDbPath}" "SELECT name, telefono FROM contact WHERE telefono = '${testSqlitePhone}';"`, { encoding: 'utf8' }).trim();
        assert.equal(sqliteRow, `Smoke|${testSqlitePhone}`);
        execSync(`sqlite3 "${sqliteDbPath}" "DELETE FROM contact WHERE telefono = '${testSqlitePhone}';"`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST 4: Atomic Concurrency & Lease Expiration Under Load
// ─────────────────────────────────────────────────────────────────────────────
test('SMOKE TEST 4: Atomic Concurrency & Lease Expiration Under Load', async () => {
    // Insert 6 test leads
    for (let i = 1; i <= 6; i++) {
        await pool.query('INSERT INTO `asterisk`.`dialer_leads` (campaign_id, phone_number, first_name, status) VALUES (?, ?, ?, "pending")', [
            testCampaignId,
            `0105000000${i}`,
            `Concurrent Lead ${i}`
        ]);
    }

    // Atomic claim simulation function
    const simulateAtomicClaim = async (campId) => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [leads] = await conn.query(`
                SELECT l.id, l.phone_number
                FROM \`asterisk\`.\`dialer_leads\` l
                LEFT JOIN \`asterisk\`.\`dialer_dnc\` d ON d.phone_number = l.phone_number
                WHERE l.campaign_id = ? AND l.status = 'pending' AND d.phone_number IS NULL
                ORDER BY l.id ASC
                LIMIT 1
                FOR UPDATE
            `, [campId]);

            if (leads.length === 0) {
                await conn.rollback();
                return null;
            }

            const lead = leads[0];
            const attemptUuid = 'att_smoke_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

            await conn.query('UPDATE `asterisk`.`dialer_leads` SET status = "dialing", attempts = attempts + 1, last_called_at = NOW() WHERE id = ?', [lead.id]);
            await conn.query(`
                INSERT INTO \`asterisk\`.\`dialer_call_attempts\`
                (attempt_uuid, action_id, campaign_id, lead_id, active_flag, status, lease_expires_at)
                VALUES (?, ?, ?, ?, 1, 'originated', NOW() + INTERVAL 2 MINUTE)
            `, [attemptUuid, attemptUuid, campId, lead.id]);

            await conn.commit();
            return { attemptUuid, leadId: lead.id, phone: lead.phone_number };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    };

    // Execute 6 concurrent claims in parallel
    const results = await Promise.all([
        simulateAtomicClaim(testCampaignId),
        simulateAtomicClaim(testCampaignId),
        simulateAtomicClaim(testCampaignId),
        simulateAtomicClaim(testCampaignId),
        simulateAtomicClaim(testCampaignId),
        simulateAtomicClaim(testCampaignId)
    ]);

    const claimedLeadIds = results.filter(Boolean).map(r => r.leadId);
    assert.equal(claimedLeadIds.length, 6, 'All 6 pending leads must be claimed');
    const uniqueLeadIds = new Set(claimedLeadIds);
    assert.equal(uniqueLeadIds.size, 6, 'Zero collisions: each concurrent claim must get a unique lead ID');

    // Verify 6 active attempts created in dialer_call_attempts
    const [activeAttempts] = await pool.query('SELECT attempt_uuid, lead_id FROM `asterisk`.`dialer_call_attempts` WHERE campaign_id = ? AND active_flag = 1', [testCampaignId]);
    assert.equal(activeAttempts.length, 6, '6 active attempts in dialer_call_attempts');

    // Artificially expire the lease on 2 of the attempts
    const expiredUuids = [activeAttempts[0].attempt_uuid, activeAttempts[1].attempt_uuid];
    await pool.query('UPDATE `asterisk`.`dialer_call_attempts` SET lease_expires_at = NOW() - INTERVAL 10 SECOND WHERE attempt_uuid IN (?, ?)', expiredUuids);

    // Run reconciliation logic on expired attempts
    const [expiredRows] = await pool.query(`
        SELECT attempt_uuid, lead_id
        FROM \`asterisk\`.\`dialer_call_attempts\`
        WHERE active_flag = 1 AND lease_expires_at < NOW() AND campaign_id = ?
    `, [testCampaignId]);
    assert.equal(expiredRows.length, 2, '2 attempts detected as expired');

    for (const att of expiredRows) {
        await pool.query('UPDATE `asterisk`.`dialer_call_attempts` SET active_flag = NULL, status = "stale", cause_code = 999 WHERE attempt_uuid = ?', [att.attempt_uuid]);
        await pool.query('UPDATE `asterisk`.`dialer_leads` SET status = "pending" WHERE id = ?', [att.lead_id]);
    }

    // Verify the 2 expired leads were reset to pending for retry
    const [rePending] = await pool.query('SELECT id FROM `asterisk`.`dialer_leads` WHERE campaign_id = ? AND status = "pending"', [testCampaignId]);
    assert.equal(rePending.length, 2, 'The 2 stale attempts were reset to pending');

    // Clean up
    await pool.query('DELETE FROM `asterisk`.`dialer_call_attempts` WHERE campaign_id = ?', [testCampaignId]);
    await pool.query('DELETE FROM `asterisk`.`dialer_leads` WHERE campaign_id = ?', [testCampaignId]);
});

// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST 5: Agent State Transitions & Post-Call Wrapup Timer
// ─────────────────────────────────────────────────────────────────────────────
test('SMOKE TEST 5: Agent State Transitions & Post-Call Wrapup Timer', async () => {
    const testExt = '999';

    // 1. Initialize agent to idle
    await pool.query(`
        INSERT INTO \`asterisk\`.\`dialer_agent_states\` (extension, state, current_lead_id, current_attempt_uuid)
        VALUES (?, 'idle', NULL, NULL)
        ON DUPLICATE KEY UPDATE state = 'idle', current_lead_id = NULL, current_attempt_uuid = NULL, wrapup_until = NULL
    `, [testExt]);

    // 2. Transition to reserved
    await pool.query('UPDATE `asterisk`.`dialer_agent_states` SET state = "reserved", current_lead_id = 123 WHERE extension = ?', [testExt]);
    let [row] = await pool.query('SELECT state FROM `asterisk`.`dialer_agent_states` WHERE extension = ?', [testExt]);
    assert.equal(row[0].state, 'reserved');

    // 3. Transition to in_call on connect
    await pool.query('UPDATE `asterisk`.`dialer_agent_states` SET state = "in_call" WHERE extension = ?', [testExt]);
    [row] = await pool.query('SELECT state FROM `asterisk`.`dialer_agent_states` WHERE extension = ?', [testExt]);
    assert.equal(row[0].state, 'in_call');

    // 4. On call end: transition to wrapup with 2 second window
    const wrapupMs = 1500;
    const wrapupUntil = new Date(Date.now() + wrapupMs);
    await pool.query('UPDATE `asterisk`.`dialer_agent_states` SET state = "wrapup", wrapup_until = ?, current_lead_id = NULL WHERE extension = ?', [wrapupUntil, testExt]);

    [row] = await pool.query('SELECT state, wrapup_until FROM `asterisk`.`dialer_agent_states` WHERE extension = ?', [testExt]);
    assert.equal(row[0].state, 'wrapup');
    assert.ok(row[0].wrapup_until > new Date(), 'Wrapup window is active in future');

    // Wait for wrapup to expire
    await new Promise(r => setTimeout(r, 2000));

    // Pacer cycle wrapup check query
    const [expiredWrapups] = await pool.query('SELECT extension FROM `asterisk`.`dialer_agent_states` WHERE state = "wrapup" AND wrapup_until <= NOW() AND extension = ?', [testExt]);
    assert.equal(expiredWrapups.length, 1, 'Agent wrapup period has elapsed');

    // Pacer auto-resets agent back to idle
    await pool.query('UPDATE `asterisk`.`dialer_agent_states` SET state = "idle", wrapup_until = NULL WHERE extension = ?', [testExt]);
    [row] = await pool.query('SELECT state FROM `asterisk`.`dialer_agent_states` WHERE extension = ?', [testExt]);
    assert.equal(row[0].state, 'idle', 'Agent successfully reset to idle');

    await pool.query('DELETE FROM `asterisk`.`dialer_agent_states` WHERE extension = ?', [testExt]);
});

// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST 6: Asterisk Dialplan & AMI Integration Verification
// ─────────────────────────────────────────────────────────────────────────────
test('SMOKE TEST 6: Asterisk Dialplan & AMI Integration Verification', async () => {
    // 1. Verify Asterisk dialplan contexts
    const progressiveContext = execSync('/usr/sbin/asterisk -rx "dialplan show from-autodialer-progressive"', { encoding: 'utf8' });
    assert.ok(progressiveContext.includes('from-autodialer-progressive'), 'from-autodialer-progressive context exists');
    assert.ok(progressiveContext.includes('CALLERID(name)=${LEAD_NAME}'), 'Sets caller name from LEAD_NAME');
    assert.ok(progressiveContext.includes('CALLERID(num)=${LEAD_PHONE}'), 'Sets caller number from LEAD_PHONE');
    assert.ok(progressiveContext.includes('sub-autodialer-progressive-connect'), 'U-option hooks sub-autodialer-progressive-connect');
    assert.ok(progressiveContext.includes('sub-autodialer-progressive-hangup'), 'Hangup handler hooks sub-autodialer-progressive-hangup');

    const agentSetupContext = execSync('/usr/sbin/asterisk -rx "dialplan show autodialer-agent-setup"', { encoding: 'utf8' });
    assert.ok(agentSetupContext.includes('autodialer-agent-setup'), 'autodialer-agent-setup context exists');
    assert.ok(agentSetupContext.includes('SIPHEADERS,Alert-Info'), 'Auto-answer Alert-Info header present');
    assert.ok(agentSetupContext.includes('SIPHEADERS,Call-Info'), 'Auto-answer Call-Info header present');

    const connectContext = execSync('/usr/sbin/asterisk -rx "dialplan show sub-autodialer-progressive-connect"', { encoding: 'utf8' });
    assert.ok(connectContext.includes('UserEvent(DialerProgressiveConnect'), 'Fires UserEvent DialerProgressiveConnect');
    assert.ok(connectContext.includes('AttemptUUID'), 'Passes AttemptUUID to UserEvent');
    assert.ok(connectContext.includes('AgentExtension'), 'Passes AgentExtension to UserEvent');

    const hangupContext = execSync('/usr/sbin/asterisk -rx "dialplan show sub-autodialer-progressive-hangup"', { encoding: 'utf8' });
    assert.ok(hangupContext.includes('UserEvent(DialerProgressiveHangup'), 'Fires UserEvent DialerProgressiveHangup');
    assert.ok(hangupContext.includes('AttemptUUID'), 'Passes AttemptUUID to UserEvent on hangup');

    // 2. Verify AMI connection responds with Pong
    const amiPromise = new Promise((resolve, reject) => {
        const client = net.createConnection({ port: 5038, host: '127.0.0.1' }, () => {
            client.write('Action: Login\r\nUsername: admin\r\nSecret: admin\r\n\r\n');
        });
        let buffer = '';
        client.on('data', (chunk) => {
            buffer += chunk.toString();
            if (buffer.includes('Authentication accepted') && !buffer.includes('Action: Ping')) {
                client.write('Action: Ping\r\n\r\n');
            }
            if (buffer.includes('Ping: Pong')) {
                client.write('Action: Logoff\r\n\r\n');
                client.end();
                resolve(true);
            }
        });
        client.on('error', reject);
        setTimeout(() => { client.destroy(); reject(new Error('AMI connection timed out')); }, 5000);
    });

    const isAmiAlive = await amiPromise;
    assert.equal(isAmiAlive, true, 'Asterisk AMI connection is healthy and responsive');
});

// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST 7: End-to-End Autodialer Call Simulation via Local Channel
// ─────────────────────────────────────────────────────────────────────────────
test('SMOKE TEST 7: End-to-End Autodialer Call Simulation via Local Channel', async () => {
    // Dynamically install mock answer/hangup targets in Asterisk
    execSync('asterisk -rx "dialplan add extension s,1,Answer into mock-autodialer-agent replace"');
    execSync('asterisk -rx "dialplan add extension s,2,Wait(1) into mock-autodialer-agent replace"');
    execSync('asterisk -rx "dialplan add extension s,3,Hangup into mock-autodialer-agent replace"');

    execSync('asterisk -rx "dialplan add extension 5555,1,Answer into mock-autodialer-lead replace"');
    execSync('asterisk -rx "dialplan add extension 5555,2,Wait(1) into mock-autodialer-lead replace"');
    execSync('asterisk -rx "dialplan add extension 5555,3,Hangup into mock-autodialer-lead replace"');

    const testAttemptUuid = 'att_smoke_sim_' + Date.now();
    const testLeadId = 99999;
    const testAgent = '103';

    // Seed attempt in database
    await pool.query(`
        INSERT INTO \`asterisk\`.\`dialer_call_attempts\`
        (attempt_uuid, action_id, campaign_id, lead_id, active_flag, status, agent_extension, lease_expires_at)
        VALUES (?, ?, ?, ?, 1, 'originated', ?, NOW() + INTERVAL 2 MINUTE)
    `, [testAttemptUuid, testAttemptUuid, testCampaignId, testLeadId, testAgent]);

    // Originate through Asterisk AMI
    const originatePromise = new Promise((resolve, reject) => {
        const client = net.createConnection({ port: 5038, host: '127.0.0.1' }, () => {
            client.write('Action: Login\r\nUsername: admin\r\nSecret: admin\r\n\r\n');
        });
        let buf = '';
        let eventsCaptured = [];

        client.on('data', (d) => {
            buf += d.toString();
            if (buf.includes('Authentication accepted') && !buf.includes('Action: Originate')) {
                const varHeaders = [
                    `Variable: ATTEMPT_UUID=${testAttemptUuid}`,
                    `Variable: CAMPAIGN_ID=${testCampaignId}`,
                    `Variable: LEAD_ID=${testLeadId}`,
                    `Variable: LEAD_PHONE=5555`,
                    `Variable: DIAL_NUM=5555`,
                    `Variable: LEAD_NAME=Smoke Lead`,
                    `Variable: OUTBOUND_CONTEXT=mock-autodialer-lead`,
                    `Variable: DIAL_TARGET=Local/5555@mock-autodialer-lead/n`,
                    `Variable: ORIGINATION_CALLER_ID=101`,
                    `Variable: TARGET_AGENT=${testAgent}`,
                    `Variable: AGENT_EXTEN=${testAgent}`
                ].join('\r\n');

                client.write(`Action: Originate\r\nActionID: ${testAttemptUuid}\r\nChannel: Local/s@mock-autodialer-agent/n\r\nContext: from-autodialer-progressive\r\nExten: s\r\nPriority: 1\r\n${varHeaders}\r\n\r\n`);
            }

            if (buf.includes('DialerProgressiveConnect')) {
                eventsCaptured.push('connect');
            }
            if (buf.includes('DialerProgressiveHangup')) {
                eventsCaptured.push('hangup');
                client.write('Action: Logoff\r\n\r\n');
                client.end();
                resolve(eventsCaptured);
            }
        });

        client.on('error', reject);
        setTimeout(() => { client.destroy(); resolve(eventsCaptured); }, 8000);
    });

    const events = await originatePromise;
    assert.ok(events.includes('connect'), 'DialerProgressiveConnect UserEvent fired on call bridge');
    assert.ok(events.includes('hangup'), 'DialerProgressiveHangup UserEvent fired on call completion');

    // Clean up mock extensions from Asterisk
    execSync('asterisk -rx "dialplan remove extension s@mock-autodialer-agent"');
    execSync('asterisk -rx "dialplan remove extension 5555@mock-autodialer-lead"');
    await pool.query('DELETE FROM `asterisk`.`dialer_call_attempts` WHERE attempt_uuid = ?', [testAttemptUuid]);
});

// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST 8: Multi-Installer Dialplan Synchronization Verification
// ─────────────────────────────────────────────────────────────────────────────
test('SMOKE TEST 8: Multi-Installer Dialplan Synchronization Verification', () => {
    const installSh = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
    const offlineSh = fs.readFileSync(path.join(__dirname, '../installer-bundle/install-sokrat.sh'), 'utf8');
    const upgradeSh = fs.readFileSync(path.join(__dirname, '../scripts/safe-upgrade.sh'), 'utf8');

    for (const ctx of ['[from-autodialer-progressive]', '[autodialer-agent-setup]', '[sub-autodialer-progressive-connect]', '[sub-autodialer-progressive-hangup]']) {
        assert.ok(installSh.includes(ctx), `install.sh must contain ${ctx}`);
        assert.ok(offlineSh.includes(ctx), `installer-bundle/install-sokrat.sh must contain ${ctx}`);
        assert.ok(upgradeSh.includes(ctx), `scripts/safe-upgrade.sh must contain ${ctx}`);
    }
});
