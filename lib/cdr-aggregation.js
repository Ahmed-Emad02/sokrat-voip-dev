/**
 * CDR Aggregation and Analytics Module
 * Handles logical call grouping (COALESCE(NULLIF(linkedid, ''), uniqueid)),
 * multi-leg CDR resolution, customer call history SQL pagination,
 * and extension statistics calculations with knownExtensions distinction.
 */

const moment = require('moment');
const { getPhoneVariants, extractPhoneFromClid, cleanPhoneString } = require('./phone-normalization');
const { createMediaId } = require('./recordings');

const TIMEZONE = 'Africa/Cairo';

/**
 * Group raw CDR rows by logical call ID: COALESCE(NULLIF(linkedid, ''), uniqueid)
 * Separates customerLeg, agentLeg, and recordingLeg independently.
 * @param {object[]} rows Raw CDR database rows
 * @param {object|string[]} options Context object { customerVariants, agentExtension, knownExtensions } or array of variants
 * @returns {object[]} Aggregated logical calls
 */
function aggregateCdrRows(rows, options = {}) {
    const customerVariants = Array.isArray(options) ? options : (options.customerVariants || []);
    const agentExtension = typeof options === 'object' && options.agentExtension ? String(options.agentExtension).trim() : '';
    const knownExtensions = (typeof options === 'object' && options.knownExtensions)
        ? new Set(Array.from(options.knownExtensions).map(String))
        : null;

    const variantSet = new Set(customerVariants.map(v => String(v).replace(/\D/g, '')));

    const groups = new Map();
    for (const row of rows) {
        const logicalId = (row.linkedid && row.linkedid.trim()) ? row.linkedid.trim() : row.uniqueid;
        if (!groups.has(logicalId)) groups.set(logicalId, []);
        groups.get(logicalId).push(row);
    }

    const logicalCalls = [];

    for (const [logicalId, legs] of groups.entries()) {
        legs.sort((a, b) => new Date(a.calldate) - new Date(b.calldate));
        const firstLeg = legs[0];

        // 1. recordingLeg: prefer leg with non-empty recordingfile + longest billsec
        const recordingLegs = legs.filter(l => l.recordingfile && l.recordingfile.trim());
        let recordingLeg = null;
        if (recordingLegs.length > 0) {
            recordingLegs.sort((a, b) => (Number(b.billsec) || 0) - (Number(a.billsec) || 0));
            recordingLeg = recordingLegs[0];
        }

        // 2. customerLeg & Direction determination
        let customerLeg = firstLeg;
        let direction = 'inbound';

        if (variantSet.size > 0) {
            const customerSrcLeg = legs.find(l => variantSet.has(String(l.src || l.cnum || '').replace(/\D/g, '')));
            const customerDstLeg = legs.find(l => variantSet.has(String(l.dst || l.did || '').replace(/\D/g, '')));

            if (customerSrcLeg) {
                customerLeg = customerSrcLeg;
                direction = 'inbound';
            } else if (customerDstLeg) {
                customerLeg = customerDstLeg;
                direction = 'outbound';
            }
        } else if (agentExtension) {
            const srcLeg = legs.find(l => l.src === agentExtension || l.cnum === agentExtension);
            const dstLeg = legs.find(l => l.dst === agentExtension);

            if (knownExtensions && knownExtensions.size > 0) {
                const srcExt = srcLeg ? srcLeg.src : (firstLeg.src || '');
                const dstExt = dstLeg ? dstLeg.dst : (firstLeg.dst || '');

                if (srcExt === agentExtension && knownExtensions.has(dstExt)) {
                    direction = 'internal';
                    customerLeg = srcLeg || firstLeg;
                } else if (srcExt === agentExtension && !knownExtensions.has(dstExt)) {
                    direction = 'outbound';
                    customerLeg = srcLeg || firstLeg;
                } else if (dstExt === agentExtension && knownExtensions.has(srcExt)) {
                    direction = 'internal';
                    customerLeg = dstLeg || firstLeg;
                } else if (dstExt === agentExtension && !knownExtensions.has(srcExt)) {
                    direction = 'inbound';
                    customerLeg = dstLeg || firstLeg;
                } else {
                    direction = 'internal';
                    customerLeg = firstLeg;
                }
            } else {
                // Fallback heuristic when knownExtensions is not provided
                if (srcLeg && !dstLeg) {
                    direction = 'outbound';
                    customerLeg = srcLeg;
                } else if (dstLeg && !srcLeg) {
                    direction = 'inbound';
                    customerLeg = dstLeg;
                } else {
                    direction = 'internal';
                    customerLeg = firstLeg;
                }
            }
        } else {
            const isSrcAgent = /^\d{2,5}$/.test(firstLeg.src);
            direction = isSrcAgent ? 'outbound' : 'inbound';
        }

        // 3. Customer number & Agent extension
        let customerNumber = '';
        let agentExt = '';
        let agentName = '';

        if (direction === 'inbound') {
            customerNumber = customerLeg.src || customerLeg.cnum || extractPhoneFromClid(customerLeg.clid);
            agentExt = customerLeg.dst;
            agentName = customerLeg.dst_name || '';
        } else if (direction === 'outbound') {
            customerNumber = customerLeg.dst;
            agentExt = customerLeg.src;
            agentName = customerLeg.src_name || '';
        } else {
            customerNumber = customerLeg.dst || customerLeg.src;
            agentExt = customerLeg.src;
            agentName = customerLeg.src_name || '';
        }

        // 4. Disposition & Durations
        const isAnswered = legs.some(l => (l.disposition || '').trim().toUpperCase() === 'ANSWERED');
        const finalDisposition = isAnswered ? 'ANSWERED' : (firstLeg.disposition || 'NO ANSWER').trim().toUpperCase();
        const durationSec = Math.max(...legs.map(l => Number(l.duration) || 0));
        const billsecSec = Math.max(...legs.map(l => Number(l.billsec) || 0));

        const hasRecording = Boolean(recordingLeg);
        const mediaId = hasRecording ? createMediaId(recordingLeg.uniqueid) : null;

        logicalCalls.push({
            id: logicalId,
            started_at: moment(firstLeg.calldate).format(),
            direction,
            customer_number: customerNumber,
            agent_extension: agentExt,
            agent_name: agentName,
            disposition: finalDisposition,
            duration_seconds: durationSec,
            billable_seconds: billsecSec,
            recording: {
                available: hasRecording,
                media_id: mediaId
            }
        });
    }

    logicalCalls.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    return logicalCalls;
}

/**
 * Fetch customer call history with normalized phone matching & SQL-level logical pagination
 * @param {object} pool MySQL connection pool
 * @param {object} params { phone, from, to, page, per_page }
 * @param {string} [countryCode='20']
 * @returns {Promise<object>} API Contract payload
 */
async function getCustomerCallHistory(pool, params, countryCode = '20') {
    const { phone, from, to } = params;
    if (!phone) {
        throw new Error('Phone number is required');
    }

    let page = parseInt(params.page, 10) || 1;
    let perPage = parseInt(params.per_page, 10) || 25;
    if (page < 1) page = 1;
    if (perPage < 1) perPage = 25;
    if (perPage > 100) perPage = 100;

    if (from && to && moment(to).isBefore(moment(from))) {
        throw new Error('End date cannot be before start date');
    }

    let variants = getPhoneVariants(phone, countryCode);
    if (!variants || variants.length === 0) {
        const fallback = cleanPhoneString(phone) || String(phone).trim();
        variants = fallback ? [fallback] : [String(phone)];
    }

    const whereClauses = [];
    const queryParams = [];

    const inPlaceholders = variants.map(() => '?').join(',');
    whereClauses.push(`(src IN (${inPlaceholders}) OR dst IN (${inPlaceholders}) OR cnum IN (${inPlaceholders}) OR did IN (${inPlaceholders}))`);
    queryParams.push(...variants, ...variants, ...variants, ...variants);

    if (from) {
        whereClauses.push('calldate >= ?');
        queryParams.push(moment(from).format('YYYY-MM-DD HH:mm:ss'));
    }
    if (to) {
        whereClauses.push('calldate <= ?');
        queryParams.push(moment(to).format('YYYY-MM-DD HH:mm:ss'));
    }

    const whereSql = whereClauses.join(' AND ');

    // 1. Count distinct logical call IDs
    const countSql = `
        SELECT COUNT(DISTINCT COALESCE(NULLIF(linkedid, ''), uniqueid)) AS total
        FROM asteriskcdrdb.cdr
        WHERE ${whereSql}
    `;
    const [countRows] = await pool.query(countSql, queryParams);
    const total = countRows[0] ? countRows[0].total : 0;
    const totalPages = Math.ceil(total / perPage) || 0;

    if (total === 0) {
        return {
            data: [],
            meta: {
                page,
                per_page: perPage,
                total: 0,
                total_pages: 0,
                timezone: TIMEZONE
            }
        };
    }

    // 2. Select distinct logical IDs for current page
    const offset = (page - 1) * perPage;
    const pagedIdsSql = `
        SELECT COALESCE(NULLIF(linkedid, ''), uniqueid) AS logical_id, MAX(calldate) AS max_date
        FROM asteriskcdrdb.cdr
        WHERE ${whereSql}
        GROUP BY logical_id
        ORDER BY max_date DESC
        LIMIT ? OFFSET ?
    `;
    const [pagedIdRows] = await pool.query(pagedIdsSql, [...queryParams, perPage, offset]);
    const logicalIds = pagedIdRows.map(r => r.logical_id);

    if (logicalIds.length === 0) {
        return {
            data: [],
            meta: {
                page,
                per_page: perPage,
                total,
                total_pages: totalPages,
                timezone: TIMEZONE
            }
        };
    }

    // 3. Fetch ALL legs for selected logical IDs
    const idPlaceholders = logicalIds.map(() => '?').join(',');
    const legsSql = `
        SELECT c.uniqueid, c.linkedid, c.calldate, c.src, c.dst, c.cnum, c.did, c.clid, c.duration, c.billsec, c.disposition, c.recordingfile,
               u_src.name AS src_name, u_dst.name AS dst_name
        FROM asteriskcdrdb.cdr c
        LEFT JOIN asterisk.users u_src ON u_src.extension = c.src
        LEFT JOIN asterisk.users u_dst ON u_dst.extension = c.dst
        WHERE COALESCE(NULLIF(c.linkedid, ''), c.uniqueid) IN (${idPlaceholders})
        ORDER BY c.calldate ASC
    `;
    const [legRows] = await pool.query(legsSql, logicalIds);
    const aggregated = aggregateCdrRows(legRows, { customerVariants: variants });

    return {
        data: aggregated,
        meta: {
            page,
            per_page: perPage,
            total,
            total_pages: totalPages,
            timezone: TIMEZONE
        }
    };
}

/**
 * Calculate detailed Extension Statistics for a given extension
 * @param {object} pool MySQL connection pool
 * @param {string} extension
 * @param {object} params { from, to, direction }
 * @returns {Promise<object>} Stats report payload
 */
async function getExtensionStats(pool, extension, params = {}) {
    const ext = String(extension || '').trim();
    if (!/^\d{1,10}$/.test(ext)) {
        throw new Error('Invalid extension format');
    }

    let fromDate = params.from ? moment(params.from) : moment().startOf('month');
    let toDate = params.to ? moment(params.to) : moment().endOf('day');

    if (!fromDate.isValid() || !toDate.isValid()) {
        throw new Error('Invalid date format');
    }
    if (toDate.isBefore(fromDate)) {
        throw new Error('End date cannot be before start date');
    }
    if (toDate.diff(fromDate, 'days') > 366) {
        throw new Error('Date range cannot exceed 366 days');
    }

    const directionFilter = (params.direction || 'all').toLowerCase();
    if (!['all', 'inbound', 'outbound'].includes(directionFilter)) {
        throw new Error('Invalid direction filter. Must be all, inbound, or outbound.');
    }

    let knownExtensions = new Set();
    if (pool) {
        try {
            const [extRows] = await pool.query("SELECT extension FROM asterisk.users WHERE extension REGEXP '^[0-9]+$'");
            knownExtensions = new Set(extRows.map(r => String(r.extension)));
        } catch (_) {}
    }

    const sql = `
        SELECT c.uniqueid, c.linkedid, c.calldate, c.src, c.dst, c.cnum, c.did, c.clid, c.duration, c.billsec, c.disposition, c.recordingfile,
               u_src.name AS src_name, u_dst.name AS dst_name
        FROM asteriskcdrdb.cdr c
        LEFT JOIN asterisk.users u_src ON u_src.extension = c.src
        LEFT JOIN asterisk.users u_dst ON u_dst.extension = c.dst
        WHERE c.calldate >= ? AND c.calldate <= ?
          AND (c.src = ? OR c.dst = ?)
        ORDER BY c.calldate ASC
    `;

    const [rows] = await pool.query(sql, [
        fromDate.format('YYYY-MM-DD HH:mm:ss'),
        toDate.format('YYYY-MM-DD HH:mm:ss'),
        ext,
        ext
    ]);

    const aggregated = aggregateCdrRows(rows, { agentExtension: ext, knownExtensions });

    let totalCalls = 0;
    let answeredCalls = 0;
    let inboundCalls = 0;
    let outboundCalls = 0;
    let internalCalls = 0;
    let inboundTalkSec = 0;
    let outboundTalkSec = 0;
    let totalTalkSec = 0;
    const uniqueContactsSet = new Set();
    const dispositionCounts = {};
    const dailyMap = new Map();

    const filtered = aggregated.filter(call => {
        if (directionFilter === 'inbound' && call.direction !== 'inbound') return false;
        if (directionFilter === 'outbound' && call.direction !== 'outbound') return false;
        return true;
    });

    for (const call of filtered) {
        totalCalls++;
        const isAnswered = call.disposition === 'ANSWERED';
        if (isAnswered) answeredCalls++;

        if (call.direction === 'outbound') {
            outboundCalls++;
            outboundTalkSec += call.billable_seconds;
        } else if (call.direction === 'inbound') {
            inboundCalls++;
            inboundTalkSec += call.billable_seconds;
        } else {
            internalCalls++;
        }

        totalTalkSec += call.billable_seconds;
        if (call.customer_number) {
            uniqueContactsSet.add(call.customer_number);
        }

        const disp = call.disposition || 'NO ANSWER';
        dispositionCounts[disp] = (dispositionCounts[disp] || 0) + 1;

        const dayKey = moment(call.started_at).format('YYYY-MM-DD');
        if (!dailyMap.has(dayKey)) {
            dailyMap.set(dayKey, { date: dayKey, total: 0, answered: 0, inbound: 0, outbound: 0, internal: 0 });
        }
        const dayStat = dailyMap.get(dayKey);
        dayStat.total++;
        if (isAnswered) dayStat.answered++;
        if (call.direction === 'outbound') dayStat.outbound++;
        else if (call.direction === 'inbound') dayStat.inbound++;
        else dayStat.internal++;
    }

    const answerRate = totalCalls > 0 ? Number(((answeredCalls / totalCalls) * 100).toFixed(1)) : 0;
    const avgTalkSec = answeredCalls > 0 ? Math.round(totalTalkSec / answeredCalls) : 0;

    return {
        extension: ext,
        from: fromDate.format(),
        to: toDate.format(),
        summary: {
            total_calls: totalCalls,
            answered_calls: answeredCalls,
            answer_rate_percent: answerRate,
            inbound_calls: inboundCalls,
            outbound_calls: outboundCalls,
            internal_calls: internalCalls,
            inbound_talk_seconds: inboundTalkSec,
            outbound_talk_seconds: outboundTalkSec,
            total_talk_seconds: totalTalkSec,
            avg_talk_seconds: avgTalkSec,
            unique_contacts_count: uniqueContactsSet.size
        },
        disposition_breakdown: dispositionCounts,
        daily_breakdown: Array.from(dailyMap.values()),
        recent_calls: filtered.slice(0, 50)
    };
}

module.exports = {
    aggregateCdrRows,
    getCustomerCallHistory,
    getExtensionStats
};
