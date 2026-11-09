#!/usr/bin/env node
/**
 * Sokrat VoIP - Speech-To-Text background worker.
 * Supports offline whisper.cpp and the existing cloud providers.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const mysql = require('mysql2/promise');
const { execFile, execFileSync } = require('child_process');
const { decrypt } = require('../lib/ai/crypto');
const { evaluateTranscript } = require('../lib/ai/evaluation');
const {
    normaliseSegments,
    singleSegment,
    deepgramSegments,
    transcriptText
} = require('../lib/ai/transcripts');

const envFile = process.env.STT_ENV_FILE || '/etc/sokrat-voip/stt.env';
if (fs.existsSync(envFile)) {
    require('dotenv').config({ path: envFile, quiet: true });
}
// The web app keeps ENCRYPTION_KEY in /opt/sokrat-voip/.env. The STT worker
// needs the same key to decrypt AI provider credentials stored by the UI.
const appEnvFile = path.join(__dirname, '..', '.env');
if (!process.env.ENCRYPTION_KEY && fs.existsSync(appEnvFile)) {
    require('dotenv').config({ path: appEnvFile, quiet: true });
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

const MONITOR_ROOT = process.env.STT_MONITOR_ROOT || '/var/spool/asterisk/monitor';
const VM_ROOT = process.env.STT_VM_ROOT || '/var/spool/asterisk/voicemail/default';
const LOCAL_ENDPOINT = process.env.STT_LOCAL_ENDPOINT || 'http://127.0.0.1:8178/inference';
const LOCAL_TIMEOUT_MS = Math.max(30_000, Number(process.env.STT_LOCAL_TIMEOUT_MS || 1_800_000));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.STT_MAX_ATTEMPTS || 3));

const DEFAULT_PROMPTS = {
    ar: 'تسجيل مكالمة هاتفية خدمة عملاء باللغة العربية والعامية المصرية: الموظف، العميل، التحويلة، المكالمة.',
    en: 'Phone conversation: hello, yes, okay, thank you, goodbye.',
    auto: 'محادثة هاتفية بالعامية المصرية: ألو، أيوة، تمام، إزيك، شكراً. Phone call.'
};

let isRunning = true;
let isBusy = false;
let localInferenceActive = false;
let pauseDuringCallsEnabled = true;
let whisperPausedForCall = false;
let shuttingDown = false;
let activeJob = null;
let activeRequestController = null;

function execFileAsync(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(file, args, options, (err, stdout, stderr) => {
            if (err) return reject(new Error(`${err.message}${stderr ? ` - Stderr: ${stderr}` : ''}`));
            resolve({ stdout, stderr });
        });
    });
}

function resolveCallAudioPath(rawRecordingFile, callDate) {
    if (!rawRecordingFile) return null;
    const cleanName = path.basename(rawRecordingFile);
    const dateObj = callDate ? new Date(callDate) : null;
    const candidatePaths = [];

    if (path.isAbsolute(rawRecordingFile)) {
        const resolved = path.resolve(rawRecordingFile);
        const monitorPrefix = `${path.resolve(MONITOR_ROOT)}${path.sep}`;
        if ((resolved === path.resolve(MONITOR_ROOT) || resolved.startsWith(monitorPrefix)) && fs.existsSync(resolved)) {
            return resolved;
        }
    }

    if (dateObj && !Number.isNaN(dateObj.getTime())) {
        const y = String(dateObj.getFullYear());
        const m = String(dateObj.getMonth() + 1).padStart(2, '0');
        const d = String(dateObj.getDate()).padStart(2, '0');
        for (const ext of ['', '.wav', '.mp3', '.WAV']) {
            const name = ext ? cleanName.replace(/\.[^.]+$/, ext) : cleanName;
            candidatePaths.push(path.join(MONITOR_ROOT, y, m, d, name));
        }
    }

    for (const ext of ['', '.wav', '.mp3', '.WAV']) {
        const name = ext ? cleanName.replace(/\.[^.]+$/, ext) : cleanName;
        candidatePaths.push(path.join(MONITOR_ROOT, name));
    }
    for (const candidate of candidatePaths) {
        if (fs.existsSync(candidate)) return candidate;
    }

    try {
        const found = execFileSync('find', [MONITOR_ROOT, '-name', cleanName, '-type', 'f'], {
            encoding: 'utf8', timeout: 3000
        }).trim();
        const first = found.split('\n')[0];
        if (first && fs.existsSync(first)) return first;
    } catch (_) {}
    return null;
}

function resolveVoicemailAudioPath(mailbox, msgFile) {
    if (!mailbox || !msgFile) return null;
    const safeMailbox = path.basename(String(mailbox));
    const baseName = path.basename(String(msgFile)).replace(/\.[^.]+$/, '');
    const inbox = path.join(VM_ROOT, safeMailbox, 'INBOX');
    for (const ext of ['.wav', '.WAV', '.mp3', '.gsm', '.sln']) {
        const candidate = path.join(inbox, `${baseName}${ext}`);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

async function prepareAudioForUpload(inputPath, outputPath) {
    await execFileAsync('ffmpeg', [
        '-y', '-i', inputPath, '-ar', '16000', '-ac', '1',
        '-af', 'highpass=f=120,lowpass=f=3800,loudnorm=I=-16:TP=-1.5:LRA=11',
        '-b:a', '64k', outputPath
    ], { timeout: 120_000 });
}

async function prepareAudioForLocal(inputPath, outputPath) {
    await execFileAsync('ffmpeg', [
        '-y', '-i', inputPath, '-ar', '16000', '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-af', 'highpass=f=120,lowpass=f=3800',
        outputPath
    ], { timeout: 120_000 });
}

function assertLoopbackEndpoint(rawUrl) {
    const endpoint = new URL(rawUrl || LOCAL_ENDPOINT);
    const host = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
        throw new Error('Local whisper.cpp endpoint must use HTTP on 127.0.0.1, localhost, or ::1.');
    }
    return endpoint.toString();
}

function extractTranscript(data) {
    if (!data) return '';
    if (typeof data === 'string') return data.trim();
    if (typeof data.text === 'string') return data.text.trim();
    if (typeof data.transcript === 'string') return data.transcript.trim();
    if (Array.isArray(data.transcription)) {
        return data.transcription.map(item => typeof item === 'string' ? item : item?.text || '').join(' ').trim();
    }
    if (Array.isArray(data.segments)) {
        return data.segments.map(item => item?.text || '').join(' ').trim();
    }
    return '';
}

async function transcribeWithLocalWhisper(audioFilePath, options = {}) {
    const endpoint = assertLoopbackEndpoint(options.apiUrl || options.api_url || LOCAL_ENDPOINT);
    const language = options.language || 'ar';
    const prompt = options.prompt || DEFAULT_PROMPTS[language] || DEFAULT_PROMPTS.ar;
    const fileBuffer = fs.readFileSync(audioFilePath);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), path.basename(audioFilePath));
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');
    if (language) formData.append('language', language);
    if (prompt) {
        formData.append('prompt', prompt);

    }

    let response;
    try {
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs || LOCAL_TIMEOUT_MS);
        response = await fetch(endpoint, {
            method: 'POST', body: formData,
            signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
        });
    } catch (err) {
        throw new Error(`Local whisper.cpp service unreachable at ${endpoint}: ${err.message}`);
    }
    const body = await response.text();
    if (!response.ok) throw new Error(`Local whisper.cpp error (${response.status}): ${body.slice(0, 500)}`);
    let parsed = body;
    try { parsed = JSON.parse(body); } catch (_) {}
    return extractTranscript(parsed).replace(/\s+/g, ' ').trim();
}

const MUNSIT_SEGMENT_SEC = Math.max(60, Number(process.env.MUNSIT_SEGMENT_SEC || 600));

async function getAudioDuration(filePath) {
    return new Promise(resolve => {
        execFile('ffmpeg', ['-i', filePath], (err, stdout, stderr) => {
            const out = (stderr || '') + (err ? err.message : '');
            const match = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (match) {
                const sec = parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseFloat(match[3]);
                return resolve(sec);
            }
            resolve(0);
        });
    });
}

async function transcribeMunsitSingleFile(filePath, options = {}) {
    const { apiKey = '', apiUrl = '', modelName = 'munsit', language = 'ar' } = options;
    const endpoint = apiUrl || 'https://api.munsit.com/api/v1/audio/transcribe';
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: filePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' }), fileName);
    formData.append('model', modelName || 'munsit');
    if (language && language !== 'auto') formData.append('language', language);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
        body: formData,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(LOCAL_TIMEOUT_MS)]) : AbortSignal.timeout(LOCAL_TIMEOUT_MS)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Munsit API error (${res.status}): ${errText.slice(0, 500)}`);
    }
    const json = await res.json();
    return (json?.data?.transcription || json?.data?.text || '').trim();
}

async function transcribeWithMunsit(audioFilePath, options = {}) {
    const durationSec = await getAudioDuration(audioFilePath);
    if (!durationSec || durationSec <= MUNSIT_SEGMENT_SEC) {
        return transcribeMunsitSingleFile(audioFilePath, options);
    }

    const chunkDir = path.join(os.tmpdir(), `munsit_chunks_${Date.now()}_${process.pid}`);
    fs.mkdirSync(chunkDir, { recursive: true });
    const ext = path.extname(audioFilePath) || '.wav';
    try {
        await execFileAsync('ffmpeg', [
            '-y', '-i', audioFilePath,
            '-f', 'segment',
            '-segment_time', String(MUNSIT_SEGMENT_SEC),
            '-reset_timestamps', '1',
            '-c', 'copy',
            path.join(chunkDir, `chunk_%03d${ext}`)
        ], { timeout: 120_000 });

        const chunks = fs.readdirSync(chunkDir)
            .filter(f => f.startsWith('chunk_') && f.endsWith(ext))
            .sort()
            .map(f => path.join(chunkDir, f));

        if (!chunks.length) {
            return transcribeMunsitSingleFile(audioFilePath, options);
        }

        const chunkTranscripts = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunkPath = chunks[i];
            console.log(`[STT-WORKER] Transcribing Munsit segment ${i + 1}/${chunks.length} (${path.basename(chunkPath)})...`);
            const text = await transcribeMunsitSingleFile(chunkPath, options);
            if (text) chunkTranscripts.push(text);
        }
        return chunkTranscripts.join(' ').trim();
    } finally {
        try {
            fs.rmSync(chunkDir, { recursive: true, force: true });
        } catch (_) {}
    }
}


async function transcribeWithCloudAiDetailed(audioFilePath, options = {}) {
    const {
        provider = 'groq', apiKey = '', apiUrl = '', modelName = 'whisper-large-v3',
        language = 'auto', prompt = ''
    } = options;
    if (!apiKey) throw new Error('AI Provider API key is not configured. Please set your API key in PBX Settings -> Speech-to-Text.');

    const normalizedProvider = String(provider || 'groq').toLowerCase();
    const fileBuffer = fs.readFileSync(audioFilePath);
    const fileName = path.basename(audioFilePath);
    const resolvedPrompt = prompt || DEFAULT_PROMPTS[language] || DEFAULT_PROMPTS.ar;
    const durationSec = await getAudioDuration(audioFilePath).catch(() => 0);

    if (normalizedProvider === 'munsit') {
        const text = await transcribeWithMunsit(audioFilePath, options);
        return {
            text: transcriptText(singleSegment(text, durationSec), text),
            segments: singleSegment(text, durationSec),
            language,
            provider: 'munsit',
            model: modelName || 'munsit',
            raw: null
        };
    }

    if (normalizedProvider === 'deepgram') {
        const targetUrl = new URL(apiUrl || 'https://api.deepgram.com/v1/listen');
        if (modelName) targetUrl.searchParams.set('model', modelName);
        if (language && language !== 'auto') targetUrl.searchParams.set('language', language);
        else targetUrl.searchParams.set('detect_language', 'true');
        targetUrl.searchParams.set('smart_format', 'true');
        targetUrl.searchParams.set('punctuate', 'true');
        // Speaker diarization is the critical addition. Utterances give
        // speaker-labeled segments with millisecond timestamps.
        targetUrl.searchParams.set('diarize', 'true');
        targetUrl.searchParams.set('utterances', 'true');
        targetUrl.searchParams.set('paragraphs', 'true');
        const res = await fetch(targetUrl.toString(), {
            method: 'POST',
            headers: { Authorization: `Token ${apiKey}`, 'Content-Type': audioFilePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' },
            body: fileBuffer,
            signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(LOCAL_TIMEOUT_MS)]) : AbortSignal.timeout(LOCAL_TIMEOUT_MS)
        });
        if (!res.ok) throw new Error(`Deepgram API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        const fallbackText = (data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
        const segments = deepgramSegments(data, fallbackText);
        return {
            text: transcriptText(segments, fallbackText),
            segments,
            language: data?.results?.channels?.[0]?.detected_language || language,
            provider: 'deepgram',
            model: modelName || 'nova-3',
            raw: data
        };
    }

    let endpoint = apiUrl;
    if (!endpoint) endpoint = normalizedProvider === 'openai'
        ? 'https://api.openai.com/v1/audio/transcriptions'
        : 'https://api.groq.com/openai/v1/audio/transcriptions';
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: audioFilePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' }), fileName);
    let effectiveModel = modelName;
    if (!effectiveModel || ['base', 'small', 'tiny'].includes(effectiveModel)) {
        effectiveModel = normalizedProvider === 'openai' ? 'whisper-1' : 'whisper-large-v3';
    }
    formData.append('model', effectiveModel);
    if (language && language !== 'auto') formData.append('language', language);
    if (resolvedPrompt) formData.append('prompt', resolvedPrompt);
    formData.append('temperature', '0.0');
    const res = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: formData,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(LOCAL_TIMEOUT_MS)]) : AbortSignal.timeout(LOCAL_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`${normalizedProvider.toUpperCase()} API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    const text = extractTranscript(data);
    const segments = singleSegment(text, durationSec);
    return {
        text: transcriptText(segments, text),
        segments,
        language,
        provider: normalizedProvider,
        model: effectiveModel,
        raw: data
    };
}

async function transcribeWithCloudAi(audioFilePath, options = {}) {
    const detailed = await transcribeWithCloudAiDetailed(audioFilePath, options);
    return detailed.text;
}

function isLocalSettings(settings = {}) {
    return settings.engine === 'local_whisper' || settings.provider === 'local';
}

async function transcribeAudioDetailed(audioPath, settings) {
    if (isLocalSettings(settings)) {
        throw new Error('Local whisper engine has been removed. Please select a Cloud STT provider (Munsit, Groq, OpenAI, Deepgram, or Custom) in settings.');
    }
    return transcribeWithCloudAiDetailed(audioPath, {
        provider: settings.provider, apiKey: settings.api_key, apiUrl: settings.api_url,
        modelName: settings.model_name, language: settings.language, prompt: settings.prompt, signal: settings.signal
    });
}

async function transcribeAudio(audioPath, settings) {
    const detailed = await transcribeAudioDetailed(audioPath, settings);
    return detailed.text;
}

async function testSttConnection(settings = {}) {
    if (isLocalSettings(settings)) {
        throw new Error('Local whisper engine has been removed. Please configure a Cloud STT provider (Munsit, Groq, OpenAI, Deepgram, or Custom).');
    }
    const startTime = Date.now();
    const tmpAudio = path.join(os.tmpdir(), `stt_test_${Date.now()}.mp3`);
    try {
        const wav = `${tmpAudio}.wav`;
        await execFileAsync('ffmpeg', [
            '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.6', '-c:a', 'pcm_s16le', wav
        ], { timeout: 10_000 });
        await prepareAudioForUpload(wav, tmpAudio);
        try { if (fs.existsSync(wav)) fs.unlinkSync(wav); } catch (_) {}
        const resultText = await transcribeAudio(tmpAudio, {
            ...settings,
            api_key: settings.api_key || settings.apiKey,
            api_url: settings.api_url || settings.apiUrl,
            model_name: settings.model_name || settings.modelName
        });
        return {
            success: true,
            message: 'Cloud API connection verified successfully.',
            latencyMs: Date.now() - startTime,
            sampleResult: resultText || '[No speech in health-check audio]'
        };
    } finally {
        try { if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio); } catch (_) {}
    }
}

const testCloudSttConnection = testSttConnection;

async function getSttSettings(pool) {
    try {
        const [rows] = await pool.query('SELECT * FROM `asterisk`.`stt_settings` WHERE id = 1');
        if (rows?.length) return rows[0];
    } catch (_) {}
    return {
        enabled: 1, engine: 'cloud_api', provider: 'munsit', api_key: '', api_url: 'https://api.munsit.com/api/v1/audio/transcribe',
        model_name: 'munsit', language: 'ar', prompt: DEFAULT_PROMPTS.ar,
        transcribe_calls: 1, transcribe_voicemails: 1, min_duration_sec: 3, pause_during_calls: 1
    };
}

function parseAsteriskActivity(output = '') {
    const channels = String(output).match(/(\d+) active channels?/i);
    const calls = String(output).match(/(\d+) active calls?/i);
    return Number(channels?.[1] || 0) > 0 || Number(calls?.[1] || 0) > 0;
}

async function hasActiveCalls() {
    try {
        const { stdout } = await execFileAsync('asterisk', ['-rx', 'core show channels count'], { timeout: 5000 });
        return parseAsteriskActivity(stdout);
    } catch (err) {
        // Fail safe: if Asterisk cannot be queried, do not take CPU from telephony.
        console.error(`[STT-WORKER] Unable to determine Asterisk call activity: ${err.message}`);
        return true;
    }
}

async function signalLocalWhisper(signal) {
    try {
        const { stdout } = await execFileAsync('pgrep', ['-u', String(process.getuid()), '-x', 'whisper-server'], { timeout: 3000 });
        for (const rawPid of stdout.trim().split(/\s+/)) {
            const pid = Number(rawPid);
            if (Number.isInteger(pid) && pid > 1) process.kill(pid, signal);
        }
    } catch (err) {
        if (!String(err.message).includes('Command failed')) {
            console.error(`[STT-WORKER] Unable to signal local Whisper: ${err.message}`);
        }
    }
}

async function enforceLiveCallPriority() {
    if (!pauseDuringCallsEnabled) {
        if (whisperPausedForCall) {
            await signalLocalWhisper('SIGCONT');
            whisperPausedForCall = false;
            console.log('[STT-WORKER] Resumed local Whisper inference.');
        }
        return;
    }
    const active = await hasActiveCalls();
    if (!localInferenceActive) {
        if (!active && whisperPausedForCall) {
            await signalLocalWhisper('SIGCONT');
            whisperPausedForCall = false;
            console.log('[STT-WORKER] Resumed local Whisper after calls ended.');
        }
        return;
    }
    if (active && !whisperPausedForCall) {
        await signalLocalWhisper('SIGSTOP');
        whisperPausedForCall = true;
        console.log('[STT-WORKER] Paused local Whisper inference for an active Asterisk call.');
    } else if (!active && whisperPausedForCall) {
        await signalLocalWhisper('SIGCONT');
        whisperPausedForCall = false;
        console.log('[STT-WORKER] Resumed local Whisper inference after calls ended.');
    }
}

async function waitForStableFile(filePath) {
    const first = fs.statSync(filePath);
    await new Promise(resolve => setTimeout(resolve, 750));
    const second = fs.statSync(filePath);
    if (!second.size || first.size !== second.size) throw new Error('Audio file is still being written; job will retry.');
}

async function recoverStaleJobs(pool) {
    const [callResult] = await pool.query(`
        UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
        SET attempt_count = attempt_count + 1,
            status = IF(attempt_count + 1 >= ?, 'failed', 'pending'),
            error_message = 'Recovered after interrupted transcription worker', processing_started_at = NULL
        WHERE status = 'processing' AND processing_started_at < NOW() - INTERVAL 45 MINUTE
    `, [MAX_ATTEMPTS]);
    const [vmResult] = await pool.query(`
        UPDATE \`asteriskcdrdb\`.\`voicemail_transcriptions\`
        SET attempt_count = attempt_count + 1,
            status = IF(attempt_count + 1 >= ?, 'failed', 'pending'),
            error_message = 'Recovered after interrupted transcription worker', processing_started_at = NULL
        WHERE status = 'processing' AND processing_started_at < NOW() - INTERVAL 45 MINUTE
    `, [MAX_ATTEMPTS]);
    const recovered = Number(callResult.affectedRows || 0) + Number(vmResult.affectedRows || 0);
    if (recovered) console.log(`[STT-WORKER] Recovered ${recovered} stale job(s).`);
}

async function markFailure(pool, table, id, err, terminal = false) {
    const message = String(err?.message || err).slice(0, 500);
    await pool.query(`
        UPDATE \`asteriskcdrdb\`.\`${table}\`
        SET attempt_count = attempt_count + 1,
            status = IF(? OR attempt_count + 1 >= ?, 'failed', 'pending'),
            error_message = ?, processing_started_at = NULL
        WHERE id = ?
    `, [terminal ? 1 : 0, MAX_ATTEMPTS, message, id]);
}

async function normalizeAndTranscribe(audioPath, jobKey, settings) {
    await waitForStableFile(audioPath);
    const local = isLocalSettings(settings);
    const output = path.join(os.tmpdir(), `stt_${local ? 'local' : 'cloud'}_${jobKey}_${Date.now()}.${local ? 'wav' : 'mp3'}`);
    try {
        if (local) await prepareAudioForLocal(audioPath, output);
        else await prepareAudioForUpload(audioPath, output);
        if (local) localInferenceActive = true;
        activeRequestController = new AbortController();
        return await transcribeAudioDetailed(output, { ...settings, signal: activeRequestController.signal });
    } finally {
        activeRequestController = null;
        if (local) {
            localInferenceActive = false;
            if (whisperPausedForCall) {
                const active = pauseDuringCallsEnabled && await hasActiveCalls();
                if (!active) {
                    await signalLocalWhisper('SIGCONT');
                    whisperPausedForCall = false;
                }
            }
        }
        try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch (_) {}
    }
}

function averageConfidence(segments) {
    const values = (segments || []).map(s => Number(s.confidence)).filter(v => Number.isFinite(v));
    if (!values.length) return null;
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10000) / 10000;
}

async function persistSegments(pool, transcriptionType, transcriptionId, segments, language) {
    const normalised = normaliseSegments(segments, 0).map((segment, index) => ({ ...segment, seq: index }));
    await pool.query(
        'DELETE FROM `asteriskcdrdb`.`transcript_segments` WHERE transcription_type = ? AND transcription_id = ?',
        [transcriptionType, transcriptionId]
    );
    if (!normalised.length) return { segments: [], confidenceAvg: null };
    const rows = normalised.map(segment => [
        transcriptionType,
        transcriptionId,
        segment.seq,
        segment.speaker || 'unknown',
        segment.start_ms,
        segment.end_ms,
        segment.text,
        segment.confidence,
        language || null
    ]);
    await pool.query(
        `INSERT INTO \`asteriskcdrdb\`.\`transcript_segments\`
         (transcription_type, transcription_id, seq, speaker, start_ms, end_ms, text, confidence, language)
         VALUES ?`,
        [rows]
    );
    return { segments: normalised, confidenceAvg: averageConfidence(normalised) };
}

function inferCallDirection(row = {}) {
    const dcontext = String(row.dcontext || '').toLowerCase();
    if (dcontext.startsWith('from-dongle') || dcontext.startsWith('from-trunk') || dcontext.startsWith('from-pstn')) return 'inbound';
    if (dcontext.startsWith('outrt-') || dcontext === 'ext-external-failover') return 'outbound';
    return 'any';
}

async function enqueueEvaluationJobs(pool, targetType, transcriptionId, metadata = {}) {
    try {
        const [profiles] = await pool.query(
            `SELECT id, version, scope_type, scope_id, sampling_percent, min_duration_sec,
                    direction, language, name, context_text, instructions_text,
                    rubric_json, thresholds_json, temperature
             FROM \`asterisk\`.\`evaluation_profiles\`
             WHERE active = 1`
        );
        if (!profiles.length) return 0;
        let enqueued = 0;
        for (const profile of profiles) {
            if (profile.direction && profile.direction !== 'any' && profile.direction !== metadata.direction) continue;
            const scope = String(profile.scope_type || 'global');
            const scopeMatches = scope === 'global' ||
                (scope === 'campaign' && metadata.campaignId && String(profile.scope_id) === String(metadata.campaignId)) ||
                (scope === 'agent' && metadata.agent && String(profile.scope_id) === String(metadata.agent)) ||
                (scope === 'did' && metadata.did && String(profile.scope_id) === String(metadata.did));
            if (!scopeMatches) continue;
            if (targetType === 'call' && Number(metadata.duration || 0) < Number(profile.min_duration_sec || 0)) continue;
            const sampling = Math.min(100, Math.max(0, Number(profile.sampling_percent ?? 100)));
            if (sampling <= 0) continue;
            if (sampling < 100 && Math.random() * 100 >= sampling) continue;
            const targetId = targetType === 'call'
                ? String(metadata.uniqueid || transcriptionId)
                : String(metadata.targetId || transcriptionId);
            const [result] = await pool.query(
                `INSERT IGNORE INTO \`asteriskcdrdb\`.\`evaluation_jobs\`
                 (target_type, target_id, transcription_id, uniqueid, profile_id, profile_version,
                  profile_snapshot_json, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [targetType, targetId, transcriptionId, metadata.uniqueid || null, profile.id, profile.version || 1,
                 JSON.stringify({
                     name: profile.name,
                     context_text: profile.context_text,
                     instructions_text: profile.instructions_text,
                     rubric_json: profile.rubric_json,
                     thresholds_json: profile.thresholds_json,
                     language: profile.language,
                     temperature: profile.temperature
                 })]
            );
            enqueued += result.affectedRows || 0;
        }
        return enqueued;
    } catch (err) {
        console.error('[STT-WORKER] Could not enqueue evaluations:', err.message);
        return 0;
    }
}

async function getAiEvaluationSettings(pool) {
    try {
        const [rows] = await pool.query('SELECT * FROM `asterisk`.`ai_evaluation_settings` WHERE id = 1');
        const row = rows?.[0];
        if (!row || !Number(row.enabled)) return null;
        const apiKey = decrypt(row.api_key_enc);
        if (!apiKey) return null;
        return {
            enabled: 1,
            provider: row.provider || 'openai',
            api_key: apiKey,
            api_url: row.api_url || '',
            model: row.model || '',
            temperature: Number(row.temperature || 0),
            max_tokens: Number(row.max_tokens || 4096),
            require_evidence: Boolean(Number(row.require_evidence ?? 1)),
            monthly_budget_usd: Number(row.monthly_budget_usd || 0)
        };
    } catch (err) {
        console.error('[STT-WORKER] Could not read AI evaluation settings:', err.message);
        return null;
    }
}

async function loadEvaluationTarget(pool, job) {
    if (job.target_type === 'voicemail') {
        const [rows] = await pool.query(
            'SELECT * FROM `asteriskcdrdb`.`voicemail_transcriptions` WHERE id = ?',
            [job.transcription_id]
        );
        return rows?.[0] || null;
    }
    const [rows] = await pool.query(
        `SELECT t.*, c.calldate, c.src, c.dst, c.dcontext, c.disposition, c.billsec
         FROM \`asteriskcdrdb\`.\`cdr_transcriptions\` t
         LEFT JOIN \`asteriskcdrdb\`.\`cdr\` c ON c.uniqueid = t.uniqueid
         WHERE t.id = ? LIMIT 1`,
        [job.transcription_id]
    );
    return rows?.[0] || null;
}

async function processEvaluationJob(pool) {
    const llmSettings = await getAiEvaluationSettings(pool);
    if (!llmSettings) return false;

    const [jobs] = await pool.query(
        `SELECT j.*, p.name AS profile_name, p.context_text, p.instructions_text,
                p.rubric_json, p.thresholds_json, p.language, p.temperature
         FROM \`asteriskcdrdb\`.\`evaluation_jobs\` j
         JOIN \`asterisk\`.\`evaluation_profiles\` p ON p.id = j.profile_id
         WHERE j.status = 'pending' AND j.attempt_count < ?
         ORDER BY j.id ASC LIMIT 1`,
        [MAX_ATTEMPTS]
    );
    if (!jobs?.length) return false;
    const job = jobs[0];

    const [claim] = await pool.query(
        `UPDATE \`asteriskcdrdb\`.\`evaluation_jobs\`
         SET status = 'processing', processing_started_at = NOW(), error_message = NULL
         WHERE id = ? AND status = 'pending'`,
        [job.id]
    );
    if (!claim.affectedRows) return true;

    try {
        const target = await loadEvaluationTarget(pool, job);
        if (!target) throw new Error('Evaluation target transcript not found');
        const transcript = String(target.transcript || '').trim();
        if (!transcript || transcript.startsWith('[No ') || transcript.startsWith('[Call duration')) {
            await pool.query(
                `UPDATE \`asteriskcdrdb\`.\`evaluation_jobs\`
                 SET status = 'skipped', completed_at = NOW(), error_message = 'No usable transcript'
                 WHERE id = ?`,
                [job.id]
            );
            return true;
        }

        let segments = [];
        if (target.segments_json) {
            try { segments = normaliseSegments(JSON.parse(target.segments_json), Number(target.duration_sec || target.billsec || 0)); } catch (_) {}
        }
        if (!segments.length) {
            const [segmentRows] = await pool.query(
                `SELECT seq, speaker, start_ms, end_ms, text, confidence
                 FROM \`asteriskcdrdb\`.\`transcript_segments\`
                 WHERE transcription_type = ? AND transcription_id = ? ORDER BY seq ASC`,
                [job.target_type, job.transcription_id]
            );
            segments = normaliseSegments(segmentRows, Number(target.duration_sec || target.billsec || 0));
        }

        let snapshot = null;
        try { snapshot = job.profile_snapshot_json ? JSON.parse(job.profile_snapshot_json) : null; } catch (_) {}
        const rubric = JSON.parse(snapshot?.rubric_json || job.rubric_json || '[]');
        let thresholds = {};
        try { thresholds = JSON.parse(snapshot?.thresholds_json || job.thresholds_json || '{}'); } catch (_) {}
        const profile = {
            id: job.profile_id,
            name: snapshot?.name || job.profile_name,
            context_text: snapshot?.context_text || job.context_text,
            instructions_text: snapshot?.instructions_text || job.instructions_text,
            rubric,
            thresholds,
            language: snapshot?.language || job.language,
            temperature: snapshot?.temperature ?? job.temperature
        };
        const metadata = job.target_type === 'call'
            ? {
                uniqueid: target.uniqueid,
                direction: inferCallDirection(target),
                duration: Number(target.billsec || target.duration_sec || 0),
                src: target.src,
                dst: target.dst,
                dcontext: target.dcontext,
                disposition: target.disposition,
                calldate: target.calldate
            }
            : {
                mailbox: target.mailbox,
                msg_file: target.msg_file,
                callerid: target.callerid,
                direction: 'any'
            };

        const result = await evaluateTranscript({
            profile,
            transcript,
            segments,
            metadata,
            llmSettings
        });

        const evaluation = result.evaluation;
        const promptHash = require('crypto')
            .createHash('sha256')
            .update(result.prompt.systemPrompt + '\n' + result.prompt.userPrompt)
            .digest('hex');

        await pool.query(
            `INSERT INTO \`asteriskcdrdb\`.\`call_evaluations\`
             (job_id, target_type, target_id, uniqueid, profile_id, profile_version,
              overall_score, pass, critical_fail, summary, warnings_json, raw_response_json,
              provider, model, prompt_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
              id = LAST_INSERT_ID(id),
              overall_score = VALUES(overall_score),
              pass = VALUES(pass),
              critical_fail = VALUES(critical_fail),
              summary = VALUES(summary),
              warnings_json = VALUES(warnings_json),
              raw_response_json = VALUES(raw_response_json),
              provider = VALUES(provider),
              model = VALUES(model),
              prompt_hash = VALUES(prompt_hash)`,
            [
                job.id, job.target_type, job.target_id, job.uniqueid || target.uniqueid || null,
                job.profile_id, job.profile_version, evaluation.overall_score,
                evaluation.pass ? 1 : 0, evaluation.critical_fail ? 1 : 0,
                evaluation.summary, JSON.stringify(evaluation.warnings || []),
                JSON.stringify(result.raw), result.provider, result.model, promptHash
            ]
        );
        const [[evaluationRow]] = await pool.query(
            'SELECT id FROM `asteriskcdrdb`.`call_evaluations` WHERE job_id = ? LIMIT 1',
            [job.id]
        );
        const evaluationId = evaluationRow?.id;
        if (evaluationId) {
            await pool.query('DELETE FROM `asteriskcdrdb`.`evaluation_scores` WHERE evaluation_id = ?', [evaluationId]);
            if (evaluation.criteria.length) {
                await pool.query(
                    `INSERT INTO \`asteriskcdrdb\`.\`evaluation_scores\`
                     (evaluation_id, criterion_key, label, score, weight, weighted_score, critical, evidence_json, comment)
                     VALUES ?`,
                    [evaluation.criteria.map(item => [
                        evaluationId, item.key, item.label, item.score, item.weight,
                        item.weighted_score, item.critical ? 1 : 0,
                        JSON.stringify(item.evidence || []), item.comment || null
                    ])]
                );
            }
        }
        await pool.query(
            `UPDATE \`asteriskcdrdb\`.\`evaluation_jobs\`
             SET status = 'completed', completed_at = NOW(), processing_started_at = NULL,
                 provider = ?, model = ?, error_message = NULL
             WHERE id = ?`,
            [result.provider, result.model, job.id]
        );
        console.log(`[STT-WORKER] Evaluated ${job.target_type} ${job.target_id} with profile ${job.profile_id}: ${evaluation.overall_score}`);
    } catch (err) {
        console.error(`[STT-WORKER] Evaluation ${job.id} failed:`, err.message);
        await pool.query(
            `UPDATE \`asteriskcdrdb\`.\`evaluation_jobs\`
             SET attempt_count = attempt_count + 1,
                 status = IF(attempt_count + 1 >= ?, 'failed', 'pending'),
                 error_message = ?, processing_started_at = NULL
             WHERE id = ?`,
            [MAX_ATTEMPTS, String(err.message || err).slice(0, 500), job.id]
        );
    }
    return true;
}

async function processVoicemail(pool, settings) {
    // In on-demand mode, any explicitly queued voicemail is processed
    const [jobs] = await pool.query(`
        SELECT id, mailbox, msg_file, callerid, attempt_count
        FROM \`asteriskcdrdb\`.\`voicemail_transcriptions\`
        WHERE status = 'pending' AND attempt_count < ? ORDER BY id ASC LIMIT 1
    `, [MAX_ATTEMPTS]);
    if (!jobs?.length) return false;
    const job = jobs[0];
    const [claim] = await pool.query(`
        UPDATE \`asteriskcdrdb\`.\`voicemail_transcriptions\`
        SET status = 'processing', processing_started_at = NOW(), error_message = NULL
        WHERE id = ? AND status = 'pending'
    `, [job.id]);
    if (!claim.affectedRows) return true;
    const audioPath = resolveVoicemailAudioPath(job.mailbox, job.msg_file);
    if (!audioPath) {
        await markFailure(pool, 'voicemail_transcriptions', job.id, new Error('Voicemail audio file not found on disk'), true);
        return true;
    }
    const vmStat = fs.statSync(audioPath);
    if (!vmStat.size || vmStat.size <= 44) {
        await pool.query(`
            UPDATE \`asteriskcdrdb\`.\`voicemail_transcriptions\`
            SET status = 'completed', transcript = '[No speech in voicemail]', completed_at = NOW()
            WHERE id = ?
        `, [job.id]);
        return true;
    }
    activeJob = { table: 'voicemail_transcriptions', id: job.id };
    const started = Date.now();
    try {
        const detailed = await normalizeAndTranscribe(audioPath, `vm_${job.id}`, settings);
        const transcript = detailed.text || '[No speech in voicemail]';
        const saved = await persistSegments(pool, 'voicemail', job.id, detailed.segments, detailed.language);
        await pool.query(`
            UPDATE \`asteriskcdrdb\`.\`voicemail_transcriptions\`
            SET status = 'completed', transcript = ?, completed_at = NOW(), processing_started_at = NULL,
                processing_ms = ?, engine = ?, model_used = ?, segments_json = ?,
                provider = ?, language_detected = ?, confidence_avg = ? WHERE id = ?
        `, [transcript, Date.now() - started,
            isLocalSettings(settings) ? 'local_whisper' : 'cloud_api', detailed.model || settings.model_name || '',
            JSON.stringify(saved.segments), detailed.provider || settings.provider || null,
            detailed.language || null, saved.confidenceAvg, job.id]);
        await enqueueEvaluationJobs(pool, 'voicemail', job.id, {
            targetId: `${job.mailbox}/${job.msg_file}`,
            uniqueid: null,
            direction: 'any',
            duration: 0,
            mailbox: job.mailbox,
            msg_file: job.msg_file
        });
        console.log(`[STT-WORKER] Transcribed voicemail ${job.mailbox}/${job.msg_file} in ${Date.now() - started}ms.`);
    } catch (err) {
        console.error(`[STT-WORKER] Voicemail ${job.mailbox}/${job.msg_file} failed:`, err.message);
        if (!shuttingDown) await markFailure(pool, 'voicemail_transcriptions', job.id, err);
    } finally {
        if (activeJob?.table === 'voicemail_transcriptions' && activeJob.id === job.id) activeJob = null;
    }
    return true;
}

async function processCall(pool, settings) {
    // In on-demand mode, any explicitly queued call is processed
    const [jobs] = await pool.query(`
        SELECT t.id, t.uniqueid, t.recordingfile, t.language, t.attempt_count,
               c.calldate, c.duration, c.billsec, c.src, c.dst, c.dcontext, c.disposition, c.did
        FROM \`asteriskcdrdb\`.\`cdr_transcriptions\` t
        LEFT JOIN \`asteriskcdrdb\`.\`cdr\` c ON c.uniqueid = t.uniqueid
        WHERE t.status = 'pending' AND t.attempt_count < ? ORDER BY t.id ASC LIMIT 1
    `, [MAX_ATTEMPTS]);
    if (!jobs?.length) return false;
    const job = jobs[0];
    const duration = Number(job.billsec || job.duration || 0);
    if (duration < Number(settings.min_duration_sec || 3)) {
        await pool.query(`
            UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
            SET status = 'completed', transcript = '[Call duration too short for transcription]', completed_at = NOW()
            WHERE id = ?
        `, [job.id]);
        return true;
    }
    const [claim] = await pool.query(`
        UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
        SET status = 'processing', processing_started_at = NOW(), error_message = NULL
        WHERE id = ? AND status = 'pending'
    `, [job.id]);
    if (!claim.affectedRows) return true;
    const audioPath = resolveCallAudioPath(job.recordingfile, job.calldate);
    if (!audioPath) {
        await markFailure(pool, 'cdr_transcriptions', job.id, new Error('Recording audio file not found on disk'), true);
        return true;
    }
    const callStat = fs.statSync(audioPath);
    if (!callStat.size || callStat.size <= 44) {
        await pool.query(`
            UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
            SET status = 'completed', transcript = '[No audio recorded]', completed_at = NOW()
            WHERE id = ?
        `, [job.id]);
        return true;
    }
    activeJob = { table: 'cdr_transcriptions', id: job.id };
    const started = Date.now();
    try {
        const detailed = await normalizeAndTranscribe(audioPath, `call_${job.id}`, {
            ...settings, language: job.language && job.language !== 'auto' ? job.language : settings.language
        });
        const transcript = detailed.text || '[No speech detected]';
        const saved = await persistSegments(pool, 'call', job.id, detailed.segments, detailed.language);
        await pool.query(`
            UPDATE \`asteriskcdrdb\`.\`cdr_transcriptions\`
            SET status = 'completed', transcript = ?, duration_sec = ?, completed_at = NOW(),
                processing_started_at = NULL, processing_ms = ?, engine = ?, model_used = ?,
                segments_json = ?, provider = ?, language_detected = ?, confidence_avg = ? WHERE id = ?
        `, [transcript, duration, Date.now() - started,
            isLocalSettings(settings) ? 'local_whisper' : 'cloud_api', detailed.model || settings.model_name || '',
            JSON.stringify(saved.segments), detailed.provider || settings.provider || null,
            detailed.language || null, saved.confidenceAvg, job.id]);
        let campaignId = null;
        try {
            const [campaignRows] = await pool.query(
                `SELECT campaign_id FROM \`asterisk\`.\`dialer_call_attempts\`
                 WHERE (uniqueid = ? OR linkedid = ?) ORDER BY created_at DESC LIMIT 1`,
                [job.uniqueid, job.uniqueid]
            );
            campaignId = campaignRows?.[0]?.campaign_id || null;
        } catch (_) {}
        await enqueueEvaluationJobs(pool, 'call', job.id, {
            uniqueid: job.uniqueid,
            direction: inferCallDirection(job),
            duration,
            src: job.src,
            dst: job.dst,
            dcontext: job.dcontext,
            disposition: job.disposition,
            did: job.did,
            agent: job.src,
            campaignId
        });
        console.log(`[STT-WORKER] Transcribed call ${job.uniqueid} (${duration}s) in ${Date.now() - started}ms.`);
    } catch (err) {
        console.error(`[STT-WORKER] Call ${job.uniqueid} failed:`, err.message);
        if (!shuttingDown) await markFailure(pool, 'cdr_transcriptions', job.id, err);
    } finally {
        if (activeJob?.table === 'cdr_transcriptions' && activeJob.id === job.id) activeJob = null;
    }
    return true;
}

async function processNextJob(pool) {
    if (isBusy) return;
    isBusy = true;
    try {
        const settings = await getSttSettings(pool);
        const canTranscribe = Boolean(Number(settings.enabled)) && (isLocalSettings(settings) || Boolean(settings.api_key));
        if (canTranscribe) {
            pauseDuringCallsEnabled = Boolean(Number(settings.pause_during_calls ?? 1));
            if (!(pauseDuringCallsEnabled && await hasActiveCalls())) {
                const didVoicemail = await processVoicemail(pool, settings);
                if (!didVoicemail) await processCall(pool, settings);
            }
        }
        // Evaluation is a cloud API call, not local CPU. Run it even while
        // telephony is busy and when transcription is disabled. Do not return
        // after a transcription so evaluation cannot starve behind a backlog.
        await processEvaluationJob(pool);
    } catch (err) {
        console.error('[STT-WORKER] Loop error:', err.message);
    } finally {
        isBusy = false;
    }
}

async function startWorker() {
    if (!DB_CONFIG.password) throw new Error(`A database password is required. Configure DB_PASS or DB_PASS_B64 in ${envFile}.`);
    console.log('[STT-WORKER] Starting Sokrat Speech-To-Text worker...');
    const pool = mysql.createPool(DB_CONFIG);
    // Recover a suspended engine only when telephony is idle. Otherwise keep it
    // stopped until the live-call guard observes that all channels have ended.
    if (await hasActiveCalls()) {
        await signalLocalWhisper('SIGSTOP');
        whisperPausedForCall = true;
    } else {
        await signalLocalWhisper('SIGCONT');
    }
    await recoverStaleJobs(pool);
    const callGuard = setInterval(() => {
        enforceLiveCallPriority().catch(err => console.error('[STT-WORKER] Live-call guard error:', err.message));
    }, 2000);
    callGuard.unref();
    const shutdown = async signal => {
        if (shuttingDown) return;
        shuttingDown = true;
        isRunning = false;
        clearInterval(callGuard);
        activeRequestController?.abort(new Error(`Worker received ${signal}`));
        if (activeJob) {
            await pool.query(`
                UPDATE \`asteriskcdrdb\`.\`${activeJob.table}\`
                SET status = 'pending', processing_started_at = NULL,
                    error_message = 'Requeued after graceful worker shutdown'
                WHERE id = ? AND status = 'processing'
            `, [activeJob.id]);
            activeJob = null;
        }
        if (whisperPausedForCall && !await hasActiveCalls()) {
            await signalLocalWhisper('SIGCONT');
            whisperPausedForCall = false;
        }
        console.log(`[STT-WORKER] Received ${signal}; shutting down.`);
        await pool.end();
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    let recoveryCounter = 0;
    while (isRunning) {
        await processNextJob(pool);
        if (++recoveryCounter >= 120) {
            await recoverStaleJobs(pool);
            recoveryCounter = 0;
        }
        await new Promise(resolve => setTimeout(resolve, 2500));
    }
}

if (require.main === module) {
    startWorker().catch(err => {
        console.error('[STT-WORKER] Fatal startup error:', err.message);
        process.exit(1);
    });
}

module.exports = {
    resolveCallAudioPath,
    resolveVoicemailAudioPath,
    prepareAudioForUpload,
    prepareAudioForLocal,
    transcribeWithCloudAi,
    transcribeWithCloudAiDetailed,
    transcribeWithLocalWhisper,
    transcribeAudio,
    transcribeAudioDetailed,
    testCloudSttConnection,
    getAudioDuration,
    transcribeWithMunsit,
    testSttConnection,
    getSttSettings,
    getAiEvaluationSettings,
    processEvaluationJob,
    recoverStaleJobs,
    processNextJob,
    assertLoopbackEndpoint,
    extractTranscript,
    parseAsteriskActivity,
    signalLocalWhisper,
    enforceLiveCallPriority
};
