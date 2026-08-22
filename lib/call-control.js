/**
 * Shared Call-Control Service Module
 * Handles Call Spy (Listen, Whisper, Barge), Hijack, and Hangup operations
 * for both Sokrat UI routes and CRM Live actions.
 */

const { execFile } = require('child_process');

/**
 * Resolve device dial string (e.g. PJSIP/101 or SIP/101) from Asterisk devices table
 * @param {object} pool MySQL connection pool
 * @param {string} ext Extension number
 * @returns {Promise<string>} Dial channel string
 */
async function resolveDeviceChannel(pool, ext) {
    const cleanExt = String(ext || '').trim();
    if (!/^\d{2,10}$/.test(cleanExt)) return `PJSIP/${cleanExt}`;
    try {
        const [rows] = await pool.query('SELECT dial, tech FROM `asterisk`.`devices` WHERE id = ?', [cleanExt]);
        if (rows.length > 0 && rows[0].dial) {
            return rows[0].dial;
        }
    } catch (_) {}
    return `PJSIP/${cleanExt}`;
}

/**
 * Execute Call Spy (Listen 222, Whisper 223, Barge 224)
 * @param {object} pool
 * @param {object|null} amiClient
 * @param {string} asteriskBin
 * @param {object} params { supervisorExt, targetExt, mode }
 */
async function executeCallSpy(pool, amiClient, asteriskBin, params) {
    const { supervisorExt, targetExt, mode } = params;
    const cleanSup = String(supervisorExt || '').trim();
    const cleanTarget = String(targetExt || '').trim();

    if (!/^\d{2,10}$/.test(cleanSup) || !/^\d{2,10}$/.test(cleanTarget)) {
        throw new Error('Invalid extension format');
    }

    const spyPrefixMap = { listen: '222', whisper: '223', barge: '224' };
    const prefix = spyPrefixMap[mode] || '222';
    const spyExten = `${prefix}${cleanTarget}`;

    const supervisorChan = await resolveDeviceChannel(pool, cleanSup);

    if (amiClient) {
        amiClient.write(`Action: Originate\r\nChannel: ${supervisorChan}\r\nContext: from-internal\r\nExten: ${spyExten}\r\nPriority: 1\r\nCallerID: "Call Spy" <${spyExten}>\r\nVariable: __SIPADDHEADER=X-Call-Purpose: Monitoring\r\nAsync: true\r\n\r\n`);
    } else {
        await new Promise((resolve, reject) => {
            execFile(asteriskBin || '/usr/sbin/asterisk', ['-rx', `channel originate ${supervisorChan} extension ${spyExten}@from-internal`], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }
}

/**
 * Execute Call Hangup
 * @param {object|null} amiClient
 * @param {string} asteriskBin
 * @param {object|function} activeCallsObj Map or function returning activeCalls
 * @param {string} targetExt
 */
async function executeCallHangup(amiClient, asteriskBin, activeCallsObj, targetExt) {
    const cleanTarget = String(targetExt || '').trim();
    const activeCallsMap = typeof activeCallsObj === 'function' ? activeCallsObj() : activeCallsObj;
    
    let targetChan = null;
    if (activeCallsMap && activeCallsMap[cleanTarget]) {
        targetChan = activeCallsMap[cleanTarget].channel;
    }

    if (!targetChan) {
        throw new Error(`No active call channel found for extension ${cleanTarget}`);
    }

    if (amiClient) {
        amiClient.write(`Action: Hangup\r\nChannel: ${targetChan}\r\n\r\n`);
    } else {
        await new Promise((resolve, reject) => {
            execFile(asteriskBin || '/usr/sbin/asterisk', ['-rx', `channel request hangup ${targetChan}`], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }
}

/**
 * Execute Call Hijack (Steal Call 225)
 * @param {object} pool
 * @param {object|null} amiClient
 * @param {string} asteriskBin
 * @param {object} params { supervisorExt, targetExt, activeCallsObj }
 */
async function executeCallHijack(pool, amiClient, asteriskBin, params) {
    const { supervisorExt, targetExt, activeCallsObj } = params || {};
    const cleanSup = String(supervisorExt || '').trim();
    const cleanTarget = String(targetExt || '').trim();

    if (!/^\d{2,10}$/.test(cleanSup) || !/^\d{2,10}$/.test(cleanTarget)) {
        throw new Error('Invalid extension format');
    }

    if (activeCallsObj) {
        const activeCallsMap = typeof activeCallsObj === 'function' ? activeCallsObj() : activeCallsObj;
        if (activeCallsMap && !activeCallsMap[cleanTarget]) {
            throw new Error(`No active call found for extension ${cleanTarget}`);
        }
    }

    const hijackExten = `225${cleanTarget}`;
    const supervisorChan = await resolveDeviceChannel(pool, cleanSup);

    if (amiClient) {
        amiClient.write(`Action: Originate\r\nChannel: ${supervisorChan}\r\nContext: from-internal\r\nExten: ${hijackExten}\r\nPriority: 1\r\nCallerID: "Call Hijack" <${hijackExten}>\r\nVariable: __SIPADDHEADER=X-Call-Purpose: Monitoring\r\nAsync: true\r\n\r\n`);
    } else {
        await new Promise((resolve, reject) => {
            execFile(asteriskBin || '/usr/sbin/asterisk', ['-rx', `channel originate ${supervisorChan} extension ${hijackExten}@from-internal`], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }
}

module.exports = {
    resolveDeviceChannel,
    executeCallSpy,
    executeCallHangup,
    executeCallHijack
};
