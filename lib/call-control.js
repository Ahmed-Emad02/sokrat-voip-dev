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

/**
 * Resolve channels involved in a call transfer for source extension
 * @param {string} conciseOutput Output from `core show channels concise`
 * @param {string} sourceExt Source extension number
 * @param {string} [activeChan] Known channel for source extension
 * @returns {{ sourceChan: string, channelToRedirect: string, isBridged: boolean }}
 */
function resolveTransferChannels(conciseOutput, sourceExt, activeChan) {
    const cleanSource = String(sourceExt || '').trim();
    const lines = String(conciseOutput || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    let sourceChan = String(activeChan || '').trim();
    let bridgeId = '';
    let directPeer = '';

    // 1. Identify source channel if not explicitly passed or verify it in lines
    for (const line of lines) {
        const parts = line.split('!');
        if (parts.length < 8) continue;
        const chan = parts[0].trim();
        const cid = parts[7].trim();
        const isTarget = (
            chan.startsWith(`PJSIP/${cleanSource}-`) ||
            chan.startsWith(`SIP/${cleanSource}-`) ||
            chan.startsWith(`IAX2/${cleanSource}-`) ||
            chan.startsWith(`Local/${cleanSource}@`) ||
            chan.includes(`/${cleanSource}-`) ||
            chan.includes(`/${cleanSource}@`) ||
            cid === cleanSource
        );

        if (isTarget) {
            if (!sourceChan || chan === sourceChan) {
                sourceChan = chan;
                if (parts.length >= 13) bridgeId = parts[12].trim();
                if (parts.length >= 12) {
                    const dp = parts[11].trim();
                    if (dp && dp !== '(None)' && dp !== 'None' && dp !== 'none') directPeer = dp;
                }
                break;
            }
        }
    }

    // 2. Case A: Bridged call (In Call) - resolve peer channel
    let peerChan = '';
    let isBridged = false;

    if (bridgeId && bridgeId !== '(None)' && bridgeId !== 'None' && bridgeId !== 'none') {
        for (const line of lines) {
            const parts = line.split('!');
            if (parts.length >= 13) {
                const chan = parts[0].trim();
                const bid = parts[12].trim();
                if (bid === bridgeId && chan !== sourceChan) {
                    peerChan = chan;
                    isBridged = true;
                    break;
                }
            }
        }
    }

    if (!peerChan && directPeer && directPeer !== sourceChan) {
        peerChan = directPeer;
        isBridged = true;
    }

    // 3. Case B: Unbridged / Ringing call - find caller channel dialing sourceExt
    if (!peerChan) {
        for (const line of lines) {
            const parts = line.split('!');
            if (parts.length < 7) continue;
            const chan = parts[0].trim();
            if (chan === sourceChan) continue;

            const exten = parts[2] ? parts[2].trim() : '';
            const app = parts[5] ? parts[5].trim() : '';
            const data = parts[6] ? parts[6].trim() : '';

            const isDialingTarget = (
                (app === 'Dial' || app === 'AppDial') &&
                (data.includes(`/${cleanSource}`) || data.includes(cleanSource) || exten === cleanSource)
            ) || (
                exten === cleanSource && (app === 'Dial' || app === 'AppDial' || !app)
            );

            if (isDialingTarget) {
                peerChan = chan;
                isBridged = false;
                break;
            }
        }
    }

    // Fallback: If still no peer found, but sourceChan exists and is caller (e.g. source dialed external)
    if (!peerChan && sourceChan) {
        for (const line of lines) {
            const parts = line.split('!');
            if (parts.length < 8) continue;
            const chan = parts[0].trim();
            if (chan === sourceChan) {
                const app = parts[5] ? parts[5].trim() : '';
                const data = parts[6] ? parts[6].trim() : '';
                // If sourceChan is executing Dial to another peer
                if (app === 'Dial' || app === 'AppDial') {
                    // Find destination channel
                    for (const oline of lines) {
                        const oparts = oline.split('!');
                        const ochan = oparts[0].trim();
                        if (ochan !== sourceChan && data.includes(ochan.split('-')[0])) {
                            peerChan = ochan;
                            break;
                        }
                    }
                }
                break;
            }
        }
    }

    return {
        sourceChan,
        channelToRedirect: peerChan || sourceChan,
        isBridged
    };
}

/**
 * Execute Call Transfer (Blind Transfer to destination extension)
 * @param {object} pool MySQL connection pool
 * @param {object|null} amiClient Asterisk Manager Interface client
 * @param {string} asteriskBin Path to asterisk binary
 * @param {object} params { sourceExt, destinationExt, activeCallsObj, conciseOutput }
 */
async function executeCallTransfer(pool, amiClient, asteriskBin, params) {
    const { sourceExt, destinationExt, activeCallsObj } = params || {};
    const cleanSource = String(sourceExt || '').trim();
    const cleanDst = String(destinationExt || '').trim();

    if (!/^\d{2,10}$/.test(cleanSource)) {
        throw new Error('Invalid source extension format');
    }
    if (!/^\+?\d{2,15}$/.test(cleanDst)) {
        throw new Error('Invalid destination extension format');
    }
    if (cleanSource === cleanDst) {
        throw new Error('Cannot transfer call to the same extension');
    }

    const activeCallsMap = typeof activeCallsObj === 'function' ? activeCallsObj() : activeCallsObj;
    let knownChan = '';
    if (activeCallsMap && activeCallsMap[cleanSource]) {
        knownChan = activeCallsMap[cleanSource].channel || '';
    }

    // Get channels snapshot from Asterisk CLI or params override
    const bin = asteriskBin || '/usr/sbin/asterisk';
    let conciseOutput = params?.conciseOutput !== undefined ? String(params.conciseOutput) : null;
    if (conciseOutput === null) {
        try {
            conciseOutput = await new Promise((resolve) => {
                execFile(bin, ['-rx', 'core show channels concise'], (err, stdout) => {
                    resolve(err ? '' : stdout || '');
                });
            });
        } catch (_) {
            conciseOutput = '';
        }
    }
    const { sourceChan, channelToRedirect, isBridged } = resolveTransferChannels(conciseOutput, cleanSource, knownChan);

    if (!channelToRedirect) {
        throw new Error(`No active call or channel found for extension ${cleanSource}`);
    }

    // Execute redirect via AMI or CLI fallback
    if (amiClient) {
        amiClient.write(`Action: Redirect\r\nChannel: ${channelToRedirect}\r\nContext: from-internal\r\nExten: ${cleanDst}\r\nPriority: 1\r\n\r\n`);
    } else {
        await new Promise((resolve, reject) => {
            execFile(bin, ['-rx', `channel redirect ${channelToRedirect} from-internal,${cleanDst},1`], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    // If call was in-call / bridged and sourceChan exists, ensure sourceChan hangs up
    if (isBridged && sourceChan && sourceChan !== channelToRedirect) {
        try {
            if (amiClient) {
                amiClient.write(`Action: Hangup\r\nChannel: ${sourceChan}\r\n\r\n`);
            } else {
                execFile(bin, ['-rx', `channel request hangup ${sourceChan}`], () => {});
            }
        } catch (_) {}
    }

    return {
        success: true,
        sourceExtension: cleanSource,
        destinationExtension: cleanDst,
        redirectedChannel: channelToRedirect,
        isBridged
    };
}

module.exports = {
    resolveDeviceChannel,
    executeCallSpy,
    executeCallHangup,
    executeCallHijack,
    executeCallTransfer,
    resolveTransferChannels
};
