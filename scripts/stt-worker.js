#!/usr/bin/env node
/**
 * Sokrat VoIP - Cloud AI Speech-To-Text (STT) Background Worker
 * Supports OpenAI, Groq, Deepgram, and OpenAI-Compatible Custom Endpoints
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

const MONITOR_ROOT = '/var/spool/asterisk/monitor';
const VM_ROOT = '/var/spool/asterisk/voicemail/default';

const DEFAULT_PROMPTS = {
    ar: 'محادثة هاتفية خدمة عملاء بالعامية المصرية: ألو، أيوة يا فندم، تمام، إزيك، معاك، الخط، حاضر، شكراً، مع السلامة.',
    en: 'Phone conversation: hello, yes, okay, thank you, goodbye.',
    auto: 'محادثة هاتفية بالعامية المصرية: ألو، أيوة، تمام، إزيك، شكراً. Phone call.'
};

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

async function prepareAudioForUpload(inputPath, outputPath) {
    // Normalizes to high-quality compressed 16kHz mono MP3 for fast upload and high transcription accuracy
    await execFileAsync('ffmpeg', [
        '-y',
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-af', 'highpass=f=120,lowpass=f=3800,loudnorm=I=-16:TP=-1.5:LRA=11',
        '-b:a', '64k',
        outputPath
    ], { timeout: 30000 });
}

async function transcribeWithCloudAi(audioFilePath, options = {}) {
    const {
        provider = 'groq',
        apiKey = '',
        apiUrl = '',
        modelName = 'whisper-large-v3',
        language = 'auto',
        prompt = ''
    } = options;

    if (!apiKey) {
        throw new Error('AI Provider API key is not configured. Please set your API key in PBX Settings -> Speech-to-Text.');
    }

    const fileBuffer = fs.readFileSync(audioFilePath);
    const fileName = path.basename(audioFilePath);
    const resolvedPrompt = prompt || DEFAULT_PROMPTS[language] || DEFAULT_PROMPTS.ar;

    // --- Provider 1: Deepgram ---
    if (provider === 'deepgram') {
        const targetUrl = new URL(apiUrl || 'https://api.deepgram.com/v1/listen');
        if (modelName) targetUrl.searchParams.set('model', modelName);
        if (language && language !== 'auto') targetUrl.searchParams.set('language', language);
        else targetUrl.searchParams.set('detect_language', 'true');
        targetUrl.searchParams.set('smart_format', 'true');
        targetUrl.searchParams.set('punctuate', 'true');

        const res = await fetch(targetUrl.toString(), {
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': audioFilePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'
            },
            body: fileBuffer
        });

        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`Deepgram API error (${res.status}): ${errBody}`);
        }

        const data = await res.json();
        const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
        return transcript.trim();
    }

    // --- Provider 2: Groq / OpenAI / Custom OpenAI-compatible ---
    let endpoint = apiUrl;
    if (!endpoint) {
        if (provider === 'openai') {
            endpoint = 'https://api.openai.com/v1/audio/transcriptions';
        } else {
            endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
        }
    }

    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: audioFilePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' });
    formData.append('file', blob, fileName);

    let effectiveModel = modelName;
    if (!effectiveModel || effectiveModel === 'base' || effectiveModel === 'small' || effectiveModel === 'tiny') {
        if (provider === 'openai') effectiveModel = 'whisper-1';
        else effectiveModel = 'whisper-large-v3';
    }
    formData.append('model', effectiveModel);

    if (language && language !== 'auto') {
        formData.append('language', language);
    }
    if (resolvedPrompt) {
        formData.append('prompt', resolvedPrompt);
    }
    formData.append('temperature', '0.0');

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`
        },
        body: formData
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`${provider.toUpperCase()} API error (${res.status}): ${errBody}`);
    }

    const data = await res.json();
    return (data.text || '').trim();
}

async function testCloudSttConnection(settings) {
    const startTime = Date.now();
    const tmpAudio = path.join(os.tmpdir(), `stt_test_${Date.now()}.wav`);

    try {
        // Generate a 1-second synthetic silence/tone WAV file using ffmpeg
        await execFileAsync('ffmpeg', [
            '-y',
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:duration=1',
            '-ar', '16000',
            '-ac', '1',
            tmpAudio
        ], { timeout: 10000 });

        const resultText = await transcribeWithCloudAi(tmpAudio, {
            provider: settings.provider || 'groq',
            apiKey: settings.api_key || settings.apiKey,
            apiUrl: settings.api_url || settings.apiUrl,
            modelName: settings.model_name || settings.modelName,
            language: settings.language || 'auto',
            prompt: settings.prompt
        });

        const latencyMs = Date.now() - startTime;
        return {
            success: true,
            message: `API connection verified successfully (${latencyMs}ms response time).`,
            latencyMs,
            sampleResult: resultText || '[No speech in test tone]'
        };
    } finally {
        try { if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio); } catch (_) {}
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
        provider: 'groq',
        api_key: '',
        api_url: 'https://api.groq.com/openai/v1/audio/transcriptions',
        model_name: 'whisper-large-v3',
        language: 'auto',
        prompt: DEFAULT_PROMPTS.ar,
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
        if (!settings.enabled || !settings.api_key) {
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

                const tmpUploadAudio = path.join(os.tmpdir(), `stt_upload_${job.uniqueid}_${Date.now()}.mp3`);
                try {
                    await prepareAudioForUpload(audioPath, tmpUploadAudio);
                    const lang = job.language && job.language !== 'auto' ? job.language : settings.language;
                    const transcript = await transcribeWithCloudAi(tmpUploadAudio, {
                        provider: settings.provider,
                        apiKey: settings.api_key,
                        apiUrl: settings.api_url,
                        modelName: settings.model_name,
                        language: lang,
                        prompt: settings.prompt
                    });

                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
                        SET status = 'completed', transcript = ?, duration_sec = ?, completed_at = NOW()
                        WHERE id = ?
                    `, [transcript || '[No speech detected]', duration, job.id]);
                    console.log(`[STT-CLOUD-WORKER] Transcribed call ${job.uniqueid} (${duration}s via ${settings.provider}): "${(transcript || '').slice(0, 80)}..."`);
                } catch (err) {
                    console.error(`[STT-CLOUD-WORKER] Error transcribing call ${job.uniqueid}:`, err.message);
                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
                        SET status = 'failed', error_message = ?
                        WHERE id = ?
                    `, [err.message.slice(0, 250), job.id]);
                } finally {
                    try { if (fs.existsSync(tmpUploadAudio)) fs.unlinkSync(tmpUploadAudio); } catch (_) {}
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

                const tmpUploadAudio = path.join(os.tmpdir(), `stt_vm_upload_${job.mailbox}_${Date.now()}.mp3`);
                try {
                    await prepareAudioForUpload(audioPath, tmpUploadAudio);
                    const transcript = await transcribeWithCloudAi(tmpUploadAudio, {
                        provider: settings.provider,
                        apiKey: settings.api_key,
                        apiUrl: settings.api_url,
                        modelName: settings.model_name,
                        language: settings.language || 'auto',
                        prompt: settings.prompt
                    });

                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`voicemail_transcriptions\`
                        SET status = 'completed', transcript = ?
                        WHERE id = ?
                    `, [transcript || '[No speech in voicemail]', job.id]);
                    console.log(`[STT-CLOUD-WORKER] Transcribed voicemail [${job.mailbox}/${job.msg_file}]: "${(transcript || '').slice(0, 80)}..."`);
                } catch (err) {
                    console.error(`[STT-CLOUD-WORKER] Error transcribing voicemail [${job.mailbox}/${job.msg_file}]:`, err.message);
                    await pool.query(`
                        UPDATE \`asteriskcdrdb\`.\`voicemail_transcriptions\`
                        SET status = 'failed', transcript = ?
                        WHERE id = ?
                    `, [`[Transcription error: ${err.message}]`, job.id]);
                } finally {
                    try { if (fs.existsSync(tmpUploadAudio)) fs.unlinkSync(tmpUploadAudio); } catch (_) {}
                }
            }
        }
    } catch (err) {
        console.error('[STT-CLOUD-WORKER] Loop error:', err.message);
    } finally {
        isBusy = false;
    }
}

async function startWorker() {
    console.log('[STT-CLOUD-WORKER] Starting Sokrat Cloud AI Speech-To-Text Worker...');
    const pool = mysql.createPool(DB_CONFIG);

    process.on('SIGINT', async () => {
        isRunning = false;
        console.log('[STT-CLOUD-WORKER] Shutting down gracefully...');
        await pool.end();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        isRunning = false;
        console.log('[STT-CLOUD-WORKER] Received SIGTERM. Shutting down...');
        await pool.end();
        process.exit(0);
    });

    while (isRunning) {
        await processNextJob(pool);
        await new Promise(r => setTimeout(r, 2500));
    }
}

if (require.main === module) {
    startWorker().catch(err => {
        console.error('[STT-CLOUD-WORKER] Fatal startup error:', err);
        process.exit(1);
    });
}

module.exports = {
    resolveCallAudioPath,
    resolveVoicemailAudioPath,
    prepareAudioForUpload,
    transcribeWithCloudAi,
    testCloudSttConnection,
    getSttSettings,
    processNextJob
};
