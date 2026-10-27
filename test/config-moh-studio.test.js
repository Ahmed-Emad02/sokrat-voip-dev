const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const configEjsPath = path.join(__dirname, '../views/config.ejs');
const serverJsPath = path.join(__dirname, '../server.js');

const configSrc = fs.readFileSync(configEjsPath, 'utf8') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '');
const serverSrc = fs.readFileSync(serverJsPath, 'utf8');

test('Music-on-Hold tracks expose the audio studio', async () => {
    const pageHtml = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['recordings'],
        isTabAllowed: (t) => t === 'recordings'
    });
    // The MoH studio code lives in the external client bundle now.
    const bundlePath = path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs');
    const bundleHtml = fs.existsSync(bundlePath) ? await ejs.renderFile(bundlePath, { isRtl: false }) : '';
    const html = pageHtml + bundleHtml;
    assert.ok(html.includes('openMohStudioModal('), 'MoH rows must expose a Studio action');
    assert.ok(html.includes('window.openMohStudioModal = openMohStudioModal;'), 'openMohStudioModal must be exported to window');
    assert.ok(html.includes('studioEndpoints'), 'The studio must resolve its endpoints per target');
    assert.ok(html.includes('kind: \'moh\''), 'The studio must support a MoH target kind');
});

test('The studio drives the recording and the MoH endpoints', () => {
    // target aware endpoints
    assert.ok(configSrc.includes("/api/config/moh/file/info?category="), 'MoH info endpoint must be used');
    assert.ok(configSrc.includes("/api/config/moh/stream/"), 'MoH stream endpoint must be used for the preview');
    assert.ok(configSrc.includes("dsp: '/api/config/moh/file/dsp'"), 'MoH DSP endpoint must be used');
    // the recordings path keeps working
    assert.ok(configSrc.includes("info: `/api/config/recordings/${id}/info`"), 'Recordings info endpoint must be kept');
    assert.ok(configSrc.includes("dsp: `/api/config/recordings/${id}/dsp`"), 'Recordings DSP endpoint must be kept');
    // the MoH payload carries the target
    assert.ok(configSrc.includes('payload.category = studioTarget.category;'), 'MoH DSP payload must carry the category');
    assert.ok(configSrc.includes('payload.filename = studioTarget.filename;'), 'MoH DSP payload must carry the file name');
});

test('server exposes the MoH studio endpoints', () => {
    assert.ok(serverSrc.includes("app.get('/api/config/moh/file/info'"), 'Must expose the MoH track info endpoint');
    assert.ok(serverSrc.includes("app.post('/api/config/moh/file/dsp'"), 'Must expose the MoH track DSP endpoint');
    assert.ok(serverSrc.includes('async function processMohDsp(categoryName, fileName, options = {})'),
        'Must define processMohDsp');
});

test('MoH processing keeps the pristine copy out of the category folder', () => {
    assert.ok(serverSrc.includes(".studio-backup"), 'MoH backups must live in a hidden folder outside the category');
    assert.ok(serverSrc.includes('soxOutputArgsForExt'), 'The original container format must be preserved');
    assert.ok(serverSrc.includes('function buildStudioDspChain(o)'), 'Recordings and MoH must share one effect chain');
    // the recordings path must use the shared chain too
    assert.ok(serverSrc.includes('const dspEffects = buildStudioDspChain({'), 'processRecordingDsp must use the shared chain');
});

test('MoH studio state is stored in its own AstDB namespace', () => {
    assert.ok(serverSrc.includes('database put MOH'), 'MoH studio settings must be persisted under the MOH namespace');
    assert.ok(serverSrc.includes('database get MOH'), 'MoH studio settings must be read back from the MOH namespace');
    assert.ok(serverSrc.includes('RECORDINGS ${recId}/gain'), 'Recordings keep their own AstDB namespace');
});
