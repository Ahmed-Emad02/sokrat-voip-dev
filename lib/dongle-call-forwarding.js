/**
 * GSM Dongle Call Forwarding MMI & 3GPP AT+CCFC Translation Engine
 * 
 * Implements 3GPP TS 22.030 §6.5.2 (Supplementary Services MMI syntax)
 * and 3GPP TS 27.007 §7.11 (AT+CCFC Call Forwarding AT command builder & parser)
 */

const SC_REASON_MAP = {
    '21': 0,   // Unconditional (CFU)
    '67': 1,   // Busy (CFB)
    '61': 2,   // No Reply (CFNRY)
    '62': 3,   // Not Reachable / Switched off (CFNRC)
    '002': 4,  // All Forwarding
    '004': 5   // All Conditional
};

const SC_NAMES = {
    '21': 'Call Forwarding Unconditional (CFU)',
    '0': 'Call Forwarding Unconditional (CFU)',
    '67': 'Call Forwarding on Busy (CFB)',
    '1': 'Call Forwarding on Busy (CFB)',
    '61': 'Call Forwarding on No Reply (CFNRY)',
    '2': 'Call Forwarding on No Reply (CFNRY)',
    '62': 'Call Forwarding on Not Reachable (CFNRC)',
    '3': 'Call Forwarding on Not Reachable (CFNRC)',
    '004': 'All Conditional Call Forwarding',
    '5': 'All Conditional Call Forwarding',
    '002': 'All Call Forwarding',
    '4': 'All Call Forwarding'
};

const CME_ERROR_MAP = {
    '256': 'Operation not allowed by carrier',
    '257': 'Carrier network rejected request (Call forwarding not provisioned on this SIM line or restricted by carrier tier)',
    '258': 'Temporary carrier network error, please retry',
    '259': 'Invalid forwarded-to phone number format',
    '260': 'Invalid subaddress format',
    '261': 'Number of forwarded-to numbers exceeded',
    '262': 'Forwarding scenario not supported by carrier',
    '263': 'Call forwarding subscription not provisioned on this SIM line',
    'network rejected request': 'Carrier network rejected request (Call forwarding not provisioned on this SIM line or restricted by carrier tier)'
};

/**
 * Parse an MMI string for Supplementary Services Call Forwarding.
 * Returns structured metadata or null if not an MMI call forwarding code.
 * 
 * @param {string} code 
 * @returns {object|null}
 */
function parseMmiCallForwardingDetails(code) {
    if (!code || typeof code !== 'string') return null;
    const clean = code.trim();

    // 1. Registration & Activation: **<SC>*<DN>[*<BS>[*<T>]]# (mode = 3)
    const regMatch = /^\*\*([0-9]{2,3})\*([+0-9]+)(?:\*([0-9]+)?(?:\*([0-9]+))?)?#$/.exec(clean);
    if (regMatch) {
        const sc = regMatch[1];
        if (SC_REASON_MAP[sc] === undefined) return null;
        const reason = SC_REASON_MAP[sc];
        const num = regMatch[2];
        const type = num.startsWith('+') ? 145 : 129;
        const time = regMatch[4] ? parseInt(regMatch[4], 10) : null;
        const atCmd = time ? `AT+CCFC=${reason},3,"${num}",${type},1,,,${time}` : `AT+CCFC=${reason},3,"${num}",${type},1`;
        return {
            atCmd,
            reason,
            serviceCode: sc,
            action: 'activate',
            mode: 3,
            number: num,
            type,
            delay: time
        };
    }

    // 2. Activation: *<SC>[*<DN>[*<BS>[*<T>]]]# (mode = 1)
    const actMatch = /^\*([0-9]{2,3})(?:\*([+0-9]+)(?:\*([0-9]+)?(?:\*([0-9]+))?)?)?#$/.exec(clean);
    if (actMatch) {
        const sc = actMatch[1];
        if (SC_REASON_MAP[sc] === undefined) return null;
        const reason = SC_REASON_MAP[sc];
        const num = actMatch[2];
        const time = actMatch[4] ? parseInt(actMatch[4], 10) : null;
        const type = num && num.startsWith('+') ? 145 : 129;
        const atCmd = num ? (time ? `AT+CCFC=${reason},1,"${num}",${type},1,,,${time}` : `AT+CCFC=${reason},1,"${num}",${type},1`) : `AT+CCFC=${reason},1`;
        return {
            atCmd,
            reason,
            serviceCode: sc,
            action: 'activate',
            mode: 1,
            number: num || null,
            type: num ? type : null,
            delay: time
        };
    }

    // 3. Deactivation: #<SC>[*<BS>]# (mode = 0)
    const deactMatch = /^#([0-9]{2,3})(?:\*[0-9]+)?#$/.exec(clean);
    if (deactMatch) {
        const sc = deactMatch[1];
        if (SC_REASON_MAP[sc] === undefined) return null;
        return {
            atCmd: `AT+CCFC=${SC_REASON_MAP[sc]},0`,
            reason: SC_REASON_MAP[sc],
            serviceCode: sc,
            action: 'cancel',
            mode: 0,
            number: null
        };
    }

    // 4. Erasure: ##<SC>[*<BS>]# (mode = 4)
    const eraseMatch = /^##([0-9]{2,3})(?:\*[0-9]+)?#$/.exec(clean);
    if (eraseMatch) {
        const sc = eraseMatch[1];
        if (SC_REASON_MAP[sc] === undefined) return null;
        return {
            atCmd: `AT+CCFC=${SC_REASON_MAP[sc]},4`,
            reason: SC_REASON_MAP[sc],
            serviceCode: sc,
            action: 'cancel',
            mode: 4,
            number: null
        };
    }

    // 5. Interrogation: *#<SC>[*<BS>]# (mode = 2)
    const queryMatch = /^\*#([0-9]{2,3})(?:\*[0-9]+)?#$/.exec(clean);
    if (queryMatch) {
        const sc = queryMatch[1];
        if (SC_REASON_MAP[sc] === undefined) return null;
        return {
            atCmd: `AT+CCFC=${SC_REASON_MAP[sc]},2`,
            reason: SC_REASON_MAP[sc],
            serviceCode: sc,
            action: 'query',
            mode: 2,
            number: null
        };
    }

    return null;
}

/**
 * Translate MMI call forwarding string to 3GPP TS 27.007 AT+CCFC command.
 * Returns null if not an MMI call forwarding code.
 * 
 * @param {string} code 
 * @returns {string|null}
 */
function parseMmiCallForwarding(code) {
    const details = parseMmiCallForwardingDetails(code);
    return details ? details.atCmd : null;
}

/**
 * Build 3GPP TS 27.007 AT+CCFC command and MMI code from structured parameters.
 * 
 * @param {object} params
 * @param {string} params.scenario - '21' | '67' | '61' | '62' | '004' | '002'
 * @param {string} params.action - 'activate' | 'query' | 'cancel'
 * @param {string} [params.number] - Target phone number (required for activate)
 * @param {number|string} [params.delay] - No answer timer in seconds (for 61/004)
 * @returns {object}
 */
function buildCallForwardingAtCommand({ scenario, action, number, delay }) {
    const sc = String(scenario || '21').trim();
    const reason = SC_REASON_MAP[sc] !== undefined ? SC_REASON_MAP[sc] : 0;
    const act = String(action || 'activate').toLowerCase().trim();
    const cleanNum = number ? String(number).trim() : '';

    if (act === 'query' || act === '2') {
        return {
            atCmd: `AT+CCFC=${reason},2`,
            mmiCode: `*#${sc}#`,
            scenario: sc,
            action: 'query',
            mode: 2,
            number: null
        };
    }

    if (act === 'cancel' || act === 'deactivate' || act === '0' || act === '4') {
        return {
            atCmd: `AT+CCFC=${reason},4`,
            mmiCode: `##${sc}#`,
            scenario: sc,
            action: 'cancel',
            mode: 4,
            number: null
        };
    }

    // Default: activate / register (mode 3)
    if (!cleanNum) {
        throw new Error('Forwarding destination phone number is required for activation');
    }
    const type = cleanNum.startsWith('+') ? 145 : 129;
    const cleanDelay = (sc === '61' || sc === '004') && delay ? parseInt(delay, 10) : null;
    const atCmd = cleanDelay
        ? `AT+CCFC=${reason},3,"${cleanNum}",${type},1,,,${cleanDelay}`
        : `AT+CCFC=${reason},3,"${cleanNum}",${type},1`;
    const mmiCode = cleanDelay
        ? `**${sc}*${cleanNum}**${cleanDelay}#`
        : `**${sc}*${cleanNum}#`;

    return {
        atCmd,
        mmiCode,
        scenario: sc,
        action: 'activate',
        mode: 3,
        number: cleanNum,
        type,
        delay: cleanDelay
    };
}

/**
 * Format raw AT+CCFC cellular responses into friendly, human-readable status text.
 * 
 * @param {string} rawText
 * @param {string|number} scenario
 * @param {string|number} action
 * @param {string} [number]
 * @returns {string}
 */
function formatCcfcResponse(rawText, scenario, action, number) {
    const sName = SC_NAMES[String(scenario)] || 'Call Forwarding';
    // Strip unsolicited Huawei modem notifications (^RSSI, ^MODE, ^DSFLOWRPT, ^BOOT, etc.)
    const cleanLines = String(rawText || '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('^'));
    const text = cleanLines.join('\n');

    // Check for carrier error
    if (text.includes('+CME ERROR:') || text.includes('+CMS ERROR:') || (text.includes('ERROR') && !text.includes('+CCFC:'))) {
        const cmeMatch = /\+CM[ES] ERROR:\s*(.+)/i.exec(text);
        let errMsg = '';
        if (cmeMatch && cmeMatch[1]) {
            const rawErr = cmeMatch[1].trim();
            errMsg = CME_ERROR_MAP[rawErr.toLowerCase()] || CME_ERROR_MAP[rawErr] || rawErr;
        } else {
            errMsg = 'Carrier network rejected request (Call forwarding not provisioned on this SIM line or restricted by carrier tier)';
        }
        return `${sName} Error: ${errMsg}`;
    }

    // Check query response
    if (action === 'query' || action === 2 || action === '2') {
        const lines = text.split('\n');
        const activeLines = [];
        let isAnyActive = false;

        for (const line of lines) {
            const m = /\+CCFC:\s*(\d+),(\d+)(?:,"([^"]*)",(\d+))?/.exec(line);
            if (m) {
                const status = parseInt(m[1], 10);
                const cls = parseInt(m[2], 10);
                const target = m[3];
                if (status === 1 && target) {
                    isAnyActive = true;
                    activeLines.push(`${sName}: ACTIVE -> ${target} (Voice)`);
                }
            }
        }

        if (isAnyActive) {
            return activeLines.join('\n');
        }

        if (text.includes('+CCFC: 0') || text.includes('+CCFC:0') || text.includes('OK')) {
            return `${sName}: INACTIVE`;
        }

        return `${sName}: ${text || 'INACTIVE'}`;
    }

    // Check activation / registration response
    if (action === 'activate' || action === 3 || action === '3' || action === 1 || action === '1') {
        if (/OK/i.test(text)) {
            return `${sName} registered and activated to ${number || 'target number'} (Status: OK)`;
        }
        return `${sName}: ${text}`;
    }

    // Check cancel / deactivation response
    if (action === 'cancel' || action === 0 || action === '0' || action === 4 || action === '4') {
        if (/OK/i.test(text)) {
            return `${sName}: Deactivated / Cancelled (Status: OK)`;
        }
        return `${sName}: ${text}`;
    }

    return `${sName}: ${text || 'Command executed'}`;
}

module.exports = {
    SC_REASON_MAP,
    CME_ERROR_MAP,
    SC_NAMES,
    parseMmiCallForwardingDetails,
    parseMmiCallForwarding,
    buildCallForwardingAtCommand,
    formatCcfcResponse
};
