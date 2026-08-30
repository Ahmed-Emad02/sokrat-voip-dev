const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ejs = require('ejs');

test('whisper.cpp binaries and models exist on disk', () => {
    assert.ok(fs.existsSync('/usr/local/bin/whisper-cli'), '/usr/local/bin/whisper-cli wrapper must exist');
    assert.ok(fs.existsSync('/opt/whisper.cpp/build/bin/whisper-cli'), 'whisper-cli binary must exist');
    assert.ok(fs.existsSync('/opt/whisper.cpp/models/ggml-base.bin'), 'ggml-base.bin model must exist');
    assert.ok(fs.existsSync('/opt/whisper.cpp/models/ggml-tiny.bin'), 'ggml-tiny.bin model must exist');
});

test('scripts/stt-worker.js and scripts/enqueue-stt.js exist and export required helpers', () => {
    assert.ok(fs.existsSync(path.join(__dirname, '../scripts/stt-worker.js')), 'scripts/stt-worker.js must exist');
    assert.ok(fs.existsSync(path.join(__dirname, '../scripts/enqueue-stt.js')), 'scripts/enqueue-stt.js must exist');

    const worker = require('../scripts/stt-worker');
    assert.equal(typeof worker.resolveCallAudioPath, 'function', 'resolveCallAudioPath must be exported');
    assert.equal(typeof worker.resolveVoicemailAudioPath, 'function', 'resolveVoicemailAudioPath must be exported');
    assert.equal(typeof worker.convertTo16kWav, 'function', 'convertTo16kWav must be exported');
    assert.equal(typeof worker.runWhisperTranscription, 'function', 'runWhisperTranscription must be exported');

    const enqueue = require('../scripts/enqueue-stt');
    assert.equal(typeof enqueue.enqueueCall, 'function', 'enqueueCall must be exported');
    assert.equal(typeof enqueue.enqueueVoicemail, 'function', 'enqueueVoicemail must be exported');
    assert.equal(typeof enqueue.scanAndEnqueueUntranscribed, 'function', 'scanAndEnqueueUntranscribed must be exported');
});

test('systemd service unit /etc/systemd/system/sokrat-stt.service exists with low CPU priority', () => {
    assert.ok(fs.existsSync('/etc/systemd/system/sokrat-stt.service'), 'sokrat-stt.service unit must exist');
    const unitContent = fs.readFileSync('/etc/systemd/system/sokrat-stt.service', 'utf8');
    assert.ok(unitContent.includes('Nice=15'), 'Service must run with Nice=15 low CPU priority');
    assert.ok(unitContent.includes('CPUShares=256'), 'Service must restrict CPUShares');
    assert.ok(unitContent.includes('scripts/stt-worker.js'), 'Service must execute scripts/stt-worker.js');
});

test('server.js defines all required STT REST API routes and CDR/Voicemail integrations', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.ok(serverJs.includes("app.get('/api/transcripts/call/:uniqueid'"), 'GET /api/transcripts/call/:uniqueid route must exist');
    assert.ok(serverJs.includes("app.post('/api/transcripts/call/:uniqueid/transcribe'"), 'POST /api/transcripts/call/:uniqueid/transcribe route must exist');
    assert.ok(serverJs.includes("app.get('/api/transcripts/voicemail/:mailbox/:file'"), 'GET /api/transcripts/voicemail route must exist');
    assert.ok(serverJs.includes("app.post('/api/transcripts/voicemail/:mailbox/:file/transcribe'"), 'POST /api/transcripts/voicemail route must exist');
    assert.ok(serverJs.includes("app.get('/api/config/stt'"), 'GET /api/config/stt route must exist');
    assert.ok(serverJs.includes("app.put('/api/config/stt'"), 'PUT /api/config/stt route must exist');
    assert.ok(serverJs.includes("app.post('/api/transcripts/scan'"), 'POST /api/transcripts/scan route must exist');

    assert.ok(serverJs.includes('cdr_transcriptions'), 'server.js must query cdr_transcriptions table');
    assert.ok(serverJs.includes('voicemail_transcriptions'), 'server.js must query voicemail_transcriptions table');
    assert.ok(serverJs.includes('searchTranscript'), 'server.js must support searchTranscript parameter');
});

test('views/cdr.ejs renders transcript filter, STT buttons and transcript modal without errors', async () => {
    const cdrEjsPath = path.join(__dirname, '../views/cdr.ejs');
    const moment = require('moment');

    const html = await ejs.renderFile(cdrEjsPath, {
        currentPage: '/cdr',
        currentLang: 'en',
        isRtl: false,
        isSuper: true,
        user: { username: 'admin', isRoot: true },
        t: {
            title: 'Call', subtitle: 'History',
            startTime: 'Start Time', endTime: 'End Time', roster: 'Roster',
            allExt: 'All Extensions', status: 'Status', allDisp: 'All Dispositions',
            direction: 'Direction', allDir: 'All Directions', dirOut: 'Outbound',
            dirIn: 'Inbound', dirInternal: 'Internal', scope: 'Scope', allScope: 'All Scope',
            scopeInternal: 'Internal', scopeExternal: 'External', src: 'Source',
            dst: 'Destination', did: 'DID', uid: 'Unique ID', btn: 'Apply Filters',
            pagShowing: 'Showing', pagOf: 'of', pagResults: 'results', pagPrev: 'Prev',
            pagNext: 'Next', noAudio: 'No Audio', download: 'Download', deleteBtn: 'Delete',
            footerLeft: 'Total', footerRight: 'Records'
        },
        filters: {
            startDate: '2026-08-30 00:00:00',
            endDate: '2026-08-30 23:59:59',
            targetExtension: 'ALL',
            statusFilter: 'ALL',
            searchSrc: '',
            searchDst: '',
            searchDid: '',
            searchUniqueId: '',
            searchTranscript: 'invoice',
            directionFilter: 'ALL',
            callScopeFilter: 'ALL',
            page: 1,
            perPage: 25
        },
        pagination: { total: 1, totalPages: 1, page: 1, perPage: 25 },
        calls: [
            {
                calldate: new Date(),
                src: '101',
                dst: '01011719380',
                dcontext: 'from-internal',
                lastdata: '',
                duration: 45,
                billsec: 40,
                disposition: 'ANSWERED',
                uniqueid: '1725000000.1',
                recordingfile: '/var/spool/asterisk/monitor/2026/08/30/call-101.wav',
                channel: 'PJSIP/101-00000001',
                dstchannel: 'Dongle/dongle1/01011719380',
                did: '',
                src_name: 'Ahmed',
                direction: 'OUTBOUND',
                call_scope: 'EXTERNAL',
                transcript: 'Hello, this is a test transcript for our customer call.',
                stt_status: 'completed',
                stt_duration: 40,
                stt_lang: 'en'
            }
        ],
        roster: [{ extension: '101', name: 'Ahmed' }],
        moment
    });

    assert.ok(html.includes('id="cdrSearchTranscript"'), 'cdr.ejs must render searchTranscript input in filter bar');
    assert.ok(html.includes('id="transcriptModal"'), 'cdr.ejs must render transcriptModal');
    assert.ok(html.includes('showTranscriptModal'), 'cdr.ejs must wire showTranscriptModal handler');
    assert.ok(html.includes('transcribeCallNow'), 'cdr.ejs must wire transcribeCallNow handler');

    const scriptMatches = html.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/gi) || [];
    for (const s of scriptMatches) {
        const code = s.replace(/<script[\s\S]*?>/i, '').replace(/<\/script>/i, '');
        assert.doesNotThrow(() => {
            new Function(code);
        }, 'Client script in cdr.ejs must have valid JS syntax');
    }
});
test('views/voicemails.ejs renders transcript filter, STT badges and transcript modal without errors', async () => {
    const vmEjsPath = path.join(__dirname, '../views/voicemails.ejs');
    const moment = require('moment');

    const html = await ejs.renderFile(vmEjsPath, {
        currentPage: '/voicemails',
        currentLang: 'en',
        isRtl: false,
        user: { username: 'admin', isRoot: true },
        t: {
            title: 'Voice', subtitle: 'Mails',
            storageSettingsBtn: 'Storage', exportCsv: 'Export CSV',
            thMailbox: 'Mailbox', thCallerid: 'Caller ID', thDuration: 'Duration',
            thFile: 'File', thRec: 'Recording', thDate: 'Date',
            searchMailbox: 'All Mailboxes', startTime: 'Start Time', endTime: 'End Time',
            btn: 'Apply', clearBtn: 'Clear', noData: 'No Voicemails',
            download: 'Download', noAudio: 'No Audio', footerLeft: 'Total',
            footerRight: 'Messages', pagShowing: 'Showing', pagOf: 'of',
            pagResults: 'results', pagPrev: 'Prev', pagNext: 'Next'
        },
        filters: {
            searchCallerid: '',
            searchMailbox: '',
            searchTranscript: 'urgent',
            startDate: '',
            endDate: '',
            page: 1,
            perPage: 25
        },
        pagination: { total: 1, totalPages: 1, page: 1, perPage: 25 },
        messages: [
            {
                id: 1,
                mailbox: '101',
                callerid: '01011719380',
                origtime: Date.now(),
                duration: 25,
                wavFile: 'msg0001.wav',
                txtFile: 'msg0001.txt',
                transcript: 'Please call me back as soon as possible.',
                stt_status: 'completed'
            }
        ],
        mailboxes: ['101', '102'],
        moment
    });

    assert.ok(html.includes('id="vmSearchTranscript"'), 'voicemails.ejs must render vmSearchTranscript input');
    assert.ok(html.includes('id="vmTranscriptModal"'), 'voicemails.ejs must render vmTranscriptModal');
    assert.ok(html.includes('showVmTranscriptModal'), 'voicemails.ejs must wire showVmTranscriptModal handler');
    const scriptMatches = html.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/gi) || [];
    for (const s of scriptMatches) {
        const code = s.replace(/<script[\s\S]*?>/i, '').replace(/<\/script>/i, '');
        assert.doesNotThrow(() => {
            new Function(code);
        }, 'Client script in voicemails.ejs must have valid JS syntax');
    }
    assert.ok(html.includes('transcribeVoicemailNow'), 'voicemails.ejs must wire transcribeVoicemailNow handler');
});

test('views/config.ejs renders AI Speech-to-Text Transcription Engine Card', async () => {
    const configEjsPath = path.join(__dirname, '../views/config.ejs');
    const html = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        isSuperAdmin: true,
        isRoot: true,
        user: { username: 'admin', isRoot: true },
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['modem', 'extensions'],
        isTabAllowed: () => true
    });

    assert.ok(html.includes('id="sttEnabled"'), 'config.ejs must render sttEnabled select');
    assert.ok(html.includes('id="sttModel"'), 'config.ejs must render sttModel select');
    assert.ok(html.includes('id="sttLanguage"'), 'config.ejs must render sttLanguage select');
    assert.ok(html.includes('id="sttTranscribeCalls"'), 'config.ejs must render sttTranscribeCalls select');
    assert.ok(html.includes('id="sttTranscribeVoicemails"'), 'config.ejs must render sttTranscribeVoicemails select');
    assert.ok(html.includes('saveSttSettings'), 'config.ejs must wire saveSttSettings handler');
    assert.ok(html.includes('scanAndTranscribeQueue'), 'config.ejs must wire scanAndTranscribeQueue handler');
});

test('live whisper transcription executes on sample audio and returns clean transcript', async () => {
    const { runWhisperTranscription } = require('../scripts/stt-worker');
    const sampleWav = '/opt/whisper.cpp/samples/jfk.wav';
    assert.ok(fs.existsSync(sampleWav), 'Sample audio /opt/whisper.cpp/samples/jfk.wav must exist');

    const transcript = await runWhisperTranscription(sampleWav, 'tiny', 'en');
    assert.ok(transcript && transcript.length > 10, 'Transcript must contain valid text');
    assert.ok(transcript.toLowerCase().includes('fellow americans'), 'Transcript must accurately transcribe JFK sample');
});
