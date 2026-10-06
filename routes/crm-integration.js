/**
 * CRM Integration REST API Router
 * Handles /api/integrations/crm/v1/* endpoints
 */

const express = require('express');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const ASTERISK_BIN = '/usr/sbin/asterisk';
const pkg = require('../package.json');
const {
    authenticateClientToken,
    verifyAndUsePairingCode,
    createIntegrationClient,
    createEmbedTicket,
    validateOriginUrl,
    SUPPORTED_SCOPES
} = require('../lib/integration-auth');
const { getCustomerCallHistory, getExtensionStats } = require('../lib/cdr-aggregation');
const { createMediaId, resolveRecordingPath, streamRecordingFile } = require('../lib/recordings');

// Rate limiting map for pairing attempts (IP -> timestamps array)
const pairingRateLimitMap = new Map();

const pairingRateLimitTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of pairingRateLimitMap.entries()) {
        const fresh = timestamps.filter(t => now - t < 60000);
        if (fresh.length === 0) pairingRateLimitMap.delete(ip);
        else pairingRateLimitMap.set(ip, fresh);
    }
}, 5 * 60 * 1000);
if (pairingRateLimitTimer.unref) pairingRateLimitTimer.unref();

const CDR_DISPOSITION_SQL = `
    CASE
        WHEN c.billsec > 0 THEN c.disposition
        WHEN c.userfield = '17' OR c.userfield = '21' THEN 'BUSY'
        WHEN c.userfield IN ('18', '19') THEN 'NO ANSWER'
        WHEN c.userfield IN ('34', '38', '41', '42', '44') THEN 'CONGESTION'
        WHEN c.disposition IN ('CONGESTION', 'BUSY') AND c.duration >= 5 THEN 'NO ANSWER'
        ELSE c.disposition
    END
`;

const CDR_EXTERNAL_DST_SQL = `(c.dst REGEXP '^[0-9+]+$' AND CHAR_LENGTH(c.dst) >= 7)`;

const CDR_DIRECTION_CASE = `
    CASE
        WHEN c.channel LIKE 'Dongle/%' OR c.channel LIKE 'DAHDI/%'
             OR c.dcontext LIKE 'from-dongle%' OR c.dcontext LIKE 'from-trunk%' OR c.dcontext LIKE 'from-pstn%'
             OR (c.did != '' AND c.did IS NOT NULL)
        THEN 'INBOUND'

        WHEN (c.channel LIKE 'SIP/%' OR c.channel LIKE 'PJSIP/%' OR c.channel LIKE 'IAX2/%' OR c.dcontext = 'from-internal' OR c.dcontext LIKE 'from-internal%')
             AND (c.dstchannel LIKE 'Dongle/%' OR c.dstchannel LIKE 'DAHDI/%' OR c.lastdata LIKE 'dongle/%' OR c.lastdata LIKE 'DAHDI/%'
                  OR ${CDR_EXTERNAL_DST_SQL})
        THEN 'OUTBOUND'

        ELSE 'INTERNAL'
    END
`;

const CDR_CALL_SCOPE_CASE = `
    CASE
        WHEN c.dcontext = 'ext-external-failover' OR c.userfield LIKE 'Failover:%'
        THEN 'FAILOVER'

        WHEN (c.channel LIKE 'SIP/%' OR c.channel LIKE 'PJSIP/%' OR c.channel LIKE 'IAX2/%' OR c.dcontext = 'from-internal' OR c.dcontext LIKE 'from-internal%' OR c.dcontext LIKE 'from-intercom%')
             AND (c.dstchannel NOT LIKE 'Dongle/%' AND c.dstchannel NOT LIKE 'DAHDI/%' AND c.lastdata NOT LIKE 'dongle/%' AND c.lastdata NOT LIKE 'DAHDI/%')
             AND (NOT ${CDR_EXTERNAL_DST_SQL} OR c.dst IN ('101','102','111','200','600','300'))
             AND c.channel NOT LIKE 'Dongle/%' AND c.channel NOT LIKE 'DAHDI/%'
             AND (c.did = '' OR c.did IS NULL)
             AND c.dcontext NOT LIKE 'from-dongle%' AND c.dcontext NOT LIKE 'from-trunk%' AND c.dcontext NOT LIKE 'from-pstn%'
        THEN 'INTERNAL'

        ELSE 'EXTERNAL'
    END
`;

const CDR_HISTORY_FILTERS_SQL = `
    AND c.dst NOT IN ('ussd','sms','report','s','*87','*88','*89')
    AND c.dcontext NOT LIKE 'test-%'
    AND c.dcontext NOT LIKE '%benchmark%'
    AND c.dcontext <> 'play_audio'
    AND NOT EXISTS (
        SELECT 1 FROM \`asteriskcdrdb\`.\`cdr\` cx
        WHERE cx.uniqueid = c.uniqueid
          AND (cx.duration > c.duration OR (cx.duration = c.duration AND cx.sequence > c.sequence))
    )
`;

function parseVoicemailMeta(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const meta = {};
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
            const idx = trimmed.indexOf('=');
            if (idx > 0) meta[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim();
        }
        return meta;
    } catch { return null; }
}

async function getGeneralCdr(pool, queryParams) {
    const page = Math.max(1, parseInt(queryParams.page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(queryParams.per_page || queryParams.perPage || queryParams.limit, 10) || 25));
    const offset = (page - 1) * perPage;

    let startDate = queryParams.startDate || queryParams.from || '';
    let endDate = queryParams.endDate || queryParams.to || '';

    if (startDate) {
        startDate = moment(startDate).format('YYYY-MM-DD HH:mm:ss');
    } else {
        startDate = moment().subtract(30, 'days').startOf('day').format('YYYY-MM-DD HH:mm:ss');
    }
    if (endDate) {
        endDate = moment(endDate).format('YYYY-MM-DD HH:mm:ss');
    } else {
        endDate = moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
    }

    const whereClauses = ['c.calldate BETWEEN ? AND ?'];
    const params = [startDate, endDate];

    const extFilter = queryParams.extension || queryParams.targetExtension;
    if (extFilter && extFilter !== 'ALL') {
        const exts = Array.isArray(extFilter) ? extFilter : [extFilter];
        const regexpPattern = exts.map(e => String(e).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        whereClauses.push("(c.src IN (?) OR c.dst IN (?) OR c.cnum IN (?) OR c.channel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)') OR c.dstchannel REGEXP CONCAT('^[A-Za-z0-9_]+/(', ?, ')([^0-9]|$)'))");
        params.push(exts, exts, exts, regexpPattern, regexpPattern);
    }

    const statusFilter = queryParams.status || queryParams.statusFilter || queryParams.disposition;
    if (statusFilter && statusFilter !== 'ALL') {
        const statuses = Array.isArray(statusFilter) ? statusFilter : [statusFilter];
        const matchStatuses = [...statuses];
        if (matchStatuses.includes('FAILED') && !matchStatuses.includes('CONGESTION')) {
            matchStatuses.push('CONGESTION');
        }
        whereClauses.push(`((${CDR_DISPOSITION_SQL}) IN (?) OR ('FAILED' IN (?) AND (${CDR_DISPOSITION_SQL}) = 'CONGESTION'))`);
        params.push(matchStatuses, statuses);
    }

    const dirFilter = queryParams.direction || queryParams.directionFilter;
    if (dirFilter && dirFilter !== 'ALL') {
        whereClauses.push(`(${CDR_DIRECTION_CASE}) = ?`);
        params.push(dirFilter.toUpperCase());
    }

    const search = queryParams.search || queryParams.q;
    if (search) {
        whereClauses.push("(c.src LIKE ? OR c.dst LIKE ? OR c.did LIKE ? OR COALESCE(u.name, '') LIKE ?)");
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereSql = whereClauses.join(' AND ') + ' ' + CDR_HISTORY_FILTERS_SQL;

    const countSql = `
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN ${CDR_DISPOSITION_SQL} = 'ANSWERED' THEN 1 ELSE 0 END) as answered_count,
            SUM(c.duration) as total_duration_sec,
            AVG(CASE WHEN ${CDR_DISPOSITION_SQL} = 'ANSWERED' THEN c.duration ELSE NULL END) as avg_duration_sec
        FROM \`asteriskcdrdb\`.\`cdr\` c
        LEFT JOIN \`asterisk\`.\`users\` u ON c.src = u.extension
        WHERE ${whereSql}
    `;
    const [countRows] = await pool.query(countSql, params);
    const total = countRows[0] ? Number(countRows[0].total) || 0 : 0;
    const answeredCount = countRows[0] ? Number(countRows[0].answered_count) || 0 : 0;
    const totalDuration = countRows[0] ? Number(countRows[0].total_duration_sec) || 0 : 0;
    const avgDuration = countRows[0] ? Math.round(Number(countRows[0].avg_duration_sec) || 0) : 0;
    const totalPages = Math.ceil(total / perPage) || 0;

    const dataSql = `
        SELECT 
            c.calldate, c.src, c.dst, c.duration, c.billsec,
            ${CDR_DISPOSITION_SQL} as disposition,
            c.uniqueid, c.recordingfile, c.did,
            COALESCE(u.name, NULLIF(TRIM(c.cnam), ''), 'No Name') as src_name,
            ${CDR_DIRECTION_CASE} as direction,
            ${CDR_CALL_SCOPE_CASE} as call_scope,
            stt.transcript, stt.status as stt_status
        FROM \`asteriskcdrdb\`.\`cdr\` c
        LEFT JOIN \`asterisk\`.\`users\` u ON c.src = u.extension
        LEFT JOIN \`asteriskcdrdb\`.\`cdr_transcriptions\` stt ON stt.uniqueid = c.uniqueid
        WHERE ${whereSql}
        ORDER BY c.calldate DESC
        LIMIT ? OFFSET ?
    `;
    const dataParams = [...params, perPage, offset];
    const [rows] = await pool.query(dataSql, dataParams);

    const calls = rows.map(r => ({
        uniqueid: r.uniqueid,
        calldate: r.calldate,
        src: r.src,
        dst: r.dst,
        src_name: r.src_name,
        duration: Number(r.duration) || 0,
        billsec: Number(r.billsec) || 0,
        disposition: r.disposition,
        direction: r.direction,
        call_scope: r.call_scope,
        did: r.did || '',
        recordingfile: r.recordingfile || '',
        has_recording: Boolean(r.recordingfile && r.recordingfile.length > 0),
        media_id: r.uniqueid ? createMediaId(r.uniqueid) : null,
        transcript: r.transcript || '',
        stt_status: r.stt_status || 'none'
    }));

    return {
        success: true,
        data: calls,
        meta: {
            total,
            page,
            per_page: perPage,
            total_pages: totalPages
        },
        summary: {
            total_calls: total,
            answered_calls: answeredCount,
            answer_rate: total > 0 ? Math.round((answeredCount / total) * 100) : 0,
            total_duration_sec: totalDuration,
            avg_duration_sec: avgDuration
        }
    };
}

async function getVoicemailMessages(pool, queryParams, vmRoot = '/var/spool/asterisk/voicemail/default') {
    const messages = [];
    const targetMailbox = queryParams.mailbox || queryParams.extension || '';
    const searchCaller = queryParams.search || queryParams.searchCallerid || queryParams.q || '';
    const page = Math.max(1, parseInt(queryParams.page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(queryParams.per_page || queryParams.perPage, 10) || 25));

    const mailboxes = new Set();
    if (fs.existsSync(vmRoot)) {
        const extDirs = fs.readdirSync(vmRoot, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const ext of extDirs) {
            mailboxes.add(ext.name);
            if (targetMailbox && targetMailbox !== 'ALL' && ext.name !== targetMailbox) {
                continue;
            }
            const inbox = path.join(vmRoot, ext.name, 'INBOX');
            if (!fs.existsSync(inbox)) continue;
            const files = fs.readdirSync(inbox).filter(f => f.endsWith('.txt'));
            for (const txt of files) {
                const meta = parseVoicemailMeta(path.join(inbox, txt));
                if (!meta) continue;

                let wavFile = null;
                for (const audioExt of ['.wav', '.WAV', '.gsm', '.mp3', '.sln']) {
                    const candidate = txt.replace(/\.txt$/, audioExt);
                    if (fs.existsSync(path.join(inbox, candidate))) {
                        wavFile = candidate;
                        break;
                    }
                }

                const duration = parseInt(meta.duration, 10) || 0;
                const origtime = meta.origtime ? parseInt(meta.origtime, 10) * 1000 : 0;
                const callerid = (meta.callerid || '').replace(/"/g, '');

                messages.push({
                    mailbox: ext.name,
                    callerid,
                    origdate: meta.origdate || '',
                    origtime,
                    duration,
                    context: meta.context || '',
                    extension: meta.extension || '',
                    wavFile,
                    txtFile: txt,
                    transcript: '',
                    stt_status: 'none'
                });
            }
        }
    }

    try {
        const [transcripts] = await pool.query('SELECT mailbox, msg_file, transcript, status FROM `asteriskcdrdb`.`voicemail_transcriptions`');
        const transMap = new Map();
        for (const t of transcripts) {
            transMap.set(`${t.mailbox}:${t.msg_file}`, t);
        }
        for (const m of messages) {
            if (m.wavFile) {
                const tr = transMap.get(`${m.mailbox}:${m.wavFile}`);
                if (tr) {
                    m.transcript = tr.transcript || '';
                    m.stt_status = tr.status || 'completed';
                }
            }
        }
    } catch (_) {}

    let filtered = messages;
    if (searchCaller) {
        filtered = filtered.filter(m => m.callerid.toLowerCase().includes(searchCaller.toLowerCase()));
    }
    if (queryParams.startDate) {
        const startMs = moment(queryParams.startDate).valueOf();
        filtered = filtered.filter(m => m.origtime && m.origtime >= startMs);
    }
    if (queryParams.endDate) {
        const endMs = moment(queryParams.endDate).valueOf();
        filtered = filtered.filter(m => m.origtime && m.origtime <= endMs);
    }

    filtered.sort((a, b) => (b.origtime || 0) - (a.origtime || 0));

    const total = filtered.length;
    const totalPages = Math.ceil(total / perPage) || 1;
    const paged = filtered.slice((page - 1) * perPage, page * perPage);

    return {
        success: true,
        messages: paged,
        mailboxes: [...mailboxes].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)),
        pagination: {
            total,
            totalPages,
            page,
            perPage
        }
    };
}

async function getTelephonyReportsSummary(pool, queryParams) {
    let startDate = queryParams.startDate || queryParams.from || '';
    let endDate = queryParams.endDate || queryParams.to || '';

    if (startDate) {
        startDate = moment(startDate).format('YYYY-MM-DD HH:mm:ss');
    } else {
        startDate = moment().subtract(30, 'days').startOf('day').format('YYYY-MM-DD HH:mm:ss');
    }
    if (endDate) {
        endDate = moment(endDate).format('YYYY-MM-DD HH:mm:ss');
    } else {
        endDate = moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
    }

    const params = [startDate, endDate];

    const totalsSql = `
        SELECT 
            COUNT(*) as total_calls,
            SUM(CASE WHEN ${CDR_DISPOSITION_SQL} = 'ANSWERED' THEN 1 ELSE 0 END) as answered_calls,
            SUM(CASE WHEN (${CDR_DIRECTION_CASE}) = 'INBOUND' THEN 1 ELSE 0 END) as inbound_calls,
            SUM(CASE WHEN (${CDR_DIRECTION_CASE}) = 'OUTBOUND' THEN 1 ELSE 0 END) as outbound_calls,
            SUM(CASE WHEN (${CDR_DIRECTION_CASE}) = 'INBOUND' AND ${CDR_DISPOSITION_SQL} != 'ANSWERED' THEN 1 ELSE 0 END) as missed_inbound_calls,
            SUM(c.duration) as total_duration_sec,
            AVG(CASE WHEN ${CDR_DISPOSITION_SQL} = 'ANSWERED' THEN c.duration ELSE NULL END) as avg_talk_sec
        FROM \`asteriskcdrdb\`.\`cdr\` c
        WHERE c.calldate BETWEEN ? AND ? ${CDR_HISTORY_FILTERS_SQL}
    `;
    const [totalsRows] = await pool.query(totalsSql, params);
    const totals = totalsRows[0] || {};

    const hourlySql = `
        SELECT 
            HOUR(c.calldate) as hour_num,
            SUM(CASE WHEN (${CDR_DIRECTION_CASE}) = 'INBOUND' THEN 1 ELSE 0 END) as inbound_count,
            SUM(CASE WHEN (${CDR_DIRECTION_CASE}) = 'OUTBOUND' THEN 1 ELSE 0 END) as outbound_count,
            COUNT(*) as total_count
        FROM \`asteriskcdrdb\`.\`cdr\` c
        WHERE c.calldate BETWEEN ? AND ? ${CDR_HISTORY_FILTERS_SQL}
        GROUP BY HOUR(c.calldate)
        ORDER BY hour_num ASC
    `;
    const [hourlyRows] = await pool.query(hourlySql, params);
    const hourlyMap = {};
    for (const h of hourlyRows) {
        hourlyMap[h.hour_num] = {
            inbound: Number(h.inbound_count) || 0,
            outbound: Number(h.outbound_count) || 0,
            total: Number(h.total_count) || 0
        };
    }
    const hourlyDistribution = [];
    for (let h = 0; h < 24; h++) {
        hourlyDistribution.push({
            hour: h,
            label: `${String(h).padStart(2, '0')}:00`,
            inbound: hourlyMap[h]?.inbound || 0,
            outbound: hourlyMap[h]?.outbound || 0,
            total: hourlyMap[h]?.total || 0
        });
    }

    const extSql = `
        SELECT 
            c.src as extension,
            COALESCE(u.name, c.src) as name,
            COUNT(*) as total_calls,
            SUM(CASE WHEN ${CDR_DISPOSITION_SQL} = 'ANSWERED' THEN 1 ELSE 0 END) as answered_calls,
            SUM(c.duration) as total_talk_sec,
            AVG(CASE WHEN ${CDR_DISPOSITION_SQL} = 'ANSWERED' THEN c.duration ELSE NULL END) as avg_talk_sec
        FROM \`asteriskcdrdb\`.\`cdr\` c
        LEFT JOIN \`asterisk\`.\`users\` u ON c.src = u.extension
        WHERE c.calldate BETWEEN ? AND ? ${CDR_HISTORY_FILTERS_SQL}
          AND c.src REGEXP '^[0-9]{3,4}$'
        GROUP BY c.src, u.name
        ORDER BY total_calls DESC
        LIMIT 25
    `;
    const [extRows] = await pool.query(extSql, params);
    const extensionStats = extRows.map(r => ({
        extension: r.extension,
        name: r.name,
        total_calls: Number(r.total_calls) || 0,
        answered_calls: Number(r.answered_calls) || 0,
        answer_rate: Number(r.total_calls) > 0 ? Math.round((Number(r.answered_calls) / Number(r.total_calls)) * 100) : 0,
        total_talk_sec: Number(r.total_talk_sec) || 0,
        avg_talk_sec: Math.round(Number(r.avg_talk_sec) || 0)
    }));

    const dispSql = `
        SELECT 
            ${CDR_DISPOSITION_SQL} as disp,
            COUNT(*) as count
        FROM \`asteriskcdrdb\`.\`cdr\` c
        WHERE c.calldate BETWEEN ? AND ? ${CDR_HISTORY_FILTERS_SQL}
        GROUP BY disp
    `;
    const [dispRows] = await pool.query(dispSql, params);
    const dispositionBreakdown = {};
    for (const d of dispRows) {
        dispositionBreakdown[d.disp] = Number(d.count) || 0;
    }

    return {
        success: true,
        date_range: { start_date: startDate, end_date: endDate },
        totals: {
            total_calls: Number(totals.total_calls) || 0,
            answered_calls: Number(totals.answered_calls) || 0,
            answer_rate: Number(totals.total_calls) > 0 ? Math.round((Number(totals.answered_calls) / Number(totals.total_calls)) * 100) : 0,
            inbound_calls: Number(totals.inbound_calls) || 0,
            outbound_calls: Number(totals.outbound_calls) || 0,
            missed_inbound_calls: Number(totals.missed_inbound_calls) || 0,
            total_duration_sec: Number(totals.total_duration_sec) || 0,
            avg_talk_sec: Math.round(Number(totals.avg_talk_sec) || 0)
        },
        hourly_distribution: hourlyDistribution,
        extension_stats: extensionStats,
        disposition_breakdown: dispositionBreakdown
    };
}

function createCrmRouter(pool, options = {}) {
    const getPeerStatus = typeof options === 'function' ? options : (options.getPeerStatus || (() => options.peerStatus || {}));
    const getActiveCalls = typeof options === 'object' && typeof options.getActiveCalls === 'function'
        ? options.getActiveCalls
        : (() => options.activeCalls || {});
    const getAmiClient = typeof options === 'object' && typeof options.getAmiClient === 'function'
        ? options.getAmiClient
        : (() => options.amiClient || null);
    const router = express.Router();

    // 1. PUBLIC HEALTH ENDPOINT
    router.get('/health', (req, res) => {
        res.json({
            service: 'sokrat-voip',
            status: 'ok',
            api_version: '1.0',
            application_version: pkg.version || '1.0.0',
            server_time: moment().format(),
            timezone: 'Africa/Cairo'
        });
    });

    // 2. PAIRING ENDPOINT (Public with single-use pairing code & origin validation)
    router.post('/pair', async (req, res) => {
        const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
        const now = Date.now();

        let attempts = (pairingRateLimitMap.get(ip) || []).filter(t => now - t < 60000);
        if (attempts.length >= 5) {
            return res.status(429).json({ success: false, error: 'Too many pairing attempts. Please try again later.' });
        }
        attempts.push(now);
        pairingRateLimitMap.set(ip, attempts);

        const { pairing_code, name, origin, default_country_code } = req.body || {};

        if (!pairing_code || !name || !origin) {
            return res.status(400).json({ success: false, error: 'Missing required parameters: pairing_code, name, origin' });
        }

        const validOrigin = validateOriginUrl(origin);
        if (!validOrigin) {
            return res.status(400).json({ success: false, error: 'Invalid origin URL. Must be http:// or https:// without paths, queries, or wildcards.' });
        }

        try {
            const client = await createIntegrationClient(pool, {
                pairingCode: String(pairing_code).trim(),
                name: String(name).trim(),
                origin: validOrigin,
                defaultCountryCode: String(default_country_code || '20').trim()
            });

            if (!client) {
                return res.status(401).json({ success: false, error: 'Invalid, expired, or already used pairing code' });
            }

            const liveControls = (client.scopes || []).filter(s => s.startsWith('live:') && s !== 'live:read').map(s => s.substring(5));

            return res.json({
                client_id: client.clientId,
                client_secret: client.bearerToken,
                api_version: '1.0',
                capabilities: {
                    call_history: true,
                    recordings: true,
                    extension_stats: true,
                    live_panel: true,
                    live_controls: liveControls
                }
            });
        } catch (err) {
            console.error('CRM Pairing error:', err.message);
            return res.status(500).json({ success: false, error: 'Internal server error during pairing' });
        }
    });

    // CRM AUTHENTICATION & SCOPE MIDDLEWARE
    function requireCrmScope(requiredScope) {
        return async (req, res, next) => {
            try {
                // Support Static API Key authentication (X-API-Key, Bearer sokrat_live_...)
                if (req.isApiKeyAuthenticated && req.apiKey) {
                    const scopes = String(req.apiKey.scopes || '*').split(',').map(s => s.trim().toLowerCase());
                    if (scopes.includes('*')) {
                        req.crmClient = {
                            clientId: 'api-key-' + req.apiKey.id,
                            name: req.apiKey.name || 'Static API Key Client',
                            defaultCountryCode: '20',
                            scopes: ['calls:read', 'recordings:read', 'extensions:read', 'embed:live', 'live:read']
                        };
                        return next();
                    }
                    const reqScope = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
                    const matches = reqScope.some(s => scopes.includes(s.toLowerCase()));
                    if (matches) {
                        req.crmClient = {
                            clientId: 'api-key-' + req.apiKey.id,
                            name: req.apiKey.name || 'Static API Key Client',
                            defaultCountryCode: '20',
                            scopes
                        };
                        return next();
                    }
                }

                const authHeader = req.headers.authorization || '';
                if (!authHeader.startsWith('Bearer ')) {
                    return res.status(401).json({ success: false, error: 'Unauthorized. Bearer authentication required.' });
                }

                const token = authHeader.substring(7).trim();
                if (token.length < 10 || token.length > 256 || !token.includes('.')) {
                    return res.status(401).json({ success: false, error: 'Unauthorized. Malformed bearer token.' });
                }

                const client = await authenticateClientToken(pool, token);

                if (!client) {
                    return res.status(401).json({ success: false, error: 'Unauthorized. Invalid, expired, or revoked integration credentials.' });
                }

                if (requiredScope) {
                    const hasScope = Array.isArray(requiredScope)
                        ? requiredScope.some(s => client.scopes.includes(s))
                        : client.scopes.includes(requiredScope);
                    if (!hasScope) {
                        return res.status(403).json({ success: false, error: `Forbidden. Missing required scope: ${Array.isArray(requiredScope) ? requiredScope.join(' or ') : requiredScope}` });
                    }
                }

                req.crmClient = client;
                next();
            } catch (err) {
                console.error('CRM Auth Middleware error:', err.message);
                return res.status(503).json({ success: false, error: 'Service temporarily unavailable' });
            }
        };
    }

    // 3. CAPABILITIES ENDPOINT
    router.get('/capabilities', requireCrmScope(), (req, res) => {
        const clientScopes = req.crmClient.scopes || [];
        const liveControls = clientScopes.filter(s => s.startsWith('live:') && s !== 'live:read').map(s => s.substring(5));

        res.json({
            api_version: '1.0',
            application_version: pkg.version || '1.0.0',
            supported: {
                call_history: true,
                recordings: true,
                extension_stats: true,
                live_panel: true,
                voicemails: true,
                reports_summary: true,
                live_controls: ['listen', 'whisper', 'barge', 'hangup', 'hijack']
            },
            granted_scopes: clientScopes,
            effective_live_controls: liveControls
        });
    });

    // 4. SAFE LIVE EXTENSION LIST
    router.get('/extensions', requireCrmScope('extensions:read'), async (req, res) => {
        try {
            const [rows] = await pool.query(`
                SELECT extension AS id, name
                FROM asterisk.users
                WHERE extension REGEXP '^[0-9]+$'
                ORDER BY CAST(extension AS UNSIGNED) ASC
            `);

            const peerMap = typeof getPeerStatus === 'function' ? getPeerStatus() : {};
            const activeCallMap = getActiveCalls();

            const extensions = rows.map(r => {
                const ext = String(r.id);
                const peer = peerMap[ext];
                const activeCall = activeCallMap && typeof activeCallMap === 'object'
                    ? activeCallMap[ext]
                    : null;
                let isOnline = false;

                if (typeof peer === 'boolean') {
                    isOnline = peer;
                } else if (peer && typeof peer === 'object') {
                    const peerStatus = String(peer.status || '').toLowerCase();
                    isOnline = Boolean(peer.online)
                        || peerStatus.includes('ok')
                        || ['online', 'registered', 'available', 'idle', 'ready'].includes(peerStatus);
                }

                const inCall = Boolean(activeCall);
                const rawCallState = String(activeCall?.state || activeCall?.status || '').toLowerCase();
                const status = inCall
                    ? (rawCallState.includes('ring') ? 'ringing' : 'in_call')
                    : (isOnline ? 'online' : 'offline');
                const startedAt = inCall
                    ? (Number(activeCall.start || activeCall.started_at) || Date.now())
                    : null;

                return {
                    extension: ext,
                    name: r.name || `Extension ${ext}`,
                    technology: 'sip',
                    enabled: true,
                    online: isOnline || inCall,
                    in_call: inCall,
                    status,
                    call: inCall ? {
                        state: activeCall.state || activeCall.status || 'In Call',
                        partner: String(activeCall.partner || activeCall.callee || activeCall.caller || ''),
                        started_at: startedAt,
                        duration_seconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
                    } : null
                };
            });

            res.json({
                extensions,
                generated_at: new Date().toISOString()
            });
        } catch (err) {
            console.error('CRM Extensions fetch error:', err.message);
            res.status(500).json({ success: false, error: 'Failed to retrieve extensions' });
        }
    });

    // 5. CALL HISTORY (CDR) API (Supports both single-phone and general multi-filter CDR)
    router.get('/calls', requireCrmScope('calls:read'), async (req, res) => {
        const { phone } = req.query;
        if (phone) {
            try {
                const countryCode = req.crmClient.default_country_code || '20';
                const history = await getCustomerCallHistory(pool, req.query, countryCode);
                return res.json(history);
            } catch (err) {
                if (err.message.includes('required') || err.message.includes('End date')) {
                    return res.status(400).json({ success: false, error: err.message });
                }
                console.error('CRM Call History error:', err.message);
                return res.status(500).json({ success: false, error: 'Failed to retrieve customer call history' });
            }
        }

        try {
            const history = await getGeneralCdr(pool, req.query);
            return res.json(history);
        } catch (err) {
            console.error('CRM General CDR error:', err.message);
            return res.status(500).json({ success: false, error: 'Failed to retrieve call detail records' });
        }
    });

    router.get('/cdr', requireCrmScope('calls:read'), async (req, res) => {
        try {
            const history = await getGeneralCdr(pool, req.query);
            return res.json(history);
        } catch (err) {
            console.error('CRM General CDR error:', err.message);
            return res.status(500).json({ success: false, error: 'Failed to retrieve call detail records' });
        }
    });

    // VOICEMAIL INBOX API
    router.get('/voicemails', requireCrmScope('calls:read'), async (req, res) => {
        try {
            const VM_ROOT = options.VM_ROOT || '/var/spool/asterisk/voicemail/default';
            const result = await getVoicemailMessages(pool, req.query, VM_ROOT);
            return res.json(result);
        } catch (err) {
            console.error('CRM Voicemails fetch error:', err.message);
            return res.status(500).json({ success: false, error: 'Failed to retrieve voicemails' });
        }
    });

    // VOICEMAIL AUDIO STREAMING
    router.get('/voicemails/:mailbox/:file/audio', requireCrmScope('recordings:read'), (req, res) => {
        const { mailbox, file } = req.params;
        const safeMailbox = String(mailbox).replace(/[^a-zA-Z0-9_-]/g, '');
        const safeFile = path.basename(file);
        const VM_ROOT = options.VM_ROOT || '/var/spool/asterisk/voicemail/default';
        const filePath = path.join(VM_ROOT, safeMailbox, 'INBOX', safeFile);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: 'Voicemail audio file not found' });
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = { '.wav': 'audio/wav', '.WAV': 'audio/wav', '.gsm': 'audio/x-gsm', '.mp3': 'audio/mpeg' };
        const contentType = mimeTypes[ext] || 'audio/wav';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        fs.createReadStream(filePath).pipe(res);
    });

    // TELEPHONY ANALYTICS / REPORTS SUMMARY
    router.get('/reports/summary', requireCrmScope('stats:read'), async (req, res) => {
        try {
            const reports = await getTelephonyReportsSummary(pool, req.query);
            return res.json(reports);
        } catch (err) {
            console.error('CRM Telephony Reports Summary error:', err.message);
            return res.status(500).json({ success: false, error: 'Failed to generate telephony reports summary' });
        }
    });

    // 6. RECORDING STREAMING API
    router.get('/recordings/:mediaId', requireCrmScope('recordings:read'), async (req, res) => {
        const { mediaId } = req.params;
        try {
            const recordingPath = await resolveRecordingPath(mediaId, pool);
            if (!recordingPath) {
                return res.status(404).json({ success: false, error: 'Recording file not found' });
            }
            streamRecordingFile(req, res, recordingPath);
        } catch (err) {
            console.error('CRM Recording streaming error:', err.message);
            res.status(500).json({ success: false, error: 'Failed to stream recording file' });
        }
    });

    // 7. EXTENSION STATISTICS API
    router.get('/extensions/:extension/stats', requireCrmScope('stats:read'), async (req, res) => {
        const { extension } = req.params;
        try {
            const stats = await getExtensionStats(pool, extension, req.query);
            res.json(stats);
        } catch (err) {
            if (err.message.includes('Invalid extension') || err.message.includes('Date range') || err.message.includes('direction')) {
                return res.status(400).json({ success: false, error: err.message });
            }
            console.error('CRM Extension Stats error:', err.message);
            res.status(500).json({ success: false, error: 'Failed to generate extension statistics' });
        }
    });

    // 8. EMBED TICKET GENERATOR
    router.post('/embed-tickets', requireCrmScope(['live:read', 'softphone:use']), async (req, res) => {
        const { crm_user_id, crm_user_name, supervisor_extension, requested_scopes, extension } = req.body || {};

        if (!crm_user_id || !crm_user_name) {
            return res.status(400).json({ success: false, error: 'Missing required parameters: crm_user_id, crm_user_name' });
        }

        try {
            const requestedScopes = Array.isArray(requested_scopes)
                ? requested_scopes
                : ['softphone:use', 'live:read'];
            const canIssueRequestedTicket = requestedScopes.some(scope =>
                (scope === 'softphone:use' || scope === 'live:read') &&
                req.crmClient.scopes.includes(scope)
            );
            if (!canIssueRequestedTicket) {
                return res.status(403).json({
                    success: false,
                    error: 'Forbidden. Requested embed scope is not granted to this client.'
                });
            }
            const ticket = await createEmbedTicket(pool, req.crmClient, {
                crmUserId: String(crm_user_id),
                crmUserName: String(crm_user_name),
                supervisorExtension: supervisor_extension ? String(supervisor_extension) : null,
                extension: extension ? String(extension) : null,
                requestedScopes
            });
            if (ticket.effectiveScopes.length === 0) {
                throw new Error('Embed ticket was created without an effective scope');
            }

            res.json({
                ticket: ticket.rawTicket,
                expires_at: ticket.expiresAt.toISOString(),
                effective_scopes: ticket.effectiveScopes
            });
        } catch (err) {
            console.error('CRM Embed Ticket creation error:', err.message);
            res.status(500).json({ success: false, error: 'Failed to create embed ticket' });
        }
    });

    // 9. AGENT PRESENCE & AVAILABILITY STATUS (STATIC + DYNAMIC STATUSES)
    const STATIC_AGENT_STATUSES = [
        {
            key: 'available',
            label_ar: 'متاح',
            label_en: 'Available',
            desc_ar: 'جاهز لاستقبال المكالمات',
            desc_en: 'Ready to receive calls',
            color: '#10b981',
            type: 'static',
            has_timer: false
        },
        {
            key: 'offline',
            label_ar: 'غير متاح',
            label_en: 'Offline',
            desc_ar: 'حجب المكالمات مؤقتاً',
            desc_en: 'Temporarily not taking calls',
            color: '#94a3b8',
            type: 'static',
            has_timer: false
        }
    ];

    async function getDynamicStatuses(targetGroup = null) {
        try {
            let sql = `SELECT status_key AS \`key\`, label_ar, label_en, desc_ar, desc_en, color, target_group, sort_order, is_active
                       FROM asterisk.synq_agent_status_definitions
                       WHERE is_active = 1`;
            const params = [];
            if (targetGroup) {
                sql += ` AND (target_group IS NULL OR target_group = '' OR target_group = 'all' OR target_group = ?)`;
                params.push(targetGroup);
            }
            sql += ` ORDER BY sort_order ASC, id ASC`;
            const [rows] = await pool.query(sql, params);
            return (rows || []).map(r => ({
                ...r,
                type: 'dynamic',
                has_timer: true
            }));
        } catch (_) {
            return [
                { key: 'break', label_ar: 'استراحة', label_en: 'Break', desc_ar: 'فترة راحة قصيرة', desc_en: 'Short break', color: '#f59e0b', type: 'dynamic', has_timer: true },
                { key: 'lunch', label_ar: 'غداء', label_en: 'Lunch', desc_ar: 'فترة تناول الغداء', desc_en: 'Lunch break', color: '#ea580c', type: 'dynamic', has_timer: true },
                { key: 'meeting', label_ar: 'اجتماع', label_en: 'Meeting', desc_ar: 'اجتماع داخلي أو مقابلة عميل', desc_en: 'Internal meeting', color: '#8b5cf6', type: 'dynamic', has_timer: true },
                { key: 'training', label_ar: 'تدريب', label_en: 'Training', desc_ar: 'جلسة تدريب أو ورشة عمل', desc_en: 'Training session', color: '#3b82f6', type: 'dynamic', has_timer: true }
            ];
        }
    }

    router.get('/agent-statuses', requireCrmScope('stats:read'), async (req, res) => {
        try {
            const ext = String(req.query.extension || '').trim();
            let targetGroup = String(req.query.group || '').trim();

            if (!targetGroup && ext) {
                const [extRows] = await pool.query(
                    'SELECT emp_group FROM asterisk.employee_extras WHERE extension = ? LIMIT 1',
                    [ext]
                );
                if (extRows && extRows[0] && extRows[0].emp_group) {
                    targetGroup = extRows[0].emp_group;
                }
            }

            const dynamic = await getDynamicStatuses(targetGroup || null);
            const availableStatic = STATIC_AGENT_STATUSES.find(s => s.key === 'available');
            const offlineStatic = STATIC_AGENT_STATUSES.find(s => s.key === 'offline');
            const all = [
                availableStatic,
                ...dynamic,
                offlineStatic
            ].filter(Boolean);

            res.json({
                success: true,
                extension: ext || null,
                group: targetGroup || null,
                static: STATIC_AGENT_STATUSES,
                dynamic: dynamic,
                statuses: all
            });
        } catch (err) {
            console.error('Fetch agent statuses error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/agent-statuses', requireCrmScope('stats:read'), async (req, res) => {
        const { status_key, label_ar, label_en, desc_ar, desc_en, color, sort_order } = req.body || {};
        const key = String(status_key || '').toLowerCase().trim();
        if (!key || !/^[a-z0-9_-]+$/.test(key)) {
            return res.status(400).json({ success: false, error: 'Valid status_key is required' });
        }
        if (key === 'available' || key === 'offline') {
            return res.status(400).json({ success: false, error: 'Cannot override static status (available, offline)' });
        }
        const nameAr = String(label_ar || key).trim();
        const nameEn = String(label_en || key).trim();
        const col = String(color || '#f59e0b').trim();
        const order = parseInt(sort_order, 10) || 10;

        try {
            await pool.query(
                `INSERT INTO asterisk.synq_agent_status_definitions (status_key, label_ar, label_en, desc_ar, desc_en, color, is_active, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?)
                 ON DUPLICATE KEY UPDATE label_ar = VALUES(label_ar), label_en = VALUES(label_en), desc_ar = VALUES(desc_ar), desc_en = VALUES(desc_en), color = VALUES(color), is_active = 1, sort_order = VALUES(sort_order)`,
                [key, nameAr, nameEn, desc_ar || null, desc_en || null, col, order]
            );
            res.json({ success: true, key, label_ar: nameAr, label_en: nameEn, color: col });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/agent-status', requireCrmScope('stats:read'), async (req, res) => {
        const { extension, status, display_name } = req.body || {};
        const ext = String(extension || '').trim();
        if (!ext || !/^[0-9A-Za-z_-]+$/.test(ext)) {
            return res.status(400).json({ success: false, error: 'Valid extension is required' });
        }
        const newStatus = String(status || 'available').toLowerCase().trim();
        const name = String(display_name || ext).trim();

        try {
            const [currentRows] = await pool.query(
                'SELECT status, last_update FROM asterisk.synq_agent_status WHERE extension = ? LIMIT 1',
                [ext]
            );
            const current = currentRows && currentRows[0];

            if (current && current.status !== newStatus) {
                const startTime = current.last_update;
                await pool.query(
                    `INSERT INTO asterisk.synq_agent_status_log (extension, status, start_time, end_time, duration_seconds)
                     VALUES (?, ?, ?, NOW(), TIMESTAMPDIFF(SECOND, ?, NOW()))`,
                    [ext, current.status, startTime, startTime]
                );
            }

            await pool.query(
                `INSERT INTO asterisk.synq_agent_status (extension, display_name, status, last_update)
                 VALUES (?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE status = ?, display_name = ?, last_update = NOW()`,
                [ext, name, newStatus, newStatus, name]
            );

            // Asterisk DND and Queue Pause Control
            if (newStatus === 'available') {
                await execFileAsync(ASTERISK_BIN, ['-rx', `database del DND ${ext}`]).catch(() => {});
                await execFileAsync(ASTERISK_BIN, ['-rx', `queue unpause member PJSIP/${ext}`]).catch(() => {});
                await pool.query(
                    `INSERT INTO asterisk.extension_policies (extension, dnd) VALUES (?, 'user_choice')
                     ON DUPLICATE KEY UPDATE dnd = 'user_choice'`,
                    [ext]
                ).catch(() => {});
            } else {
                await execFileAsync(ASTERISK_BIN, ['-rx', `database put DND ${ext} YES`]).catch(() => {});
                await execFileAsync(ASTERISK_BIN, ['-rx', `queue pause member PJSIP/${ext} reason ${newStatus}`]).catch(() => {});
                await pool.query(
                    `INSERT INTO asterisk.extension_policies (extension, dnd) VALUES (?, 'enabled')
                     ON DUPLICATE KEY UPDATE dnd = 'enabled'`,
                    [ext]
                ).catch(() => {});
            }

            const hasTimer = (newStatus !== 'available' && newStatus !== 'offline');

            res.json({
                success: true,
                extension: ext,
                status: newStatus,
                display_name: name,
                has_timer: hasTimer,
                updated_at: new Date().toISOString()
            });
        } catch (err) {
            console.error('Agent status update error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/agent-status/:extension', requireCrmScope('stats:read'), async (req, res) => {
        const ext = String(req.params.extension || '').trim();
        try {
            const [rows] = await pool.query(
                'SELECT status, display_name, last_update, TIMESTAMPDIFF(SECOND, last_update, NOW()) AS elapsed_seconds FROM asterisk.synq_agent_status WHERE extension = ? LIMIT 1',
                [ext]
            );
            const currentStatus = (rows && rows[0] && rows[0].status) ? rows[0].status : 'available';
            const displayName = (rows && rows[0] && rows[0].display_name) ? rows[0].display_name : ext;
            const lastUpdate = (rows && rows[0]) ? rows[0].last_update : new Date();
            const elapsed = (rows && rows[0]) ? Number(rows[0].elapsed_seconds) || 0 : 0;
            const hasTimer = (currentStatus !== 'available' && currentStatus !== 'offline');

            res.json({
                success: true,
                extension: ext,
                status: currentStatus,
                display_name: displayName,
                last_update: lastUpdate,
                has_timer: hasTimer,
                elapsed_seconds: hasTimer ? elapsed : 0
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/agent-status-stats', requireCrmScope('stats:read'), async (req, res) => {
        const { extension, from, to } = req.query;
        try {
            let sql = `
                SELECT extension, status, SUM(duration_seconds) AS total_seconds, COUNT(*) AS count
                FROM asterisk.synq_agent_status_log
                WHERE 1=1
            `;
            const params = [];
            if (extension) {
                sql += ' AND extension = ?';
                params.push(extension);
            }
            if (from) {
                sql += ' AND start_time >= ?';
                params.push(from + ' 00:00:00');
            }
            if (to) {
                sql += ' AND start_time <= ?';
                params.push(to + ' 23:59:59');
            }
            sql += ' GROUP BY extension, status';
            const [rows] = await pool.query(sql, params);
            res.json({
                success: true,
                stats: rows || []
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 10. DESKTOP TELEPHONY SESSION PROVISIONING
    router.get('/desktop-session', requireCrmScope(['live:read', 'softphone:use', 'extensions:read']), async (req, res) => {
        const ext = String(req.query.extension || '').trim();
        try {
            let password = 'sss333';
            if (ext) {
                try {
                    const { stdout } = await execFileAsync(ASTERISK_BIN, ['-rx', `pjsip show auth ${ext}-auth`]);
                    const match = stdout.match(/password\s*:\s*(\S+)/i);
                    if (match && match[1]) {
                        password = match[1];
                    }
                } catch (_) {}
            }
            let policy = { auto_answer: 'user_choice', dnd: 'user_choice', disable_outbound_ringing_cancel: 0 };
            if (ext) {
                try {
                    const [rows] = await pool.query('SELECT auto_answer, dnd, COALESCE(disable_outbound_ringing_cancel, 0) AS disable_outbound_ringing_cancel FROM `asterisk`.`extension_policies` WHERE extension = ?', [ext]);
                    if (rows && rows.length > 0) {
                        policy = rows[0];
                    }
                } catch (_) {}
            }

            const requestHost = req.hostname || (req.headers.host ? req.headers.host.split(':')[0] : '192.168.100.50');
            const host = (requestHost === 'localhost' || requestHost === '127.0.0.1' || requestHost === 'host.docker.internal')
                ? '192.168.100.50'
                : requestHost;
            res.json({
                success: true,
                ws_url: `ws://${host}:8088/ws`,
                wss_url: `wss://${host}:8089/ws`,
                sip_domain: host,
                extension: ext || '150',
                password: password,
                auto_answer: policy.auto_answer || 'user_choice',
                dnd: policy.dnd || 'user_choice',
                disable_outbound_ringing_cancel: Boolean(policy.disable_outbound_ringing_cancel),
                api_url: `http://${host}:8080/api/integrations/crm/v1`,
                softphone_api_url: `http://${host}:8090`
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 11. DESKTOP CALL TRANSFER (Server-Side Asterisk Channel Redirect)
    router.post('/transfer', requireCrmScope(['live:read', 'softphone:use', 'live:barge']), async (req, res) => {
        try {
            const { sourceExtension, targetExtension } = req.body;
            const src = String(sourceExtension || '').trim();
            const dst = String(targetExtension || '').trim();
            if (!src || !dst) {
                return res.status(400).json({ success: false, error: 'Source and target extensions are required.' });
            }
            const ami = typeof getAmiClient === 'function' ? getAmiClient() : null;
            if (!ami) {
                return res.status(503).json({ success: false, error: 'Asterisk AMI client is temporarily unavailable.' });
            }
            const { executeCallTransfer } = require('../lib/call-control');
            const result = await executeCallTransfer(pool, ami, ASTERISK_BIN, {
                sourceExt: src,
                destinationExt: dst
            });
            res.json({ success: true, message: `Call on extension ${src} successfully transferred to ${dst}.`, result });
        } catch (err) {
            console.error('[CRM Integration] Transfer error:', err.message);
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // 11.1 CHANNEL ACTION (Listen, Whisper, Barge, Hangup, Transfer)
    router.post('/channels/action', requireCrmScope(['live:read']), async (req, res) => {
        try {
            const { action, targetExtension, supervisorExtension, destinationExtension } = req.body || {};
            const act = String(action || '').trim().toLowerCase();
            const target = String(targetExtension || '').trim();
            const supervisor = String(supervisorExtension || '').trim();

            if (!act || !target) {
                return res.status(400).json({ success: false, error: 'action and targetExtension are required.' });
            }

            const ami = typeof getAmiClient === 'function' ? getAmiClient() : null;
            const { executeCallSpy, executeCallHangup, executeCallTransfer } = require('../lib/call-control');

            if (act === 'hangup') {
                await executeCallHangup(ami, ASTERISK_BIN, getActiveCalls, target);
                return res.json({ success: true, message: `Call on extension ${target} hung up.` });
            }

            if (['listen', 'whisper', 'barge'].includes(act)) {
                if (!supervisor) {
                    return res.status(400).json({ success: false, error: 'supervisorExtension is required for monitoring spy actions.' });
                }
                await executeCallSpy(pool, ami, ASTERISK_BIN, {
                    supervisorExt: supervisor,
                    targetExt: target,
                    mode: act
                });
                return res.json({ success: true, message: `Spy action (${act}) initiated to supervisor ${supervisor}.` });
            }

            if (act === 'hijack') {
                if (!supervisor) {
                    return res.status(400).json({ success: false, error: 'supervisorExtension is required for hijack action.' });
                }
                const { executeCallHijack } = require('../lib/call-control');
                await executeCallHijack(pool, ami, ASTERISK_BIN, {
                    supervisorExt: supervisor,
                    targetExt: target,
                    activeCallsObj: getActiveCalls
                });
                return res.json({ success: true, message: `Call on extension ${target} hijacked to supervisor ${supervisor}.` });
            }

            if (act === 'transfer') {
                const dst = String(destinationExtension || '').trim();
                if (!dst) {
                    return res.status(400).json({ success: false, error: 'destinationExtension is required for transfer.' });
                }
                const result = await executeCallTransfer(pool, ami, ASTERISK_BIN, {
                    sourceExt: target,
                    destinationExt: dst
                });
                return res.json({ success: true, message: `Call on extension ${target} transferred to ${dst}.`, result });
            }

            return res.status(400).json({ success: false, error: `Unsupported channel action: ${act}` });
        } catch (err) {
            console.error('[CRM Integration] Channels action error:', err.message);
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // 12. ADVANCED WEBRTC CALL TELEMETRY & BUSINESS STATS INGESTION
    router.post('/telemetry/call-session', requireCrmScope(['calls:read', 'softphone:use', 'live:read', 'stats:read']), async (req, res) => {
        try {
            const body = req.body || {};
            const ext = String(body.extension || '').trim();
            if (!ext) {
                return res.status(400).json({ success: false, error: 'Extension is required' });
            }

            let uniqueid = body.uniqueid ? String(body.uniqueid).trim() : null;
            const phone = body.phone ? String(body.phone).trim() : null;

            // Auto-bind to Asterisk CDR uniqueid if not provided by client
            if (!uniqueid && phone) {
                const cleanPhone = phone.replace(/[^0-9]/g, '');
                if (cleanPhone.length >= 7) {
                    const [cdrRows] = await pool.query(
                        `SELECT uniqueid FROM asteriskcdrdb.cdr
                         WHERE (src = ? OR dst = ? OR dst LIKE ? OR src LIKE ?)
                           AND calldate >= NOW() - INTERVAL 15 MINUTE
                         ORDER BY calldate DESC LIMIT 1`,
                        [ext, ext, `%${cleanPhone.slice(-8)}%`, `%${cleanPhone.slice(-8)}%`]
                    );
                    if (cdrRows && cdrRows.length > 0) {
                        uniqueid = cdrRows[0].uniqueid;
                    }
                }
            }

            const callId = body.call_id ? String(body.call_id).trim() : null;
            const direction = String(body.direction || 'outbound').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
            const leadId = body.lead_id ? Number(body.lead_id) || null : null;
            const leadName = body.lead_name ? String(body.lead_name).trim().slice(0, 150) : null;
            const holdSec = Math.max(0, parseInt(body.hold_seconds, 10) || 0);
            const holdCount = Math.max(0, parseInt(body.hold_count, 10) || 0);
            const muteSec = Math.max(0, parseInt(body.mute_seconds, 10) || 0);
            const wrapUpSec = Math.max(0, parseInt(body.wrap_up_seconds, 10) || 0);
            const jitterMs = Math.max(0, parseFloat(body.jitter_ms) || 0);
            const packetLossPct = Math.max(0, parseFloat(body.packet_loss_pct) || 0);
            const rttMs = Math.max(0, parseInt(body.rtt_ms, 10) || 0);
            const outcome = body.disposition_outcome ? String(body.disposition_outcome).trim().slice(0, 100) : null;
            const deviceName = body.audio_device_name ? String(body.audio_device_name).trim().slice(0, 150) : null;

            await pool.query(
                `INSERT INTO asterisk.crm_call_telemetry
                 (uniqueid, call_id, extension, phone, direction, lead_id, lead_name,
                  hold_seconds, hold_count, mute_seconds, wrap_up_seconds, jitter_ms,
                  packet_loss_pct, rtt_ms, disposition_outcome, audio_device_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [uniqueid, callId, ext, phone, direction, leadId, leadName,
                 holdSec, holdCount, muteSec, wrapUpSec, jitterMs,
                 packetLossPct, rttMs, outcome, deviceName]
            );

            res.json({
                success: true,
                message: 'Telemetry recorded successfully',
                uniqueid: uniqueid
            });
        } catch (err) {
            console.error('[CRM Integration] Telemetry ingestion error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 13. RETRIEVE ADVANCED AGENT TELEMETRY STATS
    router.get('/telemetry/stats', requireCrmScope('stats:read'), async (req, res) => {
        const { extension, from, to } = req.query;
        try {
            let sql = `
                SELECT 
                    extension,
                    COUNT(*) AS telemetry_calls_count,
                    AVG(hold_seconds) AS avg_hold_sec,
                    SUM(hold_seconds) AS total_hold_sec,
                    SUM(hold_count) AS total_hold_count,
                    AVG(mute_seconds) AS avg_mute_sec,
                    SUM(mute_seconds) AS total_mute_sec,
                    AVG(wrap_up_seconds) AS avg_wrap_up_sec,
                    SUM(wrap_up_seconds) AS total_wrap_up_sec,
                    AVG(jitter_ms) AS avg_jitter_ms,
                    AVG(packet_loss_pct) AS avg_packet_loss_pct,
                    AVG(rtt_ms) AS avg_rtt_ms
                FROM asterisk.crm_call_telemetry
                WHERE 1=1
            `;
            const params = [];
            if (extension) {
                sql += ' AND extension = ?';
                params.push(extension);
            }
            if (from) {
                sql += ' AND created_at >= ?';
                params.push(from + ' 00:00:00');
            }
            if (to) {
                sql += ' AND created_at <= ?';
                params.push(to + ' 23:59:59');
            }
            sql += ' GROUP BY extension';

            const [rows] = await pool.query(sql, params);
            res.json({
                success: true,
                stats: rows || []
            });
        } catch (err) {
            console.error('[CRM Integration] Telemetry stats error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

module.exports = createCrmRouter;
