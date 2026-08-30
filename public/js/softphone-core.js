/**
 * Sokrat Standalone WebRTC Softphone Core Telephony Engine v2.1
 * High-performance PJSIP WebRTC Gateway with Bidirectional Audio & Multi-Window Sync
 */

(function (window) {
    'use strict';

    const DTMF_FREQS = {
        '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
        '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
        '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
        '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633]
    };

    class SokratSoftphoneCore {
        constructor(options = {}) {
            this.options = Object.assign({
                busName: 'sokrat_sp_bus',
                wsKeepAliveInterval: 20000,
                maxReconnectAttempts: 5,
                iceGatheringTimeout: 1500
            }, options);

            // Core State
            this.isOwner = true;
            this.ua = null;
            this.activePreset = null;
            this.regState = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, REGISTERED, RETRY_WAIT, AUTH_FAILED
            this.activeCalls = new Map(); // callId -> CallEntry
            this.nextCallId = 1;
            this.isDnd = false;
            this.isAutoAnswer = false;
            this.selectedAudioInputId = '';
            this.selectedAudioOutputId = '';
            this.isSpeakerMuted = false;

            // Audio & Media
            this.audioCtx = null;
            this.micStream = null;
            this.micPermissionGranted = false;
            this.vuAnalyser = null;
            this.vuTimer = null;
            this.remoteAudioEl = null;

            // Ringtones & Sidetones
            this.ringtoneGain = null;
            this.ringtoneOsc = null;
            this.ringtoneTimer = null;
            this.ringbackOsc = null;
            this.ringbackTimer = null;

            // Reconnection & Quality
            this.reconnectTimer = null;
            this.reconnectAttempt = 0;
            this.keepAliveTimer = null;
            this.qualityPoller = null;

            // Attended Transfer State
            this.consultCallPending = null;

            // Event Subscriptions
            this.listeners = new Map();

            // Broadcast Channel for Multi-window Coordination
            this.initBus();
            this.initHardwareListeners();
            this.initLifecycleListeners();
        }

        on(event, callback) {
            if (!this.listeners.has(event)) this.listeners.set(event, []);
            this.listeners.get(event).push(callback);
            return this;
        }

        emit(event, data) {
            const list = this.listeners.get(event);
            if (list) list.forEach(cb => {
                try { cb(data); } catch (err) { console.error(`[Softphone Event Error] ${event}:`, err); }
            });
        }

        // --- MULTI-WINDOW SINGLE-TAB LEADERSHIP LOCK ---
        initBus() {
            this.tabId = 'tab_' + Math.random().toString(36).slice(2) + '_' + Date.now();
            this.LOCK_KEY = 'sokrat_sp_owner_lock_v2';

            // Check existing owner in localStorage
            const existingLockStr = localStorage.getItem(this.LOCK_KEY);
            let existingLock = null;
            try {
                existingLock = existingLockStr ? JSON.parse(existingLockStr) : null;
            } catch (_) {}

            const isLockFresh = existingLock && existingLock.tabId !== this.tabId && (Date.now() - existingLock.time < 3500);

            if (isLockFresh) {
                // Another tab is currently active on this device
                this.isOwner = false;
            } else {
                this.claimLeadership();
            }

            try {
                if (typeof BroadcastChannel !== 'undefined') {
                    this.bus = new BroadcastChannel(this.options.busName);
                    this.bus.onmessage = (e) => this.handleBusMessage(e.data);
                    this.bus.postMessage({ type: 'PING_OWNER', fromTab: this.tabId });
                }
            } catch (_) {}

            this.emit('ownerChange', { isOwner: this.isOwner });
            this.startLockHeartbeat();

            window.addEventListener('beforeunload', () => {
                if (this.isOwner) {
                    localStorage.removeItem(this.LOCK_KEY);
                    if (this.bus) this.bus.postMessage({ type: 'OWNER_RELEASED', fromTab: this.tabId });
                }
            });
        }

        claimLeadership() {
            this.isOwner = true;
            try {
                localStorage.setItem(this.LOCK_KEY, JSON.stringify({ tabId: this.tabId, time: Date.now() }));
            } catch (_) {}
        }

        startLockHeartbeat() {
            if (this.lockHeartbeatTimer) clearInterval(this.lockHeartbeatTimer);
            this.lockHeartbeatTimer = setInterval(() => {
                if (this.isOwner && this.ua && this.ua.isConnected()) {
                    try {
                        localStorage.setItem(this.LOCK_KEY, JSON.stringify({ tabId: this.tabId, time: Date.now() }));
                    } catch (_) {}
                } else if (!this.isOwner) {
                    // Check if previous owner abandoned/closed without take over
                    const lockStr = localStorage.getItem(this.LOCK_KEY);
                    let lock = null;
                    try { lock = lockStr ? JSON.parse(lockStr) : null; } catch (_) {}
                    if (!lock || (Date.now() - lock.time > 4500)) {
                        // Owner is gone, automatically allow this tab to take over
                        this.claimLeadership();
                        this.emit('ownerChange', { isOwner: true });
                    }
                }
            }, 1500);
        }

        handleBusMessage(data) {
            if (!data || !data.type) return;
            switch (data.type) {
                case 'PING_OWNER':
                    if (this.isOwner && this.ua && this.ua.isConnected()) {
                        this.claimLeadership();
                        if (this.bus) this.bus.postMessage({ type: 'OWNER_HEARTBEAT', fromTab: this.tabId });
                    }
                    break;
                case 'OWNER_HEARTBEAT':
                    if (data.fromTab !== this.tabId && this.isOwner && (!this.ua || !this.ua.isConnected())) {
                        this.isOwner = false;
                        this.emit('ownerChange', { isOwner: false });
                    }
                    break;
                case 'TAKE_OVER':
                    if (data.fromTab !== this.tabId && this.isOwner) {
                        this.disconnect();
                        this.isOwner = false;
                        this.emit('ownerChange', { isOwner: false });
                    }
                    break;
                case 'OWNER_RELEASED':
                    if (!this.isOwner) {
                        this.claimLeadership();
                        this.emit('ownerChange', { isOwner: true });
                    }
                    break;
                case 'FOCUS_POPOUT':
                    if (window.name === 'sokratSoftphonePopout') {
                        window.focus();
                    }
                    break;
            }
        }

        takeOverOwnership() {
            this.claimLeadership();
            if (this.bus) this.bus.postMessage({ type: 'TAKE_OVER', fromTab: this.tabId });
            this.emit('ownerChange', { isOwner: true });
        }

        // --- AUDIO ENGINE & DSP ---
        initAudioContext() {
            if (!this.audioCtx) {
                const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
                if (AudioCtxClass) {
                    this.audioCtx = new AudioCtxClass();
                }
            }
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }
        }

        setRemoteAudioElement(el) {
            this.remoteAudioEl = el;
            if (this.remoteAudioEl) {
                this.remoteAudioEl.autoplay = true;
                this.remoteAudioEl.playsInline = true;
                this.remoteAudioEl.muted = Boolean(this.isSpeakerMuted);
            }
            if (this.selectedAudioOutputId && this.remoteAudioEl && typeof this.remoteAudioEl.setSinkId === 'function') {
                this.remoteAudioEl.setSinkId(this.selectedAudioOutputId).catch(() => {});
            }
        }

        async acquireMicrophone(deviceId = '') {
            this.initAudioContext();
            const constraints = {
                audio: {
                    echoCancellation: { ideal: true },
                    noiseSuppression: { ideal: true },
                    autoGainControl: { ideal: true },
                    channelCount: { ideal: 1 },
                    sampleRate: { ideal: 48000 }
                },
                video: false
            };
            if (deviceId) {
                constraints.audio.deviceId = { exact: deviceId };
            }

            try {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    throw new Error('MediaDevices API is unavailable. Ensure HTTPS connection.');
                }
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                this.micStream = stream;
                this.micPermissionGranted = true;
                this.selectedAudioInputId = deviceId;
                const track = stream.getAudioTracks()[0];
                if (track) {
                    this.activeCalls.forEach(call => {
                        if (call.session && call.session.connection) {
                            try {
                                const senders = call.session.connection.getSenders();
                                const s = senders.find(sd => sd.track && sd.track.kind === 'audio');
                                if (s) s.replaceTrack(track).catch(() => {});
                            } catch (_) {}
                        }
                    });
                }
                this.startVuMeter(stream);
                this.emit('micGranted', { stream, deviceId });
                return stream;
            } catch (err) {
                this.micPermissionGranted = false;
                this.stopVuMeter();
                this.emit('micError', { error: err.message || err.name });
                throw err;
            }
        }

        startVuMeter(stream) {
            this.stopVuMeter();
            if (!this.audioCtx || !stream) return;
            try {
                const source = this.audioCtx.createMediaStreamSource(stream);
                this.vuAnalyser = this.audioCtx.createAnalyser();
                this.vuAnalyser.fftSize = 64;
                source.connect(this.vuAnalyser);

                const dataArray = new Uint8Array(this.vuAnalyser.frequencyBinCount);
                this.vuTimer = setInterval(() => {
                    if (!this.vuAnalyser) return;
                    this.vuAnalyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                    const avg = sum / dataArray.length;
                    const level = Math.min(100, Math.round((avg / 128) * 100));
                    this.emit('vuLevel', level);
                }, 75);
            } catch (_) {}
        }

        stopVuMeter() {
            if (this.vuTimer) {
                clearInterval(this.vuTimer);
                this.vuTimer = null;
            }
            this.vuAnalyser = null;
            this.emit('vuLevel', 0);
        }

        async setOutputDevice(deviceId) {
            this.selectedAudioOutputId = deviceId;
            if (this.remoteAudioEl && typeof this.remoteAudioEl.setSinkId === 'function') {
                try {
                    await this.remoteAudioEl.setSinkId(deviceId);
                    this.emit('speakerChanged', { deviceId });
                } catch (err) {
                    this.emit('speakerError', { error: err.message });
                }
            }
        }

        toggleSpeakerMute() {
            this.isSpeakerMuted = !this.isSpeakerMuted;
            if (this.remoteAudioEl) {
                this.remoteAudioEl.muted = this.isSpeakerMuted;
            }
            this.emit('speakerMuteChanged', { isMuted: this.isSpeakerMuted });
            return this.isSpeakerMuted;
        }

        initHardwareListeners() {
            if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
                navigator.mediaDevices.ondevicechange = async () => {
                    this.emit('deviceChange');
                    if (this.micStream) {
                        const tracks = this.micStream.getAudioTracks();
                        if (tracks.length === 0 || tracks[0].readyState === 'ended') {
                            try {
                                await this.acquireMicrophone(this.selectedAudioInputId);
                            } catch (_) {}
                        }
                    }
                };
            }
        }

        initLifecycleListeners() {
            window.addEventListener('online', () => {
                if (this.isOwner && this.activePreset && this.regState !== 'REGISTERED' && this.regState !== 'AUTH_FAILED') {
                    this.reconnect();
                }
            });

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && this.isOwner && this.activePreset && (!this.ua || !this.ua.isConnected()) && this.regState !== 'AUTH_FAILED') {
                    this.reconnect();
                }
            });
        }

        // --- DTMF & RINGTONES & AUDIO TEST CHIME ---
        playDtmfSidetone(key) {
            this.initAudioContext();
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume().catch(() => {});
            }
            const freqs = DTMF_FREQS[String(key).toUpperCase()];
            if (!freqs || !this.audioCtx) return;

            try {
                const now = this.audioCtx.currentTime;
                const osc1 = this.audioCtx.createOscillator();
                const osc2 = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();

                osc1.type = 'sine';
                osc1.frequency.value = freqs[0];
                osc2.type = 'sine';
                osc2.frequency.value = freqs[1];

                gain.gain.setValueAtTime(0.18, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

                osc1.connect(gain);
                osc2.connect(gain);
                gain.connect(this.audioCtx.destination);

                osc1.start(now);
                osc2.start(now);
                osc1.stop(now + 0.18);
                osc2.stop(now + 0.18);
            } catch (_) {}
        }

        playTestChime() {
            this.initAudioContext();
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume().catch(() => {});
            }
            if (!this.audioCtx) return;

            try {
                const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 (Ascending Bell Chime)
                const startTime = this.audioCtx.currentTime;

                notes.forEach((freq, idx) => {
                    const noteTime = startTime + (idx * 0.13);
                    const osc = this.audioCtx.createOscillator();
                    const osc2 = this.audioCtx.createOscillator();
                    const gain = this.audioCtx.createGain();

                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(freq, noteTime);

                    osc2.type = 'triangle';
                    osc2.frequency.setValueAtTime(freq * 2, noteTime);

                    gain.gain.setValueAtTime(0, noteTime);
                    gain.gain.linearRampToValueAtTime(0.28, noteTime + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.40);

                    osc.connect(gain);
                    osc2.connect(gain);
                    gain.connect(this.audioCtx.destination);

                    osc.start(noteTime);
                    osc2.start(noteTime);
                    osc.stop(noteTime + 0.42);
                    osc2.stop(noteTime + 0.42);
                });
            } catch (err) {
                console.warn('Audio test chime error:', err);
            }
        }

        startRingtone() {
            this.stopRingtone();
            this.initAudioContext();
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume().catch(() => {});
            }
            if (!this.audioCtx) return;

            try {
                this.ringtoneGain = this.audioCtx.createGain();
                this.ringtoneGain.gain.value = 0.20;
                this.ringtoneGain.connect(this.audioCtx.destination);

                const playRingBurst = () => {
                    if (!this.audioCtx || !this.ringtoneGain) return;
                    try {
                        const now = this.audioCtx.currentTime;
                        const osc1 = this.audioCtx.createOscillator();
                        const osc2 = this.audioCtx.createOscillator();
                        osc1.type = 'sine';
                        osc2.type = 'sine';
                        osc1.frequency.value = 440;
                        osc2.frequency.value = 480;

                        const burstGain = this.audioCtx.createGain();
                        burstGain.gain.setValueAtTime(0, now);
                        burstGain.gain.linearRampToValueAtTime(0.25, now + 0.05);
                        burstGain.gain.setValueAtTime(0.25, now + 1.8);
                        burstGain.gain.linearRampToValueAtTime(0, now + 2.0);

                        osc1.connect(burstGain);
                        osc2.connect(burstGain);
                        burstGain.connect(this.ringtoneGain);

                        osc1.start(now);
                        osc2.start(now);
                        osc1.stop(now + 2.0);
                        osc2.stop(now + 2.0);
                    } catch (_) {}
                };

                playRingBurst();
                this.ringtoneTimer = setInterval(playRingBurst, 3500);
            } catch (_) {}
        }

        stopRingtone() {
            if (this.ringtoneTimer) {
                clearInterval(this.ringtoneTimer);
                this.ringtoneTimer = null;
            }
            if (this.ringtoneGain) {
                try { this.ringtoneGain.disconnect(); } catch (_) {}
                this.ringtoneGain = null;
            }
        }

        startRingback() {
            this.stopRingback();
            this.initAudioContext();
            if (!this.audioCtx) return;

            try {
                const gain = this.audioCtx.createGain();
                gain.gain.value = 0.14;
                const osc1 = this.audioCtx.createOscillator();
                const osc2 = this.audioCtx.createOscillator();
                osc1.frequency.value = 440;
                osc2.frequency.value = 480;

                osc1.connect(gain);
                osc2.connect(gain);
                gain.connect(this.audioCtx.destination);
                osc1.start();
                osc2.start();

                let on = true;
                this.ringbackTimer = setInterval(() => {
                    on = !on;
                    if (gain) gain.gain.value = on ? 0.14 : 0;
                }, 1500);

                this.ringbackOsc = { osc1, osc2, gain };
            } catch (_) {}
        }

        stopRingback() {
            if (this.ringbackOsc) {
                try {
                    this.ringbackOsc.osc1.stop();
                    this.ringbackOsc.osc2.stop();
                    this.ringbackOsc.gain.disconnect();
                } catch (_) {}
                this.ringbackOsc = null;
            }
            if (this.ringbackTimer) {
                clearInterval(this.ringbackTimer);
                this.ringbackTimer = null;
            }
        }

        // --- SIP REGISTRATION & LIFECYCLE ---
        async connect(preset, secret) {
            if (!preset || !preset.extension || !preset.sipDomain || !preset.wssUrl) {
                throw new Error('Invalid account configuration: missing extension, domain, or WSS URL.');
            }
            if (!secret) {
                throw new Error('Extension password is required.');
            }

            this.takeOverOwnership();
            this.disconnect();
            this.activePreset = preset;
            this.isDnd = Boolean(preset.dnd);
            this.isAutoAnswer = Boolean(preset.autoAnswer);
            if (!this.micPermissionGranted) {
                try {
                    await this.acquireMicrophone(this.selectedAudioInputId);
                } catch (micErr) {
                    console.warn('Microphone permission ignored, proceeding with registration:', micErr);
                }
            }

            this.setRegState('CONNECTING');
            this.reconnectAttempt = 0;

            if (typeof JsSIP === 'undefined') {
                this.setRegState('DISCONNECTED');
                throw new Error('JsSIP library failed to load.');
            }

            try {
                const host = window.location.hostname || '127.0.0.1';
                const portStr = (window.location.port === '8443') ? ':8443' : (window.location.port ? ':' + window.location.port : '');
                const defaultWss = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + host + portStr + '/ws';
                const wssUrl = preset.wssUrl || defaultWss;
                const sipDomain = preset.sipDomain || host;

                const socket = new JsSIP.WebSocketInterface(wssUrl);
                const configuration = {
                    sockets: [socket],
                    uri: `sip:${preset.extension}@${sipDomain}`,
                    password: secret,
                    register: true,
                    register_expires: 120,
                    session_timers: false
                };

                this.ua = new JsSIP.UA(configuration);
                this.attachUaListeners(this.ua, preset);
                this.ua.start();
                this.startKeepAlive();
            } catch (err) {
                this.setRegState('DISCONNECTED');
                throw err;
            }
        }

        attachUaListeners(ua, preset) {
            ua.on('connecting', () => this.setRegState('CONNECTING'));
            ua.on('connected', () => {
                this.reconnectAttempt = 0;
            });
            ua.on('registered', () => {
                this.setRegState('REGISTERED');
                this.emit('registered', { preset });
            });
            ua.on('unregistered', () => {
                this.setRegState('DISCONNECTED');
                this.emit('unregistered');
            });
            ua.on('registrationFailed', (e) => {
                const code = e.response ? e.response.status_code : 0;
                if (code === 401 || code === 403) {
                    this.setRegState('AUTH_FAILED');
                    this.emit('authFailed', { code, reason: 'Invalid Extension or Password' });
                    this.disconnect(true);
                } else {
                    this.setRegState('RETRY_WAIT');
                    this.scheduleReconnect();
                }
            });
            ua.on('disconnected', () => {
                if (this.regState !== 'AUTH_FAILED' && this.regState !== 'DISCONNECTED') {
                    this.setRegState('RETRY_WAIT');
                    this.scheduleReconnect();
                }
            });
            ua.on('newRTCSession', (data) => this.handleNewRTCSession(data.session));
        }

        setRegState(state) {
            this.regState = state;
            this.emit('regStateChange', { state, preset: this.activePreset });
        }

        scheduleReconnect() {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            if (this.regState === 'AUTH_FAILED' || !this.activePreset) return;

            this.reconnectAttempt++;
            const backoffSec = Math.min(30, Math.pow(2, Math.min(5, this.reconnectAttempt)));
            this.emit('retryCountdown', { seconds: backoffSec, attempt: this.reconnectAttempt });

            this.reconnectTimer = setTimeout(() => {
                if (this.ua && !this.ua.isConnected() && this.regState !== 'AUTH_FAILED') {
                    try { this.ua.start(); } catch (_) {}
                }
            }, backoffSec * 1000);
        }

        reconnect() {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            if (this.ua && this.regState !== 'AUTH_FAILED') {
                try { this.ua.start(); } catch (_) {}
            }
        }

        disconnect(preserveAuthFailed = false) {
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            this.stopKeepAlive();
            this.hangupAllCalls();
            if (this.ua) {
                try {
                    this.ua.stop();
                } catch (_) {}
                this.ua = null;
            }
            if (!preserveAuthFailed) {
                this.setRegState('DISCONNECTED');
            }
        }

        startKeepAlive() {
            this.stopKeepAlive();
            this.keepAliveTimer = setInterval(() => {
                if (this.ua && this.ua.isConnected() && this.ua.transport && this.ua.transport.socket) {
                    try {
                        this.ua.transport.socket.send('\r\n\r\n');
                    } catch (_) {}
                }
            }, this.options.wsKeepAliveInterval);
        }

        stopKeepAlive() {
            if (this.keepAliveTimer) {
                clearInterval(this.keepAliveTimer);
                this.keepAliveTimer = null;
            }
        }

        // --- BIDIRECTIONAL MEDIA & CALL TELEPHONY ENGINE ---
        handleNewRTCSession(session) {
            const callId = 'call_' + (this.nextCallId++);
            const isIncoming = session.direction === 'incoming';
            const remoteUser = session.remote_identity ? (session.remote_identity.uri.user || session.remote_identity.display_name || 'Unknown') : 'Unknown';

            // DND & Busy Rejections (SIP 486)
            if (isIncoming) {
                if (this.isDnd) {
                    session.terminate({ status_code: 486, reason_phrase: 'Busy Here (DND)' });
                    this.emit('callLog', { target: remoteUser, direction: 'incoming', status: 'rejected_dnd', durationSec: 0 });
                    return;
                }
                if (this.activeCalls.size > 0) {
                    session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
                    this.emit('callLog', { target: remoteUser, direction: 'incoming', status: 'busy', durationSec: 0 });
                    return;
                }
            }

            const callEntry = {
                id: callId,
                session: session,
                direction: isIncoming ? 'incoming' : 'outgoing',
                target: remoteUser,
                status: isIncoming ? 'ringing' : 'progress',
                startTime: Date.now(),
                answerTime: null,
                isHeld: false,
                isMuted: false,
                recordingDetected: false,
                progressTimer: null,
                recordingPoller: null
            };

            this.activeCalls.set(callId, callEntry);
            this.attachSessionListeners(session, callEntry);

            if (isIncoming) {
                this.startRingtone();
                this.emit('incomingCall', callEntry);

                if (this.isAutoAnswer && this.micPermissionGranted) {
                    setTimeout(() => {
                        this.answerCall(callId);
                    }, 400);
                }
            } else {
                this.startRingback();
                this.emit('callProgress', callEntry);
            }
        }

        attachSessionListeners(session, callEntry) {
            // Guarantee Bidirectional Audio by attaching PeerConnection track handlers
            session.on('peerconnection', (data) => {
                const pc = data.peerconnection;
                if (pc) {
                    pc.addEventListener('track', (event) => {
                        if (this.remoteAudioEl) {
                            const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
                            this.remoteAudioEl.srcObject = stream;
                            this.remoteAudioEl.play().catch(() => {});
                        }
                    });
                }
            });

            session.on('progress', () => {
                if (callEntry.direction === 'outgoing') {
                    callEntry.status = 'progress';
                }
                this.emit('callUpdated', callEntry);
            });

            session.on('confirmed', () => {
                this.stopRingtone();
                this.stopRingback();
                if (callEntry.progressTimer) {
                    clearTimeout(callEntry.progressTimer);
                    callEntry.progressTimer = null;
                }
                callEntry.status = 'active';
                callEntry.answerTime = Date.now();

                // Secondary fallback track attachment from connection receivers
                if (session.connection && this.remoteAudioEl && (!this.remoteAudioEl.srcObject || !this.remoteAudioEl.srcObject.active)) {
                    const remoteStream = new MediaStream();
                    session.connection.getReceivers().forEach(receiver => {
                        if (receiver.track && receiver.track.kind === 'audio') {
                            remoteStream.addTrack(receiver.track);
                        }
                    });
                    this.remoteAudioEl.srcObject = remoteStream;
                    this.remoteAudioEl.play().catch(() => {});
                }

                this.startQualityMetricsPoller(session);
                this.checkRecordingStatus(callEntry);
                this.emit('callAnswered', callEntry);
            });

            session.on('hold', () => {
                callEntry.isHeld = true;
                callEntry.status = 'held';
                this.emit('callUpdated', callEntry);
            });

            session.on('unhold', () => {
                callEntry.isHeld = false;
                callEntry.status = 'active';
                this.emit('callUpdated', callEntry);
            });

            session.on('ended', () => this.handleCallEnd(callEntry, 'answered'));
            session.on('failed', (e) => {
                const cause = e.cause || (e.response ? e.response.status_code : 'failed');
                let userMsg = `Call ended: ${cause}`;
                if (cause === 'Busy' || cause === 486) userMsg = `Extension ${callEntry.target} is Busy`;
                else if (cause === 'Not Found' || cause === 404) userMsg = `Extension ${callEntry.target} Not Found`;
                else if (cause === 'Unavailable' || cause === 480) userMsg = `Extension ${callEntry.target} is Unavailable`;
                else if (cause === 'User Denied Media Access' || cause === 'Not Acceptable Here' || cause === 488) userMsg = `Media negotiation error: ${cause}`;
                this.emit('toast', { type: 'warning', message: userMsg });
                this.handleCallEnd(callEntry, callEntry.answerTime ? 'answered' : cause);
            });

            // Call progress timeout — if no answer within 60s, auto-terminate
            if (callEntry.status === 'progress' || callEntry.status === 'ringing') {
                callEntry.progressTimer = setTimeout(() => {
                    if (callEntry.status === 'progress' || callEntry.status === 'ringing') {
                        try { session.terminate({ status_code: 408, reason_phrase: 'Request Timeout' }); } catch (_) {}
                        this.emit('toast', { type: 'warning', message: 'Call timed out — no answer after 60s' });
                    }
                }, 60000);
            }
        }

        handleCallEnd(callEntry, outcome) {
            this.stopRingtone();
            this.stopRingback();
            this.stopQualityMetricsPoller();
            if (callEntry.progressTimer) {
                clearTimeout(callEntry.progressTimer);
                callEntry.progressTimer = null;
            }
            if (callEntry.recordingPoller) {
                clearInterval(callEntry.recordingPoller);
                callEntry.recordingPoller = null;
            }

            const durationSec = callEntry.answerTime ? Math.round((Date.now() - callEntry.answerTime) / 1000) : 0;
            this.activeCalls.delete(callEntry.id);

            this.emit('callEnded', { callId: callEntry.id, target: callEntry.target, durationSec, outcome });
            this.emit('callLog', {
                target: callEntry.target,
                direction: callEntry.direction,
                status: outcome,
                durationSec,
                timestamp: new Date().toISOString()
            });
        }

        makeCall(targetNumber) {
            if (!this.ua || !this.ua.isConnected()) {
                throw new Error('Softphone is offline. Connect to extension first.');
            }
            const cleanTarget = String(targetNumber).trim();
            if (!cleanTarget) throw new Error('Target number cannot be empty.');

            this.initAudioContext();

            const options = {
                mediaConstraints: { audio: true, video: false },
                rtcOfferConstraints: {
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: false
                },
                pcConfig: {
                    // LAN-only: empty iceServers — host candidates are sufficient.
                    // For WAN/remote, restore: { urls: 'stun:stun.l.google.com:19302' }
                    iceServers: [],
                    bundlePolicy: 'max-bundle',
                    rtcpMuxPolicy: 'require'
                },
                iceGatheringTimeout: this.options.iceGatheringTimeout,
                sessionTimersExpires: 120
            };

            // Pass already-acquired mic stream to avoid redundant getUserMedia
            if (this.micStream && this.micStream.active) {
                options.mediaStream = this.micStream;
            }

            try {
                this.ua.call(`sip:${cleanTarget}@${this.activePreset.sipDomain}`, options);
            } catch (err) {
                this.stopRingback();
                throw err;
            }
        }

        answerCall(callId) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) return;
            this.stopRingtone();
            this.initAudioContext();

            const answerOpts = {
                mediaConstraints: { audio: true, video: false },
                pcConfig: {
                    // LAN-only: empty iceServers — host candidates are sufficient.
                    iceServers: [],
                    bundlePolicy: 'max-bundle',
                    rtcpMuxPolicy: 'require'
                },
                iceGatheringTimeout: this.options.iceGatheringTimeout
            };

            // Pass already-acquired mic stream
            if (this.micStream && this.micStream.active) {
                answerOpts.mediaStream = this.micStream;
            }

            callEntry.session.answer(answerOpts);
        }


        hangupCall(callId) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) return;
            try {
                callEntry.session.terminate();
            } catch (_) {}
        }

        hangupAllCalls() {
            this.activeCalls.forEach(call => {
                try { call.session.terminate(); } catch (_) {}
            });
            this.activeCalls.clear();
            this.stopRingtone();
            this.stopRingback();
        }

        toggleMute(callId) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) return;

            if (callEntry.isMuted) {
                callEntry.session.unmute({ audio: true });
                callEntry.isMuted = false;
            } else {
                callEntry.session.mute({ audio: true });
                callEntry.isMuted = true;
            }
            this.emit('callUpdated', callEntry);
        }

        toggleHold(callId) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) return;

            if (callEntry.isHeld) {
                callEntry.session.unhold();
            } else {
                callEntry.session.hold();
            }
        }

        sendDtmf(callId, digit) {
            const callEntry = this.activeCalls.get(callId);
            if (callEntry && callEntry.session && callEntry.status === 'active') {
                try {
                    callEntry.session.sendDTMF(digit);
                } catch (_) {}
            }
            this.playDtmfSidetone(digit);
        }

        blindTransfer(callId, targetNumber) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) throw new Error('No active call to transfer.');
            const target = String(targetNumber).trim();
            if (!target) throw new Error('Target extension is required.');

            callEntry.session.refer(`sip:${target}@${this.activePreset.sipDomain}`);
            this.emit('toast', { type: 'info', message: `Transferring to ${target}...` });
        }

        // --- ATTENDED TRANSFER ---
        attendedTransfer(callId, targetNumber) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) throw new Error('No active call to transfer.');
            const target = String(targetNumber).trim();
            if (!target) throw new Error('Target extension is required.');

            // Hold current call before consultation
            if (!callEntry.isHeld) {
                callEntry.session.hold();
            }
            // Store reference for consultation
            this.consultCallPending = { originalCallId: callId, target };
            // Make consultation call
            this.makeCall(target);
        }

        completeAttendedTransfer() {
            if (!this.consultCallPending) return;
            const origEntry = this.activeCalls.get(this.consultCallPending.originalCallId);
            // Find the consultation call (the other active call)
            const consultEntry = Array.from(this.activeCalls.values()).find(c => c.id !== this.consultCallPending.originalCallId);
            if (origEntry && consultEntry && origEntry.session && consultEntry.session) {
                origEntry.session.refer(consultEntry.session.remote_identity.uri.toString(), {
                    replaces: consultEntry.session
                });
                this.emit('toast', { type: 'info', message: 'Attended transfer completing...' });
            }
            this.consultCallPending = null;
        }

        cancelAttendedTransfer() {
            if (!this.consultCallPending) return;
            // Hang up consultation call, unhold original
            const consultEntry = Array.from(this.activeCalls.values()).find(c => c.id !== this.consultCallPending.originalCallId);
            if (consultEntry) {
                try { consultEntry.session.terminate(); } catch (_) {}
            }
            const origEntry = this.activeCalls.get(this.consultCallPending.originalCallId);
            if (origEntry && origEntry.isHeld) {
                origEntry.session.unhold();
            }
            this.consultCallPending = null;
        }

        // --- CALL RECORDING DETECTION ---
        checkRecordingStatus(callEntry) {
            if (!callEntry || !callEntry.session) return;
            // Poll for recording indicators via SIP session info headers
            // Asterisk MixMonitor sets Record: on — detected via SIP INFO or re-INVITE headers
            callEntry.recordingPoller = setInterval(() => {
                if (!callEntry.session || callEntry.status !== 'active') {
                    if (callEntry.recordingPoller) {
                        clearInterval(callEntry.recordingPoller);
                        callEntry.recordingPoller = null;
                    }
                    return;
                }
                // Check last incoming request headers for recording indicators
                try {
                    const lastReq = callEntry.session.last_provisional_response ||
                                    callEntry.session._dialog && callEntry.session._dialog.last_response;
                    if (lastReq) {
                        const recordHeader = lastReq.getHeader && lastReq.getHeader('Record');
                        const wasRecording = callEntry.recordingDetected;
                        callEntry.recordingDetected = (recordHeader && recordHeader.toLowerCase() === 'on');
                        if (callEntry.recordingDetected !== wasRecording) {
                            this.emit('recordingStatus', {
                                callId: callEntry.id,
                                isRecording: callEntry.recordingDetected
                            });
                        }
                    }
                } catch (_) {}
            }, 5000);
        }

        // --- WEBRTC STATS & QUALITY METRICS ---
        startQualityMetricsPoller(session) {
            this.stopQualityMetricsPoller();
            if (!session || !session.connection) return;

            this.qualityPoller = setInterval(async () => {
                try {
                    const stats = await session.connection.getStats();
                    let jitterMs = 0;
                    let packetsLost = 0;
                    let totalPackets = 0;

                    stats.forEach(report => {
                        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                            jitterMs = Math.round((report.jitter || 0) * 1000);
                            packetsLost = report.packetsLost || 0;
                            totalPackets = (report.packetsReceived || 0) + packetsLost;
                        }
                    });

                    const lossPercent = totalPackets > 0 ? ((packetsLost / totalPackets) * 100).toFixed(1) : 0;
                    let quality = 'excellent';
                    if (lossPercent > 5 || jitterMs > 60) quality = 'poor';
                    else if (lossPercent > 2 || jitterMs > 30) quality = 'good';

                    this.emit('callQuality', { jitterMs, lossPercent, quality });
                } catch (_) {}
            }, 2500);
        }

        stopQualityMetricsPoller() {
            if (this.qualityPoller) {
                clearInterval(this.qualityPoller);
                this.qualityPoller = null;
            }
            this.emit('callQuality', null);
        }
    }

    window.SokratSoftphoneCore = SokratSoftphoneCore;

})(window);
