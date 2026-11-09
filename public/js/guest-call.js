/* Sokrat Cloud Tenants — public web guest call client. */
(function () {
    'use strict';

    var configEl = document.getElementById('sokratGuestConfig');
    if (!configEl || typeof JsSIP === 'undefined') return;

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
    var timerEl = document.getElementById('guestTimer');
    var callBtn = document.getElementById('guestCallBtn');
    var audioBtn = document.getElementById('guestAudioBtn');
    var actionsEl = document.getElementById('guestInCallActions');
    var muteBtn = document.getElementById('guestMuteBtn');
    var muteLabel = document.getElementById('guestMuteLabel');
    var endBtn = document.getElementById('guestEndBtn');

    var ua = null;
    var session = null;
    var rtcSession = null;
    var startedAt = null;
    var timer = null;
    var finished = false;
    var reported = false;
    var muted = false;
    var registrationTimer = null;

    var audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);

    function setCallState(state) {
        if (cardEl) cardEl.dataset.state = state;
    }

    function setStatus(text, isError) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle('error', Boolean(isError));
    }

    function setBusy(busy) {
        if (callBtn) {
            callBtn.disabled = Boolean(busy);
            callBtn.classList.toggle('end', false);
        }
    }

    function showTimer(show) {
        if (timerEl) timerEl.classList.toggle('hidden', !show);
    }

    function formatDuration(sec) {
        var total = Math.max(0, Math.floor(sec));
        var mm = Math.floor(total / 60);
        var ss = total % 60;
        return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    }

    function startTimer() {
        startedAt = Date.now();
        showTimer(true);
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

    function resetUi() {
        if (callBtn) {
            callBtn.textContent = labels.tapToCall || labels.tryAgain || callLabel;
            callBtn.classList.remove('end');
            callBtn.classList.remove('hidden');
            callBtn.disabled = false;
        }
        if (actionsEl) actionsEl.classList.add('hidden');
        if (audioBtn) audioBtn.classList.add('hidden');
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

    function finish(status, message, isError) {
        if (finished) return;
        finished = true;
        setCallState(status === 'ended' ? 'ended' : 'failed');
        var duration = startedAt ? (Date.now() - startedAt) / 1000 : 0;
        stopTimer();
        showTimer(false);
        if (session) endSessionReport(status === 'failed' ? 'failed' : 'ended', duration);
        if (message) setStatus(message, isError);
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
        resetUi();
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
                audioEl.play().then(function () {
                    if (audioBtn) audioBtn.classList.add('hidden');
                }).catch(function () {
                    if (audioBtn) audioBtn.classList.remove('hidden');
                });
            });
        });
    }

    function placeCall() {
        if (!ua || !ua.isConnected() || !session) return;
        var options = {
            mediaConstraints: { audio: true, video: false },
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
            setCallState('ringing');
            setStatus(labels.ringing || 'Ringing...');
        });

        rtcSession.on('confirmed', function () {
            setCallState('connected');
            setStatus(labels.connected || 'Connected');
            startTimer();
            if (callBtn) callBtn.classList.add('hidden');
            if (actionsEl) actionsEl.classList.remove('hidden');
        });

        rtcSession.on('ended', function () {
            if (finished) return;
            var duration = startedAt ? (Date.now() - startedAt) / 1000 : 0;
            endSessionReport('ended', duration);
            finish('ended', labels.ended || 'Call ended', false);
        });

        rtcSession.on('failed', function (event) {
            if (finished) return;
            var cause = (event && event.cause) || 'failed';
            var message = labels.failed || 'Could not start the call';
            if (/denied media|permission/i.test(String(cause))) {
                message = labels.micDenied || 'Microphone permission was denied.';
            } else if (/no answer|expires|408|487|canceled/i.test(String(cause))) {
                message = labels.noAnswer || 'The business did not answer. Please try again.';
            } else if (/busy|486/i.test(String(cause))) {
                message = labels.busy || 'All lines are busy right now.';
            } else if (/unavailable|480|404/i.test(String(cause))) {
                message = labels.noAgents || 'No agents are available right now.';
            }
            finish('failed', message, true);
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

    function beginCall() {
        if (ua || rtcSession) return;
        finished = false;
        reported = false;
        setCallState('connecting');
        if (callBtn) callBtn.classList.add('hidden');
        if (audioBtn) audioBtn.classList.add('hidden');
        setBusy(true);
        setStatus(labels.connecting || 'Connecting...');

        fetch('/api/public/call-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenant: tenant, link: link, source: 'web' })
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
                startRegistration(session);
            });
        }).catch(function (error) {
            finish('failed', error.message || labels.failed || 'Could not start the call', true);
        });
    }

    if (callBtn) {
        callBtn.addEventListener('click', function () {
            beginCall();
        });
    }

    if (endBtn) {
        endBtn.addEventListener('click', function () {
            var duration = startedAt ? (Date.now() - startedAt) / 1000 : 0;
            endSessionReport('ended', duration);
            finish('ended', labels.ended || 'Call ended', false);
        });
    }

    if (muteBtn) {
        muteBtn.addEventListener('click', function () {
            if (!rtcSession) return;
            try {
                if (muted) {
                    rtcSession.unmute();
                    muted = false;
                    if (muteLabel) muteLabel.textContent = labels.mute || 'Mute';
                } else {
                    rtcSession.mute();
                    muted = true;
                    if (muteLabel) muteLabel.textContent = labels.unmute || 'Unmute';
                }
            } catch (_) {}
        });
    }

    if (audioBtn) {
        audioBtn.addEventListener('click', function () {
            audioEl.play().then(function () {
                audioBtn.classList.add('hidden');
            }).catch(function () {});
        });
    }

    if (autoStart) {
        // Direct links and embed clicks start immediately. If the browser
        // requires a gesture for the microphone or audio playback, finish()
        // reveals a single tap-to-call fallback button.
        setTimeout(beginCall, 30);
    } else if (callBtn) {
        callBtn.classList.remove('hidden');
        callBtn.textContent = callLabel;
    }

    window.addEventListener('pagehide', function () {
        if (session && !finished) {
            var duration = startedAt ? (Date.now() - startedAt) / 1000 : 0;
            endSessionReport('ended', duration);
        }
    });
})();
