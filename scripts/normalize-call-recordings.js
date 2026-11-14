#!/usr/bin/env node
'use strict';

/**
 * Recording-only loudness normalizer.
 *
 * This never touches a live channel, an Asterisk dialplan, or the bridge.
 * It scans completed WAV recordings, applies speech-oriented dynamic
 * normalization and loudness normalization, and atomically replaces the file.
 *
 * The first run records a cutoff timestamp and skips older recordings so an
 * installation cannot unexpectedly rewrite historical call evidence. Pass
 * --all to explicitly process the existing archive, or --file <path> to
 * process one file.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RECORDING_ROOT = process.env.RECORDING_ROOT || '/var/spool/asterisk/monitor';
const STATE_DIR = process.env.RECORDING_NORMALIZER_STATE_DIR || '/var/lib/sokrat-recording-normalizer';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = path.join(STATE_DIR, '.lock');
const FFMPEG = process.env.FFMPEG_BIN || '/usr/local/bin/ffmpeg';
const ASTERISK_BIN = process.env.ASTERISK_BIN || '/usr/sbin/asterisk';
const MIN_AGE_MS = Math.max(30, Number(process.env.RECORDING_NORMALIZER_MIN_AGE_SEC || 120)) * 1000;
const MAX_FILES = Math.max(1, Number(process.env.RECORDING_NORMALIZER_MAX_FILES || 5));
const FILTER = process.env.RECORDING_NORMALIZER_FILTER
    || 'dynaudnorm=f=250:g=15:p=0.9:m=8,loudnorm=I=-16:TP=-1.5:LRA=11';

function log(message) {
    console.log(`[recording-normalizer] ${message}`);
}

function readState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function writeState(state) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
}

function listWavFiles(root, result = []) {
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
        return result;
    }
    for (const entry of entries) {
        if (entry.name === 'keys') continue;
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            listWavFiles(full, result);
        } else if (entry.isFile() && /\.wav$/i.test(entry.name)) {
            result.push(full);
        }
    }
    return result;
}

function isOpen(file) {
    const lsof = spawnSync('lsof', ['-t', '--', file], { encoding: 'utf8' });
    if (!lsof.error) return Boolean(String(lsof.stdout || '').trim());

    // lsof is not installed on every PBX; fuser is part of psmisc and is
    // present on the standard Issabel image.
    const fuser = spawnSync('fuser', [file], { encoding: 'utf8' });
    if (!fuser.error) {
        const text = `${fuser.stdout || ''}${fuser.stderr || ''}`.trim();
        if (text) return true;
        return !(fuser.status === 0 || fuser.status === 1);
    }
    return false;
}

function activeCallCount() {
    const result = spawnSync(ASTERISK_BIN, ['-rx', 'core show channels count'], { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    const match = `${result.stdout || ''}${result.stderr || ''}`.match(/(\d+)\s+active calls?/i);
    return match ? Number(match[1]) : null;
}

function normalizationEnabled() {
    const result = spawnSync(ASTERISK_BIN, ['-rx', 'database get AUDIO_GLOBALS recording_normalize'], { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) return true;
    const match = `${result.stdout || ''}${result.stderr || ''}`.match(/Value:\s*(\S+)/i);
    return !match || match[1] !== '0';
}

function normalizeFile(file, stat) {
    const temp = `${file}.norm-${process.pid}.wav`;
    const result = spawnSync(FFMPEG, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-i', file,
        '-af', FILTER,
        '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le',
        temp
    ], { stdio: 'ignore', timeout: 30 * 60 * 1000 });

    if (result.status !== 0 || !fs.existsSync(temp) || fs.statSync(temp).size < 1024) {
        try { fs.unlinkSync(temp); } catch (_) {}
        throw new Error(`ffmpeg failed${result.status === null ? ' (timeout)' : ` with status ${result.status}`}`);
    }

    try { fs.chmodSync(temp, stat.mode & 0o777); } catch (_) {}
    try { fs.chownSync(temp, stat.uid, stat.gid); } catch (_) {}
    fs.renameSync(temp, file);
    return fs.statSync(file);
}

function processOne(file, state, force = false) {
    const stat = fs.statSync(file);
    const age = Date.now() - stat.mtimeMs;
    const previous = state.files ? state.files[file] : null;

    if (!force && previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) return false;
    if (!force && age < MIN_AGE_MS) return false;
    if (!force && isOpen(file)) return false;

    const started = Date.now();
    const updated = normalizeFile(file, stat);
    if (!state.files) state.files = {};
    state.files[file] = { mtimeMs: updated.mtimeMs, size: updated.size, at: new Date().toISOString() };
    log(`normalized ${path.relative(RECORDING_ROOT, file)} in ${Date.now() - started}ms`);
    return true;
}

function main() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    let lock;
    try {
        lock = fs.openSync(LOCK_FILE, 'wx');
    } catch (_) {
        log('another run is active; exiting');
        return;
    }

    try {
        const args = process.argv.slice(2);
        const fileArgIndex = args.indexOf('--file');
        if (fileArgIndex !== -1) {
            const file = path.resolve(args[fileArgIndex + 1] || '');
            if (!file || !/\.wav$/i.test(file) || !fs.existsSync(file)) throw new Error('--file requires an existing .wav file');
            const state = readState();
            processOne(file, state, true);
            writeState(state);
            return;
        }

        if (!normalizationEnabled()) {
            log('recording normalization is disabled; skipping');
            return;
        }

        const active = activeCallCount();
        if (active === null || active > 0) {
            log(active === null ? 'cannot read Asterisk call state; skipping' : `${active} active call(s); skipping`);
            return;
        }

        const state = readState();
        if (state.files === undefined) state.files = {};
        if (args.includes('--all')) {
            state.since = 0;
        } else if (!Number.isFinite(Number(state.since))) {
            // Do not rewrite historical evidence on first install.
            state.since = Date.now();
            writeState(state);
            log(`initialized cutoff at ${new Date(state.since).toISOString()}; existing recordings are skipped`);
            return;
        }

        const files = listWavFiles(RECORDING_ROOT)
            .map(file => ({ file, stat: fs.statSync(file) }))
            .filter(item => item.stat.mtimeMs >= Number(state.since))
            .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

        let processed = 0;
        for (const item of files) {
            if (processed >= MAX_FILES) break;
            try {
                if (processOne(item.file, state)) processed += 1;
            } catch (error) {
                log(`${path.relative(RECORDING_ROOT, item.file)}: ${error.message}`);
            }
        }
        writeState(state);
        if (processed) log(`processed ${processed} recording(s)`);
    } finally {
        try { fs.closeSync(lock); } catch (_) {}
        try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    }
}

main();
