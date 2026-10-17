#!/usr/bin/env node
/**
 * Sokrat VoIP - Enqueue Recording or Voicemail for STT Transcription
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const envFile = process.env.STT_ENV_FILE || '/etc/sokrat-voip/stt.env';
if (fs.existsSync(envFile)) {
    require('dotenv').config({ path: envFile, quiet: true });
}

function decodeBase64Env(value) {
    if (!value) return '';
    try { return Buffer.from(value, 'base64').toString('utf8'); } catch (_) { return ''; }
}

const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'asteriskuser',
    password: process.env.DB_PASS || decodeBase64Env(process.env.DB_PASS_B64),
    waitForConnections: true,
    connectionLimit: 2
};

const VM_ROOT = '/var/spool/asterisk/voicemail/default';
const MAX_PENDING_JOBS = Math.max(1, Number(process.env.STT_MAX_PENDING_JOBS || 20));

async function isQueueingEnabled(pool) {
    try {
        const [rows] = await pool.query('SELECT enabled, transcribe_calls, transcribe_voicemails FROM `asterisk`.`stt_settings` WHERE id = 1');
        if (rows?.length) return rows[0];
    } catch (_) {}
    return { enabled: 0, transcribe_calls: 0, transcribe_voicemails: 0 };
}

async function enqueueCall(uniqueid, recordingfile, language = 'auto') {
    if (!uniqueid || !recordingfile) {
        console.error('Usage: enqueue-stt.js call <uniqueid> <recordingfile> [language]');
        process.exit(1);
    }
    if (!DB_CONFIG.password) throw new Error(`A database password is required. Configure DB_PASS or DB_PASS_B64 in ${envFile}.`);
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
    if (!DB_CONFIG.password) throw new Error(`A database password is required. Configure DB_PASS or DB_PASS_B64 in ${envFile}.`);
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
    if (!DB_CONFIG.password) throw new Error(`A database password is required. Configure DB_PASS or DB_PASS_B64 in ${envFile}.`);
    const pool = mysql.createPool(DB_CONFIG);
    try {
        const settings = await isQueueingEnabled(pool);
        if (!Number(settings.enabled)) {
            console.log('[ENQUEUE-STT] Speech-to-Text is disabled; scan skipped.');
            return { callCount: 0, voicemailCount: 0 };
        }
        // 1. Scan active voicemails first so they cannot be starved by a call backlog.
        let vmCount = 0;
        if (Number(settings.transcribe_voicemails) && fs.existsSync(VM_ROOT)) {
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
                        const [[queueState]] = await pool.query(`
                            SELECT
                                (SELECT COUNT(*) FROM \`asteriskcdrdb\`.\`cdr_transcriptions\` WHERE status IN ('pending', 'processing')) +
                                (SELECT COUNT(*) FROM \`asteriskcdrdb\`.\`voicemail_transcriptions\` WHERE status IN ('pending', 'processing')) AS queued
                        `);
                        if (Number(queueState?.queued || 0) >= MAX_PENDING_JOBS) break;
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

        // 2. Fill the remaining bounded queue with recent call recordings.
        const [[queueState]] = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM \`asteriskcdrdb\`.\`cdr_transcriptions\` WHERE status IN ('pending', 'processing')) +
                (SELECT COUNT(*) FROM \`asteriskcdrdb\`.\`voicemail_transcriptions\` WHERE status IN ('pending', 'processing')) AS queued
        `);
        const capacity = Math.max(0, MAX_PENDING_JOBS - Number(queueState?.queued || 0));
        let callCount = 0;
        if (Number(settings.transcribe_calls) && capacity > 0) {
            const [recentCalls] = await pool.query(`
                SELECT c.uniqueid, MAX(c.recordingfile) AS recordingfile, MAX(c.duration) AS duration, MAX(c.calldate) AS latest_calldate
                FROM \`asteriskcdrdb\`.\`cdr\` c
                LEFT JOIN \`asteriskcdrdb\`.\`cdr_transcriptions\` t ON t.uniqueid = c.uniqueid
                WHERE c.recordingfile IS NOT NULL
                  AND c.recordingfile != ''
                  AND (c.billsec >= 3 OR c.duration >= 3)
                  AND c.calldate >= NOW() - INTERVAL 7 DAY
                  AND t.id IS NULL
                GROUP BY c.uniqueid
                ORDER BY latest_calldate DESC
                LIMIT ?
            `, [capacity]);
            for (const call of recentCalls) {
                const [insert] = await pool.query(`
                    INSERT INTO \`asteriskcdrdb\`.\`cdr_transcriptions\` (uniqueid, recordingfile, status, transcript)
                    VALUES (?, ?, 'pending', '')
                    ON DUPLICATE KEY UPDATE status = status
                `, [call.uniqueid, call.recordingfile]);
                if (insert.affectedRows === 1) callCount++;
            }
        }
        console.log(`[ENQUEUE-STT] Auto-scanned: Enqueued ${callCount} call(s) and ${vmCount} voicemail(s).`);
        return { callCount, voicemailCount: vmCount };
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
