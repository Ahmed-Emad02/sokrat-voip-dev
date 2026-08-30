#!/usr/bin/env node
/**
 * Sokrat VoIP - Enqueue Recording or Voicemail for STT Transcription
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'asteriskuser',
    password: process.env.DB_PASS || 'admin',
    waitForConnections: true,
    connectionLimit: 2
};

const VM_ROOT = '/var/spool/asterisk/voicemail/default';

async function enqueueCall(uniqueid, recordingfile, language = 'auto') {
    if (!uniqueid || !recordingfile) {
        console.error('Usage: enqueue-stt.js call <uniqueid> <recordingfile> [language]');
        process.exit(1);
    }
    const pool = mysql.createPool(DB_CONFIG);
    try {
        await pool.query(`
            INSERT INTO \`asteriskcdrdb\`.\`cdr_transcriptions\` (uniqueid, recordingfile, language, status, transcript)
            VALUES (?, ?, ?, 'pending', '')
            ON DUPLICATE KEY UPDATE
                recordingfile = VALUES(recordingfile),
                status = IF(status = 'completed', status, 'pending')
        `, [uniqueid, recordingfile, language || 'auto']);
        console.log(`[ENQUEUE-STT] Enqueued call recording: ${uniqueid} (${recordingfile})`);
    } finally {
        await pool.end();
    }
}

async function enqueueVoicemail(mailbox, msgFile, callerid = '') {
    if (!mailbox || !msgFile) {
        console.error('Usage: enqueue-stt.js voicemail <mailbox> <msgFile> [callerid]');
        process.exit(1);
    }
    const pool = mysql.createPool(DB_CONFIG);
    try {
        await pool.query(`
            INSERT INTO \`asteriskcdrdb\`.\`voicemail_transcriptions\` (mailbox, msg_file, callerid, status, transcript)
            VALUES (?, ?, ?, 'pending', '')
            ON DUPLICATE KEY UPDATE
                callerid = VALUES(callerid),
                status = IF(status = 'completed', status, 'pending')
        `, [mailbox, msgFile, callerid]);
        console.log(`[ENQUEUE-STT] Enqueued voicemail: ${mailbox}/${msgFile}`);
    } finally {
        await pool.end();
    }
}

async function scanAndEnqueueUntranscribed() {
    const pool = mysql.createPool(DB_CONFIG);
    try {
        // 1. Scan calls with recordings from the last 7 days that don't have transcriptions
        const [recentCalls] = await pool.query(`
            SELECT c.uniqueid, c.recordingfile, c.duration
            FROM \`asteriskcdrdb\`.\`cdr\` c
            LEFT JOIN \`asteriskcdrdb\`.\`cdr_transcriptions\` t ON t.uniqueid = c.uniqueid
            WHERE c.recordingfile IS NOT NULL
              AND c.recordingfile != ''
              AND (c.billsec >= 3 OR c.duration >= 3)
              AND t.id IS NULL
            ORDER BY c.calldate DESC
            LIMIT 50
        `);

        let callCount = 0;
        for (const call of recentCalls) {
            await pool.query(`
                INSERT INTO \`asteriskcdrdb\`.\`cdr_transcriptions\` (uniqueid, recordingfile, status, transcript)
                VALUES (?, ?, 'pending', '')
                ON DUPLICATE KEY UPDATE status = status
            `, [call.uniqueid, call.recordingfile]);
            callCount++;
        }

        // 2. Scan active voicemails
        let vmCount = 0;
        if (fs.existsSync(VM_ROOT)) {
            const mailboxes = fs.readdirSync(VM_ROOT);
            for (const mb of mailboxes) {
                const inbox = path.join(VM_ROOT, mb, 'INBOX');
                if (!fs.existsSync(inbox)) continue;
                const files = fs.readdirSync(inbox).filter(f => f.endsWith('.txt'));
                for (const txtFile of files) {
                    const base = txtFile.replace(/\.txt$/, '');
                    const audioFile = `${base}.wav`;
                    const [existing] = await pool.query(
                        'SELECT id FROM `asteriskcdrdb`.`voicemail_transcriptions` WHERE mailbox = ? AND msg_file = ?',
                        [mb, audioFile]
                    );
                    if (!existing || existing.length === 0) {
                        await pool.query(`
                            INSERT INTO \`asteriskcdrdb\`.\`voicemail_transcriptions\` (mailbox, msg_file, status, transcript)
                            VALUES (?, ?, 'pending', '')
                            ON DUPLICATE KEY UPDATE status = status
                        `, [mb, audioFile]);
                        vmCount++;
                    }
                }
            }
        }
        console.log(`[ENQUEUE-STT] Auto-scanned: Enqueued ${callCount} call(s) and ${vmCount} voicemail(s).`);
    } finally {
        await pool.end();
    }
}

async function main() {
    const action = process.argv[2];
    if (action === 'call') {
        await enqueueCall(process.argv[3], process.argv[4], process.argv[5]);
    } else if (action === 'voicemail') {
        await enqueueVoicemail(process.argv[3], process.argv[4], process.argv[5]);
    } else if (action === 'scan') {
        await scanAndEnqueueUntranscribed();
    } else {
        console.log('Usage: enqueue-stt.js [call|voicemail|scan] ...');
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('[ENQUEUE-STT] Error:', err.message);
        process.exit(1);
    });
}

module.exports = {
    enqueueCall,
    enqueueVoicemail,
    scanAndEnqueueUntranscribed
};
