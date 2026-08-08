#!/usr/bin/env node
const { exec } = require('child_process');
const mysql = require('/opt/sokrat-voip/node_modules/mysql2/promise');
require('/opt/sokrat-voip/node_modules/dotenv').config({ path: '/opt/sokrat-voip/.env' });

const ASTERISK_BIN = process.env.ASTERISK_BIN || '/usr/sbin/asterisk';

async function main() {
    const hostExt = String(process.argv[2] || '').trim();
    const roomId = String(process.argv[3] || '').trim();

    if (!hostExt || !roomId) {
        console.error('Usage: node trigger-intercom-code.js <hostExt> <roomId>');
        process.exit(1);
    }

    try {
        // 1. Fetch live channels concise to find busy extensions
        const activeChannelsOutput = await new Promise(resolve => {
            exec(`${ASTERISK_BIN} -rx "core show channels concise"`, (err, stdout) => resolve(stdout || ''));
        });

        const busyExts = new Set();
        const lines = activeChannelsOutput.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split('!');
            const chan = parts[0] || '';
            const m = chan.match(/^(?:SIP|PJSIP|IAX2|Local)\/(?:loc_)?(\d{2,5})(?:[-@:;]|$)/i);
            if (m) busyExts.add(m[1]);
        }

        // 2. Fetch online SIP peers from Asterisk CLI
        const sipPeersOutput = await new Promise(resolve => {
            exec(`${ASTERISK_BIN} -rx "sip show peers"`, (err, stdout) => resolve(stdout || ''));
        });

        const onlineExts = new Set();
        const peerLines = sipPeersOutput.split('\n');
        for (const line of peerLines) {
            const match = line.trim().match(/^(\d{2,5})\/\d+/);
            if (match && line.includes('OK')) {
                onlineExts.add(match[1]);
            }
        }

        // Also check pjsip contacts if pjsip is used
        const pjsipOutput = await new Promise(resolve => {
            exec(`${ASTERISK_BIN} -rx "pjsip show contacts"`, (err, stdout) => resolve(stdout || ''));
        });
        const pjsipLines = pjsipOutput.split('\n');
        for (const line of pjsipLines) {
            const match = line.trim().match(/Contact:\s*(\d{2,5})\//);
            if (match && line.includes('Avail')) {
                onlineExts.add(match[1]);
            }
        }

        // 3. Filter targets: must be online, NOT busy, NOT hostExt
        const targetsToCall = [];
        for (const ext of onlineExts) {
            if (ext === hostExt) continue;
            if (busyExts.has(ext)) continue;
            targetsToCall.push(ext);
        }

        console.log(`Mass Intercom Triggered by ${hostExt} for Room ${roomId}. Targets to call: ${targetsToCall.join(', ') || 'None'}`);

        // 4. Originate calls for each target extension
        for (const targetExt of targetsToCall) {
            const targetChan = `Local/${targetExt}@from-intercom-autoanswer`;
            const cmd = `${ASTERISK_BIN} -rx "channel originate ${targetChan} extension ${roomId}@from-intercom-conf"`;
            exec(cmd, (err) => {
                if (err) console.error(`Failed to originate intercom call to ${targetExt}:`, err.message);
                else console.log(`Originated intercom call to ${targetExt} into room ${roomId}`);
            });
        }
    } catch (err) {
        console.error('Error in trigger-intercom-code.js:', err.message);
    }
}

main();
