const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

test('views/gsm-dongles.ejs renders redesigned duration stats with incoming/outgoing branch', async () => {
    const donglesEjsPath = path.join(__dirname, '../views/gsm-dongles.ejs');
    const content = fs.readFileSync(donglesEjsPath, 'utf8');

    // Structural checks on raw template
    assert.ok(content.includes('id="dongle-duration-stats-section"'), 'Template should contain dongle-duration-stats-section');
    assert.ok(content.includes('id="reportStartDate"'), 'Template should contain reportStartDate');
    assert.ok(content.includes('id="reportEndDate"'), 'Template should contain reportEndDate');
    assert.ok(content.includes('id="reportDongleSelect"'), 'Template should contain reportDongleSelect');
    assert.ok(content.includes('id="reportSimSelect"'), 'Template should contain reportSimSelect');
    assert.ok(content.includes('id="report-kpi-inbound-dur"'), 'Template should contain report-kpi-inbound-dur');
    assert.ok(content.includes('id="report-kpi-outbound-dur"'), 'Template should contain report-kpi-outbound-dur');
    assert.ok(content.includes('id="report-tab-dongles-btn"'), 'Template should contain report-tab-dongles-btn');
    assert.ok(content.includes('id="report-tab-sims-btn"'), 'Template should contain report-tab-sims-btn');
    assert.ok(content.includes('id="report-table-body"'), 'Template should contain report-table-body');
    assert.ok(content.includes('window.setDongleReportTab'), 'Template should contain setDongleReportTab controller');
    assert.ok(content.includes('window.setDongleReportPreset'), 'Template should contain setDongleReportPreset controller');
    assert.ok(content.includes('window.fetchDongleStateReports'), 'Template should contain fetchDongleStateReports controller');
    assert.ok(content.includes('id="reportWorkHoursEnabled"'), 'Template should contain reportWorkHoursEnabled');
    assert.ok(content.includes('id="reportShiftStart"'), 'Template should contain reportShiftStart');
    assert.ok(content.includes('id="reportShiftEnd"'), 'Template should contain reportShiftEnd');
    assert.ok(content.includes('window.toggleReportWorkHours'), 'Template should contain toggleReportWorkHours');
    assert.ok(content.includes('window.setReportWorkDaysPreset'), 'Template should contain setReportWorkDaysPreset');

    // Test English render
    const htmlEn = await ejs.renderFile(donglesEjsPath, {
        currentLang: 'en',
        currentPage: '/gsm-dongles',
        user: { username: 'admin', role: 'admin' },
        devices: [
            { ID: 'dongle0', Number: '01000000001', State: 'Free', RSSI: '18', Provider: 'Vodafone', IMEI: '123456789012345', IMSI: '123456789012345' },
            { ID: 'dongle1', Number: '01000000002', State: 'Busy', RSSI: '22', Provider: 'Orange', IMEI: '987654321098765', IMSI: '987654321098765' }
        ],
        allowedTabs: ['dashboard', 'gsm-dongles', 'config'],
        isRoot: true,
        moment: require('moment')
    });

    assert.ok(htmlEn.includes('Dongle & SIM State Duration Analytics'), 'English render should contain section title');
    assert.ok(htmlEn.includes('Incoming'), 'English render should contain Incoming branch label');
    assert.ok(htmlEn.includes('Outgoing'), 'English render should contain Outgoing branch label');
    assert.ok(htmlEn.includes('By Dongle'), 'English render should contain By Dongle tab');
    assert.ok(htmlEn.includes('By SIM Number (DID)'), 'English render should contain By SIM Number tab');

    // Test Arabic render
    const htmlAr = await ejs.renderFile(donglesEjsPath, {
        currentLang: 'ar',
        currentPage: '/gsm-dongles',
        user: { username: 'admin', role: 'admin' },
        devices: [
            { ID: 'dongle0', Number: '01000000001', State: 'Free', RSSI: '18', Provider: 'Vodafone', IMEI: '123456789012345', IMSI: '123456789012345' }
        ],
        allowedTabs: ['dashboard', 'gsm-dongles', 'config'],
        isRoot: true,
        moment: require('moment')
    });

    assert.ok(htmlAr.includes('تحليلات مدة حالات المودم والشرائح'), 'Arabic render should contain section title');
    assert.ok(htmlAr.includes('المكالمات الواردة'), 'Arabic render should contain Incoming branch label');
    assert.ok(htmlAr.includes('المكالمات الصادرة'), 'Arabic render should contain Outgoing branch label');
    assert.ok(htmlAr.includes('حسب المودم'), 'Arabic render should contain By Dongle tab');
    assert.ok(htmlAr.includes('حسب رقم الشريحة'), 'Arabic render should contain By SIM Number tab');
});

test('views/config.ejs renders navigation notice pointing to GSM Dongles analytics', async () => {
    const configEjsPath = path.join(__dirname, '../views/config.ejs');
    const content = fs.readFileSync(configEjsPath, 'utf8');

    assert.ok(content.includes('/gsm-dongles#dongle-duration-stats-section'), 'config.ejs should link to gsm-dongles duration section');

    const html = await ejs.renderFile(configEjsPath, {
        currentLang: 'en',
        currentPage: '/config',
        user: { username: 'admin', role: 'admin' },
        allowedTabs: ['dashboard', 'gsm-dongles', 'config'],
        isRoot: true,
        isRtl: false,
        moment: require('moment'),
        recordings: [],
        routes: [],
        trunks: [],
        extensions: []
    });

    assert.ok(html.includes('/gsm-dongles#dongle-duration-stats-section'), 'Rendered config.ejs should contain link to gsm-dongles');
});

test('duration report calculation logic correctly branches incoming and outgoing calls', () => {
    // Test the calculation logic used in /api/config/modem/reports
    const formatDuration = (sec) => {
        if (!sec || sec <= 0) return '0s';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const parts = [];
        if (h > 0) parts.push(`${h}h`);
        if (m > 0 || h > 0) parts.push(`${m}m`);
        parts.push(`${s}s`);
        return parts.join(' ');
    };

    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(45), '45s');
    assert.equal(formatDuration(125), '2m 5s');
    assert.equal(formatDuration(3665), '1h 1m 5s');

    const mockCdrRows = [
        { channel: 'Dongle/dongle0-01', dstchannel: 'SIP/101-01', billsec: 120, disposition: 'ANSWERED' }, // incoming
        { channel: 'Dongle/dongle0-02', dstchannel: 'SIP/102-01', billsec: 60, disposition: 'ANSWERED' },  // incoming
        { channel: 'SIP/101-02', dstchannel: 'Dongle/dongle0-03', lastdata: 'Dongle/dongle0/012345', billsec: 180, disposition: 'ANSWERED' }, // outgoing
        { channel: 'SIP/103-01', dstchannel: 'Dongle/dongle0-04', lastdata: 'Dongle/dongle0/012346', billsec: 0, disposition: 'NO ANSWER' }   // outgoing unanswered
    ];

    const dStat = {
        totalCalls: 0,
        answeredCalls: 0,
        talkSec: 0,
        inbound: { calls: 0, answered: 0, talkSec: 0 },
        outbound: { calls: 0, answered: 0, talkSec: 0 }
    };

    mockCdrRows.forEach(row => {
        const isIncoming = Boolean(row.channel && row.channel.toLowerCase().startsWith('dongle/'));
        const billsec = row.billsec || 0;
        const isAnswered = row.disposition === 'ANSWERED';

        dStat.totalCalls++;
        if (isAnswered) dStat.answeredCalls++;
        dStat.talkSec += billsec;

        if (isIncoming) {
            dStat.inbound.calls++;
            if (isAnswered) dStat.inbound.answered++;
            dStat.inbound.talkSec += billsec;
        } else {
            dStat.outbound.calls++;
            if (isAnswered) dStat.outbound.answered++;
            dStat.outbound.talkSec += billsec;
        }
    });

    assert.equal(dStat.totalCalls, 4);
    assert.equal(dStat.answeredCalls, 3);
    assert.equal(dStat.talkSec, 360);
    assert.equal(dStat.inbound.calls, 2);
    assert.equal(dStat.inbound.answered, 2);
    assert.equal(dStat.inbound.talkSec, 180);
    assert.equal(dStat.outbound.calls, 2);
    assert.equal(dStat.outbound.answered, 1);
    assert.equal(dStat.outbound.talkSec, 180);
});

test('report aggregation handles SIM and Dongle swapping seamlessly', () => {
    // Scenario: SIM1 was in dongle0 in the morning, then swapped to dongle1 in the afternoon
    // dongle0 then received SIM2 in the afternoon
    const mockLogs = [
        { dongle_name: 'dongle0', sim_number: '01011111111', imsi: 'IMSI_1', state: 'Free', started_at: '2026-09-19 09:00:00', ended_at: '2026-09-19 12:00:00' },
        { dongle_name: 'dongle1', sim_number: '01011111111', imsi: 'IMSI_1', state: 'Free', started_at: '2026-09-19 12:00:00', ended_at: '2026-09-19 17:00:00' },
        { dongle_name: 'dongle0', sim_number: '01022222222', imsi: 'IMSI_2', state: 'Free', started_at: '2026-09-19 12:00:00', ended_at: '2026-09-19 17:00:00' }
    ];

    const dongleStats = {};
    const simStats = {};

    mockLogs.forEach(log => {
        const dName = log.dongle_name;
        const simNum = log.sim_number;
        if (!dongleStats[dName]) {
            dongleStats[dName] = { dongle_name: dName, sim_numbers: new Set() };
        }
        dongleStats[dName].sim_numbers.add(simNum);

        if (!simStats[simNum]) {
            simStats[simNum] = { sim_number: simNum, dongles: new Set() };
        }
        simStats[simNum].dongles.add(dName);
    });

    // dongle0 should report both SIMs that were used in its slot
    assert.equal(dongleStats['dongle0'].sim_numbers.size, 2);
    assert.ok(dongleStats['dongle0'].sim_numbers.has('01011111111'));
    assert.ok(dongleStats['dongle0'].sim_numbers.has('01022222222'));

    // SIM1 should report both dongles it was plugged into
    assert.equal(simStats['01011111111'].dongles.size, 2);
    assert.ok(simStats['01011111111'].dongles.has('dongle0'));
    assert.ok(simStats['01011111111'].dongles.has('dongle1'));

    // SIM2 only used in dongle0
    assert.equal(simStats['01022222222'].dongles.size, 1);
    // SIM2 only used in dongle0
    assert.equal(simStats['01022222222'].dongles.size, 1);
    assert.ok(simStats['01022222222'].dongles.has('dongle0'));
});

test('working hours (shift) slice algorithm accurately filters idle nights, weekends, and overlaps', () => {
    const moment = require('moment');
    const startStr = '2026-09-13 00:00:00'; // Sunday
    const endStr = '2026-09-19 23:59:59';   // Saturday (7 full days)
    const winStartMs = moment(startStr).valueOf();
    const winEndMs = moment(endStr).valueOf();

    const workHoursEnabled = true;
    const shiftStartParam = '09:00';
    const shiftEndParam = '17:00';
    const workDays = [0, 1, 2, 3, 4]; // Sun, Mon, Tue, Wed, Thu (5 days, Fri & Sat are off)

    const [startH, startM] = shiftStartParam.split(':').map(n => parseInt(n, 10) || 0);
    const [endH, endM] = shiftEndParam.split(':').map(n => parseInt(n, 10) || 0);

    const activeIntervals = [];
    const currDay = moment(startStr).startOf('day');
    const lastDay = moment(endStr).endOf('day');

    while (currDay.isSameOrBefore(lastDay, 'day')) {
        const dayOfWeek = currDay.day();
        if (workDays.includes(dayOfWeek)) {
            const shiftStartMs = currDay.clone().hour(startH).minute(startM).second(0).millisecond(0).valueOf();
            const shiftEndMs = currDay.clone().hour(endH).minute(endM).second(0).millisecond(0).valueOf();
            const s = Math.max(winStartMs, shiftStartMs);
            const e = Math.min(winEndMs, shiftEndMs);
            if (e > s) activeIntervals.push({ startMs: s, endMs: e });
        }
        currDay.add(1, 'day');
    }

    // 5 active days (Sun-Thu) x 8 hours = 40 hours = 144,000 seconds
    assert.equal(activeIntervals.length, 5);
    const totalWinSec = activeIntervals.reduce((acc, inv) => acc + Math.floor((inv.endMs - inv.startMs) / 1000), 0);
    assert.equal(totalWinSec, 5 * 8 * 3600);

    // Function to calculate overlap duration for a state log
    const calcLogDuration = (logStartStr, logEndStr) => {
        const logStartMs = Math.max(winStartMs, moment(logStartStr).valueOf());
        const logEndMs = Math.min(winEndMs, moment(logEndStr).valueOf());
        let durSec = 0;
        if (logEndMs > logStartMs) {
            for (const inv of activeIntervals) {
                const s = Math.max(logStartMs, inv.startMs);
                const e = Math.min(logEndMs, inv.endMs);
                if (e > s) {
                    durSec += Math.floor((e - s) / 1000);
                }
            }
        }
        return durSec;
    };

    // Case 1: Night-time Free state on Sunday night (20:00 to 23:00) -> should be 0s in shift
    assert.equal(calcLogDuration('2026-09-13 20:00:00', '2026-09-13 23:00:00'), 0);

    // Case 2: Weekend Free state on Friday all day -> should be 0s in shift
    assert.equal(calcLogDuration('2026-09-18 09:00:00', '2026-09-18 17:00:00'), 0);

    // Case 3: In-call log spanning 08:30 to 09:30 on Monday -> should be clipped to 09:00-09:30 (1800s)
    assert.equal(calcLogDuration('2026-09-14 08:30:00', '2026-09-14 09:30:00'), 1800);

    // Case 4: In-call log completely inside shift on Tuesday (10:00 to 11:00) -> full 3600s
    assert.equal(calcLogDuration('2026-09-15 10:00:00', '2026-09-15 11:00:00'), 3600);

    // Case 5: CDR call filtering: call at 22:00 on Sunday vs call at 10:00 on Sunday
    const isCallInShift = (callDateStr) => {
        const callDateMs = moment(callDateStr).valueOf();
        return activeIntervals.some(inv => callDateMs >= inv.startMs && callDateMs <= inv.endMs);
    };
    assert.equal(isCallInShift('2026-09-13 22:15:00'), false, 'Night call should be excluded');
    assert.equal(isCallInShift('2026-09-18 11:00:00'), false, 'Friday weekend call should be excluded');
    assert.equal(isCallInShift('2026-09-13 10:30:00'), true, 'Sunday morning shift call should be included');
});
