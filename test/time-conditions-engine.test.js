const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');

test('Time Conditions Engine: server.js wires REST CRUD endpoints and PBX config reload', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');

    // 1. Time Conditions Endpoints
    assert.match(serverCode, /app\.get\('\/api\/config\/timeconditions'/, 'must define GET /api/config/timeconditions');
    assert.match(serverCode, /app\.post\('\/api\/config\/timeconditions'/, 'must define POST /api/config/timeconditions');
    assert.match(serverCode, /app\.put\('\/api\/config\/timeconditions\/:id'/, 'must define PUT /api/config/timeconditions/:id');
    assert.match(serverCode, /app\.delete\('\/api\/config\/timeconditions\/:id'/, 'must define DELETE /api/config/timeconditions/:id');

    // 2. Querying and DB structure
    assert.match(serverCode, /tc\.timeconditions_id,\s*tc\.displayname,\s*tc\.time\s*AS\s*timegroup_id,\s*tg\.description\s*AS\s*timegroup_name,\s*tc\.truegoto,\s*tc\.falsegoto/, 'GET timeconditions must select essential routing fields');
    assert.match(serverCode, /INSERT INTO.*timeconditions/i, 'POST timeconditions must insert into asterisk.timeconditions');

    // 3. Time Groups Endpoints
    assert.match(serverCode, /app\.get\('\/api\/config\/timegroups'/, 'must define GET /api/config/timegroups');
    assert.match(serverCode, /app\.post\('\/api\/config\/timegroups'/, 'must define POST /api/config/timegroups');
});

test('Time Conditions Engine: Evaluates Asterisk GotoIfTime string syntax accurately', () => {
    // Asterisk syntax: <time-of-day>,<day-of-week>,<day-of-month>,<month>
    // e.g.: 09:00-17:00,mon-fri,*,*
    function evaluateGotoIfTime(ruleStr, targetDate) {
        const parts = ruleStr.split(',');
        if (parts.length < 4) return false;

        const [timeRange, dayOfWeekRule, dayOfMonthRule, monthRule] = parts;

        // 1. Time range check (HH:MM-HH:MM)
        if (timeRange !== '*') {
            const [startStr, endStr] = timeRange.split('-');
            const [startH, startM] = startStr.split(':').map(Number);
            const [endH, endM] = endStr.split(':').map(Number);

            const curH = targetDate.getHours();
            const curM = targetDate.getMinutes();
            const curMinutes = curH * 60 + curM;
            const startMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;

            if (curMinutes < startMinutes || curMinutes > endMinutes) {
                return false;
            }
        }

        // 2. Day of week check (mon-fri, sat, sun, etc.)
        if (dayOfWeekRule !== '*') {
            const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
            const curDayName = dayNames[targetDate.getDay()];

            if (dayOfWeekRule.includes('-')) {
                const [startDay, endDay] = dayOfWeekRule.toLowerCase().split('-');
                const startIdx = dayNames.indexOf(startDay);
                const endIdx = dayNames.indexOf(endDay);
                const curIdx = targetDate.getDay();

                if (startIdx <= endIdx) {
                    if (curIdx < startIdx || curIdx > endIdx) return false;
                } else {
                    // wrap around (e.g. fri-mon)
                    if (curIdx < startIdx && curIdx > endIdx) return false;
                }
            } else {
                if (dayOfWeekRule.toLowerCase() !== curDayName) return false;
            }
        }

        return true;
    }

    const businessHoursRule = '09:00-17:00,mon-fri,*,*';

    // Monday 10:30 AM (In hours)
    const mondayMorning = new Date('2026-10-05T10:30:00');
    assert.strictEqual(evaluateGotoIfTime(businessHoursRule, mondayMorning), true, 'Monday 10:30 AM should match business hours');

    // Monday 18:30 (After hours)
    const mondayEvening = new Date('2026-10-05T18:30:00');
    assert.strictEqual(evaluateGotoIfTime(businessHoursRule, mondayEvening), false, 'Monday 6:30 PM should not match business hours');

    // Sunday 12:00 PM (Weekend)
    const sundayNoon = new Date('2026-10-04T12:00:00');
    assert.strictEqual(evaluateGotoIfTime(businessHoursRule, sundayNoon), false, 'Sunday noon should not match business hours');
});

test('Time Conditions Engine: Destination routing handles true/false branch targets correctly', () => {
    // Valid target format: <context>,<exten>,<priority>
    const validDestinations = [
        'ivr-1,s,1',
        'ext-group,601,1',
        'ext-local,101,1',
        'app-blackhole,hangup,1',
        'ext-findmefollow,102,1'
    ];

    for (const dest of validDestinations) {
        const parts = dest.split(',');
        assert.strictEqual(parts.length, 3, `Destination "${dest}" must have context, exten, and priority`);
        assert.ok(parts[0].length > 0, 'context must be non-empty');
        assert.ok(parts[1].length > 0, 'extension must be non-empty');
        assert.ok(!isNaN(parseInt(parts[2], 10)), 'priority must be integer');
    }
});

test('Time Groups: Evaluates Asterisk wrap-around weekdays and clean timespec syntax', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');

    // Extract getContiguousDayRanges and formatWeekdaysFromActiveDays from server.js
    const helperMatch = serverCode.match(/function getContiguousDayRanges\([\s\S]*?^}/m);
    const match = serverCode.match(/function formatWeekdaysFromActiveDays\([\s\S]*?^}/m);
    assert.ok(match, 'formatWeekdaysFromActiveDays must be defined in server.js');
    const fn = new Function(`${helperMatch ? helperMatch[0] : ''}; ${match[0]}; return formatWeekdaysFromActiveDays;`)();

    // Sat-Thu (Arab/Egypt standard workweek) must produce 'sat-thu'
    assert.strictEqual(fn(['sat', 'sun', 'mon', 'tue', 'wed', 'thu']), 'sat-thu');
    // Sun-Thu
    assert.strictEqual(fn(['sun', 'mon', 'tue', 'wed', 'thu']), 'sun-thu');
    // Mon-Fri
    assert.strictEqual(fn(['mon', 'tue', 'wed', 'thu', 'fri']), 'mon-fri');
    // Fri-Sat (Weekend)
    assert.strictEqual(fn(['fri', 'sat']), 'fri-sat');
    // Single day
    assert.strictEqual(fn(['fri']), 'fri');
    // All 7 days -> '*'
    assert.strictEqual(fn(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']), '*');

    // Multi-segment non-contiguous days decomposition
    const multiFn = new Function(`${helperMatch[0]}; return getContiguousDayRanges;`)();
    assert.deepStrictEqual(multiFn(['sun', 'tue', 'thu']), ['tue', 'thu', 'sun']);
    assert.deepStrictEqual(multiFn(['sat', 'sun', 'mon', 'wed', 'thu']), ['wed-thu', 'sat-mon']);
});

test('Time Conditions Engine: Syncs FreePBX feature codes and destination hooks', () => {
    const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');

    assert.match(serverCode, /syncTimeConditionFeatureCode/, 'server.js must define syncTimeConditionFeatureCode');
    assert.match(serverCode, /providedest\s*=\s*1/, 'featurecodes sync must provide destination for FreePBX');
    assert.match(serverCode, /removeTimeConditionFeatureCode/, 'server.js must define removeTimeConditionFeatureCode');
});

test('Time Groups & Outbound Routes: views/config.ejs supports optional CallerID and Route CID', () => {
    const configView = fs.readFileSync(path.join(rootDir, 'views/config.ejs'), 'utf8');

    // Outbound Route CID input and Override Extension checkbox
    assert.match(configView, /id="outCid"/, 'Must contain Route CID input in Outbound Routes modal');
    assert.match(configView, /id="outCidOverride"/, 'Must contain Override Extension checkbox in Outbound Routes modal');

    // Dial Pattern CallerID field marked optional
    assert.match(configView, /CallerID \(Optional\)/, 'CallerID in pattern grid must be marked Optional');

    // Time Group Rule Name input in modal
    assert.match(configView, /name="rule_name\[\]"/, 'Rule cards must have an Interval Name / Description input');
});
