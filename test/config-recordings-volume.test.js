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
        // Generate a 1-second 8kHz mono sine wave at full scale (0 dBFS)
        execSync(`sox -n -r 8000 -c 1 -b 16 "${tmpOrig}" synth 1.0 sine 440`);
        const origStat = execSync(`sox "${tmpOrig}" -n stat 2>&1`, { encoding: 'utf8' });
        const origPeakMatch = origStat.match(/Maximum amplitude:\s+([\d\.]+)/);
        assert.ok(origPeakMatch, 'Should measure original peak amplitude');
        const origPeak = parseFloat(origPeakMatch[1]);
        assert.ok(origPeak > 0.65, 'Original peak should be near 0.707 (-3 dBFS)');

        // Scale by -18 dB
        execSync(`sox "${tmpOrig}" -r 8000 -c 1 -b 16 "${tmpDest}" vol -18 dB`);
        const scaledStat = execSync(`sox "${tmpDest}" -n stat 2>&1`, { encoding: 'utf8' });
        const scaledPeakMatch = scaledStat.match(/Maximum amplitude:\s+([\d\.]+)/);
        assert.ok(scaledPeakMatch, 'Should measure scaled peak amplitude');
        const scaledPeak = parseFloat(scaledPeakMatch[1]);

        // -18 dB is roughly 10^(-18/20) = 0.12589 * 0.707 = ~0.088
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
