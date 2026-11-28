'use strict';

// Dual-mode extensions: a chan_sip extension (desk phone / MicroSIP) can also
// carry a WebRTC PJSIP endpoint with the same number for the CRM desktop app
// and the Sokrat mobile app. That endpoint lives in pjsip_custom.conf between
// "BEGIN/END WEBRTC EXTENSION <ext>" markers.
//
// FreePBX rings a user by walking AMPUSER/<ext>/device ("&"-separated device
// ids) and dialing DEVICE/<id>/dial for each. Instead of forking the SIP
// device's dial string, the WebRTC endpoint is added to that list as its own
// device "<ext>-webrtc" with dial "PJSIP/<ext>". macro-dial-one then expands
// it through PJSIP_DIAL_CONTACTS at call time, so every registered app (CRM
// desktop and mobile) rings, and FreePBX features that walk the device list
// (targeted ChanSpy, DND/CF device states) keep working.
//
// Pure PJSIP/WebRTC extensions (DEVICE/<ext>/tech = pjsip) already ring all
// their contacts and are left untouched, as is the mobile wake path that
// depends on that tech.

const fs = require('fs');

const PJSIP_CUSTOM_CONF = '/etc/asterisk/pjsip_custom.conf';
const WEBRTC_DEVICE_SUFFIX = '-webrtc';

const isExtension = (ext) => /^\d+$/.test(String(ext || '').trim());

function webrtcDeviceId(ext) {
    return `${String(ext).trim()}${WEBRTC_DEVICE_SUFFIX}`;
}

function readPjsipCustom(content) {
    if (content !== undefined) return content;
    try {
        return fs.readFileSync(PJSIP_CUSTOM_CONF, 'utf8');
    } catch (_) {
        return '';
    }
}

function webrtcLineExtensions(content) {
    const text = readPjsipCustom(content);
    const found = new Set();
    for (const match of text.matchAll(/^; BEGIN WEBRTC EXTENSION (\d+)\r?$/gm)) found.add(match[1]);
    return found;
}

function hasWebrtcEndpoint(ext, content) {
    if (!isExtension(ext)) return false;
    return webrtcLineExtensions(content).has(String(ext).trim());
}

function buildWebrtcLineBlock({ ext, password, displayName }) {
    const startMarker = `; BEGIN WEBRTC EXTENSION ${ext}`;
    const endMarker = `; END WEBRTC EXTENSION ${ext}`;
    return `\n${startMarker}\n[${ext}]\ntype = endpoint\ncontext = from-internal\ndisallow = all\nallow = opus,ulaw,alaw\ndtls_auto_generate_cert = yes\nwebrtc = yes\ndirect_media = no\nrtp_symmetric = yes\nmedia_encryption = dtls\ndtls_verify = fingerprint\ndtls_setup = actpass\nice_support = yes\nuse_avpf = yes\nrtcp_mux = yes\nforce_rport = yes\nrewrite_contact = yes\nrtp_timeout = 30\nrtp_timeout_hold = 60\nrtp_keepalive = 5\ntimers = yes\ntimers_min_se = 90\ntimers_sess_expires = 1800\nauth = ${ext}-auth\naors = ${ext}\ncallerid = ${displayName || ext} <${ext}>\n\n[${ext}-auth]\ntype = auth\nauth_type = userpass\nusername = ${ext}\npassword = ${password}\n\n[${ext}]\ntype = aor\nmax_contacts = 10\nremove_existing = no\nremove_unavailable = yes\nqualify_frequency = 30\nqualify_timeout = 5\n${endMarker}\n`;
}

// Replace the auth password inside the managed block for <ext>. Returns the
// new content and whether anything changed; content outside the block is
// never touched.
function setWebrtcLinePassword(content, ext, password) {
    const pass = String(password || '').trim();
    if (!isExtension(ext) || !pass || /\s/.test(pass)) return { content, changed: false };
    const block = new RegExp(`(; BEGIN WEBRTC EXTENSION ${ext}\\r?\\n)([\\s\\S]*?)(; END WEBRTC EXTENSION ${ext})`);
    const match = block.exec(content);
    if (!match) return { content, changed: false };
    const auth = new RegExp(`(\\[${ext}-auth\\][\\s\\S]*?^password\\s*=\\s*)(\\S*)`, 'm');
    const authMatch = auth.exec(match[2]);
    if (!authMatch || authMatch[2] === pass) return { content, changed: false };
    const body = match[2].replace(auth, `$1${pass}`);
    return { content: content.replace(block, `$1${body}$3`), changed: true };
}

// Parse `asterisk -rx "database show <family>"` output into { key: value },
// keys without the leading slash, e.g. "AMPUSER/111/device".
function parseAstdb(stdout) {
    const out = {};
    for (const line of String(stdout || '').split('\n')) {
        const match = /^\/(\S+?)\s*:\s?(.*?)\s*$/.exec(line);
        if (match) out[match[1]] = match[2];
    }
    return out;
}

function webrtcDeviceCommands(ext) {
    const id = webrtcDeviceId(ext);
    return [
        `database put DEVICE/${id} dial "PJSIP/${ext}"`,
        `database put DEVICE/${id} tech "pjsip"`,
        `database put DEVICE/${id} user "${ext}"`,
        `database put DEVICE/${id} default_user "${ext}"`,
        `database put DEVICE/${id} type "fixed"`
    ];
}

// Device list for AMPUSER/<ext>/device with the WebRTC device added or
// removed; other device ids keep their order.
function deviceList(ext, current, withWebrtc) {
    const id = webrtcDeviceId(ext);
    const devices = String(current || '').split('&').map(s => s.trim()).filter(Boolean).filter(d => d !== id);
    if (!devices.length) {
        // Virtual extensions have no device; never invent one for them. A
        // list that only held the WebRTC device falls back to the extension.
        const hadWebrtcOnly = String(current || '').split('&').map(s => s.trim()).includes(id);
        if (!withWebrtc) return hadWebrtcOnly ? String(ext) : current;
        devices.push(String(ext));
    }
    if (withWebrtc) devices.push(id);
    return devices.join('&');
}

// Compute the AstDB commands that bring every extension in line with its
// WebRTC line. Pure: takes parsed AMPUSER/DEVICE trees and the set of
// extensions with a managed block.
function planWebrtcDeviceSync({ ampuser, device, lineExts, only }) {
    const commands = [];
    const exts = new Set();
    for (const key of Object.keys(ampuser)) {
        const match = /^AMPUSER\/(\d+)\/device$/.exec(key);
        if (match) exts.add(match[1]);
    }
    const wantedDevices = new Set();
    for (const ext of exts) {
        if (only && ext !== String(only)) continue;
        const id = webrtcDeviceId(ext);
        const tech = String(device[`DEVICE/${ext}/tech`] || '').toLowerCase();
        const want = lineExts.has(ext) && tech === 'sip';
        // Undo the earlier "SIP/<ext>&PJSIP/<ext>" fork; the device list
        // replaces it.
        if (device[`DEVICE/${ext}/dial`] === `SIP/${ext}&PJSIP/${ext}`) {
            commands.push(`database put DEVICE/${ext} dial "SIP/${ext}"`);
        }
        if (want) {
            wantedDevices.add(id);
            const expected = { dial: `PJSIP/${ext}`, tech: 'pjsip', user: ext, default_user: ext, type: 'fixed' };
            if (Object.entries(expected).some(([k, v]) => device[`DEVICE/${id}/${k}`] !== v)) {
                commands.push(...webrtcDeviceCommands(ext));
            }
        }
        const current = ampuser[`AMPUSER/${ext}/device`];
        const next = deviceList(ext, current, want);
        if (next !== current) commands.push(`database put AMPUSER ${ext}/device "${next}"`);
        if (!want && Object.keys(device).some(k => k.startsWith(`DEVICE/${id}/`))) {
            commands.push(`database deltree DEVICE/${id}`);
        }
    }
    if (!only) {
        // WebRTC devices whose extension no longer exists.
        const orphans = new Set();
        for (const key of Object.keys(device)) {
            const match = new RegExp(`^DEVICE/(\\d+)${WEBRTC_DEVICE_SUFFIX}/`).exec(key);
            if (match && !exts.has(match[1])) orphans.add(webrtcDeviceId(match[1]));
        }
        for (const id of orphans) if (!wantedDevices.has(id)) commands.push(`database deltree DEVICE/${id}`);
    }
    return commands;
}

async function reconcileWebrtcDevices(execFileAsync, asteriskBin, { only = null, content } = {}) {
    if (only !== null && !isExtension(only)) return [];
    const show = async (family) => {
        const result = await execFileAsync(asteriskBin, ['-rx', `database show ${family}`]);
        return parseAstdb(typeof result === 'string' ? result : result && result.stdout);
    };
    const ampuser = await show(only ? `AMPUSER/${only}` : 'AMPUSER');
    const device = await show('DEVICE');
    const commands = planWebrtcDeviceSync({ ampuser, device, lineExts: webrtcLineExtensions(content), only: only && String(only) });
    for (const command of commands) {
        await execFileAsync(asteriskBin, ['-rx', command]);
    }
    return commands;
}

module.exports = {
    PJSIP_CUSTOM_CONF,
    WEBRTC_DEVICE_SUFFIX,
    webrtcDeviceId,
    webrtcLineExtensions,
    hasWebrtcEndpoint,
    buildWebrtcLineBlock,
    setWebrtcLinePassword,
    parseAstdb,
    webrtcDeviceCommands,
    deviceList,
    planWebrtcDeviceSync,
    reconcileWebrtcDevices
};
