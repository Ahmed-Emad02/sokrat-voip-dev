#!/usr/bin/env node
/**
 * Sokrat VoIP - Local Speech-To-Text (STT) Background Worker
 * Powered by whisper.cpp (Local On-Premise AI Transcription)
 */

const mysql = require('mysql2/promise');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'asteriskuser',
    password: process.env.DB_PASS || 'admin',
    waitForConnections: true,
    connectionLimit: 4
};

const WHISPER_BIN = '/usr/local/bin/whisper-cli';
const MODELS_DIR = '/opt/whisper.cpp/models';
const MONITOR_ROOT = '/var/spool/asterisk/monitor';
const VM_ROOT = '/var/spool/asterisk/voicemail/default';

let isRunning = true;
let isBusy = false;

function execFileAsync(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(file, args, options, (err, stdout, stderr) => {
            if (err) {
                return reject(new Error(`${err.message} - Stderr: ${stderr || ''}`));
            }
            resolve({ stdout, stderr });
        });
    });
}

function resolveCallAudioPath(rawRecordingFile, callDate) {
    if (!rawRecordingFile) return null;
    const cleanName = path.basename(rawRecordingFile);
    const dateObj = callDate ? new Date(callDate) : null;

    const candidatePaths = [];

    // 1. Direct path
    if (path.isAbsolute(rawRecordingFile) && fs.existsSync(rawRecordingFile)) {
        return rawRecordingFile;
    }

    // 2. Date-based monitor structure /var/spool/asterisk/monitor/YYYY/MM/DD/file
    if (dateObj && !isNaN(dateObj.getTime())) {
        const y = String(dateObj.getFullYear());
        const m = String(dateObj.getMonth() + 1).padStart(2, '0');
        const d = String(dateObj.getDate()).padStart(2, '0');
        candidatePaths.push(path.join(MONITOR_ROOT, y, m, d, cleanName));
        candidatePaths.push(path.join(MONITOR_ROOT, y, m, d, cleanName.replace(/\.[^.]+$/, '.wav')));
        candidatePaths.push(path.join(MONITOR_ROOT, y, m, d, cleanName.replace(/\.[^.]+$/, '.mp3')));
        candidatePaths.push(path.join(MONITOR_ROOT, y, m, d, cleanName.replace(/\.[^.]+$/, '.WAV')));
    }

    // 3. Flat monitor root
    candidatePaths.push(path.join(MONITOR_ROOT, cleanName));
    candidatePaths.push(path.join(MONITOR_ROOT, cleanName.replace(/\.[^.]+$/, '.wav')));
    candidatePaths.push(path.join(MONITOR_ROOT, cleanName.replace(/\.[^.]+$/, '.mp3')));
    candidatePaths.push(path.join(MONITOR_ROOT, cleanName.replace(/\.[^.]+$/, '.WAV')));

    for (const p of candidatePaths) {
        if (fs.existsSync(p)) return p;
    }

    // 4. Recursive search fallback
    try {
        const found = execFileSync('find', [MONITOR_ROOT, '-name', cleanName, '-type', 'f'], { encoding: 'utf8', timeout: 3000 }).trim();
        if (found) {
            const first = found.split('\n')[0];
            if (first && fs.existsSync(first)) return first;
        }
    } catch (_) {}

    return null;
}

function resolveVoicemailAudioPath(mailbox, msgFile) {
    if (!mailbox || !msgFile) return null;
    const baseName = msgFile.replace(/\.[^.]+$/, '');
    const inbox = path.join(VM_ROOT, String(mailbox), 'INBOX');
    const extensions = ['.wav', '.WAV', '.mp3', '.gsm', '.sln'];

    for (const ext of extensions) {
        const candidate = path.join(inbox, `${baseName}${ext}`);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

const EGYPTIAN_ARABIC_PROMPT = 'محادثة هاتفية خدمة عملاء بالعامية المصرية: ألو، أيوة يا فندم، تمام، إزيك، معاك، الخط، الدونجل، الصوت، واضح، حاضر، شكراً، مع السلامة.';

function filterForeignHallucinations(line) {
    if (!line) return '';
    // Strip pure Latin artifact tokens (e.g. "canción", "imperlational", "básicamente") that bleed into Arabic audio on pauses
    const arabicChars = (line.match(/[\u0600-\u06FF]/g) || []).length;
    const latinChars = (line.match(/[a-zA-Z]/g) || []).length;
    if (arabicChars > 0 && latinChars > 0 && arabicChars >= latinChars) {
        return line.replace(/[a-zA-Z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]{3,}/g, '').replace(/\s{2,}/g, ' ').trim();
    }
    return line.trim();
}

function cleanTranscript(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const cleanedLines = [];

    for (let line of lines) {
        line = filterForeignHallucinations(line);
        if (!line || line.length < 2) continue;

        // Collapse repetitive token loops within line (e.g. "نفسك نفسك نفسك" -> "نفسك")
        line = line.replace(/(\b\S+\b)(?:\s+\1\b){2,}/gu, '$1');
        line = line.replace(/(\b\S+\s+\S+\b)(?:\s+\1\b){2,}/gu, '$1');

        // Remove timestamp brackets if line has no speech text
        const textWithoutTimestamp = line.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '').trim();
        if (!textWithoutTimestamp || textWithoutTimestamp.length < 2) continue;

        if (cleanedLines.length === 0 || cleanedLines[cleanedLines.length - 1] !== line) {
            cleanedLines.push(line);
        }
    }

    return cleanedLines.join('\n');
}

async function convertTo16kWav(inputPath, outputPath) {
    // Normalizes to 16kHz 16-bit Mono PCM WAV with speech bandpass & loudness normalization
    await execFileAsync('ffmpeg', [
        '-y',
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-af', 'highpass=f=150,lowpass=f=3800,loudnorm=I=-16:TP=-1.5:LRA=11',
        '-c:a', 'pcm_s16le',
        outputPath
    ], { timeout: 45000 });
}

async function runWhisperTranscription(wavPath, modelName = 'base', language = 'auto') {
    let modelFile = path.join(MODELS_DIR, `ggml-${modelName}.bin`);
    if (!fs.existsSync(modelFile)) {
        modelFile = path.join(MODELS_DIR, 'ggml-small.bin');
    }
    if (!fs.existsSync(modelFile)) {
        modelFile = path.join(MODELS_DIR, 'ggml-base.bin');
    }
    if (!fs.existsSync(modelFile)) {
        modelFile = path.join(MODELS_DIR, 'ggml-tiny.bin');
    }
    if (!fs.existsSync(modelFile)) {
        throw new Error(`Whisper model file not found in ${MODELS_DIR}`);
    }
    const tmpOutBase = path.join(os.tmpdir(), `whisper_out_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const prompt = (language === 'ar' || language === 'auto')
        ? EGYPTIAN_ARABIC_PROMPT
        : 'Phone conversation: hello, yes, okay, thanks, goodbye.';

    const args = [
        '-m', modelFile,
        '-f', wavPath,
        '--output-txt',
        '-of', tmpOutBase,
        '-mc', '0',          // Stop cross-segment context repetition loop
        '-nth', '0.60',       // Skip silent pauses
        '-sns',               // Suppress non-speech tokens
        '-et', '2.4',         // Entropy threshold
        '-lpt', '-1.0',       // Logprob threshold
        '-bs', '1',           // Fast greedy beam search (prevents looping)
        '-bo', '1',
        '--prompt', prompt
    ];

    if (language && language !== 'auto') {
        args.push('-l', language);
    } else {
        args.push('-l', 'ar');
    }

    try {
        await execFileAsync(WHISPER_BIN, args, { timeout: 300000 });
        const txtFile = `${tmpOutBase}.txt`;
        let transcript = '';
        if (fs.existsSync(txtFile)) {
            transcript = fs.readFileSync(txtFile, 'utf8').trim();
            fs.unlinkSync(txtFile);
        }
        return cleanTranscript(transcript);
    } finally {
        try {
            if (fs.existsSync(`${tmpOutBase}.txt`)) fs.unlinkSync(`${tmpOutBase}.txt`);
        } catch (_) {}
    }
}

async function getSttSettings(pool) {
    try {
        const [rows] = await pool.query('SELECT * FROM `asterisk`.`stt_settings` WHERE id = 1');
        if (rows && rows.length > 0) {
            return rows[0];
        }
    } catch (_) {}
    return {
        enabled: 1,
        model_name: 'base',
        language: 'auto',
        transcribe_calls: 1,
        transcribe_voicemails: 1,
        min_duration_sec: 3
    };
}

async function processNextJob(pool) {
    if (isBusy) return;
    isBusy = true;

    try {
        const settings = await getSttSettings(pool);
        if (!settings.enabled) {
            return;
        }

        // 1. Process pending call recording transcripts
        if (settings.transcribe_calls) {
            const [pendingCalls] = await pool.query(`
                SELECT t.id, t.uniqueid, t.recordingfile, t.language, c.calldate, c.duration, c.billsec
                FROM \`asteriskcdrdb\`.\`cdr_transcriptions\` t
                LEFT JOIN \`asteriskcdrdb\`.\`cdr\` c ON c.uniqueid = t.uniqueid
                WHERE t.status = 'pending'
                ORDER BY t.id ASC
                LIMIT 1
            `);

            if (pendingCalls && pendingCalls.length > 0) {
                const job = pendingCalls[0];
                const duration = parseInt(job.billsec || job.duration || 0, 10);

                if (duration < (settings.min_duration_sec || 2)) {
                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
                        SET status = 'completed', transcript = '[Call duration too short for transcription]', completed_at = NOW()
                        WHERE id = ?
                    `, [job.id]);
                    return;
                }

                await pool.query("UPDATE `asteriskcdrdb`.`cdr_transcriptions` SET status = 'processing' WHERE id = ?", [job.id]);

                const audioPath = resolveCallAudioPath(job.recordingfile, job.calldate);
                if (!audioPath) {
                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
                        SET status = 'failed', error_message = 'Recording audio file not found on disk', completed_at = NOW()
                        WHERE id = ?
                    `, [job.id]);
                    return;
                }

                const tmpWav = path.join(os.tmpdir(), `stt_call_${job.uniqueid}_${Date.now()}.wav`);
                try {
                    await convertTo16kWav(audioPath, tmpWav);
                    const lang = job.language && job.language !== 'auto' ? job.language : settings.language;
                    const transcript = await runWhisperTranscription(tmpWav, settings.model_name || 'base', lang);

                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
                        SET status = 'completed', transcript = ?, duration_sec = ?, completed_at = NOW()
                        WHERE id = ?
                    `, [transcript || '[No audible speech detected]', duration, job.id]);
                    console.log(`[STT-WORKER] Transcribed call ${job.uniqueid} (${duration}s): "${(transcript || '').slice(0, 60)}..."`);
                } catch (err) {
                    console.error(`[STT-WORKER] Error transcribing call ${job.uniqueid}:`, err.message);
                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
                        SET status = 'failed', error_message = ?
                        WHERE id = ?
                    `, [err.message.slice(0, 250), job.id]);
                } finally {
                    try { if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav); } catch (_) {}
                }
                return;
            }
        }

        // 2. Process pending voicemail transcripts
        if (settings.transcribe_voicemails) {
            const [pendingVm] = await pool.query(`
                SELECT id, mailbox, msg_file, callerid
                FROM \`asteriskcdrdb\`.\`voicemail_transcriptions\`
                WHERE status = 'pending'
                ORDER BY id ASC
                LIMIT 1
            `);

            if (pendingVm && pendingVm.length > 0) {
                const job = pendingVm[0];
                await pool.query("UPDATE `asteriskcdrdb`.`voicemail_transcriptions` SET status = 'processing' WHERE id = ?", [job.id]);

                const audioPath = resolveVoicemailAudioPath(job.mailbox, job.msg_file);
                if (!audioPath) {
                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`voicemail_transcriptions\`
                        SET status = 'failed', transcript = '[Audio file missing]'
                        WHERE id = ?
                    `, [job.id]);
                    return;
                }

                const tmpWav = path.join(os.tmpdir(), `stt_vm_${job.mailbox}_${Date.now()}.wav`);
                try {
                    await convertTo16kWav(audioPath, tmpWav);
                    const transcript = await runWhisperTranscription(tmpWav, settings.model_name || 'base', settings.language || 'auto');

                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`voicemail_transcriptions\`
                        SET status = 'completed', transcript = ?
                        WHERE id = ?
                    `, [transcript || '[No audible speech in voicemail]', job.id]);
                    console.log(`[STT-WORKER] Transcribed voicemail [${job.mailbox}/${job.msg_file}]: "${(transcript || '').slice(0, 60)}..."`);
                } catch (err) {
                    console.error(`[STT-WORKER] Error transcribing voicemail [${job.mailbox}/${job.msg_file}]:`, err.message);
                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`voicemail_transcriptions\`
                        SET status = 'failed', transcript = ?
                        WHERE id = ?
                    `, [`[Transcription error: ${err.message}]`, job.id]);
                } finally {
                    try { if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav); } catch (_) {}
                }
            }
        }
    } catch (err) {
        console.error('[STT-WORKER] Loop error:', err.message);
    } finally {
        isBusy = false;
    }
}

async function startWorker() {
    console.log('[STT-WORKER] Starting Sokrat Local Speech-To-Text Worker...');
    const pool = mysql.createPool(DB_CONFIG);

    process.on('SIGINT', async () => {
        isRunning = false;
        console.log('[STT-WORKER] Shutting down gracefully...');
        await pool.end();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        isRunning = false;
        console.log('[STT-WORKER] Received SIGTERM. Shutting down...');
        await pool.end();
        process.exit(0);
    });
    while (isRunning) {
        await processNextJob(pool);
        await new Promise(r => setTimeout(r, 3000));
    }
}

if (require.main === module) {
    startWorker().catch(err => {
        console.error('[STT-WORKER] Fatal startup error:', err);
        process.exit(1);
    });
}

module.exports = {
    resolveCallAudioPath,
    resolveVoicemailAudioPath,
    convertTo16kWav,
    runWhisperTranscription,
    cleanTranscript,
    processNextJob
};
