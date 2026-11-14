/* Sokrat Cloud Tenants — public web guest call client. */
(function () {
    'use strict';

    var configEl = document.getElementById('sokratGuestConfig');
    if (!configEl) return;
    var preview = configEl.dataset.preview === '1';
    if (!preview && typeof JsSIP === 'undefined') return;

    var tenant = configEl.dataset.tenant || '';
    var link = configEl.dataset.link || '';
    var lang = configEl.dataset.lang === 'ar' ? 'ar' : 'en';
    var embedded = configEl.dataset.embedded === '1';
    var autoStart = configEl.dataset.autostart === '1';
    var labels = {};
    try { labels = JSON.parse(configEl.dataset.labels || '{}'); } catch (_) { labels = {}; }
    var callLabel = configEl.dataset.callLabel || (lang === 'ar' ? 'اتصل الآن' : 'Call now');

    var cardEl = document.getElementById('callCard');
    var statusEl = document.getElementById('guestStatus');
    var stateTitleEl = document.getElementById('guestStateTitle');
    var stateTextEl = document.getElementById('guestStateText');
    var timerEl = document.getElementById('guestTimer');
    var summaryEl = document.getElementById('guestCallSummary');
    var callBtn = document.getElementById('guestCallBtn');
    var cancelBtn = document.getElementById('guestCancelBtn');
    var retryBtn = document.getElementById('guestRetryBtn');
    var audioBtn = document.getElementById('guestAudioBtn');
    var actionsEl = document.getElementById('guestInCallActions');
    var muteBtn = document.getElementById('guestMuteBtn');
    var muteLabel = document.getElementById('guestMuteLabel');
    var endBtn = document.getElementById('guestEndBtn');
    var audioSettingsBtn = document.getElementById('guestAudioSettingsBtn');
    var audioModal = document.getElementById('guestAudioModal');
    var audioCloseBtn = document.getElementById('guestAudioCloseBtn');
    var audioInputSelect = document.getElementById('guestAudioInput');
    var audioOutputSelect = document.getElementById('guestAudioOutput');
    var audioSupportEl = document.getElementById('guestAudioSupport');
    var labMount = document.getElementById('guestLabMount');
    var labTemplate = document.getElementById('guestLabTemplate');
    var selectedAudioInput = '';
    var selectedAudioOutput = '';
    try {
        selectedAudioInput = localStorage.getItem('sokrat.audio.input') || '';
        selectedAudioOutput = localStorage.getItem('sokrat.audio.output') || '';
    } catch (_) {}
    var audioPermissionAsked = false;

    var ua = null;
    var session = null;
    var rtcSession = null;
    var startedAt = null;
    var timer = null;
    var finished = false;
    var reported = false;
    var muted = false;
    var registrationTimer = null;
    var previewTimers = [];
    var abortController = null;

    var audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);

    function setStatus(text, isError) {
        if (!statusEl) return;
        statusEl.textContent = text || '';
        statusEl.classList.toggle('error', Boolean(isError));
    }

    function setState(state, options) {
        options = options || {};
        cardEl.dataset.state = state;
        var titles = {
            idle: labels.callPrompt || 'Call the team',
            connecting: labels.connecting || 'Connecting...',
            ringing: labels.ringing || 'Ringing...',
            connected: labels.connected || 'Connected',
            ended: labels.ended || 'Call ended',
            failed: labels.failed || 'Could not start the call',
            no_answer: labels.failed || 'Could not start the call',
            busy: labels.failed || 'Could not start the call',
            mic_denied: labels.failed || 'Could not start the call'
        };
        if (stateTitleEl) stateTitleEl.textContent = options.title !== undefined ? options.title : (titles[state] || '');
        if (stateTextEl) {
            stateTextEl.textContent = options.text !== undefined ? options.text : '';
            stateTextEl.classList.toggle('error', Boolean(options.error));
        }
        if (options.status !== undefined) setStatus(options.status, options.error);
    }

    function updateMuteUi() {
        if (muteLabel) muteLabel.textContent = muted ? (labels.unmute || 'Unmute') : (labels.mute || 'Mute');
        if (muteBtn) {
            muteBtn.classList.toggle('is-muted', muted);
            muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
        }
    }

    function formatDuration(sec) {
        var total = Math.max(0, Math.floor(sec));
        return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
    }

    function startTimer() {
        startedAt = Date.now();
        if (timerEl) timerEl.textContent = '00:00';
        if (timer) clearInterval(timer);
        timer = setInterval(function () {
            if (!startedAt) return;
            if (timerEl) timerEl.textContent = formatDuration((Date.now() - startedAt) / 1000);
        }, 500);
    }

    function stopTimer() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    function clearPreviewTimers() {
        while (previewTimers.length) clearTimeout(previewTimers.pop());
    }

    function endSessionReport(status, duration) {
        if (!session || !session.id || reported) return;
        reported = true;
        try {
            fetch('/api/public/call-session/' + encodeURIComponent(session.id) + '/end', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: status || 'ended',
                    duration: Math.max(0, Math.round(duration || 0)),
                    hangup_cause: status === 'failed' ? 'setup_failed' : 'normal'
                }),
                keepalive: true
            }).catch(function () {});
        } catch (_) {}
        if (embedded && window.parent && window.parent !== window) {
            try { window.parent.postMessage({ type: 'sokrat-call-ended' }, '*'); } catch (_) {}
        }
    }

    function finish(state, message, isError) {
        if (finished) return;
        finished = true;
        clearPreviewTimers();
        var duration = startedAt ? (Date.now() - startedAt) / 1000 : 0;
        stopTimer();
        if (session) endSessionReport(state === 'ended' ? 'ended' : 'failed', duration);
        if (rtcSession) {
            try { rtcSession.terminate(); } catch (_) {}
            rtcSession = null;
        }
        if (ua) {
            try { ua.stop(); } catch (_) {}
            ua = null;
        }
        if (registrationTimer) clearTimeout(registrationTimer);
        registrationTimer = null;
        if (abortController) {
            try { abortController.abort(); } catch (_) {}
            abortController = null;
        }
        muted = false;
        updateMuteUi();
        if (audioBtn) audioBtn.classList.add('hidden');
        if (state === 'ended') {
            setState('ended', {
                status: labels.ended || 'Call ended',
                title: labels.ended || 'Call ended',
                text: labels.callAgainHint || ''
            });
            if (summaryEl) summaryEl.textContent = (labels.duration || 'Call duration') + ' · ' + formatDuration(duration);
        } else if (state === 'idle') {
            setState('idle', {
                status: message || labels.cancelled || '',
                title: labels.callPrompt || 'Call the team',
                text: labels.tapToCall || ''
            });
        } else {
            setState(state, {
                status: message || labels.failed || 'Call failed',
                title: labels.failed || 'Call failed',
                text: message || '',
                error: Boolean(isError)
            });
        }
    }

    function cancelCall() {
        if (finished) return;
        clearPreviewTimers();
        var duration = startedAt ? (Date.now() - startedAt) / 1000 : 0;
        stopTimer();
        if (abortController) {
            try { abortController.abort(); } catch (_) {}
            abortController = null;
        }
        if (session) endSessionReport('ended', duration);
        if (rtcSession) {
            try { rtcSession.terminate(); } catch (_) {}
            rtcSession = null;
        }
        if (ua) {
            try { ua.stop(); } catch (_) {}
            ua = null;
        }
        if (registrationTimer) clearTimeout(registrationTimer);
        registrationTimer = null;
        finished = true;
        muted = false;
        updateMuteUi();
        if (audioBtn) audioBtn.classList.add('hidden');
        setState('idle', {
            status: labels.cancelled || 'Call cancelled',
            title: labels.callPrompt || 'Call the team',
            text: labels.tapToCall || ''
        });
    }

    function applyAudioOutput() {
        if (!audioEl || typeof audioEl.setSinkId !== 'function') return;
        audioEl.setSinkId(selectedAudioOutput || '').catch(function () {});
    }

    function attachRemoteAudio(rtc) {
        rtc.on('peerconnection', function (data) {
            var pc = data && data.peerconnection;
            if (!pc) return;
            pc.addEventListener('track', function (event) {
                var stream = event.streams && event.streams[0]
                    ? event.streams[0]
                    : new MediaStream([event.track]);
                audioEl.srcObject = stream;
                applyAudioOutput();
                audioEl.play().then(function () {
                    if (audioBtn) audioBtn.classList.add('hidden');
                }).catch(function () {
                    if (audioBtn) audioBtn.classList.remove('hidden');
                });
            });
        });
    }

    function beginCall() {
        if (ua || rtcSession) return;
        if (preview) { beginPreview(); return; }
        finished = false;
        reported = false;
        muted = false;
        updateMuteUi();
        if (summaryEl) summaryEl.textContent = '';
        if (audioBtn) audioBtn.classList.add('hidden');
        setState('connecting', {
            status: labels.connecting || 'Connecting...',
            title: labels.connecting || 'Connecting...',
            text: labels.preparing || ''
        });
        abortController = new AbortController();
        fetch('/api/public/call-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenant: tenant, link: link, source: 'web' }),
            signal: abortController.signal
        }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (data) {
                if (!response.ok || !data.success || !data.session) {
                    var code = data.code || '';
                    var message = labels.failed || 'Could not start the call';
                    if (code === 'POOL_EXHAUSTED' || code === 'CONCURRENCY_LIMIT') message = labels.busy || 'All lines are busy right now.';
                    else if (code === 'TENANT_INACTIVE' || code === 'TENANT_NO_AGENTS' || code === 'LINK_INACTIVE' || code === 'LINK_EXPIRED') message = labels.noAgents || 'This business is not taking calls right now.';
                    else if (data.error) message = data.error;
                    throw new Error(message);
                }
                session = data.session;
                abortController = null;
                startRegistration(session);
            });
        }).catch(function (error) {
            if (error && error.name === 'AbortError') return;
            finish('failed', error.message || labels.failed || 'Could not start the call', true);
        });
    }

    function startRegistration(sessionData) {
        var socket = new JsSIP.WebSocketInterface(sessionData.wss_url);
        ua = new JsSIP.UA({
            sockets: [socket],
            uri: 'sip:' + sessionData.extension + '@' + sessionData.sip_domain,
            password: sessionData.password,
            register: true,
            register_expires: 60,
            session_timers: false
        });

        ua.on('registered', function () {
            if (registrationTimer) clearTimeout(registrationTimer);
            registrationTimer = null;
            placeCall();
        });

        ua.on('registrationFailed', function (event) {
            var code = event && event.response ? event.response.status_code : 0;
            var message = labels.failed || 'Could not connect to the call service';
            if (code === 401 || code === 403) message = labels.failed || 'Call credentials were rejected';
            finish('failed', message, true);
        });

        ua.on('disconnected', function () {
            if (!finished && !rtcSession) finish('failed', labels.failed || 'Call service disconnected', true);
        });

        ua.start();
        registrationTimer = setTimeout(function () {
            if (!finished && !rtcSession) finish('failed', labels.failed || 'Call service did not respond', true);
        }, 12000);
    }

    function placeCall() {
        if (!ua || !ua.isConnected() || !session) return;
        var audioConstraint = selectedAudioInput ? { deviceId: { exact: selectedAudioInput } } : true;
        var options = {
            mediaConstraints: { audio: audioConstraint, video: false },
            rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
            pcConfig: {
                iceServers: Array.isArray(session.ice_servers) ? session.ice_servers : [],
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require'
            },
            sessionTimersExpires: 120,
            extraHeaders: [
                'X-Sokrat-Guest: ' + String(session.caller_id || ''),
                'X-Sokrat-Session: ' + String(session.id || '')
            ]
        };
        try {
            rtcSession = ua.call('sip:' + session.target + '@' + session.sip_domain, options);
        } catch (error) {
            finish('failed', labels.failed || 'Could not start the call', true);
            return;
        }

        attachRemoteAudio(rtcSession);

        rtcSession.on('progress', function () {
            setState('ringing', {
                status: labels.ringing || 'Ringing...',
                title: labels.ringing || 'Ringing...',
                text: labels.preparing || ''
            });
        });

        rtcSession.on('confirmed', function () {
            setState('connected', {
                status: labels.connected || 'Connected',
                title: labels.connected || 'Connected',
                text: ''
            });
            startTimer();
        });

        rtcSession.on('ended', function () {
            if (finished) return;
            finish('ended', labels.ended || 'Call ended', false);
        });

        rtcSession.on('failed', function (event) {
            if (finished) return;
            var cause = String((event && event.cause) || '');
            if (/denied media|permission/i.test(cause)) {
                finish('mic_denied', labels.micDenied || 'Microphone permission was denied.', true);
            } else if (/no answer|expires|408|487|canceled/i.test(cause)) {
                finish('no_answer', labels.noAnswer || 'The business did not answer.', true);
            } else if (/busy|486/i.test(cause)) {
                finish('busy', labels.busy || 'All lines are busy right now.', true);
            } else if (/unavailable|480|404/i.test(cause)) {
                finish('failed', labels.noAgents || 'No agents are available right now.', true);
            } else {
                finish('failed', labels.failed || 'Could not start the call', true);
            }
        });
    }

    function beginPreview() {
        if (finished && cardEl.dataset.state !== 'idle') {
            // allow retry from any terminal state
        }
        clearPreviewTimers();
        stopTimer();
        finished = false;
        reported = false;
        muted = false;
        updateMuteUi();
        if (summaryEl) summaryEl.textContent = '';
        if (audioBtn) audioBtn.classList.add('hidden');
        setState('connecting', {
            status: labels.connecting || 'Connecting...',
            title: labels.connecting || 'Connecting...',
            text: labels.preparing || ''
        });
        previewTimers.push(setTimeout(function () {
            if (finished) return;
            setState('ringing', {
                status: labels.ringing || 'Ringing...',
                title: labels.ringing || 'Ringing...',
                text: labels.preparing || ''
            });
        }, 900));
        previewTimers.push(setTimeout(function () {
            if (finished) return;
            setState('connected', {
                status: labels.connected || 'Connected',
                title: labels.connected || 'Connected',
                text: ''
            });
            startTimer();
        }, 2400));
    }

    function applyPreviewState(state) {
        if (!preview || !state) return;
        if (state === 'connected') {
            finished = false;
            setState('connected', { status: labels.connected || 'Connected', title: labels.connected || 'Connected', text: '' });
            startTimer();
            return;
        }
        if (state === 'ringing' || state === 'connecting') {
            finished = false;
            setState(state, {
                status: state === 'ringing' ? (labels.ringing || 'Ringing...') : (labels.connecting || 'Connecting...'),
                title: state === 'ringing' ? (labels.ringing || 'Ringing...') : (labels.connecting || 'Connecting...'),
                text: labels.preparing || ''
            });
            return;
        }
        if (state === 'ended') {
            finished = true;
            setState('ended', { status: labels.ended || 'Call ended', title: labels.ended || 'Call ended', text: labels.callAgainHint || '' });
            if (summaryEl) summaryEl.textContent = (labels.duration || 'Call duration') + ' · 01:24';
            return;
        }
        if (state === 'failed' || state === 'no_answer' || state === 'busy' || state === 'mic_denied') {
            finished = true;
            var messages = {
                failed: labels.failed || 'Could not start the call',
                no_answer: labels.noAnswer || 'The business did not answer.',
                busy: labels.busy || 'All lines are busy right now.',
                mic_denied: labels.micDenied || 'Microphone permission was denied.'
            };
            setState(state, { status: messages[state], title: labels.failed || 'Call failed', text: messages[state], error: true });
        }
    }

    function rememberAudioSettings() {
        selectedAudioInput = audioInputSelect ? audioInputSelect.value : '';
        selectedAudioOutput = audioOutputSelect ? audioOutputSelect.value : '';
        try {
            localStorage.setItem('sokrat.audio.input', selectedAudioInput);
            localStorage.setItem('sokrat.audio.output', selectedAudioOutput);
        } catch (_) {}
        applyAudioOutput();
    }

    function fillAudioSelect(select, devices, selectedId, kind) {
        if (!select) return;
        select.innerHTML = '';
        var defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = labels.defaultDevice || (lang === 'ar' ? 'الافتراضي' : 'Default');
        select.appendChild(defaultOption);
        devices.forEach(function (device, index) {
            var option = document.createElement('option');
            option.value = device.deviceId;
            var prefix = kind === 'input'
                ? (lang === 'ar' ? 'ميكروفون' : 'Microphone')
                : (lang === 'ar' ? 'مكبر الصوت' : 'Speaker');
            option.textContent = device.label || (prefix + ' ' + (index + 1));
            select.appendChild(option);
        });
        select.value = devices.some(function (device) { return device.deviceId === selectedId; }) ? selectedId : '';
    }

    async function refreshAudioDevices() {
        if (!audioInputSelect || !audioOutputSelect) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            audioInputSelect.disabled = true;
            audioOutputSelect.disabled = true;
            if (audioSupportEl) audioSupportEl.textContent = labels.audioUnsupported || 'Audio device selection is not supported in this browser.';
            return;
        }
        try {
            if (!preview && !audioPermissionAsked) {
                try {
                    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    stream.getTracks().forEach(function (track) { track.stop(); });
                } catch (_) {}
                audioPermissionAsked = true;
            }
            var devices = await navigator.mediaDevices.enumerateDevices();
            var inputs = devices.filter(function (device) { return device.kind === 'audioinput'; });
            var outputs = devices.filter(function (device) { return device.kind === 'audiooutput'; });
            if (preview) {
                if (!inputs.length) inputs = [{ deviceId: 'preview-mic', label: lang === 'ar' ? 'ميكروفون افتراضي' : 'Default microphone' }];
                if (!outputs.length) outputs = [{ deviceId: 'preview-speaker', label: lang === 'ar' ? 'مكبر صوت افتراضي' : 'Default speaker' }];
            }
            fillAudioSelect(audioInputSelect, inputs, selectedAudioInput, 'input');
            fillAudioSelect(audioOutputSelect, outputs, selectedAudioOutput, 'output');
            selectedAudioInput = audioInputSelect.value || '';
            selectedAudioOutput = audioOutputSelect.value || '';
            var supportsSink = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
            audioOutputSelect.disabled = !supportsSink;
            if (audioSupportEl) audioSupportEl.textContent = supportsSink ? '' : (labels.audioUnsupported || 'Speaker selection is not supported in this browser.');
        } catch (error) {
            if (audioSupportEl) audioSupportEl.textContent = error.message || labels.audioUnsupported || 'Audio devices could not be loaded.';
        }
    }

    function openAudioSettings() {
        if (!audioModal) return;
        audioModal.classList.add('open');
        audioModal.setAttribute('aria-hidden', 'false');
        refreshAudioDevices();
    }

    function closeAudioSettings() {
        if (!audioModal) return;
        audioModal.classList.remove('open');
        audioModal.setAttribute('aria-hidden', 'true');
    }

    function mountLab() {
        if (!preview || !labMount || !labTemplate) return;
        var params = new URLSearchParams(window.location.search);
        if (params.get('lab') !== '1') return;
        labMount.appendChild(labTemplate.content.cloneNode(true));
    }

    if (callBtn) callBtn.addEventListener('click', beginCall);
    if (retryBtn) retryBtn.addEventListener('click', beginCall);
    if (cancelBtn) cancelBtn.addEventListener('click', cancelCall);
    if (endBtn) endBtn.addEventListener('click', function () { finish('ended', labels.ended || 'Call ended', false); });
    if (audioBtn) audioBtn.addEventListener('click', function () {
        audioEl.play().then(function () { audioBtn.classList.add('hidden'); }).catch(function () {});
    });
    if (muteBtn) muteBtn.addEventListener('click', function () {
        if (preview) { muted = !muted; updateMuteUi(); return; }
        if (!rtcSession) return;
        try {
            if (muted) { rtcSession.unmute(); muted = false; }
            else { rtcSession.mute(); muted = true; }
            updateMuteUi();
        } catch (_) {}
    });
    if (audioSettingsBtn) audioSettingsBtn.addEventListener('click', openAudioSettings);
    if (audioCloseBtn) audioCloseBtn.addEventListener('click', closeAudioSettings);
    if (audioModal) {
        audioModal.addEventListener('click', function (event) { if (event.target === audioModal) closeAudioSettings(); });
    }
    if (audioInputSelect) audioInputSelect.addEventListener('change', rememberAudioSettings);
    if (audioOutputSelect) audioOutputSelect.addEventListener('change', rememberAudioSettings);
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeAudioSettings(); });

    window.addEventListener('pagehide', function () {
        if (session && !finished) {
            var duration = startedAt ? (Date.now() - startedAt) / 1000 : 0;
            endSessionReport('ended', duration);
        }
    });

    updateMuteUi();
    applyAudioOutput();
    mountLab();

    if (preview) {
        var params = new URLSearchParams(window.location.search);
        applyPreviewState(params.get('state'));
        if (!params.get('state') && autoStart) setTimeout(beginPreview, 30);
        else if (!params.get('state')) setState('idle', { status: labels.ready || 'Ready when you are', title: labels.callPrompt || 'Call the team', text: labels.tapToCall || '' });
    } else if (autoStart) {
        setTimeout(beginCall, 30);
    } else {
        setState('idle', { status: labels.ready || 'Ready when you are', title: labels.callPrompt || 'Call the team', text: labels.tapToCall || '' });
    }
})();
