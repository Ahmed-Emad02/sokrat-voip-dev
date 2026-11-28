'use strict';

// A chan_sip extension can also carry a WebRTC PJSIP endpoint with the same
// number (written to pjsip_custom.conf between "BEGIN/END WEBRTC EXTENSION"
// markers when the CRM desktop app pairs). FreePBX only dials what
// DEVICE/<ext>/dial says, so with the default "SIP/<ext>" the CRM app never
// rings. Fork the dial string so the SIP phone and the CRM app ring together.
//
// SIP must stay first: macro-dial-one only runs pjsipdial when the string
// starts with "PJSIP", and pjsipdial cuts on "/" which would break a forked
// "PJSIP/<ext>&SIP/<ext>" string.

const fs = require('fs');

const PJSIP_CUSTOM_CONF = '/etc/asterisk/pjsip_custom.conf';

function hasWebrtcEndpoint(ext, content) {
    const num = String(ext || '').trim();
    if (!/^\d+$/.test(num)) return false;
    let text = content;
    if (text === undefined) {
        try {
            text = fs.readFileSync(PJSIP_CUSTOM_CONF, 'utf8');
        } catch (_) {
            return false;
        }
    }
    return new RegExp(`^; BEGIN WEBRTC EXTENSION ${num}\\r?$`, 'm').test(text);
}

function withWebrtcFork(ext, dial, content) {
    const value = String(dial || '').trim();
    const num = String(ext || '').trim();
    if (value.toUpperCase() !== `SIP/${num}`) return value;
    if (!hasWebrtcEndpoint(num, content)) return value;
    return `${value}&PJSIP/${num}`;
}

async function ensureWebrtcDialFork(ext, execFileAsync, asteriskBin) {
    const num = String(ext || '').trim();
    if (!/^\d+$/.test(num)) return null;
    const { stdout } = await execFileAsync(asteriskBin, ['-rx', `database get DEVICE/${num} dial`]);
    const match = /^Value:\s*(.+?)\s*$/m.exec(stdout || '');
    if (!match) return null;
    const current = match[1];
    const next = withWebrtcFork(num, current);
    if (next !== current) {
        await execFileAsync(asteriskBin, ['-rx', `database put DEVICE/${num} dial "${next}"`]);
    }
    return next;
}

module.exports = { PJSIP_CUSTOM_CONF, hasWebrtcEndpoint, withWebrtcFork, ensureWebrtcDialFork };
