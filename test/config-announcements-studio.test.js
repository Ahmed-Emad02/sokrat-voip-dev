const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const configEjsPath = path.join(__dirname, '../views/config.ejs');
const serverJsPath = path.join(__dirname, '../server.js');

const configSrc = fs.readFileSync(configEjsPath, 'utf8') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '');
const serverSrc = fs.readFileSync(serverJsPath, 'utf8');

test('Announcements modal exposes the audio studio, preview and upload actions', async () => {
    const html = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['announcements'],
        isTabAllowed: (t) => t === 'announcements'
    });

    assert.ok(html.includes('id="annStudioBtn"'), 'Announcement modal must expose a Studio button');
    assert.ok(html.includes('id="annPreviewBtn"'), 'Announcement modal must expose a Preview button');
    assert.ok(html.includes('id="annUploadBtn"'), 'Announcement modal must expose an Upload button');
    assert.ok(html.includes('id="annRecordingState"'), 'Announcement modal must expose the studio state line');
    assert.ok(html.includes('id="recordingUploadModal"'), 'Shared recording upload modal must be rendered');
    assert.ok(html.includes('id="ruName"') && html.includes('id="ruFile"') && html.includes('id="ruGain"'),
        'Upload modal must carry name, file and headroom fields');
});

test('Announcements table offers a Studio action and flags a missing recording', () => {
    assert.ok(configSrc.includes('openAnnouncementStudioById('), 'Announcements rows must expose a Studio action');
    assert.ok(configSrc.includes('window.openAnnouncementStudioById = openAnnouncementStudioById;'),
        'openAnnouncementStudioById must be exported to window');
    assert.ok(configSrc.includes('ann.recording_missing'), 'Announcements rows must flag a missing recording');
    assert.ok(configSrc.includes('Recording missing'), 'Missing recording must be labelled in the table');
});

test('Announcement recording picker keeps a deleted recording visible and flagged', () => {
    assert.ok(configSrc.includes('Missing recording'), 'Picker must show a missing recording entry');
    assert.ok(configSrc.includes('updateAnnouncementRecordingState'), 'Picker must refresh the studio state line');
    assert.ok(configSrc.includes('window.updateAnnouncementRecordingState = updateAnnouncementRecordingState;'),
        'updateAnnouncementRecordingState must be exported to window');
    assert.ok(configSrc.includes('onAnnRecordingChange();'), 'Changing the recording must refresh the studio state');
});

test('Announcements API validates the audio source and reports missing recordings', () => {
    // GET: flag announcements whose recording no longer exists
    assert.ok(serverSrc.includes('CASE WHEN a.recording_id > 0 AND r.id IS NULL THEN 1 ELSE 0 END AS recording_missing'),
        'Announcements GET must flag a missing recording');
    assert.ok(serverSrc.includes('r.displayname AS recording_name'), 'Announcements GET must return the recording name');

    // Shared validation used by POST and PUT
    assert.ok(serverSrc.includes('async function validateAnnouncementAudio(recId, ttsText)'),
        'Must define validateAnnouncementAudio');
    assert.ok(serverSrc.includes('The selected system recording no longer exists'),
        'Validation must reject a recording that no longer exists');
    assert.ok(serverSrc.includes('Choose a system recording, or enter the text to be spoken.'),
        'Validation must require a recording or TTS text');
    const validationCalls = (serverSrc.match(/await validateAnnouncementAudio\(/g) || []).length;
    assert.ok(validationCalls >= 2, 'Both POST and PUT must validate the announcement audio');
});

test('Recording upload returns the new recording id so it can be selected immediately', () => {
    assert.ok(serverSrc.includes("res.json({ success: true, id: newRecordingId, message: 'Recording \"'"),
        'Upload endpoint must return the new recording id');
    assert.ok(configSrc.includes('const newId = (result.recording && result.recording.id) || result.id || 0;'),
        'Upload modal must select the freshly uploaded recording');
    assert.ok(configSrc.includes('function uploadRecordingFile(file, name, gainDb, onProgress)'),
        'Upload must be shared between the System Recordings tab and the Announcements modal');
});

test('SMS messenger no longer renders the inbox count badge', () => {
    const donglesSrc = fs.readFileSync(path.join(__dirname, '../views/gsm-dongles.ejs'), 'utf8');
    assert.ok(!donglesSrc.includes('id="sms-inbox-count"'), 'The SMS inbox count badge must be removed from the panel');
    assert.ok(donglesSrc.includes('function updateSmsInboxCount(count) {'),
        'The count updater must stay null-safe for the removed badge');
    assert.ok(donglesSrc.includes('if (countEl) countEl.textContent'),
        'The count updater must guard against a missing element');
});
