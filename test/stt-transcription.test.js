const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ejs = require('ejs');

test('scripts/stt-worker.js and scripts/enqueue-stt.js export local and cloud STT helpers', () => {
    assert.ok(fs.existsSync(path.join(__dirname, '../scripts/stt-worker.js')), 'scripts/stt-worker.js must exist');
    assert.ok(fs.existsSync(path.join(__dirname, '../scripts/enqueue-stt.js')), 'scripts/enqueue-stt.js must exist');

    const worker = require('../scripts/stt-worker');
    assert.equal(typeof worker.resolveCallAudioPath, 'function', 'resolveCallAudioPath must be exported');
    assert.equal(typeof worker.resolveVoicemailAudioPath, 'function', 'resolveVoicemailAudioPath must be exported');
    assert.equal(typeof worker.prepareAudioForUpload, 'function', 'prepareAudioForUpload must be exported');
    assert.equal(typeof worker.prepareAudioForLocal, 'function', 'prepareAudioForLocal must be exported');
    assert.equal(typeof worker.transcribeWithCloudAi, 'function', 'transcribeWithCloudAi must be exported');
    assert.equal(typeof worker.transcribeWithLocalWhisper, 'function', 'transcribeWithLocalWhisper must be exported');
    assert.equal(typeof worker.testSttConnection, 'function', 'testSttConnection must be exported');
    assert.equal(typeof worker.enforceLiveCallPriority, 'function', 'live-call inference guard must be exported');
    assert.equal(typeof worker.parseAsteriskActivity, 'function', 'Asterisk activity parser must be exported');
    assert.equal(typeof worker.testCloudSttConnection, 'function', 'testCloudSttConnection must be exported');
    assert.equal(typeof worker.getAudioDuration, 'function', 'getAudioDuration must be exported');
    assert.equal(typeof worker.transcribeWithMunsit, 'function', 'transcribeWithMunsit must be exported');

    const enqueue = require('../scripts/enqueue-stt');
    assert.equal(typeof enqueue.enqueueCall, 'function', 'enqueueCall must be exported');
    assert.equal(typeof enqueue.enqueueVoicemail, 'function', 'enqueueVoicemail must be exported');
    assert.equal(typeof enqueue.scanAndEnqueueUntranscribed, 'function', 'scanAndEnqueueUntranscribed must be exported');
});

test('systemd service unit /etc/systemd/system/sokrat-stt.service exists with low CPU priority', () => {
    assert.ok(fs.existsSync('/etc/systemd/system/sokrat-stt.service'), 'sokrat-stt.service unit must exist');
    const unitContent = fs.readFileSync('/etc/systemd/system/sokrat-stt.service', 'utf8');
    assert.ok(unitContent.includes('Nice=19'), 'Service must run at the lowest normal CPU priority');
    assert.ok(unitContent.includes('CPUQuota=25%'), 'Worker service must have a strict CPU quota');
    assert.ok(unitContent.includes('scripts/stt-worker.js'), 'Service must execute scripts/stt-worker.js');
});

test('local whisper endpoint is restricted to loopback', () => {
    const { assertLoopbackEndpoint } = require('../scripts/stt-worker');
    assert.equal(assertLoopbackEndpoint('http://127.0.0.1:8178/inference'), 'http://127.0.0.1:8178/inference');
    assert.equal(assertLoopbackEndpoint('http://localhost:8178/inference'), 'http://localhost:8178/inference');
    assert.throws(() => assertLoopbackEndpoint('https://api.example.com/inference'), /loopback|127\.0\.0\.1/i);
    assert.throws(() => assertLoopbackEndpoint('http://192.168.1.10:8178/inference'), /loopback|127\.0\.0\.1/i);
});

test('local whisper parses JSON and plain text responses without an API key', async () => {
    const http = require('node:http');
    const os = require('node:os');
    const tmp = path.join(os.tmpdir(), `stt-local-test-${process.pid}.wav`);
    fs.writeFileSync(tmp, Buffer.from('RIFF-test-fixture'));
    let requestBody = '';
    const server = http.createServer((req, res) => {
        req.setEncoding('latin1');
        req.on('data', chunk => { requestBody += chunk; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: 'ألو يا فندم' }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        const { transcribeWithLocalWhisper } = require('../scripts/stt-worker');
        const text = await transcribeWithLocalWhisper(tmp, {
            apiUrl: `http://127.0.0.1:${address.port}/inference`, language: 'ar', timeoutMs: 5000
        });
        assert.equal(text, 'ألو يا فندم');
        assert.match(requestBody, /name="file"/);
        assert.match(requestBody, /name="language"/);
        assert.match(requestBody, /\r\n\r\nar\r\n/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(tmp, { force: true });
    }
});

test('server.js defines all required STT REST API routes and CDR/Voicemail integrations', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.ok(serverJs.includes("app.get('/api/transcripts/call/:uniqueid', requireAuth, requireTranscriptPermission('cdr')"), 'GET /api/transcripts/call/:uniqueid must require CDR permission');
    assert.ok(serverJs.includes("app.post('/api/transcripts/call/:uniqueid/transcribe', requireAuth, requireTranscriptPermission('cdr')"), 'POST /api/transcripts/call/:uniqueid/transcribe must require CDR permission');
    assert.ok(serverJs.includes("app.get('/api/transcripts/voicemail/:mailbox/:file', requireAuth, requireTranscriptPermission('voicemails')"), 'GET /api/transcripts/voicemail must require voicemail permission');
    assert.ok(serverJs.includes("app.post('/api/transcripts/voicemail/:mailbox/:file/transcribe', requireAuth, requireTranscriptPermission('voicemails')"), 'POST /api/transcripts/voicemail must require voicemail permission');
    assert.ok(serverJs.includes("app.get('/api/config/stt', requireAuth, requireConfigPermission('recordings')"), 'GET /api/config/stt must require recordings config permission');
    assert.ok(serverJs.includes("app.put('/api/config/stt', requireAuth, requireConfigPermission('recordings')"), 'PUT /api/config/stt must require recordings config permission');
    assert.ok(serverJs.includes("app.post('/api/config/stt/test-connection', requireAuth, requireConfigPermission('recordings')"), 'POST /api/config/stt/test-connection must require recordings config permission');
    assert.ok(serverJs.includes("app.post('/api/transcripts/scan', requireAuth, requireConfigPermission('recordings')"), 'POST /api/transcripts/scan must require recordings config permission');
    assert.ok(serverJs.includes('cdr_transcriptions'), 'server.js must query cdr_transcriptions table');
    assert.ok(serverJs.includes('voicemail_transcriptions'), 'server.js must query voicemail_transcriptions table');
    assert.ok(serverJs.includes('searchTranscript'), 'server.js must support searchTranscript parameter');
});

test('views/cdr.ejs renders cleanly without STT buttons or filter', async () => {
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
                call_scope: 'EXTERNAL'
            }
        ],
        roster: [{ extension: '101', name: 'Ahmed' }],
        moment
    });

    assert.ok(html.includes('openCdrTranscript'), 'cdr.ejs must wire openCdrTranscript on-demand button in recording rows');
    assert.ok(html.includes('cdrTranscriptModal'), 'cdr.ejs must render cdrTranscriptModal');

    const scriptMatches = html.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/gi) || [];
    for (const s of scriptMatches) {
        const code = s.replace(/<script[\s\S]*?>/i, '').replace(/<\/script>/i, '');
        assert.doesNotThrow(() => {
            new Function(code);
        }, 'Client script in cdr.ejs must have valid JS syntax');
    }
});
test('views/voicemails.ejs renders cleanly without STT buttons or transcript filter', async () => {
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

    assert.ok(html.includes('openVmTranscript'), 'voicemails.ejs must wire openVmTranscript on-demand button in voicemail rows');
    assert.ok(html.includes('vmTranscriptViewerModal'), 'voicemails.ejs must render vmTranscriptViewerModal');
    const scriptMatches = html.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/gi) || [];
    for (const s of scriptMatches) {
        const code = s.replace(/<script[\s\S]*?>/i, '').replace(/<\/script>/i, '');
        assert.doesNotThrow(() => {
            new Function(code);
        }, 'Client script in voicemails.ejs must have valid JS syntax');
    }
});

test('views/config.ejs renders AI Speech-to-Text Transcription Engine Card and parses scripts cleanly', async () => {
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
    assert.ok(html.includes('id="sttApiKeyModal"'), 'config.ejs must render sttApiKeyModal popup');
    assert.ok(html.includes('openSttApiKeyModal'), 'config.ejs must wire openSttApiKeyModal button handler');
    assert.ok(html.includes('id="sttOverviewStatusBadge"'), 'config.ejs must render sttOverviewStatusBadge');
    assert.ok(html.includes('id="sttOverviewProvider"'), 'config.ejs must render sttOverviewProvider');
    assert.ok(html.includes('id="sttEnabled"'), 'config.ejs must render sttEnabled select');
    assert.ok(html.includes('id="sttProvider"'), 'config.ejs must render sttProvider select');
    assert.ok(html.includes('id="sttApiKey"'), 'config.ejs must render sttApiKey input');
    assert.ok(html.includes('id="sttModel"'), 'config.ejs must render sttModel input');
    assert.ok(html.includes('id="sttApiUrl"'), 'config.ejs must render sttApiUrl input');
    assert.ok(html.includes('id="sttLanguage"'), 'config.ejs must render sttLanguage select');
    assert.ok(html.includes('id="sttPrompt"'), 'config.ejs must render sttPrompt input');
    assert.ok(html.includes('id="sttTranscribeCalls"'), 'config.ejs must render sttTranscribeCalls select');
    assert.ok(html.includes('id="sttTranscribeVoicemails"'), 'config.ejs must render sttTranscribeVoicemails select');
    assert.ok(html.includes('saveSttSettings'), 'config.ejs must wire saveSttSettings handler');
    assert.ok(html.includes('testSttApiConnection'), 'config.ejs must wire testSttApiConnection handler');
    assert.ok(html.includes('scanAndTranscribeQueue'), 'config.ejs must wire scanAndTranscribeQueue handler');

    // Verify concatenated script blocks parse without duplicate identifier errors (e.g. STT_PROVIDER_DEFAULTS)
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let combined = '';
    let m;
    while ((m = scriptRegex.exec(html)) !== null) {
        combined += '\n;\n' + m[1];
    }
    assert.doesNotThrow(() => {
        new Function(combined);
    }, 'Combined client scripts in rendered config.ejs must parse without duplicate identifier SyntaxErrors');
});

test('views/sidebar.ejs renders AI STT settings button and sttApiKeyModal in settings menu', async () => {
    const sidebarEjsPath = path.join(__dirname, '../views/sidebar.ejs');
    const html = await ejs.renderFile(sidebarEjsPath, {
        currentLang: 'en',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: true,
        currentUser: 'admin',
        allowedTabs: ['dashboard', 'cdr', 'voicemails', 'config']
    });

    assert.ok(html.includes('openSttApiKeyModal()'), 'sidebar.ejs must render openSttApiKeyModal() button in settings menu');
    assert.ok(html.includes('id="sttApiKeyModal"'), 'sidebar.ejs must render sttApiKeyModal');
    assert.ok(html.includes('id="sttProvider"'), 'sidebar.ejs must render sttProvider select');
    assert.ok(html.includes('id="sttApiKey"'), 'sidebar.ejs must render sttApiKey input');
    assert.ok(html.includes('testSttApiConnection()'), 'sidebar.ejs must render testSttApiConnection() handler');
});

test('transcribeWithCloudAi validates API key presence and rejects empty key', async () => {
    const { transcribeWithCloudAi } = require('../scripts/stt-worker');
    await assert.rejects(async () => {
        await transcribeWithCloudAi('/tmp/dummy.mp3', { apiKey: '' });
    }, /API key is not configured/);
});

test('STT configuration supports local offline provider', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const sidebar = fs.readFileSync(path.join(__dirname, '../views/sidebar.ejs'), 'utf8');
    assert.ok(serverJs.includes("['local', 'munsit', 'groq', 'openai', 'deepgram', 'custom']"));
    assert.ok(serverJs.includes("engine === 'local_whisper'"));
    assert.ok(sidebar.includes('<option value="local"'));
    assert.ok(sidebar.includes('http://127.0.0.1:8178/inference'));
    assert.ok(sidebar.includes('ggml-small-q5_1.bin'));
    assert.ok(sidebar.includes('sttPauseDuringCalls'));
    assert.ok(sidebar.includes('pause_during_calls'));
});

test('STT scanner bounds historical backlog and prioritizes voicemail discovery', () => {
    const enqueueJs = fs.readFileSync(path.join(__dirname, '../scripts/enqueue-stt.js'), 'utf8');
    assert.ok(enqueueJs.includes('STT_MAX_PENDING_JOBS'));
    assert.ok(enqueueJs.includes('MAX_PENDING_JOBS'));
    assert.ok(enqueueJs.includes('Speech-to-Text is disabled; scan skipped.'));
    assert.ok(enqueueJs.includes('GROUP BY c.uniqueid'));
    assert.ok(enqueueJs.includes('insert.affectedRows === 1'));
    assert.ok(enqueueJs.indexOf('Scan active voicemails first') < enqueueJs.indexOf('Fill the remaining bounded queue'));
});

test('offline STT installer pins checksummed models and old-CPU-safe build flags', () => {
    const installerPath = path.join(__dirname, '../scripts/install-local-stt.sh');
    assert.ok(fs.existsSync(installerPath));
    const installer = fs.readFileSync(installerPath, 'utf8');
    assert.ok(installer.includes('WHISPER_VERSION="${WHISPER_VERSION:-v1.9.5}"'));
    assert.ok(installer.includes('STT_MODEL_SHA256'));
    assert.ok(installer.includes('sha256sum -c'));
    assert.ok(installer.includes('-DGGML_NATIVE=OFF'));
    assert.ok(installer.includes('grep -qw avx2 /proc/cpuinfo'));
    assert.ok(installer.includes('User=asterisk'));
    assert.ok(installer.includes('--host 127.0.0.1'));
});

test('worker can suspend local inference when live calls need CPU priority', () => {
    const { parseAsteriskActivity } = require('../scripts/stt-worker');
    assert.equal(parseAsteriskActivity('0 active channels\n0 active calls'), false);
    assert.equal(parseAsteriskActivity('1 active channel\n0 active calls'), true, 'ringing and IVR channels must block inference');
    assert.equal(parseAsteriskActivity('2 active channels\n1 active call'), true);
    const workerJs = fs.readFileSync(path.join(__dirname, '../scripts/stt-worker.js'), 'utf8');
    assert.ok(workerJs.includes("signalLocalWhisper('SIGSTOP')"));
    assert.ok(workerJs.includes("signalLocalWhisper('SIGCONT')"));
    assert.ok(workerJs.includes('setInterval(() =>'));
    assert.ok(workerJs.includes('pause_during_calls'));
    assert.ok(workerJs.includes('active channels?'));
    assert.ok(workerJs.includes('return true;\n    }\n}'), 'Asterisk activity query failures must fail safe');
    assert.ok(workerJs.includes("whisperPausedForCall && !await hasActiveCalls()"), 'shutdown must not resume inference during live calls');
});

test('interrupted STT jobs count toward the bounded retry limit', () => {
    const workerJs = fs.readFileSync(path.join(__dirname, '../scripts/stt-worker.js'), 'utf8');
    const recoverySection = workerJs.slice(workerJs.indexOf('async function recoverStaleJobs'), workerJs.indexOf('async function markFailure'));
    assert.ok(recoverySection.includes('attempt_count = attempt_count + 1'));
    assert.ok(recoverySection.includes("attempt_count + 1 >= ?"));
});

test('graceful worker shutdown aborts and requeues an in-flight job', () => {
    const workerJs = fs.readFileSync(path.join(__dirname, '../scripts/stt-worker.js'), 'utf8');
    assert.ok(workerJs.includes('activeRequestController?.abort'));
    assert.ok(workerJs.includes("error_message = 'Requeued after graceful worker shutdown'"));
    assert.ok(workerJs.includes("SET status = 'pending', processing_started_at = NULL"));
    assert.ok(workerJs.includes('if (!shuttingDown) await markFailure'));
});

test('dashboard, watchdog, and schema migration use the installed STT unit and engine column', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const watchdogJs = fs.readFileSync(path.join(__dirname, '../scripts/system-watchdog.js'), 'utf8');
    assert.equal(serverJs.includes("unit: 'stt-worker.service'"), false);
    assert.ok(serverJs.includes("unit: 'sokrat-stt.service'"));
    assert.ok(serverJs.includes("[action, 'sokrat-stt']"));
    assert.ok(watchdogJs.includes("getServiceSystemdStatus('sokrat-stt.service')"));
    assert.ok(serverJs.includes("ADD COLUMN `engine` VARCHAR(32) DEFAULT \\'cloud_api\\'"));
});

test('Munsit integration supports audio duration inspection and automatic segmentation for long calls', async () => {
    const worker = require('../scripts/stt-worker');
    assert.equal(typeof worker.getAudioDuration, 'function');
    assert.equal(typeof worker.transcribeWithMunsit, 'function');
    const workerCode = fs.readFileSync(path.join(__dirname, '../scripts/stt-worker.js'), 'utf8');
    assert.ok(workerCode.includes('MUNSIT_SEGMENT_SEC'));
    assert.ok(workerCode.includes('chunk_%03d'));
    assert.ok(workerCode.includes("provider === 'munsit'"));
    assert.ok(workerCode.includes('transcribeWithMunsit(audioFilePath, options)'));
});
