const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const configEjsPath = path.join(__dirname, '../views/config.ejs');
const serverJsPath = path.join(__dirname, '../server.js');

test('views/config.ejs renders Volume / Headroom column and upload headroom selector', async () => {
    const enHtml = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['recordings'],
        isTabAllowed: (t) => t === 'recordings'
    });
    assert.ok(enHtml.includes('Volume / Headroom'), 'English render should include Volume / Headroom column header');
    assert.ok(enHtml.includes('id="sysRecGain"'), 'English render should include sysRecGain select input');

    const arHtml = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'ar',
        isRtl: true,
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['recordings'],
        isTabAllowed: (t) => t === 'recordings'
    });
    assert.ok(arHtml.includes('مستوى الصوت / الهامش'), 'Arabic render should include localized column header');
    assert.ok(arHtml.includes('id="sysRecGain"'), 'Arabic render should include sysRecGain select input');
});

test('views/config.ejs defines saveRecordingVolume and setRecordingGainQuick functions', () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    assert.ok(content.includes('async function saveRecordingVolume(id) {'), 'Must define saveRecordingVolume');
    assert.ok(content.includes('function setRecordingGainQuick(id, gainDb) {'), 'Must define setRecordingGainQuick');
    assert.ok(content.includes('window.saveRecordingVolume = saveRecordingVolume;'), 'Must export saveRecordingVolume to window');
    assert.ok(content.includes('window.setRecordingGainQuick = setRecordingGainQuick;'), 'Must export setRecordingGainQuick to window');
    assert.ok(content.includes('id="recGainRange_${rec.id}"'), 'Must render dynamic range slider for each recording');
    assert.ok(content.includes('id="recGainBadge_${rec.id}"'), 'Must render live gain badge for each recording');
});

test('server.js defines adjustRecordingVolume and POST /api/config/recordings/:id/volume endpoint', () => {
    const content = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(content.includes('async function adjustRecordingVolume(recId, filename, gainDb) {'), 'Must define adjustRecordingVolume');
    assert.ok(content.includes("app.post('/api/config/recordings/:id/volume'"), 'Must define volume update POST route');
    assert.ok(content.includes('database put RECORDINGS'), 'Must persist gain in AstDB');
    assert.ok(content.includes('.orig.wav'), 'Must maintain pristine original backup to avoid multi-generation distortion');
});

test('SoX volume adjustment accurately scales 16-bit linear PCM audio without clipping', () => {
    const { execSync } = require('child_process');
    const tmpOrig = '/tmp/test_scale_orig.wav';
    const tmpDest = '/tmp/test_scale_out.wav';

    try {
        execSync(`sox -n -r 8000 -c 1 -b 16 "${tmpOrig}" synth 1.0 sine 440`);
        const origStat = execSync(`sox "${tmpOrig}" -n stat 2>&1`, { encoding: 'utf8' });
        const origPeakMatch = origStat.match(/Maximum amplitude:\s+([\d\.]+)/);
        assert.ok(origPeakMatch, 'Should measure original peak amplitude');
        const origPeak = parseFloat(origPeakMatch[1]);
        assert.ok(origPeak > 0.65, 'Original peak should be near 0.707 (-3 dBFS)');

        execSync(`sox "${tmpOrig}" -r 8000 -c 1 -b 16 "${tmpDest}" vol -18 dB`);
        const scaledStat = execSync(`sox "${tmpDest}" -n stat 2>&1`, { encoding: 'utf8' });
        const scaledPeakMatch = scaledStat.match(/Maximum amplitude:\s+([\d\.]+)/);
        assert.ok(scaledPeakMatch, 'Should measure scaled peak amplitude');
        const scaledPeak = parseFloat(scaledPeakMatch[1]);

        assert.ok(scaledPeak < 0.12 && scaledPeak > 0.07, `Scaled peak should be approx 0.088 (-18 dB), got ${scaledPeak}`);
    } finally {
        if (fs.existsSync(tmpOrig)) fs.unlinkSync(tmpOrig);
        if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
    }
});

test('AstDB RECORDINGS family persists and parses gain values correctly', () => {
    const { execSync } = require('child_process');
    try {
        execSync('asterisk -rx "database put RECORDINGS 99999/gain -18"');
        const out = execSync('asterisk -rx "database get RECORDINGS 99999/gain"', { encoding: 'utf8' });
        assert.ok(out.includes('-18'), 'AstDB must return the stored gain of -18');
    } finally {
        execSync('asterisk -rx "database deltree RECORDINGS/99999"');
    }
});

test('views/config.ejs renders recordingStudioModal with full DSP control suite', async () => {
    const html = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['recordings'],
        isTabAllowed: (t) => t === 'recordings'
    });

    assert.ok(html.includes('id="recordingStudioModal"'), 'Must render recordingStudioModal backdrop');
    assert.ok(html.includes('id="dspNormDb"'), 'Must render Peak Normalizer selector');
    assert.ok(html.includes('id="dspCompand"'), 'Must render Voice Compander selector');
    assert.ok(html.includes('id="dspBandpass"'), 'Must render G.711 Telephony Bandpass checkbox');
    assert.ok(html.includes('id="dspHissFilter"'), 'Must render Hiss Filter checkbox');
    assert.ok(html.includes('id="dspBass"'), 'Must render Bass EQ range slider');
    assert.ok(html.includes('id="dspTreble"'), 'Must render Treble EQ range slider');
    assert.ok(html.includes('id="dspTrimSilence"'), 'Must render Auto-trim silence checkbox');
    assert.ok(html.includes('id="dspTempo"'), 'Must render Speech Pacing slider');
    assert.ok(html.includes('id="dspGenerateCodecs"'), 'Must render Multi-Codec cache checkbox');
    assert.ok(html.includes('onclick="openRecordingStudioModal('), 'Table rows must include Studio modal openers');
});

test('server.js defines processRecordingDsp and advanced DSP endpoints', () => {
    const content = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(content.includes('async function processRecordingDsp(recId, filename, options = {}) {'), 'Must define processRecordingDsp');
    assert.ok(content.includes("app.post('/api/config/recordings/:id/dsp'"), 'Must define POST /dsp route');
    assert.ok(content.includes("app.get('/api/config/recordings/:id/info'"), 'Must define GET /info route');
    assert.ok(content.includes('database put RECORDINGS'), 'Must persist settings in AstDB');
});

test('SoX combined DSP pipeline successfully applies normalization, companding, sinc filtering, and multi-codec export', () => {
    const { execSync } = require('child_process');
    const tmpIn = '/tmp/test_full_dsp_in.wav';
    const tmpOut = '/tmp/test_full_dsp_out.wav';
    const tmpGsm = '/tmp/test_full_dsp_out.gsm';
    const tmpAlaw = '/tmp/test_full_dsp_out.alaw';

    try {
        execSync(`sox -n -r 8000 -c 1 -b 16 "${tmpIn}" synth 2.0 sine 440 vol 0.9 pad 0.3 0.3`);

        execSync(`sox "${tmpIn}" -r 8000 -c 1 -b 16 "${tmpOut}" ` +
            `silence 1 0.1 1% reverse silence 1 0.1 1% reverse ` +
            `norm -18 ` +
            `sinc 300-3400 ` +
            `compand 0.05,0.2 6:-60,-40,-20 -10 -60 0.05 ` +
            `bass +2 ` +
            `treble +1 ` +
            `tempo -s 1.05 ` +
            `pad 0.1 0.1`);

        assert.ok(fs.existsSync(tmpOut), 'Processed WAV must exist');
        const stat = execSync(`sox "${tmpOut}" -n stat 2>&1`, { encoding: 'utf8' });
        const maxMatch = stat.match(/Maximum amplitude:\s+([\d\.]+)/);
        assert.ok(maxMatch, 'Must measure max amplitude');
        const peak = parseFloat(maxMatch[1]);
        assert.ok(peak < 0.20 && peak > 0.05, `Peak should be near -18 dBFS, got ${peak}`);

        execSync(`sox "${tmpOut}" -r 8000 -c 1 "${tmpGsm}"`);
        execSync(`sox "${tmpOut}" -r 8000 -c 1 -t al "${tmpAlaw}"`);
        assert.ok(fs.existsSync(tmpGsm) && fs.statSync(tmpGsm).size > 0, 'GSM file must exist');
        assert.ok(fs.existsSync(tmpAlaw) && fs.statSync(tmpAlaw).size > 0, 'ALAW file must exist');
    } finally {
        [tmpIn, tmpOut, tmpGsm, tmpAlaw].forEach(f => {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        });
    }
});
test('Recording studio supports controllable pre-roll and post-roll silence padding with SoX', () => {
    const configContent = fs.readFileSync(configEjsPath, 'utf8');
    const serverContent = fs.readFileSync(serverJsPath, 'utf8');

    // UI assertions
    assert.ok(configContent.includes('id="dspEnablePadLead"'), 'Must render pre-roll silence toggle');
    assert.ok(configContent.includes('id="dspEnablePadTrail"'), 'Must render post-roll silence toggle');
    assert.ok(configContent.includes('id="dspPadLeadRange"'), 'Must render pre-roll range slider');
    assert.ok(configContent.includes('id="dspPadTrailRange"'), 'Must render post-roll range slider');
    assert.ok(configContent.includes('id="dspPadLead"'), 'Must render pre-roll number input');
    assert.ok(configContent.includes('id="dspPadTrail"'), 'Must render post-roll number input');
    assert.ok(configContent.includes('syncStudioSilenceControls'), 'Must define syncStudioSilenceControls helper');
    assert.ok(configContent.includes('setStudioSilenceQuick'), 'Must define setStudioSilenceQuick helper');
    assert.ok(configContent.includes('id="timelinePreRoll"'), 'Must render visual timeline preview');

    // Server assertions
    assert.ok(serverContent.includes('enablePadLead'), 'Server must parse enablePadLead');
    assert.ok(serverContent.includes('enablePadTrail'), 'Server must parse enablePadTrail');

    // Real SoX execution with 0.5s pre-roll and 1.0s post-roll padding
    const { execSync } = require('child_process');
    const tmpIn = path.join('/tmp', `test_pad_in_${Date.now()}.wav`);
    const tmpOut = path.join('/tmp', `test_pad_out_${Date.now()}.wav`);

    try {
        // Generate 1.0s sine wave
        execSync(`sox -n -r 8000 -c 1 -b 16 "${tmpIn}" synth 1.0 sine 440 vol 0.5`);
        const statIn = execSync(`sox "${tmpIn}" -n stat 2>&1`, { encoding: 'utf8' });
        const lenIn = parseFloat((statIn.match(/Length \(seconds\):\s+([\d\.]+)/) || [])[1] || 0);
        assert.ok(Math.abs(lenIn - 1.0) < 0.05, `Input length must be ~1.0s, got ${lenIn}`);

        // Apply SoX pad 0.50 1.00 (0.5s pre-roll + 1.0s post-roll)
        execSync(`sox "${tmpIn}" -r 8000 -c 1 -b 16 "${tmpOut}" pad 0.50 1.00`);
        const statOut = execSync(`sox "${tmpOut}" -n stat 2>&1`, { encoding: 'utf8' });
        const lenOut = parseFloat((statOut.match(/Length \(seconds\):\s+([\d\.]+)/) || [])[1] || 0);

        // Total length should be 1.0 + 0.5 + 1.0 = 2.5s
        assert.ok(Math.abs(lenOut - 2.5) < 0.05, `Padded audio length must be ~2.5s, got ${lenOut}`);
    } finally {
        [tmpIn, tmpOut].forEach(f => {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        });
    }
});
