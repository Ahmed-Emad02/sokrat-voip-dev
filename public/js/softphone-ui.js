/**
 * Sokrat Standalone WebRTC Softphone UI Controller v3.0
 * Full-screen call view, quality badge, recording indicator,
 * browser notifications, attended transfer, contacts, favorites
 */

(function (window, document) {
    'use strict';

    const SVG_ICONS = {
        phone: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
        phoneOff: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)"/></svg>',
        mic: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
        micOff: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
        pause: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
        play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
        transfer: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
        dnd: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
        autoAnswer: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        headphones: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
        speaker: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
        users: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        voicemail: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="4"/><circle cx="18" cy="12" r="4"/><line x1="6" y1="16" x2="18" y2="16"/></svg>',
        settings: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        star: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        starFilled: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        contact: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
        plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
    };
    const I18N = {
        ar: {
            statusOffline: 'غير متصل',
            statusConnecting: 'جاري الاتصال...',
            statusOnline: 'متاح (ONLINE)',
            statusInCall: 'في مكالمة نشطة',
            statusRinging: 'رنين وارد...',
            statusProgress: 'جاري الاتصال...',
            statusAuthFailed: 'فشل المصادقة',
            statusRetry: 'إعادة المحاولة ({s}ث)',
            connect: 'اتصال',
            disconnect: 'قطع',
            cancel: 'إلغاء',
            dialPlaceholder: 'أدخل الرقم للاتصال...',
            call: 'اتصال',
            answer: 'رد',
            decline: 'رفض',
            endCall: 'إنهاء المكالمة',
            mute: 'كتم',
            unmute: 'تفعيل',
            hold: 'تعليق',
            unhold: 'استئناف',
            transfer: 'تحويل',
            dnd: 'عدم الإزعاج',
            autoAnswer: 'رد تلقائي',
            editPreset: 'تعديل الحساب',
            addPreset: 'إضافة حساب جديد',
            activeCallTitle: 'مكالمة نشطة:',
            recentCalls: 'المكالمات الأخيرة',
            clear: 'مسح',
            noLogs: 'لا توجد مكالمات مسجلة بعد.',
            incoming: 'واردة',
            outgoing: 'صادرة',
            missed: 'فائتة',
            rejected_dnd: 'مرفوضة (DND)',
            toastConnected: 'تم الاتصال بنجاح بالتحويلة {ext}',
            toastDisconnected: 'تم قطع الاتصال',
            toastAuthFailed: 'فشل تسجيل الدخول: كلمة السر غير صحيحة',
            toastError: 'خطأ: {msg}',
            loginConnecting: 'جاري الاتصال...',
            loginConnectBtn: 'تسجيل الدخول والاتصال ↗',
            loginQuickBtn: 'دخول سريع ↗',
            loginNoSaved: 'لا توجد تحويلات محفوظة بعد.',
            loginSelectExtError: 'يرجى اختيار أو إدخال رقم التحويلة',
            loginEnterPasswordError: 'يرجى إدخال كلمة سر التحويلة',
            loginConnectingExt: 'جاري الاتصال بالتحويلة {ext}...',
            loginEnterPasswordForExt: 'يرجى إدخال كلمة السر للتحويلة {ext}',
            loginAccountRemoved: 'تم حذف الحساب المحفوظ',
            loginEditAccountTitle: 'تعديل بيانات الحساب',
            loginDeleteAccountTitle: 'حذف الحساب المحفوظ'
        },
        en: {
            statusOffline: 'Offline',
            statusConnecting: 'Connecting...',
            statusOnline: 'Available',
            statusInCall: 'In Call',
            statusRinging: 'Ringing...',
            statusProgress: 'Calling...',
            statusAuthFailed: 'Auth Failed',
            statusRetry: 'Retry ({s}s)',
            connect: 'Connect',
            disconnect: 'Disconnect',
            cancel: 'Cancel',
            dialPlaceholder: 'Enter number...',
            call: 'Call',
            answer: 'Answer',
            decline: 'Decline',
            endCall: 'End Call',
            mute: 'Mute',
            unmute: 'Unmute',
            hold: 'Hold',
            unhold: 'Unhold',
            transfer: 'Transfer',
            dnd: 'Do Not Disturb',
            autoAnswer: 'Auto Answer',
            editPreset: 'Edit Account',
            addPreset: 'Add New Account',
            activeCallTitle: 'Active Call:',
            recentCalls: 'Recent Calls',
            clear: 'Clear',
            noLogs: 'No recent calls yet.',
            incoming: 'incoming',
            outgoing: 'outgoing',
            missed: 'missed',
            rejected_dnd: 'rejected (dnd)',
            toastConnected: 'Connected to ext {ext}',
            toastDisconnected: 'Disconnected',
            toastAuthFailed: 'Authentication failed: check password',
            toastError: 'Error: {msg}',
            loginConnecting: 'Connecting...',
            loginConnectBtn: 'CONNECT TO EXTENSION ↗',
            loginQuickBtn: '1-Click Login ↗',
            loginNoSaved: 'No saved extensions yet.',
            loginSelectExtError: 'Please select or enter an extension number',
            loginEnterPasswordError: 'Please enter the extension password',
            loginConnectingExt: 'Connecting Ext {ext}...',
            loginEnterPasswordForExt: 'Please enter password for extension {ext}',
            loginAccountRemoved: 'Account removed',
            loginEditAccountTitle: 'Edit account credentials',
            loginDeleteAccountTitle: 'Remove saved account'
        }
    };

    function formatTimeAgo(dateInput) {
        if (!dateInput) return 'Just now';
        const parsed = new Date(dateInput).getTime();
        if (isNaN(parsed)) return 'Just now';
        const ms = Math.max(0, Date.now() - parsed);
        const sec = Math.floor(ms / 1000);
        if (sec < 60) return `${Math.max(1, sec)}s ago`;
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hrs = Math.floor(min / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        return `${days}d ago`;
    }

    function setButtonContent(btn, svgString, textString) {
        btn.textContent = '';
        if (svgString) {
            btn.insertAdjacentHTML('afterbegin', svgString);
        }
        if (textString) {
            const span = document.createElement('span');
            span.textContent = textString;
            btn.appendChild(span);
        }
    }

    class SokratSoftphoneUI {
        minimize() {
            if (window.sokratTelephonyHost && typeof window.sokratTelephonyHost.minimize === 'function') {
                window.sokratTelephonyHost.minimize();
                return;
            }
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ version: 1, type: 'sokrat.voice.collapse' }, '*');
                return;
            }
            window.postMessage({ version: 1, type: 'sokrat.voice.collapse' }, '*');
        }

        constructor() {
            this.currentLang = (document.documentElement.lang === 'ar') ? 'ar' : 'en';
            this.t = I18N[this.currentLang] || I18N.en;
            this.core = new SokratSoftphoneCore({ lineId: 'line1', busName: 'sokrat_sp_line1_bus', lockKey: 'sokrat_sp_owner_lock_line1_v2' });

            this.PRESETS_KEY = 'sokrat_softphone_presets_v2';
            this.LOGS_KEY = 'sokrat_softphone_call_logs_v2';
            this.THEME_KEY = 'sokrat_softphone_theme';
            this.CONTACTS_KEY = 'sokrat_softphone_contacts_v2';
            this.FAVORITES_KEY = 'sokrat_softphone_favorites_v2';
            this.serverExtensionsList = [];

            if (window.opener || window.name === 'sokratSoftphonePopout' || window.innerWidth <= 1000) {
                document.documentElement.classList.add('is-popout');
                document.body.classList.add('is-popout');
            }

            this.sessionSecrets = new Map();
            this.dom = {};
            this.callTimerInterval = null;
            this.currentCallQuality = null;
            this.incomingNotification = null;
            this.attendedTransferState = null;
            this.activeDialerLead = null;
            this.activeDialerLeadPollTimer = null;
            this.activeDialerLeadPollController = null;
            this.maskPhoneNumbers = Boolean(window.SOFTPHONE_EMBED_CONFIG?.maskPhoneNumbers);
            this.realDialNumber = '';
        }

        maskPhoneNumber(num) {
            if (!num) return '';
            const clean = String(num).trim();
            if (clean.length < 7) return clean;
            const isPlus = clean.startsWith('+');
            const prefixLen = isPlus ? 5 : 4;
            const suffixLen = 3;
            if (clean.length <= (prefixLen + suffixLen)) {
                return clean.slice(0, 3) + '****' + clean.slice(-2);
            }
            return clean.slice(0, prefixLen) + '****' + clean.slice(-suffixLen);
        }

        async init() {
            this.cacheDom();
            this.applySavedTheme();
            this.core.setRemoteAudioElement(this.dom.remoteAudio);
            this.bindCoreEvents();
            this.bindDomEvents();
            await this.loadPresets();
            this.loadCallLogs();
            this.loadContacts();
            this.renderFavorites();
            this.renderContacts();
            this.renderSavedAccountsLoginList();
            this.enumerateAudioDevices().catch(() => {});
            this.checkMicrophonePermissionInitial().catch(() => {});
            this.requestNotificationPermissionInitial();
            this.startCallTimerTicker();
            this.updateInCallButtonStates();
            this.onPresetChanged();
            this.setupClickToCall();
            await this.loadPresets();
            try {
                const preset = this.getSelectedPreset();
                const ext = preset ? String(preset.extension).replace(/^ext_/, '') : '150';
                const cached = localStorage.getItem('sokrat_policy_' + ext);
                if (cached) {
                    const p = JSON.parse(cached);
                    this.extensionPolicies = this.extensionPolicies || new Map();
                    this.extensionPolicies.set(ext, p);
                    this.applyPolicyToUi(p);
                }
            } catch (_) {}
            if (this.core && this.core.regState === 'REGISTERED') {
                this.startActiveDialerLeadPoller();
            }
            // Embedded Session Auto-Connect from CRM
            const embedCfg = window.SOFTPHONE_EMBED_CONFIG;
            if (embedCfg && embedCfg.isEmbedded && embedCfg.autoConnect && embedCfg.embedPreset) {
                const ep = embedCfg.embedPreset;
                this.updateViewMode('console');
                setTimeout(async () => {
                    try {
                        let targetWss = ep.wssUrl || (window.location.protocol === 'https:' ? 'wss://100.110.36.17:8443/ws' : 'ws://100.110.36.17:8088/ws');
                        if (window.location.protocol === 'http:' && targetWss.startsWith('wss://')) {
                            targetWss = targetWss.replace(/^wss:/, 'ws:').replace(/:8443\//, ':8088/');
                        }
                        await this.core.connect({
                            id: ep.id || ('ext_' + ep.extension),
                            extension: String(ep.extension),
                            sipDomain: '100.110.36.17',
                            wssUrl: targetWss,
                            name: ep.name || ('Ext ' + ep.extension),
                            label: `Ext ${ep.extension}`
                        }, ep.secret);
                    } catch (err) {
                        console.error('[Embed AutoConnect] Failed:', err);
                    }
                }, 100);
            } else {
                if (this.core.regState === 'REGISTERED') {
                    this.updateViewMode('console');
                } else {
                    this.updateViewMode('login');
                }
            }

            if (window.parent && window.parent !== window) {
                window.parent.postMessage({
                    version: 1,
                    type: 'sokrat.voice.ready',
                    payload: {
                        inCall: this.core.activeCalls ? (this.core.activeCalls.size > 0) : false,
                        activeCallsCount: this.core.activeCalls ? this.core.activeCalls.size : 0
                    }
                }, '*');
            }

            if (!this.core.activeCalls || this.core.activeCalls.size === 0) {
                const endedMsg = { version: 1, type: 'sokrat.voice.call_state', payload: { state: 'ended' } };
                if (window.parent && window.parent !== window) window.parent.postMessage(endedMsg, '*');
                window.postMessage(endedMsg, '*');
            }
        }

        cacheDom() {
            this.dom.statusBadge = document.getElementById('statusBadge');
            this.dom.statusText = document.getElementById('statusText');
            this.dom.presetSelect = document.getElementById('presetSelect');
            this.dom.passwordInput = document.getElementById('passwordInput');
            this.dom.connectBtn = document.getElementById('connectBtn');
            this.dom.dialInput = document.getElementById('dialInput');
            this.dom.callBtn = document.getElementById('callBtn');
            this.dom.keypad = document.getElementById('keypadGrid');
            this.dom.vuMeterBar = document.getElementById('vuMeterBar');
            this.dom.speakerVuMeterBar = document.getElementById('speakerVuMeterBar');
            this.dom.activeCallContainer = document.getElementById('activeCallContainer');
            this.dom.micVolumeSlider = document.getElementById('micVolumeSlider');
            this.dom.micVolumeVal = document.getElementById('micVolumeVal');
            this.dom.speakerVolumeSlider = document.getElementById('speakerVolumeSlider');
            this.dom.speakerVolumeVal = document.getElementById('speakerVolumeVal');
            this.dom.callHistoryList = document.getElementById('callHistoryList');
            this.dom.micBanner = document.getElementById('micBanner');
            this.dom.takeOverOverlay = document.getElementById('takeOverOverlay');
            this.dom.toastContainer = document.getElementById('toastContainer');
            this.dom.remoteAudio = document.getElementById('remoteAudio');
            this.dom.ringAudio = document.getElementById('ringAudio');
            if (this.dom.ringAudio) {
                this.core.setRingAudioElement(this.dom.ringAudio);
            }
            this.dom.audioInputSelect = document.getElementById('audioInputSelect');
            this.dom.audioOutputSelect = document.getElementById('audioOutputSelect');
            this.dom.audioRingSelect = document.getElementById('audioRingSelect');
            this.dom.ringVolumeSlider = document.getElementById('ringVolumeSlider');
            this.dom.ringVolumeVal = document.getElementById('ringVolumeVal');
            this.dom.ecCheckbox = document.getElementById('ecCheckbox');
            this.dom.nsCheckbox = document.getElementById('nsCheckbox');
            this.dom.agcCheckbox = document.getElementById('agcCheckbox');
            this.dom.stunCheckbox = document.getElementById('stunCheckbox');
            this.dom.stunServerInput = document.getElementById('stunServerInput');
            this.dom.singleCallCheckbox = document.getElementById('singleCallCheckbox');
            this.dom.callWaitingCheckbox = document.getElementById('callWaitingCheckbox');
            this.dom.dtmfMethodSelect = document.getElementById('dtmfMethodSelect');
            this.dom.dndCheckbox = document.getElementById('dndCheckbox');
            this.dom.autoAnswerCheckbox = document.getElementById('autoAnswerCheckbox');
            this.dom.presetModal = document.getElementById('presetModal');
            this.dom.transferModal = document.getElementById('transferModal');
            this.dom.audioModal = document.getElementById('audioModal');
            this.dom.toolBtnMute = document.getElementById('toolBtnMute');
            this.dom.toolBtnSpeakerMute = document.getElementById('toolBtnSpeakerMute');
            this.dom.toolBtnHold = document.getElementById('toolBtnHold');
            this.dom.toolBtnTransfer = document.getElementById('toolBtnTransfer');
            this.dom.toolBtnDnd = document.getElementById('toolBtnDnd');
            this.dom.toolBtnAuto = document.getElementById('toolBtnAuto');
            this.dom.loginView = document.getElementById('loginView');
            this.dom.mainConsoleView = document.getElementById('mainConsoleView');
            this.dom.loginExtSelect = document.getElementById('loginExtSelect');
            this.dom.loginExtInput = document.getElementById('loginExtInput');
            this.dom.loginPasswordInput = document.getElementById('loginPasswordInput');
            this.dom.loginRememberCheckbox = document.getElementById('loginRememberCheckbox');
            this.dom.loginSubmitBtn = document.getElementById('loginSubmitBtn');
            this.dom.loginSavedAccountsList = document.getElementById('loginSavedAccountsList');
            this.dom.activeAccountHeaderTitle = document.getElementById('activeAccountHeaderTitle');
        }

        initVolumeControls() {
            const savedMic = localStorage.getItem('sokrat_mic_volume');
            const savedSpk = localStorage.getItem('sokrat_speaker_volume');
            const savedMicVol = (savedMic !== null && !isNaN(Number(savedMic))) ? Number(savedMic) : 100;
            const savedSpkVol = (savedSpk !== null && !isNaN(Number(savedSpk))) ? Number(savedSpk) : 100;

            this.core.setMicVolume(savedMicVol);
            this.core.setSpeakerVolume(savedSpkVol);
            if (this.line2Core) {
                this.line2Core.setMicVolume(savedMicVol);
                this.line2Core.setSpeakerVolume(savedSpkVol);
            }

            const setupSpectrum = (coreInstance) => {
                if (!coreInstance) return;
                coreInstance.on('micSpectrum', (data) => {
                    this.updateSpectrumBars('.mic-spectrum', data?.bins);
                });
                coreInstance.on('speakerSpectrum', (data) => {
                    this.updateSpectrumBars('.spk-spectrum', data?.bins);
                });
                coreInstance.on('micVolumeChanged', () => {
                    this.syncAllVolumeDisplays();
                });
                coreInstance.on('speakerVolumeChanged', () => {
                    this.syncAllVolumeDisplays();
                });
            };

            setupSpectrum(this.core);
            if (this.line2Core) setupSpectrum(this.line2Core);
        }

        updateMicVolume(val) {
            const clamped = Math.max(0, Math.min(100, Number(val) || 0));
            this.core.setMicVolume(clamped);
            if (this.line2Core) this.line2Core.setMicVolume(clamped);
            localStorage.setItem('sokrat_mic_volume', clamped);
            this.syncAllVolumeDisplays();
        }

        updateSpeakerVolume(val) {
            const clamped = Math.max(0, Math.min(100, Number(val) || 0));
            this.core.setSpeakerVolume(clamped);
            if (this.line2Core) this.line2Core.setSpeakerVolume(clamped);
            localStorage.setItem('sokrat_speaker_volume', clamped);
            this.syncAllVolumeDisplays();
        }

        refreshSegmentedVolumeDisplay(container, micVol, spkVol) {
            const NUM_SEGMENTS = 12;
            const micVal = (micVol !== undefined) ? micVol : (this.core.micVolume ?? 100);
            const spkVal = (spkVol !== undefined) ? spkVol : (this.core.speakerVolume ?? 100);
            const micActiveCount = Math.round((micVal / 100) * NUM_SEGMENTS);
            const spkActiveCount = Math.round((spkVal / 100) * NUM_SEGMENTS);
            const actualMic = micVal;
            const actualSpk = spkVal;

            const root = container || document;
            const micTracks = root.querySelectorAll('.mic-vol .vol-segments-track');
            micTracks.forEach(track => {
                const segs = track.querySelectorAll('.vol-segment');
                segs.forEach(seg => {
                    const idx = Number(seg.dataset.segmentIndex || 0);
                    seg.classList.toggle('active', idx <= micActiveCount);
                });
            });
            const micBadges = root.querySelectorAll('.mic-vol .vol-pct-badge');
            micBadges.forEach(b => { b.textContent = `${actualMic}%`; });

            const spkTracks = root.querySelectorAll('.spk-vol .vol-segments-track');
            spkTracks.forEach(track => {
                const segs = track.querySelectorAll('.vol-segment');
                segs.forEach(seg => {
                    const idx = Number(seg.dataset.segmentIndex || 0);
                    seg.classList.toggle('active', idx <= spkActiveCount);
                });
            });
            const spkBadges = root.querySelectorAll('.spk-vol .vol-pct-badge');
            spkBadges.forEach(b => { b.textContent = `${actualSpk}%`; });
        }

        syncAllVolumeDisplays() {
            this.refreshSegmentedVolumeDisplay(document, this.core.micVolume ?? 100, this.core.speakerVolume ?? 100);
        }

        updateSpectrumBars(containerSelector, bins) {
            if (!Array.isArray(bins)) return;
            const spectrumWraps = document.querySelectorAll(containerSelector);
            spectrumWraps.forEach(wrap => {
                const bars = wrap.querySelectorAll('.vu-spectrum-bar');
                bars.forEach((bar, idx) => {
                    const val = bins[idx] || 0;
                    const heightPx = Math.max(3, Math.min(18, Math.round((val / 100) * 18)));
                    bar.style.height = `${heightPx}px`;
                });
            });
        }

        createHeroAudioDeck(call, line = 'line1') {
            const isAr = this.currentLang === 'ar';
            const deck = document.createElement('div');
            deck.className = 'hero-audio-deck';
            deck.id = `${line}HeroAudioDeck_${call.id}`;

            const NUM_SEGMENTS = 12;
            const NUM_SPECTRUM_BARS = 8;

            // --- 1. MIC CHANNEL ---
            const micChan = document.createElement('div');
            micChan.className = 'hero-audio-channel mic-vol';

            const micLeft = document.createElement('div');
            micLeft.className = 'hero-audio-channel-left';

            const micLabel = document.createElement('div');
            micLabel.className = 'hero-audio-label';
            micLabel.title = isAr ? 'مستوى صوت وحساسية الميكروفون' : 'Microphone Input & Gain';
            micLabel.innerHTML = `${SVG_ICONS.mic}<span>${isAr ? 'ميك' : 'MIC'}</span>`;
            micLeft.appendChild(micLabel);

            const micSpectrum = document.createElement('div');
            micSpectrum.className = 'vu-spectrum-wrap mic-spectrum';
            micSpectrum.id = `${line}MicSpectrum_${call.id}`;
            for (let i = 0; i < NUM_SPECTRUM_BARS; i++) {
                const bar = document.createElement('div');
                bar.className = 'vu-spectrum-bar';
                bar.dataset.barIndex = i;
                micSpectrum.appendChild(bar);
            }
            micLeft.appendChild(micSpectrum);
            micChan.appendChild(micLeft);

            const micVolCtrl = document.createElement('div');
            micVolCtrl.className = 'segmented-vol-control';

            const micMinusBtn = document.createElement('button');
            micMinusBtn.type = 'button';
            micMinusBtn.className = 'vol-stepper-btn';
            micMinusBtn.textContent = '−';
            micMinusBtn.title = isAr ? 'خفض صوت الميكروفون' : 'Decrease Mic Volume';
            micVolCtrl.appendChild(micMinusBtn);

            const micTrack = document.createElement('div');
            micTrack.className = 'vol-segments-track';
            micTrack.id = `${line}MicTrack_${call.id}`;
            for (let i = 1; i <= NUM_SEGMENTS; i++) {
                const seg = document.createElement('div');
                seg.className = 'vol-segment';
                seg.dataset.segmentIndex = i;
                seg.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const newVol = Math.round((i / NUM_SEGMENTS) * 100);
                    this.updateMicVolume(newVol);
                });
                micTrack.appendChild(seg);
            }
            micVolCtrl.appendChild(micTrack);

            const micPlusBtn = document.createElement('button');
            micPlusBtn.type = 'button';
            micPlusBtn.className = 'vol-stepper-btn';
            micPlusBtn.textContent = '+';
            micPlusBtn.title = isAr ? 'رفع صوت الميكروفون' : 'Increase Mic Volume';
            micVolCtrl.appendChild(micPlusBtn);

            const micPctBadge = document.createElement('div');
            micPctBadge.className = 'vol-pct-badge';
            micPctBadge.id = `${line}MicPct_${call.id}`;
            micPctBadge.textContent = `${this.core.micVolume ?? 100}%`;
            micVolCtrl.appendChild(micPctBadge);

            micMinusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const cur = this.core.micVolume ?? 100;
                this.updateMicVolume(Math.max(0, cur - 10));
            });

            micPlusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const cur = this.core.micVolume ?? 100;
                this.updateMicVolume(Math.min(100, cur + 10));
            });

            micChan.appendChild(micVolCtrl);
            deck.appendChild(micChan);

            // --- 2. SPEAKER CHANNEL ---
            const spkChan = document.createElement('div');
            spkChan.className = 'hero-audio-channel spk-vol';

            const spkLeft = document.createElement('div');
            spkLeft.className = 'hero-audio-channel-left';

            const spkLabel = document.createElement('div');
            spkLabel.className = 'hero-audio-label';
            spkLabel.title = isAr ? 'مستوى صوت السماعة' : 'Speaker Output & Volume';
            spkLabel.innerHTML = `${SVG_ICONS.headphones}<span>${isAr ? 'سماعة' : 'SPK'}</span>`;
            spkLeft.appendChild(spkLabel);

            const spkSpectrum = document.createElement('div');
            spkSpectrum.className = 'vu-spectrum-wrap spk-spectrum';
            spkSpectrum.id = `${line}SpkSpectrum_${call.id}`;
            for (let i = 0; i < NUM_SPECTRUM_BARS; i++) {
                const bar = document.createElement('div');
                bar.className = 'vu-spectrum-bar';
                bar.dataset.barIndex = i;
                spkSpectrum.appendChild(bar);
            }
            spkLeft.appendChild(spkSpectrum);
            spkChan.appendChild(spkLeft);

            const spkVolCtrl = document.createElement('div');
            spkVolCtrl.className = 'segmented-vol-control';

            const spkMinusBtn = document.createElement('button');
            spkMinusBtn.type = 'button';
            spkMinusBtn.className = 'vol-stepper-btn';
            spkMinusBtn.textContent = '−';
            spkMinusBtn.title = isAr ? 'خفض صوت السماعة' : 'Decrease Speaker Volume';
            spkVolCtrl.appendChild(spkMinusBtn);

            const spkTrack = document.createElement('div');
            spkTrack.className = 'vol-segments-track';
            spkTrack.id = `${line}SpkTrack_${call.id}`;
            for (let i = 1; i <= NUM_SEGMENTS; i++) {
                const seg = document.createElement('div');
                seg.className = 'vol-segment';
                seg.dataset.segmentIndex = i;
                seg.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const newVol = Math.round((i / NUM_SEGMENTS) * 100);
                    this.updateSpeakerVolume(newVol);
                });
                spkTrack.appendChild(seg);
            }
            spkVolCtrl.appendChild(spkTrack);

            const spkPlusBtn = document.createElement('button');
            spkPlusBtn.type = 'button';
            spkPlusBtn.className = 'vol-stepper-btn';
            spkPlusBtn.textContent = '+';
            spkPlusBtn.title = isAr ? 'رفع صوت السماعة' : 'Increase Speaker Volume';
            spkVolCtrl.appendChild(spkPlusBtn);

            const spkPctBadge = document.createElement('div');
            spkPctBadge.className = 'vol-pct-badge';
            spkPctBadge.id = `${line}SpkPct_${call.id}`;
            spkPctBadge.textContent = `${this.core.speakerVolume ?? 100}%`;
            spkVolCtrl.appendChild(spkPctBadge);

            spkMinusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const cur = this.core.speakerVolume ?? 100;
                this.updateSpeakerVolume(Math.max(0, cur - 10));
            });

            spkPlusBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const cur = this.core.speakerVolume ?? 100;
                this.updateSpeakerVolume(Math.min(100, cur + 10));
            });

            spkChan.appendChild(spkVolCtrl);
            deck.appendChild(spkChan);

            this.refreshSegmentedVolumeDisplay(deck, this.core.micVolume ?? 100, this.core.speakerVolume ?? 100);

            return deck;
        }
        tReplace(key, params = {}) {
            let str = this.t[key] || key;
            for (const [k, v] of Object.entries(params)) {
                str = str.replace(`{${k}}`, v);
            }
            return str;
        }

        showToast(message, type = 'info') {
            if (!this.dom.toastContainer) return;
            const toast = document.createElement('div');
            toast.className = `toast toast-${type}`;
            toast.textContent = message;

            this.dom.toastContainer.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(8px)';
                toast.style.transition = 'all 0.2s ease';
                setTimeout(() => toast.remove(), 220);
            }, 3200);
        }

        // --- TOP SUB-NAV TAB SWITCHING ---
        switchTab(tabName) {
            this.activeTab = tabName;
            ['dialer', 'contacts', 'history'].forEach(tab => {
                const btn = document.getElementById(`tabBtn${tab.charAt(0).toUpperCase() + tab.slice(1)}`);
                const content = document.getElementById(`tabContent${tab.charAt(0).toUpperCase() + tab.slice(1)}`);
                if (btn) btn.classList.toggle('active', tab === tabName);
                if (content) {
                    content.classList.toggle('active', tab === tabName);
                    content.style.display = (tab === tabName) ? 'flex' : 'none';
                }
            });

            const callLogsBtn = document.getElementById('titlebarCallLogsBtn');
            if (callLogsBtn) callLogsBtn.classList.toggle('active', tabName === 'history');

            if (tabName === 'contacts') {
                this.renderContacts();
            } else if (tabName === 'history') {
                this.loadCallLogs();
            }
        }

        toggleCallLogs(line = 'line1') {
            if (line === 'line2' && this.line2Core) {
                const isLine2History = (this.activeTabLine2 === 'history');
                this.switchTabLine2(isLine2History ? 'dialer' : 'history');
                return;
            }
            if (this.activeTab === 'history') {
                this.switchTab('dialer');
            } else {
                this.switchTab('history');
            }
        }
        // --- SPEAKER / INCOMING AUDIO MUTE ---
        toggleSpeakerMute() {
            this.core.toggleSpeakerMute();
        }

        // --- DEDICATED SOFTPHONE LOGIN & VIEW MANAGEMENT ---
        setLoginInputMode(mode) {
            const selectWrapper = document.getElementById('loginFieldSelectWrapper');
            const manualWrapper = document.getElementById('loginFieldManualWrapper');
            const selectBtn = document.getElementById('loginModeSelectBtn');
            const manualBtn = document.getElementById('loginModeManualBtn');

            if (mode === 'manual') {
                if (selectWrapper) selectWrapper.style.display = 'none';
                if (manualWrapper) manualWrapper.style.display = 'flex';
                if (selectBtn) selectBtn.classList.remove('active');
                if (manualBtn) manualBtn.classList.add('active');
                const extInput = document.getElementById('loginExtInput');
                if (extInput) extInput.focus();
            } else {
                if (selectWrapper) selectWrapper.style.display = 'flex';
                if (manualWrapper) manualWrapper.style.display = 'none';
                if (selectBtn) selectBtn.classList.add('active');
                if (manualBtn) manualBtn.classList.remove('active');
            }
        }

        toggleLoginPasswordVisibility() {
            const passInput = document.getElementById('loginPasswordInput');
            if (passInput) {
                passInput.type = (passInput.type === 'password') ? 'text' : 'password';
            }
        }

        onLoginExtensionSelected() {
            const select = document.getElementById('loginExtSelect');
            if (!select || !select.value) return;
            const extNum = select.value;
            const extInput = document.getElementById('loginExtInput');
            if (extInput) extInput.value = extNum;

            const presets = this.getPresets();
            const matchingPreset = presets.find(p => String(p.extension) === String(extNum));
            const passInput = document.getElementById('loginPasswordInput');
            if (matchingPreset && passInput) {
                passInput.value = matchingPreset.secret || this.sessionSecrets.get(matchingPreset.id) || '';
            }
        }

        async submitLogin() {
            const extSelect = document.getElementById('loginExtSelect');
            const extInput = document.getElementById('loginExtInput');
            const passInput = document.getElementById('loginPasswordInput');
            const rememberCheckbox = document.getElementById('loginRememberCheckbox');

            const manualWrapper = document.getElementById('loginFieldManualWrapper');
            const isManual = manualWrapper && manualWrapper.style.display !== 'none';
            const extension = isManual ? (extInput ? extInput.value.trim() : '') : (extSelect && extSelect.value ? extSelect.value.trim() : (extInput ? extInput.value.trim() : ''));
            const password = passInput ? passInput.value.trim() : '';
            const remember = rememberCheckbox ? rememberCheckbox.checked : true;

            if (!extension) {
                this.showToast(this.t.loginSelectExtError || 'Please select or enter an extension number', 'error');
                return;
            }
            if (!password) {
                this.showToast(this.t.loginEnterPasswordError || 'Please enter the extension password', 'error');
                return;
            }

            const host = this.serverHost || window.location.hostname || '127.0.0.1';
            const defaultWss = this.serverDefaultWss || `wss://${host}:8089/ws`;

            let presets = this.getPresets();
            let preset = presets.find(p => String(p.extension) === String(extension));

            if (!preset) {
                preset = {
                    id: 'ext_' + extension,
                    label: 'Ext ' + extension,
                    extension: extension,
                    sipDomain: host,
                    wssUrl: defaultWss,
                    dnd: false,
                    autoAnswer: false,
                    secret: remember ? password : '',
                    autoConnect: remember,
                    isDefault: true
                };
                presets.push(preset);
            } else if (remember) {
                preset.secret = password;
                preset.autoConnect = true;
            }

            if (remember) {
                presets.forEach(p => p.isDefault = (p.id === preset.id));
                this.savePresets(presets);
            }
            this.sessionSecrets.set(preset.id, password);
            this.lastSessionPassword = password;

            try {
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<span>' + (this.t.loginConnecting || 'Connecting...') + '</span>';
                }
                await this.core.connect(preset, password);
            } catch (err) {
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>' + (this.t.loginConnectBtn || 'CONNECT & LOGIN ↗') + '</span>';
                }
                this.showToast(err.message, 'error');
            }
        }

        async quickLoginAccount(presetId) {
            const presets = this.getPresets();
            const preset = presets.find(p => p.id === presetId);
            if (!preset) return;

            let password = preset.secret || this.sessionSecrets.get(preset.id) || this.lastSessionPassword || '';
            if (!password) {
                this.selectAccountForLogin(preset);
                const passInput = document.getElementById('loginPasswordInput');
                if (passInput) passInput.focus();
                const promptMsg = (this.t.loginEnterPasswordForExt || 'Please enter password for extension {ext}').replace('{ext}', preset.extension);
                this.showToast(promptMsg, 'warning');
                return;
            }

            this.sessionSecrets.set(preset.id, password);
            this.lastSessionPassword = password;
            const connMsg = (this.t.loginConnectingExt || 'Connecting Ext {ext}...').replace('{ext}', preset.extension);
            this.showToast(connMsg, 'info');
            try {
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<span>' + (this.t.loginConnecting || 'Connecting...') + '</span>';
                }
                await this.core.connect(preset, password);
            } catch (err) {
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>' + (this.t.loginConnectBtn || 'CONNECT & LOGIN ↗') + '</span>';
                }
                this.showToast(err.message, 'error');
            }
        }

        renderSavedAccountsLoginList() {
            const listEl = document.getElementById('loginSavedAccountsList');
            if (!listEl) return;
            listEl.innerHTML = '';

            const presets = this.getPresets();
            if (presets.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'text-center py-6 text-xs text-muted';
                emptyMsg.textContent = this.t.loginNoSaved || (this.currentLang === 'ar' ? 'لا توجد تحويلات محفوظة بعد.' : 'No saved extensions yet.');
                listEl.appendChild(emptyMsg);
                return;
            }

            presets.forEach(p => {
                const card = document.createElement('div');
                card.className = 'saved-login-card';
                card.dataset.id = p.id;
                if (p.isDefault) card.classList.add('selected');

                // Top Row: Avatar + Info on left, Edit & Delete on right
                const topRow = document.createElement('div');
                topRow.className = 'saved-login-top';

                const left = document.createElement('div');
                left.className = 'saved-login-left';

                const avatar = document.createElement('div');
                avatar.className = 'saved-login-avatar font-mono';
                avatar.textContent = (p.extension || 'E').slice(-2);

                const details = document.createElement('div');
                details.className = 'saved-login-info';

                const nameSpan = document.createElement('div');
                nameSpan.className = 'saved-login-name';
                nameSpan.textContent = p.label || ('Ext ' + p.extension);

                const extSpan = document.createElement('div');
                extSpan.className = 'saved-login-ext';

                const badgeSpan = document.createElement('span');
                badgeSpan.className = 'saved-login-badge';
                badgeSpan.textContent = 'EXT ' + p.extension;

                const sepSpan = document.createElement('span');
                sepSpan.className = 'text-muted';
                sepSpan.textContent = p.sipDomain || 'PBX';

                extSpan.appendChild(badgeSpan);
                extSpan.appendChild(sepSpan);

                details.appendChild(nameSpan);
                details.appendChild(extSpan);
                left.appendChild(avatar);
                left.appendChild(details);

                const actions = document.createElement('div');
                actions.className = 'saved-login-actions';

                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'saved-edit-btn';
                editBtn.title = this.t.loginEditAccountTitle || 'Edit account credentials';
                editBtn.innerHTML = SVG_ICONS.edit;
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openPresetModal(p);
                });

                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'saved-del-btn';
                deleteBtn.title = this.t.loginDeleteAccountTitle || 'Remove saved account';
                deleteBtn.innerHTML = SVG_ICONS.trash;
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    let updated = this.getPresets().filter(pr => pr.id !== p.id);
                    this.savePresets(updated);
                    this.sessionSecrets.delete(p.id);
                    this.renderSavedAccountsLoginList();
                    this.showToast(this.t.loginAccountRemoved || 'Account removed', 'info');
                });

                actions.appendChild(editBtn);
                actions.appendChild(deleteBtn);
                topRow.appendChild(left);
                topRow.appendChild(actions);

                // Bottom Row: Full-width Quick Connect button
                const bottomRow = document.createElement('div');
                bottomRow.className = 'saved-login-bottom';

                const loginBtn = document.createElement('button');
                loginBtn.type = 'button';
                loginBtn.className = 'saved-quick-btn';
                loginBtn.innerHTML = `<span>${this.t.loginQuickBtn || '1-Click Login ↗'}</span>`;
                loginBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.quickLoginAccount(p.id);
                });
                bottomRow.appendChild(loginBtn);

                card.appendChild(topRow);
                card.appendChild(bottomRow);

                card.addEventListener('click', () => {
                    this.selectAccountForLogin(p);
                });

                listEl.appendChild(card);
            });
        }

        selectAccountForLogin(preset) {
            const extInput = document.getElementById('loginExtInput');
            const passInput = document.getElementById('loginPasswordInput');
            const extSelect = document.getElementById('loginExtSelect');

            if (extInput) extInput.value = preset.extension;
            if (extSelect) {
                extSelect.value = preset.extension;
                if (extSelect.value !== preset.extension) {
                    this.setLoginInputMode('manual');
                } else {
                    this.setLoginInputMode('select');
                }
            }
            const secret = preset.secret || this.sessionSecrets.get(preset.id) || this.lastSessionPassword || '';
            if (passInput) passInput.value = secret;
            if (passInput && !secret) passInput.focus();

            const cards = document.querySelectorAll('.saved-login-card');
            cards.forEach(c => c.classList.toggle('selected', c.dataset.id === preset.id));
        }

        logout() {
            this.core.disconnect();
            this.updateViewMode('login');
            this.showToast(this.t.statusOffline || 'Logged out of extension', 'info');
        }

        switchAccount() {
            this.logout();
        }

        updateViewMode(mode) {
            const loginView = document.getElementById('loginView');
            const mainAppWindow = document.getElementById('mainAppWindow');
            const titleEl = document.getElementById('activeAccountHeaderTitle');

            if (mode === 'console') {
                if (loginView) {
                    loginView.style.setProperty('display', 'none', 'important');
                    loginView.classList.add('hidden');
                }
                if (mainAppWindow) {
                    mainAppWindow.style.setProperty('display', 'flex', 'important');
                    mainAppWindow.classList.remove('hidden');
                }
                if (titleEl && this.core.activePreset) {
                    titleEl.textContent = 'Ext ' + this.core.activePreset.extension;
                }
            } else {
                if (loginView) {
                    loginView.style.setProperty('display', 'flex', 'important');
                    loginView.classList.remove('hidden');
                }
                if (mainAppWindow) {
                    mainAppWindow.style.setProperty('display', 'none', 'important');
                    mainAppWindow.classList.add('hidden');
                }
                const workspace = document.getElementById('line1Workspace');
                if (workspace) workspace.style.display = '';
                if (this.dom.activeCallContainer) this.dom.activeCallContainer.style.display = 'none';
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>' + (this.t.loginConnectBtn || (this.currentLang === 'ar' ? 'تسجيل الدخول والاتصال ↗' : 'CONNECT & LOGIN ↗')) + '</span>';
                }
                this.renderSavedAccountsLoginList();
            }
        }

        // --- MULTI-EXTENSION SPLIT SCREEN VIEW ---
        toggleSplitView() {
            this.isSplitView = !this.isSplitView;
            const appWindow = document.querySelector('.app-window');
            const splitBtn = document.getElementById('splitViewToggleBtn');

            if (this.isSplitView) {
                if (appWindow) appWindow.classList.add('is-split-view');
                if (splitBtn) {
                    splitBtn.classList.add('active');
                    splitBtn.style.background = 'var(--accent-color)';
                    splitBtn.style.color = '#ffffff';
                }
                this.initSplitLine2();
                this.showToast('Dual Extension Split View Enabled', 'success');
            } else {
                if (appWindow) appWindow.classList.remove('is-split-view');
                if (splitBtn) {
                    splitBtn.classList.remove('active');
                    splitBtn.style.background = '';
                    splitBtn.style.color = '';
                }
                const line2 = document.getElementById('splitLine2Container');
                if (line2) line2.style.display = 'none';
                if (this.line2Core) {
                    try { this.line2Core.disconnect(); } catch (_) {}
                }
                this.showToast('Single Line View', 'info');
            }
        }

                        initSplitLine2() {
            let line2 = document.getElementById('splitLine2Container');
            if (!line2) {
                const appBody = document.querySelector('.app-body');
                if (!appBody) return;
                line2 = document.createElement('div');
                line2.id = 'splitLine2Container';
                line2.className = 'workspace';
                appBody.appendChild(line2);
            }
            line2.style.display = 'flex';

            const isAr = this.currentLang === 'ar';
            const t = {
                dialer: isAr ? 'لوحة الاتصال' : 'Dialer',
                contacts: isAr ? 'جهات الاتصال' : 'Contacts',
                history: isAr ? 'سجل المكالمات' : 'Recent Calls',
                enterDest: isAr ? 'أدخل الرقم للاتصال (الخط 2)' : 'Line 2 Destination',
                call: isAr ? 'اتصال' : 'Call',
                clear: isAr ? 'مسح' : 'Clear',
                mute: isAr ? 'كتم' : 'Mute',
                speaker: isAr ? 'سماعة' : 'Speaker',
                transfer: isAr ? 'تحويل' : 'Transfer',
                hold: isAr ? 'تعليق' : 'Hold',
                dnd: isAr ? 'إزعاج' : 'DND',
                auto: isAr ? 'تلقائي' : 'Auto',
                connect: isAr ? 'اتصال' : 'Connect',
                disconnect: isAr ? 'قطع' : 'Disconnect',
                available: isAr ? 'متاح' : 'Available',
                offline: isAr ? 'غير متصل' : 'Offline'
            };

            line2.innerHTML = `
                <!-- Line 2 Sub Navigation Tabs -->
                <div class="sub-nav-tabs">
                    <button type="button" class="sub-nav-tab active" id="tabBtnLine2Dialer">
                        ${SVG_ICONS.phone}<span>${t.dialer}</span>
                    </button>
                    <button type="button" class="sub-nav-tab" id="tabBtnLine2Contacts">
                        ${SVG_ICONS.users}<span>${t.contacts}</span>
                    </button>
                    <button type="button" class="sub-nav-tab" id="tabBtnLine2History">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>${t.history}</span>
                    </button>
                </div>

                <!-- Line 2 Active Calls Hero Container -->
                <div id="line2ActiveCallContainer" style="display:none; flex-direction:column; padding:10px 14px 0;"></div>

                <!-- Tab View: Line 2 Dialer -->
                <div id="tabContentLine2Dialer" class="tab-view-content active" style="padding:10px 14px 14px;">
                    <div class="dialer-col">

                        <!-- LCD Dial Display Box -->
                        <div class="dialer-input-box" style="position: relative;">
                            <button type="button" id="line2DialHistoryDropdownBtn" class="dial-history-dropdown-btn" onclick="window.softphoneUi.toggleDialHistoryDropdown('line2')" title="${isAr ? 'الأرقام السابقة' : 'Recent Numbers'}">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                            </button>
                            <input type="text" id="line2DialInput" placeholder="${t.dialPlaceholder}" class="dialer-input" autocomplete="off">
                            <button type="button" class="clear-input-btn" id="line2BackspaceBtn" title="Backspace">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>
                            </button>
                            <div id="line2DialHistoryDropdown" class="dial-history-dropdown" style="display: none;">
                                <div class="dial-history-dropdown-header">
                                    <span>${isAr ? 'الأرقام المطلوبة مؤخراً' : 'RECENTLY DIALED'}</span>
                                    <button type="button" class="dial-history-close-btn" onclick="window.softphoneUi.closeDialHistoryDropdown('line2')">✕</button>
                                </div>
                                <div id="line2DialHistoryDropdownList" class="dial-history-dropdown-list"></div>
                            </div>
                        </div>

                        <!-- 3x4 Boxy Keypad Grid -->
                        <div class="keypad-grid" id="line2KeypadGrid"></div>

                        <!-- Action Buttons: Call & Clear -->
                        <div class="keypad-action-row">
                            <button type="button" id="line2CallBtn" class="call-pill-btn" title="Place Call (Line 2)">
                                ${SVG_ICONS.phone}
                                <span>${t.call}</span>
                            </button>
                            <button type="button" id="line2ClearBtn" class="call-aux-btn" title="Clear">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                <span>${t.clear}</span>
                            </button>
                        </div>

                        <!-- Line 2 Live In-Call & Toggle Tools Bar -->
                        <div class="dialer-tool-bar">
                            <button type="button" class="tool-icon-btn" id="line2ToolBtnSpeakerMute" title="${t.speaker}">
                                ${SVG_ICONS.speaker}
                                <span class="tool-label">${t.speaker}</span>
                            </button>
                            <button type="button" class="tool-icon-btn" id="line2ToolBtnDnd" title="${t.dnd}">
                                ${SVG_ICONS.dnd}
                                <span class="tool-label">${t.dnd}</span>
                            </button>
                            <button type="button" class="tool-icon-btn" id="line2ToolBtnAuto" title="${t.auto}">
                                ${SVG_ICONS.autoAnswer}
                                <span class="tool-label">${t.auto}</span>
                            </button>
                        </div>


                    </div>
                </div>

                <!-- Tab View: Line 2 Contacts -->
                <div id="tabContentLine2Contacts" class="tab-view-content" style="display:none; padding:12px 14px; max-height:calc(100vh - 120px); overflow-y:auto;">
                    <div id="line2ContactsSection" class="contacts-sec"></div>
                </div>

                <!-- Tab View: Line 2 Recent Calls -->
                <div id="tabContentLine2History" class="tab-view-content" style="display:none; padding:12px 14px; max-height:calc(100vh - 120px); overflow-y:auto;">
                    <div class="recent-calls-sec">
                        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                            <div class="recent-calls-title">${t.history} (Line 2)</div>
                        </div>
                        <div class="recent-calls-list" id="line2CallHistoryList"></div>
                    </div>
                </div>
            `;

            // Populate Line 2 presets in shared header with all extensions (excluding Line 1 active extension by default)
            const line2Select = document.getElementById('line2PresetSelect');
            const line2PassInput = document.getElementById('line2PasswordInput');
            const line2ConnectBtn = document.getElementById('line2ConnectBtn');
            const line2StatusBadge = document.getElementById('line2StatusBadge');
            const line2StatusText = document.getElementById('line2StatusText');

            const webrtcPool = (this.serverWebrtcList && this.serverWebrtcList.length > 0) ? this.serverWebrtcList : [
                { extension: '150', name: '150', tech: 'pjsip' },
                { extension: '151', name: 'Line 2 Ext 151', tech: 'pjsip' }
            ];
            const presets = this.getPresets();

            if (line2Select) {
                line2Select.innerHTML = '';
                const line1Val = document.getElementById('presetSelect') ? document.getElementById('presetSelect').value.replace(/^ext_/, '') : '150';

                webrtcPool.forEach((extObj, idx) => {
                    const extNum = String(extObj.extension || extObj.id || '').replace(/^ext_/, '');
                    if (!extNum) return;
                    const opt = document.createElement('option');
                    opt.value = 'ext_' + extNum;
                    const cleanName = extObj.name || `Ext ${extNum}`;
                    opt.textContent = cleanName.includes(extNum) ? cleanName : `${extNum} (${cleanName})`;
                    // Default to 151 on Line 2 if Line 1 is on 150
                    if (extNum !== line1Val || (idx === 1 && webrtcPool.length > 1)) {
                        opt.selected = true;
                    }
                    line2Select.appendChild(opt);
                });

                const onLine2ExtChanged = () => {
                    const selExt = line2Select.value.replace(/^ext_/, '');
                    const matchingPreset = presets.find(p => String(p.extension) === String(selExt));
                    const savedSecret = (matchingPreset && matchingPreset.secret) ? matchingPreset.secret : (this.sessionSecrets.get('ext_' + selExt) || '');
                    if (line2PassInput) line2PassInput.value = savedSecret;
                };

                line2Select.onchange = onLine2ExtChanged;
                onLine2ExtChanged();
            }

            if (line2PassInput) {
                line2PassInput.oninput = () => {
                    if (line2Select) {
                        this.sessionSecrets.set(line2Select.value, line2PassInput.value);
                    }
                };
            }

            
            // Render Line 2 Keypad digits with subtext
            const keypadGrid = document.getElementById('line2KeypadGrid');
            if (keypadGrid) {
                keypadGrid.innerHTML = '';
                const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
                digits.forEach(d => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'keypad-btn';
                    btn.innerHTML = `<span class="keypad-digit">${d}</span>`;
                    btn.addEventListener('click', () => {
                        const input = document.getElementById('line2DialInput');
                        if (input) input.value += d;
                    });
                    keypadGrid.appendChild(btn);
                });
            }

            // Backspace & Clear for Line 2
            const bsBtn = document.getElementById('line2BackspaceBtn');
            if (bsBtn) {
                bsBtn.onclick = () => {
                    const input = document.getElementById('line2DialInput');
                    if (input) input.value = input.value.slice(0, -1);
                };
            }
            const clrBtn = document.getElementById('line2ClearBtn');
            if (clrBtn) {
                clrBtn.onclick = () => {
                    const input = document.getElementById('line2DialInput');
                    if (input) input.value = '';
                };
            }
            this.setupDialHistorySeeking(document.getElementById('line2DialInput'), 'line2');
            // Setup Line 2 Core with explicit line2 lockKey to prevent collision
            if (!this.line2Core) {
                this.line2Core = new SokratSoftphoneCore({ 
                    lineId: 'line2', 
                    busName: 'sokrat_sp_line2_bus', 
                    lockKey: 'sokrat_sp_owner_lock_line2_v2' 
                });
                const audio2 = document.createElement('audio');
                audio2.autoplay = true;
                audio2.playsInline = true;
                document.body.appendChild(audio2);
                this.line2Core.setRemoteAudioElement(audio2);

                this.line2Core.on('regStateChange', ({ state, preset }) => {
                    const badge = document.getElementById('line2StatusBadge');
                    const text = document.getElementById('line2StatusText');
                    const btn = document.getElementById('line2ConnectBtn');
                    if (!badge || !text || !btn) return;
                    badge.className = 'status-pill';
                    if (state === 'REGISTERED') {
                        badge.classList.add('online');
                        text.textContent = t.available;
                        btn.textContent = t.disconnect;
                        btn.className = 'btn btn-danger';
                        const extLabel = preset ? `Ext ${preset.extension}` : 'Line 2';
                        this.showToast(`[Line 2] Connected to ${extLabel}`, 'success');
                    } else if (state === 'CONNECTING') {
                        badge.classList.add('ringing');
                        text.textContent = 'Connecting...';
                        btn.textContent = 'Cancel';
                        btn.className = 'btn btn-danger';
                    } else if (state === 'AUTH_FAILED') {
                        badge.classList.add('incall');
                        text.textContent = 'Auth Failed';
                        btn.textContent = t.connect;
                        btn.className = 'btn btn-primary';
                        this.showToast('[Line 2] Authentication failed: check password', 'error');
                    } else {
                        text.textContent = t.offline;
                        btn.textContent = t.connect;
                        btn.className = 'btn btn-primary';
                    }
                    this.updateLine2InCallButtonStates();
                });

                this.line2Core.on('vuLevel', (level) => {
                    const bar = document.getElementById('line2VuMeterBar');
                    if (bar) bar.style.width = level + '%';
                });
                this.line2Core.on('speakerLevel', (level) => {
                    const bar = document.getElementById('line2SpeakerVuMeterBar');
                    if (bar) bar.style.width = level + '%';
                });

                this.line2Core.on('incomingCall', () => this.renderLine2ActiveCalls());
                this.line2Core.on('callProgress', () => this.renderLine2ActiveCalls());
                this.line2Core.on('callAnswered', () => this.renderLine2ActiveCalls());
                this.line2Core.on('callUpdated', () => this.renderLine2ActiveCalls());
                this.line2Core.on('callEnded', () => this.renderLine2ActiveCalls());
                this.line2Core.on('callLog', (logEntry) => this.addCallLog({ ...logEntry, line: 'line2' }));
                this.line2Core.on('toast', ({ type, message }) => this.showToast(`[Line 2] ${message}`, type));
            }

            if (line2ConnectBtn) {
                line2ConnectBtn.onclick = async () => {
                    if (this.line2Core.regState === 'REGISTERED' || this.line2Core.regState === 'CONNECTING') {
                        this.line2Core.disconnect();
                    } else {
                        const selExt = line2Select ? line2Select.value.replace(/^ext_/, '') : '102';
                        const matchingPreset = presets.find(p => String(p.extension) === String(selExt));
                        const targetPreset = matchingPreset || {
                            id: 'ext_' + selExt,
                            label: 'Ext ' + selExt,
                            extension: selExt,
                            sipDomain: this.serverHost || window.location.hostname || '127.0.0.1',
                            wssUrl: this.serverDefaultWss || `wss://${window.location.hostname || '127.0.0.1'}:8089/ws`
                        };
                        const secret = (line2PassInput ? line2PassInput.value.trim() : '') || targetPreset.secret || (this.sessionSecrets.get('ext_' + selExt) || '');
                        if (!secret) {
                            if (line2PassInput) line2PassInput.focus();
                            this.showToast(`Please enter password for Line 2 Ext ${selExt}`, 'warning');
                            return;
                        }
                        try {
                            await this.line2Core.connect(targetPreset, secret);
                        } catch (err) {
                            this.showToast(`[Line 2] ${err.message}`, 'error');
                        }
                    }
                };
            }

            const line2CallBtn = document.getElementById('line2CallBtn');
            if (line2CallBtn) {
                line2CallBtn.onclick = () => {
                    if (this.line2Core.activeCalls.size > 0) {
                        this.showToast(this.currentLang === 'ar' ? '[الخط 2] يوجد مكالمة نشطة بالفعل' : '[Line 2] A call is already in progress', 'warning');
                        return;
                    }
                    const num = document.getElementById('line2DialInput').value.trim();
                    if (num) {
                        try {
                            this.line2Core.makeCall(num);
                        } catch (err) {
                            this.showToast(`[Line 2] ${err.message}`, 'error');
                        }
                    }
                };
            }

            const line2MicSlider = document.getElementById('line2MicVolumeSlider');
            const line2MicVal = document.getElementById('line2MicVolumeVal');
            const line2SpkSlider = document.getElementById('line2SpeakerVolumeSlider');
            const line2SpkVal = document.getElementById('line2SpeakerVolumeVal');

            if (line2MicSlider && this.line2Core) {
                line2MicSlider.addEventListener('input', (e) => {
                    const val = e.target.value;
                    if (line2MicVal) line2MicVal.textContent = val + '%';
                    this.line2Core.setMicVolume(val);
                });
            }

            if (line2SpkSlider && this.line2Core) {
                line2SpkSlider.addEventListener('input', (e) => {
                    const val = e.target.value;
                    if (line2SpkVal) line2SpkVal.textContent = val + '%';
                    this.line2Core.setSpeakerVolume(val);
                });
            }
        }

        renderLine2ActiveCalls() {
            this.updateInCallWindowState();
            const container = document.getElementById('line2ActiveCallContainer');
            if (!container || !this.line2Core) return;
            container.textContent = '';
            const calls = Array.from(this.line2Core.activeCalls.values());
            if (calls.length === 0) {
                container.style.display = 'none';
                this.updateLine2InCallButtonStates();
                return;
            }
            container.style.display = 'flex';
            calls.forEach(call => {
                const card = document.createElement('div');
                card.className = `active-call-hero ${call.status === 'ringing' ? 'ringing' : ''}`;

                const titleRow = document.createElement('div');
                titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

                const cardTitle = document.createElement('div');
                cardTitle.className = 'text-xs font-bold text-muted';
                if (!call.answerTime) {
                    if (call.direction === 'incoming') {
                        cardTitle.textContent = (this.currentLang === 'ar' ? 'مكالمة واردة (الخط 2): ' : 'Incoming Call (Line 2): ') + call.target;
                        cardTitle.style.color = '#10b981';
                    } else {
                        cardTitle.textContent = (this.currentLang === 'ar' ? 'جاري الاتصال (الخط 2): ' : 'Calling (Line 2): ') + call.target;
                    }
                } else {
                    cardTitle.textContent = `[Line 2] Active Call: ${call.target}`;
                }
                titleRow.appendChild(cardTitle);

                const statusPill = document.createElement('div');
                statusPill.className = `status-pill ${call.status === 'active' ? 'online' : 'ringing'}`;
                statusPill.innerHTML = `<span style="font-size:7px;">●</span>${call.status}`;
                titleRow.appendChild(statusPill);
                card.appendChild(titleRow);

                // Contact Row
                const contactRow = document.createElement('div');
                contactRow.className = 'hero-contact-row';
                const avatarInfo = document.createElement('div');
                avatarInfo.className = 'hero-avatar-info';
                const contactMatch = this.findContactByNumber(call.target) || this.findContactByNumber(call.displayName);
                const avatar = document.createElement('div');
                avatar.className = 'hero-avatar font-mono font-bold';
                const avatarChar = contactMatch && contactMatch.name ? contactMatch.name.trim().charAt(0) : (call.target || 'L2').slice(-2);
                avatar.textContent = avatarChar.toUpperCase();
                const nameSpan = document.createElement('div');
                nameSpan.className = 'hero-name font-mono';
                nameSpan.style.fontWeight = '800';
                if (contactMatch) {
                    nameSpan.textContent = contactMatch.name;
                    const numDiv = document.createElement('div');
                    numDiv.className = 'text-xs text-muted font-mono';
                    numDiv.textContent = call.target || call.displayName;
                    avatarInfo.appendChild(avatar);
                    avatarInfo.appendChild(nameSpan);
                    avatarInfo.appendChild(numDiv);
                } else {
                    nameSpan.textContent = (call.target && !call.target.startsWith('Ext')) ? (call.target.length <= 4 ? `Ext ${call.target}` : call.target) : (call.target || 'Line 2 Call');
                    avatarInfo.appendChild(avatar);
                    avatarInfo.appendChild(nameSpan);
                }
                contactRow.appendChild(avatarInfo);

                const timerEl = document.createElement('div');
                timerEl.className = 'hero-timer font-mono';
                timerEl.id = `line2HeroTimer_${call.id}`;
                timerEl.textContent = call.answerTime ? this.formatDuration(Math.round((Date.now() - call.answerTime)/1000)) : (call.status === 'ringing' ? 'Ringing...' : 'Calling...');
                contactRow.appendChild(timerEl);
                card.appendChild(contactRow);
                card.appendChild(this.createHeroAudioDeck(call, 'line2'));

                // Actions Row
                const isIncomingRinging = (call.direction === 'incoming' && !call.answerTime);
                const actionsRow = document.createElement('div');
                actionsRow.className = isIncomingRinging ? 'hero-actions-row hero-actions-row--incoming' : 'hero-actions-row';
                if (isIncomingRinging) {
                    const answerBtn = document.createElement('button');
                    answerBtn.className = 'end-call-btn btn-answer call-action--answer';
                    answerBtn.innerHTML = `${SVG_ICONS.phone}<span>${this.currentLang === 'ar' ? 'رد' : 'Answer'}</span>`;
                    answerBtn.onclick = () => this.line2Core.answerCall(call.id);

                    const declineBtn = document.createElement('button');
                    declineBtn.className = 'end-call-btn btn-decline call-action--decline';
                    declineBtn.innerHTML = `${SVG_ICONS.phoneOff}<span>${this.currentLang === 'ar' ? 'رفض' : 'Decline'}</span>`;
                    declineBtn.onclick = () => this.line2Core.hangupCall(call.id);

                    actionsRow.appendChild(answerBtn);
                    actionsRow.appendChild(declineBtn);
                } else {
                    const endBtn = document.createElement('button');
                    endBtn.className = 'end-call-btn btn-hangup call-action--end';
                    endBtn.innerHTML = `${SVG_ICONS.phoneOff}<span>${this.currentLang === 'ar' ? 'إنهاء' : 'End Call'}</span>`;
                    const isOutboundRinging = (call.direction === 'outgoing' && !call.answerTime);
                    const blockCancel = isOutboundRinging && this.isOutboundRingingCancelBlocked();
                    if (blockCancel) {
                        endBtn.disabled = true;
                        endBtn.classList.add('policy-locked');
                        endBtn.title = this.currentLang === 'ar'
                            ? 'ممنوع إنهاء المكالمة أثناء الرنين بموجب سياسة الإدارة'
                            : 'Ending outbound calls while ringing is blocked by Administrator policy';
                    } else {
                        endBtn.onclick = () => this.line2Core.hangupCall(call.id);
                    }
                    const muteBtn = document.createElement('button');
                    muteBtn.className = `hero-pill-action ${call.isMuted ? 'active-mute' : ''}`;
                    muteBtn.innerHTML = `${call.isMuted ? SVG_ICONS.micOff : SVG_ICONS.mic}<span>${call.isMuted ? 'Unmute' : 'Mute'}</span>`;
                    muteBtn.onclick = () => {
                        this.line2Core.toggleMute(call.id);
                        this.renderLine2ActiveCalls();
                    };

                    const holdBtn = document.createElement('button');
                    holdBtn.className = `hero-pill-action ${call.isHeld ? 'active-hold' : ''}`;
                    holdBtn.innerHTML = `${call.isHeld ? SVG_ICONS.play : SVG_ICONS.pause}<span>${call.isHeld ? 'Unhold' : 'Hold'}</span>`;
                    holdBtn.onclick = () => {
                        this.line2Core.toggleHold(call.id);
                        this.renderLine2ActiveCalls();
                    };

                    const transferBtn = document.createElement('button');
                    transferBtn.className = 'hero-pill-action';
                    transferBtn.innerHTML = `${SVG_ICONS.transfer}<span>Transfer</span>`;
                    transferBtn.onclick = () => this.openTransferModal(call.id, 'line2');

                    actionsRow.appendChild(endBtn);
                    actionsRow.appendChild(muteBtn);
                    actionsRow.appendChild(holdBtn);
                    actionsRow.appendChild(transferBtn);
                }

                card.appendChild(actionsRow);
                container.appendChild(card);
            });
            this.updateLine2InCallButtonStates();
        }

        updateLine2InCallButtonStates() {
            if (!this.line2Core) return;
            const inCall = this.line2Core.activeCalls.size > 0;
            const calls = Array.from(this.line2Core.activeCalls.values());
            const currentCall = calls[0] || null;

            const callBtn = document.getElementById('line2CallBtn');
            if (callBtn) {
                callBtn.disabled = inCall || (this.line2Core.regState !== 'REGISTERED');
            }

            const muteBtn = document.getElementById('line2ToolBtnMute');
            const holdBtn = document.getElementById('line2ToolBtnHold');
            const xferBtn = document.getElementById('line2ToolBtnTransfer');

            if (muteBtn) {
                muteBtn.disabled = !inCall;
                muteBtn.classList.toggle('active-mute', Boolean(currentCall && currentCall.isMuted));
            }
            if (holdBtn) {
                holdBtn.disabled = !inCall;
                holdBtn.classList.toggle('active-hold', Boolean(currentCall && currentCall.isHeld));
            }
            if (xferBtn) {
                xferBtn.disabled = !inCall;
            }
        }

        renderLine2Contacts() {
            const section = document.getElementById('line2ContactsSection');
            if (!section) return;
            section.textContent = '';
            const contacts = this.getContacts();
            if (contacts.length === 0) {
                section.innerHTML = '<div class="text-center py-6 text-xs text-muted">No contacts found</div>';
                return;
            }
            contacts.forEach(c => {
                const card = document.createElement('div');
                card.className = 'recent-card';
                card.innerHTML = `
                    <div class="recent-left">
                        <div class="recent-avatar">${(c.name || 'C').charAt(0).toUpperCase()}</div>
                        <div class="recent-info">
                            <div class="recent-name" title="${c.name || c.number}">${c.name || c.number}</div>
                            <div class="contact-phone-number">${c.number}</div>
                        </div>
                    </div>
                    <div class="recent-right">
                        <button type="button" class="recent-call-btn btn-call" title="Call on Line 2">
                            ${SVG_ICONS.phone}
                        </button>
                    </div>
                `;
                card.querySelector('.btn-call').onclick = () => {
                    document.getElementById('line2DialInput').value = c.number;
                    const tabBtn = document.getElementById('tabBtnLine2Dialer');
                    if (tabBtn) tabBtn.click();
                    try { this.line2Core.makeCall(c.number); } catch (e) { this.showToast(`[Line 2] ${e.message}`, 'error'); }
                };
                section.appendChild(card);
            });
        }

        renderLine2History() {
            const listEl = document.getElementById('line2CallHistoryList');
            if (!listEl) return;
            listEl.textContent = '';
            const allLogs = this.getCallLogs();
            const logs = allLogs.filter(l => !l.line || l.line === 'line1');
            if (logs.length === 0) {
                listEl.innerHTML = '<div class="text-center py-6 text-xs text-muted">No recent calls on Line 2</div>';
                return;
            }
            logs.slice(0, 10).forEach(log => {
                const card = document.createElement('div');
                card.className = 'recent-card';
                card.innerHTML = `
                    <div class="recent-left">
                        <div class="recent-avatar">${(log.target || 'U').charAt(0).toUpperCase()}</div>
                        <div class="recent-info">
                            <div class="recent-name font-mono">${log.target}</div>
                            <div class="recent-dir incoming font-mono">${log.direction || 'call'}</div>
                        </div>
                    </div>
                    <div class="recent-right">
                        <button type="button" class="recent-call-btn btn-call" title="Call on Line 2">
                            ${SVG_ICONS.phone}
                        </button>
                    </div>
                `;
                card.querySelector('.btn-call').onclick = () => {
                    document.getElementById('line2DialInput').value = log.target;
                    const tabBtn = document.getElementById('tabBtnLine2Dialer');
                    if (tabBtn) tabBtn.click();
                    try { this.line2Core.makeCall(log.target); } catch (e) { this.showToast(`[Line 2] ${e.message}`, 'error'); }
                };
                listEl.appendChild(card);
            });
        }

        async fetchServerExtensions() {
            try {
                const prefix = window.location.pathname.startsWith('/phone') ? '/phone' : '';
                const res = await fetch(`${prefix}/api/extensions`);
                const data = await res.json();
                if (data && data.success) {
                    if (Array.isArray(data.extensions)) this.serverExtensionsList = data.extensions;
                    if (Array.isArray(data.webrtcExtensions) && data.webrtcExtensions.length > 0) {
                        this.serverWebrtcList = data.webrtcExtensions;
                    } else {
                        this.serverWebrtcList = this.serverExtensionsList;
                    }
                    if (data.host) this.serverHost = data.host;
                    if (data.defaultWss) this.serverDefaultWss = data.defaultWss;
                }
            } catch (err) {
                console.warn('Could not fetch server extensions:', err);
            }
        }

        getPresets() {
            try {
                return JSON.parse(localStorage.getItem(this.PRESETS_KEY) || '[]');
            } catch (_) {
                return [];
            }
        }

        savePresets(presets) {
            localStorage.setItem(this.PRESETS_KEY, JSON.stringify(presets));
        }

        async loadPresets() {
            await this.fetchServerExtensions();
            let presets = this.getPresets();

            const webrtcPool = (this.serverWebrtcList && this.serverWebrtcList.length > 0) ? this.serverWebrtcList : this.serverExtensionsList;
            const host = this.serverHost || window.location.hostname || '127.0.0.1';
            const defaultWss = this.serverDefaultWss || `wss://${host}:8089/ws`;

            if (Array.isArray(webrtcPool) && webrtcPool.length > 0) {
                const validExtensions = new Set(webrtcPool.map(e => String(e.extension)));

                presets = presets.filter(p => validExtensions.has(String(p.extension)));

                const seenExts = new Set();
                presets = presets.filter(p => {
                    const extStr = String(p.extension);
                    if (seenExts.has(extStr)) return false;
                    seenExts.add(extStr);
                    return true;
                });

                webrtcPool.forEach((ext, idx) => {
                    const extStr = String(ext.extension);
                    const cleanLabel = (ext.name && ext.name !== ext.extension) ? `${ext.extension} (${ext.name})` : `Ext ${ext.extension}`;
                    let existing = presets.find(p => String(p.extension) === extStr);

                    if (!existing) {
                        presets.push({
                            id: 'ext_' + ext.extension,
                            label: cleanLabel,
                            extension: extStr,
                            sipDomain: host,
                            wssUrl: defaultWss,
                            dnd: false,
                            autoAnswer: false,
                            isDefault: idx === 0 && !presets.some(p => p.isDefault)
                        });
                    } else {
                        existing.label = cleanLabel;
                        existing.sipDomain = host;
                        existing.wssUrl = defaultWss;
                    }
                });
            } else if (presets.length === 0) {
                presets = [{
                    id: 'ext_150',
                    label: 'Ext 150',
                    extension: '150',
                    sipDomain: host,
                    wssUrl: defaultWss,
                    dnd: false,
                    autoAnswer: false,
                    isDefault: true
                }];
            }

            if (this.dom.presetSelect) {
                this.dom.presetSelect.textContent = '';
                presets.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.label ? p.label : `Ext ${p.extension}`;
                    if (p.isDefault) opt.selected = true;
                    this.dom.presetSelect.appendChild(opt);
                });
                this.renderCustomExtDropdown(presets);
            }

            if (this.dom.loginExtSelect) {
                const currentVal = this.dom.loginExtSelect.value;
                this.dom.loginExtSelect.textContent = '';
                const defaultOpt = document.createElement('option');
                defaultOpt.value = '';
                defaultOpt.textContent = this.currentLang === 'ar' ? '-- اختر تحويلة WebRTC --' : '-- Select WebRTC Extension --';
                this.dom.loginExtSelect.appendChild(defaultOpt);

                const listToUse = (this.serverWebrtcList && this.serverWebrtcList.length > 0) ? this.serverWebrtcList : presets;
                listToUse.forEach(item => {
                    const extNum = item.extension;
                    const opt = document.createElement('option');
                    opt.value = extNum;
                    opt.textContent = (item.name && item.name !== extNum) ? `${extNum} - ${item.name} (${item.tech || 'pjsip'})` : `Ext ${extNum} (${item.tech || 'pjsip'})`;
                    if (currentVal && String(currentVal) === String(extNum)) {
                        opt.selected = true;
                    } else if (!currentVal && String(extNum) === '150') {
                        opt.selected = true;
                    }
                    this.dom.loginExtSelect.appendChild(opt);
                });
                this.onLoginExtensionSelected();
            }

            this.savePresets(presets);
            this.onPresetChanged();
        }

        selectPresetByExtension(ext) {
            if (!ext) return;
            const clean = String(ext).trim();
            const presets = this.getPresets();
            const found = presets.find(p => String(p.extension) === clean || String(p.id) === `ext_${clean}` || String(p.id) === clean);
            if (found && this.dom.presetSelect) {
                this.dom.presetSelect.value = found.id;
                this.onPresetChanged();
            } else if (this.dom.presetSelect) {
                const opt = Array.from(this.dom.presetSelect.options).find(o => o.value === `ext_${clean}` || o.value === clean || o.textContent.includes(clean));
                if (opt) {
                    this.dom.presetSelect.value = opt.value;
                    this.onPresetChanged();
                }
            }
        }

        getSelectedPreset() {
            if (!this.dom.presetSelect) return null;
            const id = this.dom.presetSelect.value;
            const presets = this.getPresets();
            return presets.find(p => p.id === id) || presets[0] || null;
        }

        onPresetChanged() {
            const preset = this.getSelectedPreset();
            if (!preset) return;

            this.syncCustomExtTrigger();

            if (this.dom.dndCheckbox) this.dom.dndCheckbox.checked = Boolean(preset.dnd);
            if (this.dom.autoAnswerCheckbox) this.dom.autoAnswerCheckbox.checked = Boolean(preset.autoAnswer);

            if (this.dom.toolBtnDnd) this.dom.toolBtnDnd.classList.toggle('active-dnd', Boolean(preset.dnd));
            if (this.dom.toolBtnAuto) this.dom.toolBtnAuto.classList.toggle('active-auto', Boolean(preset.autoAnswer));

            const secret = preset.secret || this.sessionSecrets.get(preset.id) || '';
            if (this.dom.passwordInput) this.dom.passwordInput.value = secret;

            // Query and enforce Central Administrator Policy for this extension
            if (preset.extension) {
                this.fetchAndApplyExtensionPolicy(preset.extension);
            }

            if (preset.autoConnect && secret && this.core.regState === 'DISCONNECTED') {
                setTimeout(() => {
                    if (this.core.regState === 'DISCONNECTED' && this.dom.connectBtn) {
                        this.dom.connectBtn.click();
                    }
                }, 100);
            }
        }

        renderCustomExtDropdown(presets = null) {
            this.syncCustomExtTrigger();
        }

        toggleCustomExtDropdown(e) {
            if (e) e.stopPropagation();
        }

        closeCustomExtDropdown() {
        }

        syncCustomExtTrigger() {
            const triggerLabel = document.getElementById('customExtTriggerLabel');
            if (!triggerLabel) return;
            const preset = (this.core && this.core.activePreset) || this.getSelectedPreset();
            if (preset) {
                triggerLabel.textContent = preset.label || `Ext ${preset.extension}`;
            }
        }

        async fetchAndApplyExtensionPolicy(extension) {
            const extNum = String(extension || '').trim().replace(/^ext_/, '');
            if (!extNum) return;

            try {
                const prefix = (window.location.pathname && window.location.pathname.startsWith('/phone')) ? '/phone' : '';
                const res = await fetch(`${prefix}/api/extension-policy/${extNum}`, { cache: 'no-store' });
                if (!res.ok) return;
                const data = await res.json();
                const policy = data.policy || { auto_answer: 'user_choice', dnd: 'user_choice', disable_outbound_ringing_cancel: 0 };
                this.extensionPolicies = this.extensionPolicies || new Map();
                this.extensionPolicies.set(extNum, policy);
                this.currentPolicy = policy;
                try {
                    localStorage.setItem('sokrat_policy_' + extNum, JSON.stringify(policy));
                } catch (_) {}
                this.applyPolicyToUi(policy);
            } catch (_) {}
        }

        applyPolicyToUi(policy) {
            if (!policy) return;
            const isAr = this.currentLang === 'ar';
            const preset = this.getSelectedPreset();

            // 1. Auto Answer policy enforcement
            const autoBox = this.dom.autoAnswerCheckbox;
            const autoBtn = this.dom.toolBtnAuto;
            if (policy.auto_answer === 'force_on') {
                this.core.isAutoAnswer = true;
                if (autoBox) {
                    autoBox.checked = true;
                    autoBox.disabled = true;
                }
                if (autoBtn) {
                    autoBtn.classList.add('active-auto', 'policy-locked');
                    autoBtn.classList.remove('policy-disabled');
                    autoBtn.title = isAr ? 'الرد التلقائي مقفل ومفعل إجبارياً بواسطة الإدارة' : 'Auto Answer is permanently locked ON by Administrator';
                }
                if (preset) {
                    preset.autoAnswer = true;
                    this.updatePresetInStorage(preset);
                }
            } else if (policy.auto_answer === 'force_off') {
                this.core.isAutoAnswer = false;
                if (autoBox) {
                    autoBox.checked = false;
                    autoBox.disabled = true;
                }
                if (autoBtn) {
                    autoBtn.classList.remove('active-auto');
                    autoBtn.classList.add('policy-locked', 'policy-disabled');
                    autoBtn.title = isAr ? 'الرد التلقائي معطل وممنوع بواسطة الإدارة' : 'Auto Answer is prohibited by Administrator';
                }
                if (preset) {
                    preset.autoAnswer = false;
                    this.updatePresetInStorage(preset);
                }
            } else {
                if (autoBox) autoBox.disabled = false;
                if (autoBtn) {
                    autoBtn.classList.remove('policy-locked', 'policy-disabled');
                    autoBtn.title = isAr ? 'الرد التلقائي' : 'Auto Answer';
                }
            }

            // 2. DND policy enforcement
            const dndBox = this.dom.dndCheckbox;
            const dndBtn = this.dom.toolBtnDnd;
            if (policy.dnd === 'force_on') {
                this.core.isDnd = true;
                if (dndBox) {
                    dndBox.checked = true;
                    dndBox.disabled = true;
                }
                if (dndBtn) {
                    dndBtn.classList.add('active-dnd', 'policy-locked');
                    dndBtn.classList.remove('policy-disabled');
                    dndBtn.title = isAr ? 'عدم الإزعاج مفعل ومقفل إجبارياً بواسطة الإدارة' : 'DND is permanently locked ON by Administrator';
                }
                if (preset) {
                    preset.dnd = true;
                    this.updatePresetInStorage(preset);
                }
            } else if (policy.dnd === 'force_off') {
                this.core.isDnd = false;
                if (dndBox) {
                    dndBox.checked = false;
                    dndBox.disabled = true;
                }
                if (dndBtn) {
                    dndBtn.classList.remove('active-dnd');
                    dndBtn.classList.add('policy-locked', 'policy-disabled');
                    dndBtn.title = isAr ? 'عدم الإزعاج معطل وممنوع بواسطة الإدارة' : 'DND is prohibited by Administrator';
                }
                if (preset) {
                    preset.dnd = false;
                    this.updatePresetInStorage(preset);
                }
            } else {
                if (dndBox) dndBox.disabled = false;
                if (dndBtn) {
                    dndBtn.classList.remove('policy-locked', 'policy-disabled');
                    dndBtn.title = isAr ? 'عدم الإزعاج' : 'Do Not Disturb';
                }
            }

            // 3. Outbound ringing cancel policy enforcement
            const blockCancel = Boolean(policy.disable_outbound_ringing_cancel === 1 || policy.disable_outbound_ringing_cancel === '1' || policy.disable_outbound_ringing_cancel === true);
            this.core.disableOutboundRingingCancel = blockCancel;
            if (this.line2Core) this.line2Core.disableOutboundRingingCancel = blockCancel;
            this.currentPolicy = policy;
        }

        isOutboundRingingCancelBlocked(call) {
            const preset = (this.core && this.core.activePreset) || this.getSelectedPreset();
            const ext = preset ? String(preset.extension).replace(/^ext_/, '') : '150';
            let policy = (ext && this.extensionPolicies && this.extensionPolicies.get(ext)) || this.currentPolicy;
            if (!policy && typeof localStorage !== 'undefined') {
                try {
                    const cached = localStorage.getItem('sokrat_policy_' + ext);
                    if (cached) policy = JSON.parse(cached);
                } catch (_) {}
            }
            const isPolicyEnabled = Boolean(policy && (
                policy.disable_outbound_ringing_cancel === 1 ||
                policy.disable_outbound_ringing_cancel === '1' ||
                policy.disable_outbound_ringing_cancel === true
            ));
            if (!isPolicyEnabled) return false;

            const targetCall = call || (this.core ? Array.from(this.core.activeCalls.values())[0] : null);
            if (!targetCall) return true;

            return Boolean(targetCall.direction === 'outgoing' && !targetCall.answerTime);
        }
        updatePresetInStorage(preset) {
            if (!preset || !preset.id) return;
            let presets = this.getPresets();
            const idx = presets.findIndex(p => p.id === preset.id);
            if (idx >= 0) {
                presets[idx] = { ...presets[idx], ...preset };
                this.savePresets(presets);
            }
        }

        toggleAutoAnswerButton() {
            const preset = this.getSelectedPreset();
            const extNum = preset ? String(preset.extension) : '';
            const policy = (this.extensionPolicies && extNum) ? this.extensionPolicies.get(extNum) : null;
            if (policy && policy.auto_answer !== 'user_choice') {
                const isAr = this.currentLang === 'ar';
                const msg = policy.auto_answer === 'force_on'
                    ? (isAr ? 'الرد التلقائي مقفل ومفعل إجبارياً بواسطة الإدارة' : 'Auto Answer is permanently locked ON by Administrator')
                    : (isAr ? 'الرد التلقائي معطل وممنوع بواسطة الإدارة' : 'Auto Answer is prohibited by Administrator');
                this.showToast(msg, 'warning');
                return;
            }
            if (this.dom.autoAnswerCheckbox) {
                this.dom.autoAnswerCheckbox.checked = !this.dom.autoAnswerCheckbox.checked;
                this.dom.autoAnswerCheckbox.dispatchEvent(new Event('change'));
            }
        }

        toggleDndButton() {
            const preset = this.getSelectedPreset();
            const extNum = preset ? String(preset.extension) : '';
            const policy = (this.extensionPolicies && extNum) ? this.extensionPolicies.get(extNum) : null;
            if (policy && policy.dnd !== 'user_choice') {
                const isAr = this.currentLang === 'ar';
                const msg = policy.dnd === 'force_on'
                    ? (isAr ? 'عدم الإزعاج مفعل ومقفل إجبارياً بواسطة الإدارة' : 'DND is permanently locked ON by Administrator')
                    : (isAr ? 'عدم الإزعاج معطل وممنوع بواسطة الإدارة' : 'DND is prohibited by Administrator');
                this.showToast(msg, 'warning');
                return;
            }
            if (this.dom.dndCheckbox) {
                this.dom.dndCheckbox.checked = !this.dom.dndCheckbox.checked;
                this.dom.dndCheckbox.dispatchEvent(new Event('change'));
            }
        }
        onModalExtensionSelected() {
            const select = document.getElementById('presetExtSelect');
            if (!select || !select.value) return;
            const selectedOpt = select.options[select.selectedIndex];
            const extNum = select.value;
            const extName = selectedOpt && selectedOpt.dataset ? selectedOpt.dataset.name : extNum;
            const cleanLabel = (extName && extName !== extNum) ? `${extNum} (${extName})` : `Ext ${extNum}`;

            document.getElementById('presetExtInput').value = extNum;
            document.getElementById('presetLabelInput').value = cleanLabel;
            document.getElementById('presetDomainInput').value = this.serverHost || window.location.hostname || '127.0.0.1';
            document.getElementById('presetWssInput').value = this.serverDefaultWss || `wss://${window.location.hostname || '127.0.0.1'}:8089/ws`;
        }

        
        switchModalTab(tabName) {
            const btnSaved = document.getElementById('modalTabBtnSaved');
            const btnAdd = document.getElementById('modalTabBtnAdd');
            const contentSaved = document.getElementById('modalTabContentSaved');
            const contentAdd = document.getElementById('modalTabContentAdd');

            if (btnSaved) btnSaved.classList.toggle('active', tabName === 'saved');
            if (btnAdd) btnAdd.classList.toggle('active', tabName === 'add');
            if (contentSaved) contentSaved.style.display = (tabName === 'saved') ? 'block' : 'none';
            if (contentAdd) contentAdd.style.display = (tabName === 'add') ? 'block' : 'none';
            const titleEl = document.getElementById('modalPresetTitle');
            if (titleEl) {
                titleEl.textContent = (tabName === 'saved') ? (this.currentLang === 'ar' ? 'إدارة الحسابات المحفوظة' : 'Manage Accounts') : (this.currentLang === 'ar' ? 'إضافة حساب جديد' : 'Add New Account');
            }

            if (tabName === 'saved') {
                this.renderModalSavedAccounts();
            }
        }

        renderModalSavedAccounts() {
            const listEl = document.getElementById('modalSavedAccountsList');
            if (!listEl) return;
            listEl.innerHTML = '';

            const presets = this.getPresets();
            if (presets.length === 0) {
                listEl.innerHTML = `
                    <div class="text-center py-6 text-xs text-muted">
                        ${this.currentLang === 'ar' ? 'لا توجد حسابات محفوظة بعد. اضغط على "+ إضافة حساب جديد" لحفظ تحويلة.' : 'No saved accounts yet. Click "+ Add Account" to save an extension for 1-click login.'}
                    </div>`;
                return;
            }

            presets.forEach(p => {
                const card = document.createElement('div');
                card.className = 'saved-login-card';

                const topRow = document.createElement('div');
                topRow.className = 'saved-login-top';

                const left = document.createElement('div');
                left.className = 'saved-login-left';

                const avatar = document.createElement('div');
                avatar.className = 'saved-login-avatar font-mono';
                avatar.textContent = String(p.extension || 'E').slice(-2);

                const info = document.createElement('div');
                info.className = 'saved-login-info';

                const name = document.createElement('div');
                name.className = 'saved-login-name';
                name.textContent = p.label || ('Ext ' + p.extension);

                const extSpan = document.createElement('div');
                extSpan.className = 'saved-login-ext font-mono';
                extSpan.textContent = `Ext ${p.extension} • ${p.sipDomain || this.serverHost || 'PBX'}`;

                info.appendChild(name);
                info.appendChild(extSpan);
                left.appendChild(avatar);
                left.appendChild(info);

                const actions = document.createElement('div');
                actions.className = 'saved-login-actions';

                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'recent-call-btn btn-edit';
                editBtn.title = 'Edit Account';
                editBtn.innerHTML = SVG_ICONS.edit;
                editBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.openPresetModal(p);
                    this.switchModalTab('add');
                };

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'recent-call-btn btn-del';
                delBtn.title = 'Delete Account';
                delBtn.innerHTML = SVG_ICONS.trash;
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    const updated = this.getPresets().filter(pr => pr.id !== p.id);
                    this.savePresets(updated);
                    this.sessionSecrets.delete(p.id);
                    this.renderModalSavedAccounts();
                    this.showToast(this.currentLang === 'ar' ? 'تم حذف الحساب المحفوظ' : 'Account removed', 'info');
                };

                actions.appendChild(editBtn);
                actions.appendChild(delBtn);
                topRow.appendChild(left);
                topRow.appendChild(actions);

                // Bottom 1-Click Quick Connect Button
                const quickBtn = document.createElement('button');
                quickBtn.type = 'button';
                quickBtn.className = 'saved-quick-btn';
                quickBtn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    <span>${this.currentLang === 'ar' ? 'تسجيل الدخول والاتصال بالتحويلة ↗' : `1-Click Connect to Ext ${p.extension} ↗`}</span>`;

                quickBtn.onclick = async () => {
                    this.closePresetModal();
                    // Select in topbar
                    if (this.dom.presetSelect) {
                        this.dom.presetSelect.value = p.id;
                    }
                    const secret = p.secret || this.sessionSecrets.get(p.id) || '';
                    if (this.dom.passwordInput) {
                        this.dom.passwordInput.value = secret;
                    }
                    if (secret) {
                        this.showToast(`Connecting to Ext ${p.extension}...`, 'info');
                        try {
                            await this.core.connect(p, secret);
                        } catch (err) {
                            this.showToast(err.message, 'error');
                        }
                    } else {
                        this.showToast(`Enter password for Ext ${p.extension}`, 'warning');
                    }
                };

                card.appendChild(topRow);
                card.appendChild(quickBtn);
                listEl.appendChild(card);
            });
        }


        async openPresetModal(presetToEdit = null) {
            const isEdit = Boolean(presetToEdit);
            const modal = this.dom.presetModal || document.getElementById('presetModal');
            this.switchModalTab(isEdit ? 'add' : 'saved');

            const titleEl = document.getElementById('modalPresetTitle');
            if (titleEl) titleEl.textContent = isEdit ? (this.t.editPreset || 'Edit Account') : (this.t.addPreset || 'Add New Account');

            const idInput = document.getElementById('presetIdInput');
            if (idInput) idInput.value = isEdit ? (presetToEdit.id || '') : '';

            const labelInput = document.getElementById('presetLabelInput');
            if (labelInput) labelInput.value = isEdit ? (presetToEdit.label || '') : '';

            const extInput = document.getElementById('presetExtInput');
            if (extInput) extInput.value = isEdit ? (presetToEdit.extension || '') : '';

            const domainInput = document.getElementById('presetDomainInput');
            if (domainInput) domainInput.value = isEdit ? (presetToEdit.sipDomain || this.serverHost) : this.serverHost;

            const wssInput = document.getElementById('presetWssInput');
            if (wssInput) wssInput.value = isEdit ? (presetToEdit.wssUrl || this.serverDefaultWss) : this.serverDefaultWss;

            const defaultCb = document.getElementById('presetDefaultCheckbox');
            if (defaultCb) defaultCb.checked = isEdit ? Boolean(presetToEdit.isDefault) : false;

            const secretVal = isEdit ? (presetToEdit.secret || this.sessionSecrets.get(presetToEdit.id) || '') : '';
            const secretInput = document.getElementById('presetSecretInput');
            if (secretInput) secretInput.value = secretVal;

            const autoConnectCb = document.getElementById('presetAutoConnectCheckbox');
            if (autoConnectCb) autoConnectCb.checked = isEdit ? Boolean(presetToEdit.autoConnect) : true;

            const populateExtDropdown = () => {
                const webrtcPool = (this.serverWebrtcList && this.serverWebrtcList.length > 0) ? this.serverWebrtcList : this.serverExtensionsList;
                const extSelect = document.getElementById('presetExtSelect');
                if (extSelect) {
                    extSelect.textContent = '';
                    const promptOpt = document.createElement('option');
                    promptOpt.value = '';
                    promptOpt.textContent = this.currentLang === 'ar' ? '-- اختر التحويلة --' : '-- Select WebRTC Ext --';
                    extSelect.appendChild(promptOpt);

                    (webrtcPool || []).forEach(ext => {
                        const opt = document.createElement('option');
                        opt.value = ext.extension;
                        opt.textContent = `${ext.extension} - ${ext.name || ext.extension} (${ext.tech || 'pjsip'})`;
                        opt.dataset.name = ext.name || ext.extension;
                        if (presetToEdit && String(presetToEdit.extension) === String(ext.extension)) opt.selected = true;
                        extSelect.appendChild(opt);
                    });
                }
            };

            populateExtDropdown();

            if (modal) {
                modal.classList.remove('hidden');
            }

            this.fetchServerExtensions().then(() => populateExtDropdown()).catch(() => {});
        }

        closePresetModal() {
            const modal = this.dom.presetModal || document.getElementById('presetModal');
            if (modal) {
                modal.classList.add('hidden');
            }
        }

        savePresetFromModal() {
            const idInput = document.getElementById('presetIdInput');
            const id = (idInput && idInput.value) ? idInput.value : ('preset_' + Date.now());
            const label = document.getElementById('presetLabelInput') ? document.getElementById('presetLabelInput').value.trim() : 'Office Ext';
            const extension = document.getElementById('presetExtInput') ? document.getElementById('presetExtInput').value.trim() : '';
            const sipDomain = document.getElementById('presetDomainInput') ? document.getElementById('presetDomainInput').value.trim() : '';
            const wssUrl = document.getElementById('presetWssInput') ? document.getElementById('presetWssInput').value.trim() : '';
            const isDefault = document.getElementById('presetDefaultCheckbox') ? document.getElementById('presetDefaultCheckbox').checked : false;
            const secret = document.getElementById('presetSecretInput') ? document.getElementById('presetSecretInput').value.trim() : '';
            const autoConnect = document.getElementById('presetAutoConnectCheckbox') ? document.getElementById('presetAutoConnectCheckbox').checked : true;

            if (!extension || !sipDomain || !wssUrl) {
                this.showToast('Extension, SIP Domain and WSS URL are required', 'error');
                return;
            }

            let presets = this.getPresets();
            if (isDefault) {
                presets.forEach(p => p.isDefault = false);
            }

            const existingIdx = presets.findIndex(p => p.id === id);
            const presetObj = {
                id,
                label: label || ('Ext ' + extension),
                extension,
                sipDomain,
                wssUrl,
                dnd: (existingIdx >= 0 && presets[existingIdx].dnd !== undefined) ? presets[existingIdx].dnd : false,
                autoAnswer: (existingIdx >= 0 && presets[existingIdx].autoAnswer !== undefined) ? presets[existingIdx].autoAnswer : false,
                secret: autoConnect ? secret : '',
                autoConnect,
                isDefault
            };

            if (secret) {
                this.sessionSecrets.set(id, secret);
            }

            if (existingIdx >= 0) {
                presets[existingIdx] = Object.assign(presets[existingIdx], presetObj);
            } else {
                presets.push(presetObj);
            }

            this.savePresets(presets);
            this.switchModalTab('saved');
            this.renderModalSavedAccounts();
            this.showToast('Account saved successfully', 'success');
            this.loadPresets();
            this.renderSavedAccountsLoginList();
            if (this.dom.presetSelect) this.dom.presetSelect.value = id;
            if (this.onPresetChanged) this.onPresetChanged();
            this.showToast('Account saved', 'success');
        }

        deleteCurrentPreset() {
            const modalIdInput = document.getElementById('presetIdInput');
            const presetId = modalIdInput ? modalIdInput.value : '';
            let targetId = presetId;
            if (!targetId) {
                const preset = this.getSelectedPreset();
                if (preset) targetId = preset.id;
            }
            if (!targetId) return;

            let presets = this.getPresets().filter(p => p.id !== targetId);
            this.savePresets(presets);
            this.sessionSecrets.delete(targetId);
            this.switchModalTab('saved');
            this.renderModalSavedAccounts();
            this.showToast('Account saved successfully', 'success');
            this.loadPresets();
            this.renderSavedAccountsLoginList();
            this.showToast('Account deleted', 'info');
        }
        bindCoreEvents() {
            this.core.on('regStateChange', ({ state }) => {
                this.updateStatusUi(state);
                if (state === 'REGISTERED') {
                    this.startActiveDialerLeadPoller();
                } else {
                    this.stopActiveDialerLeadPoller();
                }
                if (window.parent && window.parent !== window) {
                    window.parent.postMessage({
                        version: 1,
                        type: 'sokrat.voice.registration',
                        payload: {
                            state: state === 'REGISTERED' ? 'REGISTERED' : 'DISCONNECTED',
                            extension: this.core.activePreset ? this.core.activePreset.extension : ''
                        }
                    }, '*');
                }
            });
            this.core.on('registered', () => {
                this.updateViewMode('console');
                this.syncCustomExtTrigger();
                this.startActiveDialerLeadPoller();
                if (window.parent && window.parent !== window) {
                    window.parent.postMessage({
                        version: 1,
                        type: 'sokrat.voice.registration',
                        payload: {
                            state: 'REGISTERED',
                            extension: this.core.activePreset ? this.core.activePreset.extension : ''
                        }
                    }, '*');
                }
            });
            this.core.on('unregistered', () => {
                this.stopActiveDialerLeadPoller();
                if (this.core.activePreset) {
                    this.updateStatusUi('DISCONNECTED');
                }
            });
            this.core.on('authFailed', () => {
                this.stopActiveDialerLeadPoller();
                if (!window.SOFTPHONE_EMBED_CONFIG?.isEmbedded) {
                    this.updateViewMode('login');
                }
                this.showToast(this.t.toastAuthFailed, 'error');
            });
            this.core.on('speakerLevel', (level) => {
                if (this.dom.speakerVuMeterBar) this.dom.speakerVuMeterBar.style.width = level + '%';
            });
            this.core.on('vuLevel', (level) => {
                if (this.dom.vuMeterBar) this.dom.vuMeterBar.style.width = `${level}%`;
            });
            this.core.on('incomingCall', (callEntry) => {
                this.pollActiveDialerLead(true);
                this.renderActiveCalls();
                this.updateInCallButtonStates();
                this.showIncomingNotification(callEntry);
                const msg = {
                    version: 1,
                    type: 'sokrat.voice.incoming',
                    payload: {
                        phone: callEntry?.target || 'Unknown',
                        callerName: callEntry?.displayName || callEntry?.callerName || '',
                        callId: callEntry?.id,
                        direction: 'incoming',
                        extension: this.core.currentExtension || '',
                        timestamp: new Date().toISOString()
                    }
                };
                if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
                window.postMessage(msg, '*');
            });
            this.core.on('callProgress', (callEntry) => {
                this.pollActiveDialerLead(true);
                this.renderActiveCalls();
                this.updateInCallButtonStates();
                const msg = {
                    version: 1,
                    type: 'sokrat.voice.call_state',
                    payload: {
                        state: 'ringing',
                        phone: callEntry?.target || '',
                        callerName: callEntry?.displayName || callEntry?.callerName || '',
                        callId: callEntry?.id,
                        direction: callEntry?.direction || 'outgoing',
                        extension: this.core.currentExtension || '',
                        timestamp: new Date().toISOString()
                    }
                };
                if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
                window.postMessage(msg, '*');
            });
            this.core.on('callAnswered', (callEntry) => {
                this.pollActiveDialerLead(true);
                this.renderActiveCalls();
                this.updateInCallButtonStates();
                this.dismissNotification();
                const startTimeMs = (callEntry?.answerTime instanceof Date) ? callEntry.answerTime.getTime() : Date.now();
                const msg = {
                    version: 1,
                    type: 'sokrat.voice.call_state',
                    payload: {
                        state: 'in_call',
                        phone: callEntry?.target || '',
                        callerName: callEntry?.displayName || callEntry?.callerName || '',
                        callId: callEntry?.id,
                        direction: callEntry?.direction || 'outgoing',
                        extension: this.core.currentExtension || '',
                        startTime: startTimeMs,
                        timestamp: new Date().toISOString()
                    }
                };
                if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
                window.postMessage(msg, '*');
            });
            this.core.on('callUpdated', () => {
                this.renderActiveCalls();
                this.updateInCallButtonStates();
            });
            this.core.on('callEnded', (data) => {
                this.renderActiveCalls();
                this.updateInCallButtonStates();
                this.dismissNotification();
                this.currentCallQuality = null;
                this.attendedTransferState = null;
                const msg = {
                    version: 1,
                    type: 'sokrat.voice.call_state',
                    payload: {
                        state: 'ended',
                        callId: data?.callId,
                        phone: data?.target || '',
                        durationSec: data?.durationSec || 0,
                        outcome: data?.outcome || 'unknown',
                        extension: this.core.currentExtension || '',
                        timestamp: new Date().toISOString()
                    }
                };
                if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
                window.postMessage(msg, '*');
            });
            this.core.on('callLog', (logEntry) => this.addCallLog({ ...logEntry, line: 'line1' }));
            this.core.on('toast', ({ type, message }) => this.showToast(message, type));
            this.core.on('speakerMuteChanged', ({ isMuted }) => {
                if (this.dom.toolBtnSpeakerMute) {
                    this.dom.toolBtnSpeakerMute.classList.toggle('active-speaker-mute', isMuted);
                }
                this.showToast(isMuted ? 'Incoming audio muted' : 'Incoming audio unmuted', isMuted ? 'warning' : 'info');
            });
            this.core.on('ownerChange', ({ isOwner }) => {
                if (this.dom.takeOverOverlay) {
                    if (isOwner) {
                        this.dom.takeOverOverlay.classList.add('hidden');
                    } else {
                        this.dom.takeOverOverlay.classList.remove('hidden');
                    }
                }
            });
            this.core.on('micGranted', () => {
                if (this.dom.micBanner) this.dom.micBanner.style.display = 'none';
            });
            this.core.on('micError', ({ error }) => {
                if (this.dom.micBanner) this.dom.micBanner.style.display = 'flex';
                this.showToast('Microphone: ' + error, 'error');
            });
            this.core.on('callQuality', (data) => {
                this.currentCallQuality = data;
                this.renderCallQualityBadge();
            });
            this.core.on('recordingStatus', (data) => {
                this.renderRecordingIndicator(data);
            });
        }

        // --- STATUS UI & CONNECT BUTTON ---
        updateStatusUi(state) {
            if (!this.dom.statusBadge || !this.dom.statusText || !this.dom.connectBtn) return;
            this.dom.statusBadge.className = 'status-pill';
            switch (state) {
                case 'REGISTERED':
                    this.dom.statusBadge.classList.add('online');
                    this.dom.statusText.textContent = this.t.statusOnline;
                    this.dom.connectBtn.textContent = this.currentLang === 'ar' ? 'خروج' : 'Sign Out';
                    this.dom.connectBtn.className = 'compact-connect-btn btn-danger';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = (this.core.activeCalls.size > 0);
                    break;
                case 'CONNECTING':
                    this.dom.statusBadge.classList.add('ringing');
                    this.dom.statusText.textContent = this.t.statusConnecting;
                    this.dom.connectBtn.textContent = this.t.cancel || 'Cancel';
                    this.dom.connectBtn.className = 'btn btn-danger';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = (this.core.activeCalls.size > 0);
                    break;
                case 'RETRY_WAIT':
                    this.dom.statusBadge.classList.add('ringing');
                    this.dom.connectBtn.textContent = this.t.cancel || 'Cancel';
                    this.dom.connectBtn.className = 'btn btn-danger';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = (this.core.activeCalls.size > 0);
                    break;
                case 'AUTH_FAILED':
                    this.dom.statusBadge.classList.add('incall');
                    this.dom.statusText.textContent = this.t.statusAuthFailed;
                    this.dom.connectBtn.textContent = this.t.connect;
                    this.dom.connectBtn.className = 'btn btn-primary';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = (this.core.activeCalls.size > 0);
                    break;
                case 'DISCONNECTED':
                default:
                    this.dom.statusText.textContent = this.t.statusOffline;
                    this.dom.connectBtn.textContent = this.t.connect;
                    this.dom.connectBtn.className = 'btn btn-primary';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = (this.core.activeCalls.size > 0);
                    break;
            }
        }

        // --- ACTIVE DIALER LEAD POLLING ---
        startActiveDialerLeadPoller() {
            this.stopActiveDialerLeadPoller();
            if (this.core.regState !== 'REGISTERED' || !this.core.activePreset?.extension) return;

            this.pollActiveDialerLead();
            this.activeDialerLeadPollTimer = setInterval(() => this.pollActiveDialerLead(), 2500);
        }

        stopActiveDialerLeadPoller() {
            if (this.activeDialerLeadPollTimer) {
                clearInterval(this.activeDialerLeadPollTimer);
                this.activeDialerLeadPollTimer = null;
            }
            if (this.activeDialerLeadPollController) {
                this.activeDialerLeadPollController.abort();
                this.activeDialerLeadPollController = null;
            }
            if (this.activeDialerLead) {
                this.activeDialerLead = null;
                this.renderActiveCalls();
            }
        }

        async pollActiveDialerLead(force = false) {
            if (this.core.regState !== 'REGISTERED' || !this.core.activePreset?.extension) return;
            if (this.activeDialerLeadPollController) {
                if (!force) return;
                try { this.activeDialerLeadPollController.abort(); } catch (_) {}
                this.activeDialerLeadPollController = null;
            }

            const prefix = window.location.pathname.startsWith('/phone') ? '/phone/' : '/';
            const extension = String(this.core.activePreset.extension).trim();
            this.fetchAndApplyExtensionPolicy(extension);
            const controller = new AbortController();
            this.activeDialerLeadPollController = controller;
            try {
                const response = await fetch(`${prefix}api/dialer/active-lead?extension=${encodeURIComponent(extension)}`, {
                    cache: 'no-store',
                    signal: controller.signal
                });
                if (!response.ok) throw new Error(`Active lead request failed (${response.status})`);
                const payload = await response.json();
                if (controller.signal.aborted) return;
                const nextLead = payload && payload.success !== false && payload.lead ? payload.lead : null;
                const previous = JSON.stringify(this.activeDialerLead);
                const next = JSON.stringify(nextLead);
                if (previous !== next) {
                    this.activeDialerLead = nextLead;
                    this.renderActiveCalls();
                }
            } catch (err) {
                if (err?.name !== 'AbortError') console.warn('[ActiveDialerLeadPoller] poll error:', err?.message);
            } finally {
                if (this.activeDialerLeadPollController === controller) this.activeDialerLeadPollController = null;
            }
        }

        // In-Call Button State Management (Clickable only while in a call)
        updateInCallButtonStates() {
            const inCall = this.core.activeCalls.size > 0;
            const calls = Array.from(this.core.activeCalls.values());
            const currentCall = calls[0] || null;

            if (this.dom.callBtn) {
                this.dom.callBtn.disabled = inCall || (this.core.regState !== 'REGISTERED');
            }

            const line2CallBtn = document.getElementById('line2CallBtn');
            if (line2CallBtn && this.line2Core) {
                const line2InCall = this.line2Core.activeCalls.size > 0;
                line2CallBtn.disabled = line2InCall || (this.line2Core.regState !== 'REGISTERED');
            }

            if (this.dom.toolBtnMute) {
                this.dom.toolBtnMute.disabled = !inCall;
                this.dom.toolBtnMute.classList.toggle('active-mute', Boolean(currentCall && currentCall.isMuted));
            }
            if (this.dom.toolBtnHold) {
                this.dom.toolBtnHold.disabled = !inCall;
                this.dom.toolBtnHold.classList.toggle('active-hold', Boolean(currentCall && currentCall.isHeld));
            }
            if (this.dom.toolBtnTransfer) {
                this.dom.toolBtnTransfer.disabled = !inCall;
            }
        }

        formatDuration(sec) {
            const s = Math.max(0, Math.floor(sec || 0));
            const m = String(Math.floor(s / 60)).padStart(2, '0');
            const remSec = String(s % 60).padStart(2, '0');
            return `${m}:${remSec}`;
        }

        // --- LIVE CALL TIMER TICKER ---
        startCallTimerTicker() {
            if (this.callTimerInterval) clearInterval(this.callTimerInterval);
            this.callTimerInterval = setInterval(() => {
                let firstFormatted = null;
                let firstSec = null;
                document.querySelectorAll('[data-timer-start]').forEach(el => {
                    const start = parseInt(el.dataset.timerStart, 10);
                    if (start > 0) {
                        const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
                        const formatted = this.formatDuration(sec);
                        el.textContent = formatted;
                        if (firstFormatted === null) {
                            firstFormatted = formatted;
                            firstSec = sec;
                        }
                    }
                });

                if (firstFormatted !== null) {
                    const syncMsg = {
                        version: 1,
                        type: 'sokrat.voice.timer_sync',
                        payload: {
                            seconds: firstSec,
                            formatted: firstFormatted
                        }
                    };
                    if (window.parent && window.parent !== window) window.parent.postMessage(syncMsg, '*');
                    window.postMessage(syncMsg, '*');
                }
            }, 1000);
        }

        // --- ACTIVE CALL HERO CARD RENDERING ---
        
        updateInCallWindowState() {
            const totalCalls = (this.core ? this.core.activeCalls.size : 0) + (this.line2Core ? this.line2Core.activeCalls.size : 0);
            const appWindow = document.querySelector('.app-window');
            if (appWindow) {
                appWindow.classList.toggle('is-in-call', totalCalls > 0);
            }

            if (window.name === 'sokratSoftphonePopout' && typeof window.resizeTo === 'function') {
                try {
                    const isSplit = Boolean(this.isSplitView || (appWindow && appWindow.classList.contains('is-split-view')));
                    const targetW = isSplit ? 900 : 460;
                    const targetH = totalCalls > 0 ? 840 : 720;
                    window.resizeTo(targetW, targetH);
                } catch (_) {}
            }
        }

        renderActiveDialerLead(card) {
            if (!card || !this.activeDialerLead) return;
            const existing = card.querySelector('[data-active-dialer-lead]');
            if (existing) existing.remove();

            const lead = this.activeDialerLead;
            const customData = (lead.custom_data && typeof lead.custom_data === 'object' && !Array.isArray(lead.custom_data))
                ? lead.custom_data
                : {};

            const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
            if (fullName) {
                const heroNameEl = card.querySelector('.hero-name');
                if (heroNameEl && (!heroNameEl.textContent || heroNameEl.textContent === lead.phone_number || heroNameEl.textContent === 'Incoming Call' || heroNameEl.textContent === 'مكالمة واردة')) {
                    heroNameEl.textContent = fullName;
                }
                const heroAvatarEl = card.querySelector('.hero-avatar');
                if (heroAvatarEl && fullName.charAt(0)) {
                    heroAvatarEl.textContent = fullName.charAt(0).toUpperCase();
                }
            }

            const fieldsToDisplay = [];
            if (lead.company && String(lead.company).trim()) {
                fieldsToDisplay.push({
                    key: 'company',
                    label: this.currentLang === 'ar' ? 'الشركة' : 'Company',
                    value: String(lead.company).trim()
                });
            }

            const configuredFields = Array.isArray(lead.lead_fields) ? lead.lead_fields : [];
            configuredFields.forEach(field => {
                const key = String(field?.key || '').trim();
                const label = String(field?.label || field?.key || '').trim();
                if (!key || !label) return;
                const rawVal = customData[key];
                if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== '') {
                    fieldsToDisplay.push({
                        key,
                        label,
                        value: String(rawVal).trim()
                    });
                }
            });

            if (fieldsToDisplay.length === 0) return;

            const panel = document.createElement('div');
            panel.dataset.activeDialerLead = 'true';
            panel.className = 'hero-lead-details';

            const grid = document.createElement('div');
            grid.className = 'hero-lead-fields-grid';
            fieldsToDisplay.forEach(f => {
                const fDiv = document.createElement('div');
                fDiv.className = 'hero-lead-field';

                const fLabel = document.createElement('span');
                fLabel.className = 'hero-lead-field-label';
                fLabel.textContent = f.label;

                const fVal = document.createElement('span');
                fVal.className = 'hero-lead-field-value';
                fVal.textContent = f.value;

                fDiv.appendChild(fLabel);
                fDiv.appendChild(fVal);
                grid.appendChild(fDiv);
            });
            panel.appendChild(grid);
            const actionsDeck = card.querySelector('.hero-actions-deck') || card.querySelector('.hero-hangup-row') || card.querySelector('.hero-actions-row');
            if (actionsDeck) {
                card.insertBefore(panel, actionsDeck);
            } else {
                card.appendChild(panel);
            }
        }

        renderActiveCalls() {
            this.updateInCallWindowState();
            const container = this.dom.activeCallContainer;
            if (!container) return;
            container.textContent = '';

            const calls = Array.from(this.core.activeCalls.values());
            const workspace = document.getElementById('line1Workspace');

            if (calls.length === 0) {
                container.style.display = 'none';
                container.classList.add('hidden');
                if (workspace) {
                    workspace.classList.remove('hidden');
                    workspace.style.removeProperty('display');
                }
                return;
            }

            if (workspace) {
                workspace.classList.add('hidden');
                workspace.style.setProperty('display', 'none', 'important');
            }
            container.classList.remove('hidden');
            container.style.setProperty('display', 'flex', 'important');
            let firstCard = null;
            calls.forEach(call => {
                const card = document.createElement('div');
                if (!firstCard) firstCard = card;
                card.className = `active-call-hero ${call.status === 'ringing' ? 'ringing' : ''}`;

                // Title Area with badges
                const titleRow = document.createElement('div');
                titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

                const cardTitle = document.createElement('div');
                cardTitle.className = 'text-xs font-bold text-muted';
                const displayTarget = this.maskPhoneNumbers ? this.maskPhoneNumber(call.target) : call.target;
                if (!call.answerTime) {
                    if (call.direction === 'incoming') {
                        cardTitle.textContent = (this.currentLang === 'ar' ? 'مكالمة واردة من: ' : 'Incoming Call from: ') + displayTarget;
                        cardTitle.style.color = '#10b981';
                    } else {
                        cardTitle.textContent = (this.currentLang === 'ar' ? 'جاري الاتصال بـ: ' : 'Calling: ') + displayTarget;
                    }
                } else {
                    cardTitle.textContent = `${this.t.activeCallTitle} ${displayTarget}`;
                }
                titleRow.appendChild(cardTitle);

                // Badges container (quality + recording)
                const badgesRow = document.createElement('div');
                badgesRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

                const recBadge = document.createElement('div');
                recBadge.id = 'callRecordingBadge_' + call.id;
                recBadge.style.display = 'none';
                badgesRow.appendChild(recBadge);

                const qualityBadge = document.createElement('div');
                qualityBadge.id = 'callQualityBadge';
                badgesRow.appendChild(qualityBadge);

                titleRow.appendChild(badgesRow);
                card.appendChild(titleRow);

                // Contact Row: Avatar + Name + Timer
                const contactRow = document.createElement('div');
                contactRow.className = 'hero-contact-row';

                const avatarInfo = document.createElement('div');
                avatarInfo.className = 'hero-avatar-info';

                const contactMatch = this.findContactByNumber(call.target) || this.findContactByNumber(call.displayName);
                const avatar = document.createElement('div');
                avatar.className = 'hero-avatar';
                const avatarChar = contactMatch && contactMatch.name ? contactMatch.name.trim().charAt(0) : (call.displayName || call.target || 'A').trim().charAt(0);
                avatar.textContent = avatarChar.toUpperCase();

                const nameCol = document.createElement('div');
                const nameDiv = document.createElement('div');
                nameDiv.className = 'hero-name';
                nameDiv.style.fontWeight = '800';

                if (contactMatch) {
                    nameDiv.textContent = contactMatch.name;
                    const numDiv = document.createElement('div');
                    numDiv.className = 'text-xs text-muted font-mono';
                    numDiv.textContent = call.target || call.displayName;
                    nameCol.appendChild(nameDiv);
                    nameCol.appendChild(numDiv);
                } else if (call.displayName && call.displayName !== call.target) {
                    nameDiv.textContent = call.displayName;
                    const numDiv = document.createElement('div');
                    numDiv.className = 'text-xs text-muted font-mono';
                    numDiv.textContent = call.target;
                    nameCol.appendChild(nameDiv);
                    nameCol.appendChild(numDiv);
                } else {
                    nameDiv.textContent = call.target || call.displayName || (this.currentLang === 'ar' ? 'مكالمة واردة' : 'Incoming Call');
                    nameCol.appendChild(nameDiv);
                }

                const timerDiv = document.createElement('div');
                timerDiv.className = 'hero-timer font-mono';
                if (call.answerTime) {
                    timerDiv.dataset.timerStart = call.answerTime;
                    timerDiv.textContent = '00:00:00';
                } else if (call.direction === 'incoming') {
                    timerDiv.textContent = this.currentLang === 'ar' ? 'رنين وارد...' : 'Incoming Ringing...';
                    timerDiv.style.color = '#10b981';
                } else {
                    timerDiv.textContent = this.currentLang === 'ar' ? 'جاري الاتصال...' : 'Calling...';
                }

                nameCol.appendChild(timerDiv);
                avatarInfo.appendChild(avatar);
                avatarInfo.appendChild(nameCol);
                contactRow.appendChild(avatarInfo);

                card.appendChild(contactRow);
                card.appendChild(this.createHeroAudioDeck(call, 'line1'));

                // Attended transfer consultation bar
                if (this.attendedTransferState && this.attendedTransferState.callId === call.id) {
                    const consultBar = document.createElement('div');
                    consultBar.className = 'consult-bar';
                    consultBar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;margin:8px 0;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);';

                    const consultLabel = document.createElement('span');
                    consultLabel.className = 'text-xs font-bold';
                    consultLabel.style.color = 'var(--accent-green)';
                    consultLabel.textContent = 'Consulting: ' + this.attendedTransferState.target;
                    consultBar.appendChild(consultLabel);

                    const completeBtn = document.createElement('button');
                    completeBtn.className = 'btn btn-primary text-xs';
                    completeBtn.style.cssText = 'margin-left:auto;padding:3px 10px;font-size:10px;';
                    completeBtn.textContent = 'Complete Transfer';
                    completeBtn.addEventListener('click', () => {
                        try {
                            this.core.completeAttendedTransfer();
                            this.attendedTransferState = null;
                            this.renderActiveCalls();
                            this.showToast('Transfer completed', 'success');
                        } catch (err) {
                            this.showToast(err.message, 'error');
                        }
                    });
                    consultBar.appendChild(completeBtn);

                    const cancelBtn = document.createElement('button');
                    cancelBtn.className = 'btn btn-secondary text-xs';
                    cancelBtn.style.cssText = 'padding:3px 10px;font-size:10px;';
                    cancelBtn.textContent = 'Cancel';
                    cancelBtn.addEventListener('click', () => {
                        try {
                            this.core.cancelAttendedTransfer();
                            this.attendedTransferState = null;
                            this.renderActiveCalls();
                            this.showToast('Transfer cancelled', 'info');
                        } catch (err) {
                            this.showToast(err.message, 'error');
                        }
                    });
                    consultBar.appendChild(cancelBtn);

                    card.appendChild(consultBar);
                }

                // Action Buttons Row with Vector SVGs
                const isIncomingRinging = (call.direction === 'incoming' && !call.answerTime);

                if (isIncomingRinging) {
                    const actionsRow = document.createElement('div');
                    actionsRow.className = 'hero-actions-row hero-actions-row--incoming';

                    const answerBtn = document.createElement('button');
                    answerBtn.className = 'end-call-btn btn-answer call-action--answer';
                    setButtonContent(answerBtn, SVG_ICONS.phone, this.t.answer || 'Answer');
                    answerBtn.addEventListener('click', () => this.core.answerCall(call.id));

                    const transferRingingBtn = document.createElement('button');
                    transferRingingBtn.className = 'end-call-btn btn-transfer call-action--transfer';
                    setButtonContent(transferRingingBtn, SVG_ICONS.transfer, this.t.transfer || 'Transfer');
                    transferRingingBtn.addEventListener('click', () => this.openTransferModal(call.id));

                    const declineBtn = document.createElement('button');
                    declineBtn.className = 'end-call-btn btn-decline call-action--decline';
                    setButtonContent(declineBtn, SVG_ICONS.phoneOff, this.t.decline || 'Decline');
                    declineBtn.addEventListener('click', () => this.core.hangupCall(call.id));

                    actionsRow.appendChild(answerBtn);
                    actionsRow.appendChild(transferRingingBtn);
                    actionsRow.appendChild(declineBtn);
                    card.appendChild(actionsRow);
                } else {
                    // In-Call DTMF Keypad (for navigating automated IVR menus)
                    const dtmfSection = document.createElement('div');
                    dtmfSection.className = 'in-call-dtmf-section';
                    // DTMF input display box
                    const dtmfDisplay = document.createElement('div');
                    dtmfDisplay.className = 'dtmf-input-display';
                    dtmfDisplay.id = `dtmfDisplay_${call.id}`;
                    dtmfDisplay.textContent = '';
                    dtmfSection.appendChild(dtmfDisplay);

                    const dtmfGrid = document.createElement('div');
                    dtmfGrid.className = 'in-call-dtmf-grid';

                    const dtmfKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
                    dtmfKeys.forEach(k => {
                        const kBtn = document.createElement('button');
                        kBtn.type = 'button';
                        kBtn.className = 'dtmf-key-btn';
                        kBtn.textContent = k;
                        kBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            try {
                                if (call.session) {
                                    this.core.sendDTMF(call.id, k);
                                    const display = document.getElementById(`dtmfDisplay_${call.id}`);
                                    if (display) {
                                        display.textContent += k;
                                        display.scrollLeft = display.scrollWidth;
                                    }
                                }
                            } catch (_) {}
                        });
                        dtmfGrid.appendChild(kBtn);
                    });
                    dtmfSection.appendChild(dtmfGrid);
                    card.appendChild(dtmfSection);

                    // Row 1: In-call Control Actions (Mute, Hold, Transfer)
                    const actionsRow = document.createElement('div');
                    actionsRow.className = 'hero-actions-row';

                    const muteBtn = document.createElement('button');
                    muteBtn.className = `hero-pill-action ${call.isMuted ? 'active-mute' : ''}`;
                    setButtonContent(muteBtn, null, call.isMuted ? this.t.unmute : this.t.mute);
                    muteBtn.addEventListener('click', () => {
                        this.core.toggleMute(call.id);
                    });

                    const holdBtn = document.createElement('button');
                    holdBtn.className = `hero-pill-action ${call.isHeld ? 'active-hold' : ''}`;
                    setButtonContent(holdBtn, null, call.isHeld ? this.t.unhold : this.t.hold);
                    holdBtn.addEventListener('click', () => {
                        this.core.toggleHold(call.id);
                    });

                    const transferBtn = document.createElement('button');
                    transferBtn.className = 'hero-pill-action';
                    setButtonContent(transferBtn, null, this.t.transfer);
                    transferBtn.addEventListener('click', () => this.openTransferModal(call.id));

                    actionsRow.appendChild(muteBtn);
                    actionsRow.appendChild(holdBtn);
                    actionsRow.appendChild(transferBtn);
                    card.appendChild(actionsRow);

                    // Row 2: Full-width End Call Button
                    const hangupRow = document.createElement('div');
                    hangupRow.className = 'hero-hangup-row';

                    const endBtn = document.createElement('button');
                    endBtn.className = 'end-call-btn btn-hangup call-action--end';
                    setButtonContent(endBtn, SVG_ICONS.phoneOff, this.t.endCall);
                    const isOutboundRinging = (call.direction === 'outgoing' && !call.answerTime);
                    const blockCancel = isOutboundRinging && this.isOutboundRingingCancelBlocked(call);
                    if (blockCancel) {
                        endBtn.disabled = true;
                        endBtn.classList.add('policy-locked');
                        endBtn.setAttribute('disabled', 'disabled');
                        endBtn.style.setProperty('opacity', '0.35', 'important');
                        endBtn.style.setProperty('cursor', 'not-allowed', 'important');
                        endBtn.style.setProperty('pointer-events', 'none', 'important');
                        endBtn.title = this.currentLang === 'ar'
                            ? 'ممنوع إنهاء المكالمة أثناء الرنين بموجب سياسة الإدارة'
                            : 'Ending outbound calls while ringing is blocked by Administrator policy';
                    } else {
                        endBtn.addEventListener('click', (e) => {
                            if (this.isOutboundRingingCancelBlocked(call)) {
                                e.preventDefault();
                                e.stopPropagation();
                                this.showToast(this.currentLang === 'ar'
                                    ? 'ممنوع إنهاء المكالمة أثناء الرنين بموجب سياسة الإدارة'
                                    : 'Ending outbound calls while ringing is blocked by Administrator policy', 'warning');
                                return;
                            }
                            this.core.hangupCall(call.id);
                        });
                    }
                    hangupRow.appendChild(endBtn);
                    card.appendChild(hangupRow);
                }

                // Render recording indicator if active
                if (call.isRecording) {
                    const recEl = card.querySelector('#callRecordingBadge_' + call.id);
                    if (recEl) {
                        recEl.style.display = 'inline-flex';
                        recEl.innerHTML = '<span class="rec-badge"><span class="rec-dot"></span>REC</span>';
                    }
                }

                container.appendChild(card);
            });
            this.renderActiveDialerLead(firstCard);

            // Re-render quality badge after active call cards are in DOM
            this.renderCallQualityBadge();
        }

        // --- CALL QUALITY BADGE ---
        renderCallQualityBadge() {
            const el = document.getElementById('callQualityBadge');
            if (!el) return;

            if (!this.currentCallQuality) {
                el.innerHTML = '';
                return;
            }

            const q = this.currentCallQuality;
            const quality = q.quality || 'good';
            const labels = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor' };
            const colors = { excellent: '#10b981', good: '#10b981', fair: '#f59e0b', poor: '#ef4444' };
            const label = labels[quality] || 'Good';
            const color = colors[quality] || '#10b981';

            el.innerHTML = '<span class="quality-badge quality-' + quality + '" style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px;font-size:9px;font-weight:800;color:' + color + ';background:' + color + '1a;border:1px solid ' + color + '66;letter-spacing:0.3px;">' +
                '<span class="quality-dot" style="width:6px;height:6px;border-radius:50%;background:' + color + ';"></span>' +
                label + '</span>';
        }

        // --- RECORDING INDICATOR ---
        renderRecordingIndicator(data) {
            if (!data) return;
            const el = document.getElementById('callRecordingBadge_' + data.callId);
            if (!el) return;

            if (data.isRecording) {
                el.style.display = 'inline-flex';
                el.innerHTML = '<span class="rec-badge"><span class="rec-dot"></span>REC</span>';
            } else {
                el.style.display = 'none';
                el.innerHTML = '';
            }
        }

        // --- BROWSER NOTIFICATIONS (FOR INCOMING CALLS ONLY) ---
        showIncomingNotification(callEntry) {
            // Strictly guard: only display desktop popup notification for incoming calls
            if (!callEntry || callEntry.direction !== 'incoming' || callEntry.status !== 'ringing') return;

            // Request permission if needed
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                Notification.requestPermission().catch(() => {});
            }

            if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

            this.dismissNotification();

            const callerName = callEntry.target || callEntry.displayName || 'Unknown';
            const contactMatch = this.findContactByNumber(callerName) || this.findContactByNumber(callEntry.displayName);
            const isAr = this.currentLang === 'ar';
            const title = isAr ? 'مكالمة واردة' : 'Incoming Call';
            const body = contactMatch ? `${contactMatch.name} (${callerName})` : callerName;
            try {
                this.incomingNotification = new Notification(title, {
                    body: body,
                    icon: '/img/phone-icon.png',
                    tag: 'sokrat-incoming-' + (callEntry.id || Date.now()),
                    requireInteraction: true
                });

                this.incomingNotification.onclick = () => {
                    window.focus();
                    this.incomingNotification.close();
                    this.incomingNotification = null;
                };

                this.incomingNotification.onclose = () => {
                    this.incomingNotification = null;
                };
            } catch (_) {
                // Notifications not supported in this context
            }
        }

        dismissNotification() {
            if (this.incomingNotification) {
                try { this.incomingNotification.close(); } catch (_) {}
                this.incomingNotification = null;
            }
        }

        requestNotificationPermissionInitial() {
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                Notification.requestPermission().catch(() => {});
            }
        }

        // --- RECENT CALLS LIST ---
        getCallLogs() {
            try {
                return JSON.parse(localStorage.getItem(this.LOGS_KEY) || '[]');
            } catch (_) {
                return [];
            }
        }

        saveCallLogs(logs) {
            localStorage.setItem(this.LOGS_KEY, JSON.stringify(logs || []));
        }

        addCallLog(logEntry) {
            const allLogs = this.getCallLogs();
            const newLog = {
                id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                line: logEntry.line || 'line1',
                target: logEntry.target || 'Unknown',
                direction: logEntry.direction || 'outgoing',
                status: logEntry.status || 'answered',
                durationSec: logEntry.durationSec || 0,
                timestamp: logEntry.timestamp || new Date().toISOString()
            };
            allLogs.unshift(newLog);
            if (allLogs.length > 60) allLogs.pop();
            this.saveCallLogs(allLogs);
            this.loadCallLogs();
            this.renderLine2History();
        }

        clearCallLogs() {
            this.saveCallLogs([]);
            this.loadCallLogs();
            this.renderLine2History();
            this.showToast('Call history cleared', 'info');
        }

        // --- TERMINAL-STYLE DIAL HISTORY SEEKING (UP/DOWN ARROWS) ---
        getDialedHistory(line = 'line1') {
            const allLogs = this.getCallLogs();
            const filtered = allLogs.filter(l => (!l.line || l.line === line) && (l.direction === 'outgoing' || l.direction === 'outbound' || l.target));
            const seen = new Set();
            const history = [];
            for (const log of filtered) {
                const target = String(log.target || log.number || '').trim();
                if (target && target !== 'Unknown' && !seen.has(target)) {
                    seen.add(target);
                    history.push(target);
                }
            }
            return history;
        }
        getDialedHistoryDetails(line = 'line1') {
            const allLogs = this.getCallLogs();
            const contacts = this.getContacts();
            const filtered = allLogs.filter(l => (!l.line || l.line === line) && (l.direction === 'outgoing' || l.direction === 'outbound' || l.target));
            const seen = new Set();
            const list = [];
            for (const log of filtered) {
                const target = String(log.target || log.number || '').trim();
                if (target && target !== 'Unknown' && !seen.has(target)) {
                    seen.add(target);
                    const contact = contacts.find(c => String(c.number) === target || String(c.extension) === target);
                    list.push({
                        number: target,
                        name: contact ? contact.name : '',
                        timestamp: log.timestamp,
                        status: log.status
                    });
                }
            }
            return list;
        }

        toggleDialHistoryDropdown(line = 'line1') {
            const dropdownId = (line === 'line2') ? 'line2DialHistoryDropdown' : 'dialHistoryDropdown';
            const btnId = (line === 'line2') ? 'line2DialHistoryDropdownBtn' : 'dialHistoryDropdownBtn';
            const dropdown = document.getElementById(dropdownId);
            const btn = document.getElementById(btnId);
            if (!dropdown) return;

            const isVisible = dropdown.style.display !== 'none';
            if (isVisible) {
                this.closeDialHistoryDropdown(line);
            } else {
                this.renderDialHistoryDropdown(line);
                dropdown.style.display = 'flex';
                if (btn) btn.classList.add('active');
            }
        }

        closeDialHistoryDropdown(line = null) {
            const lines = line ? [line] : ['line1', 'line2'];
            lines.forEach(l => {
                const dropdownId = (l === 'line2') ? 'line2DialHistoryDropdown' : 'dialHistoryDropdown';
                const btnId = (l === 'line2') ? 'line2DialHistoryDropdownBtn' : 'dialHistoryDropdownBtn';
                const dropdown = document.getElementById(dropdownId);
                const btn = document.getElementById(btnId);
                if (dropdown) dropdown.style.display = 'none';
                if (btn) btn.classList.remove('active');
            });
        }

        renderDialHistoryDropdown(line = 'line1') {
            const listId = (line === 'line2') ? 'line2DialHistoryDropdownList' : 'dialHistoryDropdownList';
            const inputId = (line === 'line2') ? 'line2DialInput' : 'dialInput';
            const listEl = document.getElementById(listId);
            const inputEl = document.getElementById(inputId);
            if (!listEl) return;

            listEl.textContent = '';
            const historyItems = this.getDialedHistoryDetails(line);

            if (historyItems.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'text-center py-4 text-xs text-muted';
                empty.textContent = (this.currentLang === 'ar') ? 'لا توجد أرقام سابقة بعد' : 'No previously dialed numbers';
                listEl.appendChild(empty);
                return;
            }

            historyItems.slice(0, 15).forEach(item => {
                const el = document.createElement('div');
                el.className = 'dial-history-item';
                
                const left = document.createElement('div');
                left.className = 'dial-history-item-left';

                const icon = document.createElement('div');
                icon.className = 'dial-history-icon';
                icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>';

                const info = document.createElement('div');
                info.className = 'dial-history-info';

                const num = document.createElement('div');
                num.className = 'dial-history-num font-mono';
                num.textContent = item.number;

                info.appendChild(num);

                if (item.name) {
                    const name = document.createElement('div');
                    name.className = 'dial-history-name';
                    name.textContent = item.name;
                    info.appendChild(name);
                }

                left.appendChild(icon);
                left.appendChild(info);

                const time = document.createElement('div');
                time.className = 'dial-history-time';
                if (item.timestamp) {
                    try {
                        const d = new Date(item.timestamp);
                        time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    } catch (_) {}
                }

                el.appendChild(left);
                el.appendChild(time);

                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (inputEl) {
                        inputEl.value = item.number;
                        inputEl.focus();
                    }
                    this.closeDialHistoryDropdown(line);
                });

                listEl.appendChild(el);
            });
        }
        setupDialHistorySeeking(inputEl, line = 'line1') {
            if (!inputEl || inputEl._hasDialHistorySeeking) return;
            inputEl._hasDialHistorySeeking = true;
            let historyIndex = -1;
            let draft = '';

            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowUp') {
                    const history = this.getDialedHistory(line);
                    if (history.length === 0) return;
                    e.preventDefault();
                    if (historyIndex === -1) {
                        draft = inputEl.value;
                    }
                    if (historyIndex < history.length - 1) {
                        historyIndex++;
                        inputEl.value = history[historyIndex];
                        setTimeout(() => inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length), 0);
                    }
                } else if (e.key === 'ArrowDown') {
                    const history = this.getDialedHistory(line);
                    if (historyIndex === -1) return;
                    e.preventDefault();
                    if (historyIndex > 0) {
                        historyIndex--;
                        inputEl.value = history[historyIndex];
                        setTimeout(() => inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length), 0);
                    } else if (historyIndex === 0) {
                        historyIndex = -1;
                        inputEl.value = draft;
                        setTimeout(() => inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length), 0);
                    }
                } else if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta' && e.key !== 'Enter') {
                    historyIndex = -1;
                }
            });

            inputEl.addEventListener('blur', () => {
                historyIndex = -1;
            });
        }
        loadCallLogs() {
            const listEl = this.dom.callHistoryList;
            if (!listEl) return;
            listEl.textContent = '';
            const allLogs = this.getCallLogs();
            const logs = allLogs.filter(l => !l.line || l.line === 'line1');

            if (logs.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'text-center py-6 text-xs text-muted';
                emptyMsg.textContent = this.t.noLogs;
                listEl.appendChild(emptyMsg);
                return;
            }

            logs.forEach(log => {
                const card = document.createElement('div');
                card.className = 'recent-card';

                const left = document.createElement('div');
                left.className = 'recent-left';

                const contactMatch = this.findContactByNumber(log.target);
                const avatar = document.createElement('div');
                avatar.className = 'recent-avatar';
                const avatarChar = contactMatch && contactMatch.name ? contactMatch.name.trim().charAt(0) : (log.target || 'U').charAt(0);
                avatar.textContent = avatarChar.toUpperCase();

                const info = document.createElement('div');
                info.className = 'recent-info';

                const nameSpan = document.createElement('div');
                nameSpan.className = 'recent-name font-mono';
                if (contactMatch) {
                    nameSpan.textContent = contactMatch.name;
                    const numDiv = document.createElement('div');
                    numDiv.className = 'text-xs text-muted font-mono';
                    numDiv.textContent = this.maskPhoneNumbers ? this.maskPhoneNumber(log.target) : log.target;
                    info.appendChild(nameSpan);
                    info.appendChild(numDiv);
                } else {
                    nameSpan.textContent = this.maskPhoneNumbers ? this.maskPhoneNumber(log.target) : log.target;
                    info.appendChild(nameSpan);
                }

                const dirSpan = document.createElement('div');
                const isMissed = log.status === 'failed' || log.status === 'busy' || log.status === 'rejected_dnd';
                const dirClass = isMissed ? 'missed' : (log.direction === 'incoming' ? 'incoming' : 'outgoing');
                const dirArrow = isMissed ? '✕' : (log.direction === 'incoming' ? '↗' : '↙');
                dirSpan.className = `recent-dir ${dirClass}`;
                dirSpan.textContent = `${dirArrow} ${this.t[dirClass] || log.status}`;
                info.appendChild(dirSpan);

                left.appendChild(avatar);
                left.appendChild(info);
                const right = document.createElement('div');
                right.className = 'recent-right';

                const timeSpan = document.createElement('span');
                timeSpan.className = 'recent-time';
                timeSpan.textContent = formatTimeAgo(log.timestamp);

                const callBtn = document.createElement('button');
                callBtn.className = 'recent-call-btn btn-call';
                setButtonContent(callBtn, SVG_ICONS.phone, '');
                callBtn.title = 'Call';
                callBtn.addEventListener('click', () => {
                    this.realDialNumber = log.target;
                    this.dom.dialInput.value = this.maskPhoneNumbers ? this.maskPhoneNumber(log.target) : log.target;
                    this.handleCallAction();
                });

                right.appendChild(timeSpan);
                right.appendChild(callBtn);

                card.appendChild(left);
                card.appendChild(right);
                listEl.appendChild(card);
            });
        }

        // --- HARDWARE AUDIO DEVICES ---
        // --- HARDWARE AUDIO & SETTINGS MODAL ---
        switchSettingsTab(tabName) {
            const tabs = ['Audio', 'Dsp', 'Calls'];
            tabs.forEach(t => {
                const btn = document.getElementById(`settingsTabBtn${t}`);
                const content = document.getElementById(`settingsTabContent${t}`);
                if (btn) btn.classList.toggle('active', t.toLowerCase() === tabName.toLowerCase());
                if (content) content.style.display = (t.toLowerCase() === tabName.toLowerCase()) ? 'block' : 'none';
            });
        }

        async openAudioModal() {
            document.getElementById('audioModal').classList.remove('hidden');
            this.switchSettingsTab('audio');
            await this.enumerateAudioDevices();
            this.syncSettingsToUi();
        }

        syncSettingsToUi() {
            if (this.dom.ringVolumeSlider) {
                this.dom.ringVolumeSlider.value = this.core.ringVolume ?? 100;
            }
            if (this.dom.ringVolumeVal) {
                this.dom.ringVolumeVal.textContent = `${this.core.ringVolume ?? 100}%`;
            }
            if (this.dom.ecCheckbox) this.dom.ecCheckbox.checked = Boolean(this.core.echoCancellation);
            if (this.dom.nsCheckbox) this.dom.nsCheckbox.checked = Boolean(this.core.noiseSuppression);
            if (this.dom.agcCheckbox) this.dom.agcCheckbox.checked = Boolean(this.core.autoGainControl);
            if (this.dom.stunCheckbox) this.dom.stunCheckbox.checked = Boolean(this.core.stunEnabled);
            if (this.dom.stunServerInput) this.dom.stunServerInput.value = this.core.stunServer || '';
            if (this.dom.singleCallCheckbox) this.dom.singleCallCheckbox.checked = Boolean(this.core.singleCallMode);
            if (this.dom.callWaitingCheckbox) this.dom.callWaitingCheckbox.checked = Boolean(this.core.callWaiting);
            if (this.dom.dtmfMethodSelect) this.dom.dtmfMethodSelect.value = this.core.dtmfMethod || 'AUTO';
        }

        async enumerateAudioDevices() {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
            try {
                let devices = await navigator.mediaDevices.enumerateDevices();
                const hasLabels = devices.some(d => Boolean(d.label));
                if (!hasLabels && (!this.core.micPermissionGranted)) {
                    try {
                        await this.core.acquireMicrophone();
                        devices = await navigator.mediaDevices.enumerateDevices();
                    } catch (_) {}
                }

                if (this.dom.audioInputSelect) this.dom.audioInputSelect.textContent = '';
                if (this.dom.audioOutputSelect) this.dom.audioOutputSelect.textContent = '';
                if (this.dom.audioRingSelect) this.dom.audioRingSelect.textContent = '';

                const audioInputs = devices.filter(d => d.kind === 'audioinput');
                const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

                if (this.dom.audioInputSelect) {
                    if (audioInputs.length === 0) {
                        const opt = document.createElement('option');
                        opt.value = '';
                        opt.textContent = 'Default Microphone (System)';
                        this.dom.audioInputSelect.appendChild(opt);
                    } else {
                        audioInputs.forEach((dev, idx) => {
                            const opt = document.createElement('option');
                            opt.value = dev.deviceId;
                            opt.textContent = dev.label || `Microphone ${idx + 1}`;
                            if (this.core.selectedAudioInputId === dev.deviceId) opt.selected = true;
                            this.dom.audioInputSelect.appendChild(opt);
                        });
                    }
                }

                if (this.dom.audioOutputSelect) {
                    if (audioOutputs.length === 0) {
                        const opt = document.createElement('option');
                        opt.value = '';
                        opt.textContent = 'Default Speaker (System)';
                        this.dom.audioOutputSelect.appendChild(opt);
                    } else {
                        audioOutputs.forEach((dev, idx) => {
                            const opt = document.createElement('option');
                            opt.value = dev.deviceId;
                            opt.textContent = dev.label || `Speaker ${idx + 1}`;
                            if (this.core.selectedAudioOutputId === dev.deviceId) opt.selected = true;
                            this.dom.audioOutputSelect.appendChild(opt);
                        });
                    }
                }

                if (this.dom.audioRingSelect) {
                    if (audioOutputs.length === 0) {
                        const opt = document.createElement('option');
                        opt.value = '';
                        opt.textContent = 'Default Ring Device (System)';
                        this.dom.audioRingSelect.appendChild(opt);
                    } else {
                        audioOutputs.forEach((dev, idx) => {
                            const opt = document.createElement('option');
                            opt.value = dev.deviceId;
                            opt.textContent = dev.label || `Ring Device ${idx + 1}`;
                            if (this.core.selectedRingOutputId === dev.deviceId) opt.selected = true;
                            this.dom.audioRingSelect.appendChild(opt);
                        });
                    }
                }
            } catch (err) {
                console.warn('Device enumeration warning:', err);
            }
        }

        testSpeakerOutput() {
            this.core.playTestChime();
            this.showToast(this.currentLang === 'ar' ? 'جاري تشغيل نغمة اختبار الصوت 🔔' : 'Playing audio test chime 🔔', 'info');
        }

        testRingOutput() {
            this.core.playTestRingChime();
            this.showToast(this.currentLang === 'ar' ? 'تشغيل نغمة اختبار الرنين 🔔' : 'Playing ring test chime 🔔', 'info');
        }
        async checkMicrophonePermissionInitial() {
            try {
                if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                    await this.core.acquireMicrophone();
                    if (this.dom.micBanner) this.dom.micBanner.style.display = 'none';
                    return;
                }
            } catch (_) {}

            try {
                if (navigator.permissions && navigator.permissions.query) {
                    const res = await navigator.permissions.query({ name: 'microphone' });
                    if (res.state === 'granted') {
                        await this.core.acquireMicrophone();
                        if (this.dom.micBanner) this.dom.micBanner.style.display = 'none';
                        return;
                    }
                }
            } catch (_) {}
            if (this.dom.micBanner && !window.navigator.userAgent.includes('Electron')) {
                this.dom.micBanner.style.display = 'flex';
            }
        }

        // --- DOM ACTIONS & HOTKEYS ---
        bindDomEvents() {
            if (this.dom.presetSelect) {
                this.dom.presetSelect.addEventListener('change', () => this.onPresetChanged());
            }

            // Custom extension dropdown outside-click and escape handling
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.custom-ext-dropdown-container')) {
                    this.closeCustomExtDropdown();
                }
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.closeCustomExtDropdown();
                }
            });
            if (this.dom.passwordInput) {
                this.dom.passwordInput.addEventListener('input', () => {
                    const preset = this.getSelectedPreset();
                    if (preset) {
                        this.sessionSecrets.set(preset.id, this.dom.passwordInput.value);
                    }
                });
            }

            if (this.dom.connectBtn) {
                this.dom.connectBtn.addEventListener('click', async () => {
                    if (this.core.regState === 'REGISTERED' || this.core.regState === 'CONNECTING' || this.core.regState === 'RETRY_WAIT') {
                        this.logout();
                    } else {
                        const preset = this.getSelectedPreset();
                        if (!preset) {
                            this.showToast('Please select account', 'error');
                            return;
                        }
                        const secret = preset.secret || this.sessionSecrets.get(preset.id) || this.lastSessionPassword || this.core.lastSecret || '';
                        if (!secret) {
                            this.showToast(this.t.loginEnterPasswordError || 'Please log in with extension password', 'warning');
                            this.updateViewMode('login');
                            return;
                        }
                        try {
                            await this.core.connect(preset, secret);
                        } catch (err) {
                            this.showToast(err.message, 'error');
                        }
                    }
                });
            }
            this.dom.callBtn.addEventListener('click', () => this.handleCallAction());
            this.setupDialHistorySeeking(this.dom.dialInput, 'line1');
            this.dom.dialInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.handleCallAction();
                }
            });

            // Close dial history dropdown on outside click or Escape
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.dialer-input-box')) {
                    this.closeDialHistoryDropdown();
                }
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.closeDialHistoryDropdown();
                }
            });
            // Keypad clicks
            document.querySelectorAll('.keypad-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const digit = btn.dataset.digit;
                    if (!digit) return;
                    this.dom.dialInput.value += digit;
                });
            });

            if (this.dom.dndCheckbox) {
                this.dom.dndCheckbox.addEventListener('change', () => {
                    const preset = this.getSelectedPreset();
                    const extNum = preset ? String(preset.extension) : '';
                    const policy = (this.extensionPolicies && extNum) ? this.extensionPolicies.get(extNum) : null;
                    if (policy && policy.dnd !== 'user_choice') {
                        this.dom.dndCheckbox.checked = policy.dnd === 'force_on';
                        this.showToast(policy.dnd === 'force_on' ? 'DND is locked ON by Administrator' : 'DND is prohibited by Administrator', 'warning');
                        return;
                    }
                    this.core.isDnd = this.dom.dndCheckbox.checked;
                    if (this.dom.toolBtnDnd) this.dom.toolBtnDnd.classList.toggle('active-dnd', this.core.isDnd);
                    if (preset) {
                        preset.dnd = this.core.isDnd;
                        let presets = this.getPresets();
                        const idx = presets.findIndex(p => p.id === preset.id);
                        if (idx >= 0) presets[idx].dnd = preset.dnd;
                        this.savePresets(presets);
                    }
                    this.showToast(this.core.isDnd ? 'DND Enabled (Busy Here)' : 'DND Disabled', this.core.isDnd ? 'warning' : 'info');
                });
            }

            this.dom.autoAnswerCheckbox.addEventListener('change', () => {
                const preset = this.getSelectedPreset();
                const extNum = preset ? String(preset.extension) : '';
                const policy = (this.extensionPolicies && extNum) ? this.extensionPolicies.get(extNum) : null;
                if (policy && policy.auto_answer !== 'user_choice') {
                    this.dom.autoAnswerCheckbox.checked = policy.auto_answer === 'force_on';
                    this.showToast(policy.auto_answer === 'force_on' ? 'Auto Answer is locked ON by Administrator' : 'Auto Answer is prohibited by Administrator', 'warning');
                    return;
                }
                this.core.isAutoAnswer = this.dom.autoAnswerCheckbox.checked;
                if (this.dom.toolBtnAuto) this.dom.toolBtnAuto.classList.toggle('active-auto', this.core.isAutoAnswer);
                if (preset) {
                    preset.autoAnswer = this.core.isAutoAnswer;
                    let presets = this.getPresets();
                    const idx = presets.findIndex(p => p.id === preset.id);
                    if (idx >= 0) presets[idx].autoAnswer = preset.autoAnswer;
                    this.savePresets(presets);
                }
                this.showToast(this.core.isAutoAnswer ? 'Auto Answer Enabled' : 'Auto Answer Disabled', this.core.isAutoAnswer ? 'success' : 'info');
            });
            // Audio Devices
            this.dom.audioInputSelect.addEventListener('change', async () => {
                const deviceId = this.dom.audioInputSelect.value;
                try {
                    await this.core.acquireMicrophone(deviceId);
                    this.showToast('Microphone updated', 'info');
                } catch (err) {
                    this.showToast(err.message, 'error');
                }
            });

            this.dom.audioOutputSelect.addEventListener('change', async () => {
                const deviceId = this.dom.audioOutputSelect.value;
                await this.core.setOutputDevice(deviceId);
                this.showToast('Speaker updated', 'info');
            });
            if (this.dom.audioRingSelect) {
                this.dom.audioRingSelect.addEventListener('change', async () => {
                    const deviceId = this.dom.audioRingSelect.value;
                    await this.core.setRingDevice(deviceId);
                    this.showToast('Ring device updated', 'info');
                });
            }

            if (this.dom.ringVolumeSlider) {
                this.dom.ringVolumeSlider.addEventListener('input', () => {
                    const val = Number(this.dom.ringVolumeSlider.value);
                    this.core.setRingVolume(val);
                    if (this.dom.ringVolumeVal) this.dom.ringVolumeVal.textContent = `${val}%`;
                });
            }

            const updateDsp = () => {
                this.core.setAudioProcessing({
                    echoCancellation: this.dom.ecCheckbox ? this.dom.ecCheckbox.checked : true,
                    noiseSuppression: this.dom.nsCheckbox ? this.dom.nsCheckbox.checked : true,
                    autoGainControl: this.dom.agcCheckbox ? this.dom.agcCheckbox.checked : true
                });
                this.showToast('Audio processing updated', 'info');
            };
            if (this.dom.ecCheckbox) this.dom.ecCheckbox.addEventListener('change', updateDsp);
            if (this.dom.nsCheckbox) this.dom.nsCheckbox.addEventListener('change', updateDsp);
            if (this.dom.agcCheckbox) this.dom.agcCheckbox.addEventListener('change', updateDsp);

            const updateStun = () => {
                const enabled = this.dom.stunCheckbox ? this.dom.stunCheckbox.checked : false;
                const server = this.dom.stunServerInput ? this.dom.stunServerInput.value : '';
                this.core.setStunConfig(enabled, server);
                this.showToast('STUN/ICE configuration updated', 'info');
            };
            if (this.dom.stunCheckbox) this.dom.stunCheckbox.addEventListener('change', updateStun);
            if (this.dom.stunServerInput) this.dom.stunServerInput.addEventListener('change', updateStun);

            if (this.dom.singleCallCheckbox) {
                this.dom.singleCallCheckbox.addEventListener('change', () => {
                    this.core.setSingleCallMode(this.dom.singleCallCheckbox.checked);
                    this.showToast(this.core.singleCallMode ? 'Single Call Mode enabled' : 'Single Call Mode disabled', 'info');
                });
            }

            if (this.dom.callWaitingCheckbox) {
                this.dom.callWaitingCheckbox.addEventListener('change', () => {
                    this.core.setCallWaiting(this.dom.callWaitingCheckbox.checked);
                    this.showToast(this.core.callWaiting ? 'Call Waiting enabled' : 'Call Waiting disabled', 'info');
                });
            }

            if (this.dom.dtmfMethodSelect) {
                this.dom.dtmfMethodSelect.addEventListener('change', () => {
                    this.core.setDtmfMethod(this.dom.dtmfMethodSelect.value);
                    this.showToast(`DTMF method set to ${this.core.dtmfMethod}`, 'info');
                });
            }

            // Global Keyboard Shortcuts
            window.addEventListener('keydown', (e) => {
                if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
                    if (e.key === 'Escape') document.activeElement.blur();
                    return;
                }

                const activeCall = Array.from(this.core.activeCalls.values())[0];
                if (e.code === 'Space' && activeCall) {
                    e.preventDefault();
                    this.core.toggleMute(activeCall.id);
                } else if ((e.key === 'h' || e.key === 'H') && activeCall) {
                    e.preventDefault();
                    this.core.toggleHold(activeCall.id);
                } else if (e.key === 'Escape' && activeCall) {
                    e.preventDefault();
                    this.core.hangupCall(activeCall.id);
                }
            });
        }

        handleCallAction() {
            if (this.core.activeCalls.size > 0) {
                this.showToast(this.currentLang === 'ar' ? 'يوجد مكالمة نشطة بالفعل' : 'A call is already in progress', 'warning');
                return;
            }
            const preset = this.getSelectedPreset() || (this.core && this.core.activePreset);
            if (preset && preset.extension) {
                this.fetchAndApplyExtensionPolicy(preset.extension);
            }
            const num = (this.realDialNumber && this.maskPhoneNumbers && this.dom.dialInput.value.includes('*'))
                ? this.realDialNumber
                : this.dom.dialInput.value.trim();
            if (!num) return;
            if (this.core.regState !== 'REGISTERED') {
                this.pendingCallTarget = num;
                this.showToast(this.currentLang === 'ar' ? `جاري الاتصال بالسنترال لطلب ${num}...` : `Connecting to call ${num}...`, 'info');
                const preset = this.getSelectedPreset();
                const secret = preset ? (preset.secret || this.sessionSecrets.get(preset.id) || this.lastSessionPassword || '') : '';
                if (preset && secret) {
                    this.core.connect(preset, secret).catch(() => {});
                }
                this.core.once('registered', () => {
                    if (this.pendingCallTarget === num) {
                        setTimeout(() => {
                            if (this.pendingCallTarget === num) {
                                this.core.makeCall(num);
                                this.pendingCallTarget = null;
                                this.realDialNumber = '';
                            }
                        }, 300);
                    }
                });
                return;
            }

            try {
                this.core.makeCall(num);
                this.realDialNumber = '';
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        }

        redialLastNumber() {
            const history = this.getDialedHistory('line1');
            if (history && history.length > 0) {
                const lastNum = history[0];
                if (this.dom.dialInput) {
                    this.dom.dialInput.value = lastNum;
                }
                this.handleCallAction();
            } else {
                this.showToast(this.currentLang === 'ar' ? 'لا يوجد رقم سابق لإعادة طلبه' : 'No previous call to redial', 'info');
            }
        }

        // --- RELOAD EXTENSION CONNECTION ---
        async reloadConnection() {
            const isAr = this.currentLang === 'ar';
            const reloadBtn = document.getElementById('titlebarReloadBtn');
            if (reloadBtn) reloadBtn.classList.add('spinning');
            this.showToast(isAr ? 'جاري إعادة الاتصال بالسنترال...' : 'Reloading Asterisk connection...', 'info');

            try {
                const preset = this.getSelectedPreset() || (this.core && this.core.activePreset);
                const secret = (preset ? (preset.secret || this.sessionSecrets.get(preset.id) || this.lastSessionPassword || (this.core && this.core.lastSecret) || '') : '');
                if (preset && secret) {
                    await this.core.connect(preset, secret);
                } else {
                    await this.core.reconnect();
                }
                this.showToast(isAr ? 'تم تحديث الاتصال بالسنترال بنجاح' : 'Asterisk connection reloaded successfully', 'success');
            } catch (err) {
                this.showToast(err.message, 'error');
            } finally {
                setTimeout(() => {
                    if (reloadBtn) reloadBtn.classList.remove('spinning');
                }, 600);
            }
        }

        // --- PERSISTENT POPOUT WINDOW ---
        openPersistentWindow() {
            const isSplit = Boolean(this.isSplitView || document.querySelector('.app-window.is-split-view'));
            const width = isSplit ? 900 : 460;
            const height = 720;
            const left = window.screen ? Math.max(0, Math.round((window.screen.width - width) / 2)) : 100;
            const top = window.screen ? Math.max(0, Math.round((window.screen.height - height) / 2)) : 60;
            const features = `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=no`;

            const popout = window.open(window.location.href, 'sokratSoftphonePopout', features);
            if (popout) {
                popout.focus();
                this.showToast('Opened in persistent window', 'info');
            } else {
                this.showToast('Popup blocker prevented opening window', 'warning');
            }
        }

        // --- TRANSFER MODAL WITH BLIND + ATTENDED TABS ---
        async openTransferModal(callId, line = 'line1') {
            this.transferCallLine = line;
            document.getElementById('transferCallIdInput').value = callId;
            const targetInput = document.getElementById('transferTargetInput');
            if (targetInput) targetInput.value = '';

            // Set up tab UI if not already present
            this.setupTransferTabs();

            const listContainer = document.getElementById('transferExtList');
            if (listContainer) {
                listContainer.textContent = '';
                await this.fetchServerExtensions();

                (this.serverExtensionsList || []).forEach(ext => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'transfer-ext-btn';

                    const extSpan = document.createElement('span');
                    extSpan.className = 'font-mono font-bold';
                    extSpan.textContent = ext.extension;

                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'text-xs text-muted truncate';
                    nameSpan.textContent = ext.name && ext.name !== ext.extension ? ext.name : 'Ext';

                    btn.appendChild(extSpan);
                    btn.appendChild(nameSpan);

                    btn.addEventListener('click', () => {
                        if (targetInput) targetInput.value = ext.extension;
                        document.querySelectorAll('.transfer-ext-btn').forEach(b => b.classList.remove('selected'));
                        btn.classList.add('selected');
                    });

                    listContainer.appendChild(btn);
                });
            }

            this.dom.transferModal.classList.remove('hidden');
        }

        setupTransferTabs() {
            const modal = this.dom.transferModal;
            if (!modal) return;
            const card = modal.querySelector('.modal-card');
            if (!card) return;

            // Only inject tabs once
            if (card.querySelector('.transfer-tabs')) return;

            const h3 = card.querySelector('h3');
            if (!h3) return;

            // Create tab bar
            const tabBar = document.createElement('div');
            tabBar.className = 'transfer-tabs';
            tabBar.style.cssText = 'display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid var(--border-primary);';

            const blindTab = document.createElement('button');
            blindTab.type = 'button';
            blindTab.className = 'transfer-tab active';
            blindTab.textContent = 'Blind Transfer';
            blindTab.dataset.tab = 'blind';
            blindTab.style.cssText = 'flex:1;padding:8px 12px;font-size:11px;font-weight:700;background:none;border:none;border-bottom:2px solid var(--accent-color);margin-bottom:-2px;color:var(--accent-color);cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;';

            const attendedTab = document.createElement('button');
            attendedTab.type = 'button';
            attendedTab.className = 'transfer-tab';
            attendedTab.textContent = 'Attended Transfer';
            attendedTab.dataset.tab = 'attended';
            attendedTab.style.cssText = 'flex:1;padding:8px 12px;font-size:11px;font-weight:700;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;color:var(--text-muted);cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;';

            tabBar.appendChild(blindTab);
            tabBar.appendChild(attendedTab);

            // Insert after h3
            h3.insertAdjacentElement('afterend', tabBar);

            // Find the existing action buttons row (last .flex in card)
            const actionRow = card.querySelector('.flex.items-center.justify-end');

            // Create attended transfer action row (hidden initially)
            const attendedActions = document.createElement('div');
            attendedActions.className = 'flex items-center justify-end gap-2 attended-actions';
            attendedActions.style.display = 'none';

            const cancelBtnA = document.createElement('button');
            cancelBtnA.type = 'button';
            cancelBtnA.className = 'btn btn-secondary text-xs';
            cancelBtnA.textContent = 'Cancel';
            cancelBtnA.addEventListener('click', () => this.closeTransferModal());

            const attendedBtn = document.createElement('button');
            attendedBtn.type = 'button';
            attendedBtn.className = 'btn btn-primary text-xs';
            attendedBtn.textContent = 'Consult & Transfer';
            attendedBtn.style.background = 'var(--accent-green)';
            attendedBtn.addEventListener('click', () => this.executeAttendedTransfer());

            attendedActions.appendChild(cancelBtnA);
            attendedActions.appendChild(attendedBtn);

            if (actionRow) {
                actionRow.insertAdjacentElement('afterend', attendedActions);
            } else {
                card.appendChild(attendedActions);
            }

            // Tab switching logic
            const switchTab = (tab) => {
                const isBlind = tab === 'blind';
                blindTab.style.borderBottomColor = isBlind ? 'var(--accent-color)' : 'transparent';
                blindTab.style.color = isBlind ? 'var(--accent-color)' : 'var(--text-muted)';
                attendedTab.style.borderBottomColor = isBlind ? 'transparent' : 'var(--accent-green)';
                attendedTab.style.color = isBlind ? 'var(--text-muted)' : 'var(--accent-green)';

                if (actionRow) actionRow.style.display = isBlind ? '' : 'none';
                attendedActions.style.display = isBlind ? 'none' : '';
            };

            blindTab.addEventListener('click', () => switchTab('blind'));
            attendedTab.addEventListener('click', () => switchTab('attended'));
        }

        closeTransferModal() {
            this.dom.transferModal.classList.add('hidden');
        }

        executeBlindTransfer() {
            const callId = document.getElementById('transferCallIdInput').value;
            const target = document.getElementById('transferTargetInput').value.trim();
            if (!target) {
                this.showToast('Target extension is required', 'error');
                return;
            }
            try {
                const activeCore = (this.transferCallLine === 'line2' && this.line2Core) ? this.line2Core : this.core;
                activeCore.blindTransfer(callId, target);
                this.closeTransferModal();
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        }

        executeAttendedTransfer() {
            const callId = document.getElementById('transferCallIdInput').value;
            const target = document.getElementById('transferTargetInput').value.trim();
            if (!target) {
                this.showToast('Target extension is required', 'error');
                return;
            }
            try {
                const activeCore = (this.transferCallLine === 'line2' && this.line2Core) ? this.line2Core : this.core;
                activeCore.attendedTransfer(callId, target);
                this.attendedTransferState = { callId: callId, target: target };
                this.closeTransferModal();
                this.renderActiveCalls();
                this.showToast('Consulting ' + target + '...', 'info');
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        }

        // --- CONTACTS / PHONEBOOK ---
        normalizePhoneNumber(num) {
            if (!num) return '';
            let s = String(num).trim().replace(/[\s\-\(\)\.]/g, '');
            s = s.replace(/^sip:/i, '').split('@')[0];
            if (s.startsWith('+20') && s.length >= 12) {
                s = '0' + s.substring(3);
            } else if (s.startsWith('0020') && s.length >= 13) {
                s = '0' + s.substring(4);
            } else if (s.startsWith('+')) {
                s = s.substring(1);
            }
            return s;
        }

        loadContacts() {
            let contacts = [];
            try {
                contacts = JSON.parse(localStorage.getItem(this.CONTACTS_KEY) || '[]');
            } catch (_) {
                contacts = [];
            }
            this._contacts = contacts;

            // Asynchronously fetch contacts from Sokrat VoIP shared address book
            const prefix = (typeof window !== 'undefined' && window.location.pathname.startsWith('/phone')) ? '/phone' : '';
            fetch(`${prefix}/api/contacts`)
                .then(r => r.json())
                .then(data => {
                    if (data.success && Array.isArray(data.contacts)) {
                        const favSet = new Set(this.getFavorites());
                        const serverContacts = data.contacts.map(c => ({
                            id: c.id || ('contact_' + (c.dbId || Date.now())),
                            dbId: c.dbId,
                            name: c.name || (c.lastName ? `${c.firstName} ${c.lastName}` : c.firstName) || c.number,
                            firstName: c.firstName || '',
                            lastName: c.lastName || '',
                            number: String(c.number || '').trim(),
                            isFavorite: favSet.has(String(c.number).trim()),
                            isExtension: Boolean(c.isExtension)
                        })).filter(c => Boolean(c.number));

                        this._contacts = serverContacts;
                        this.saveContacts(serverContacts);
                        this.renderContacts();
                        this.renderFavorites();
                        this.renderLine2Contacts();
                    }
                })
                .catch(err => {
                    console.warn('[SoftphoneUI] Remote contacts fetch fallback to cache:', err?.message);
                });

            return contacts;
        }

        saveContacts(contacts) {
            this._contacts = contacts || [];
            localStorage.setItem(this.CONTACTS_KEY, JSON.stringify(this._contacts));
        }

        getContacts() {
            if (!this._contacts || this._contacts.length === 0) {
                try {
                    this._contacts = JSON.parse(localStorage.getItem(this.CONTACTS_KEY) || '[]');
                } catch (_) {
                    this._contacts = [];
                }
            }
            return this._contacts || [];
        }

        findContactByNumber(number) {
            if (!number) return null;
            const targetClean = this.normalizePhoneNumber(number);
            const contacts = this.getContacts();
            if (!targetClean) return null;

            // 1. Exact string match
            let match = contacts.find(c => String(c.number).trim() === String(number).trim());
            if (match) return match;

            // 2. Normalized match
            match = contacts.find(c => this.normalizePhoneNumber(c.number) === targetClean);
            if (match) return match;

            // 3. Suffix match (last 8 digits)
            if (targetClean.length >= 7) {
                const targetSuffix = targetClean.slice(-8);
                match = contacts.find(c => {
                    const cClean = this.normalizePhoneNumber(c.number);
                    return cClean.length >= 7 && (cClean.slice(-8) === targetSuffix || cClean.endsWith(targetClean) || targetClean.endsWith(cClean));
                });
                if (match) return match;
            }

            return null;
        }

        renderContacts(filter) {
            // Find or create the contacts section in the right column
            let section = document.getElementById('contactsSection');
            if (!section) {
                const container = document.getElementById('tabContentContacts') || document.body;
                section = document.createElement('div');
                section.id = 'contactsSection';
                section.className = 'contacts-sec';
                container.appendChild(section);
            }

            section.textContent = '';

            // Header row
            const headerRow = document.createElement('div');
            headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';

            const title = document.createElement('div');
            title.className = 'recent-calls-title';
            title.textContent = 'Contacts';
            headerRow.appendChild(title);

            const addBtn = document.createElement('button');
            addBtn.className = 'btn btn-secondary text-xs';
            addBtn.style.cssText = 'padding:4px 10px;font-size:11px;gap:4px;';
            addBtn.innerHTML = SVG_ICONS.plus + '<span>' + (this.currentLang === 'ar' ? 'إضافة' : 'Add') + '</span>';
            addBtn.addEventListener('click', () => this.openContactModal(null));
            headerRow.appendChild(addBtn);

            section.appendChild(headerRow);

            // Search input
            const searchRow = document.createElement('div');
            searchRow.style.cssText = 'margin-bottom:8px;';
            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.className = 'input-text font-mono';
            searchInput.placeholder = 'Search contacts...';
            searchInput.style.cssText = 'width:100%;font-size:11px;padding:6px 10px;';
            if (filter) searchInput.value = filter;
            searchInput.addEventListener('input', () => {
                this.renderContactsList(section, searchInput.value.trim().toLowerCase());
            });
            searchRow.appendChild(searchInput);
            section.appendChild(searchRow);

            // Contacts list
            this.renderContactsList(section, filter ? filter.toLowerCase() : '');
        }

        renderContactsList(section, filterLower) {
            // Remove existing list if present
            let listEl = section.querySelector('.contacts-list');
            if (listEl) listEl.remove();

            listEl = document.createElement('div');
            listEl.className = 'contacts-list';
            section.appendChild(listEl);

            const contacts = this.getContacts();
            const filtered = filterLower
                ? contacts.filter(c => (c.name && c.name.toLowerCase().includes(filterLower)) || (c.number && c.number.includes(filterLower)))
                : contacts;

            if (filtered.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'text-center py-6 text-xs text-muted';
                emptyMsg.textContent = filterLower ? 'No contacts match your search.' : 'No contacts yet. Add one!';
                listEl.appendChild(emptyMsg);
                return;
            }

            filtered.forEach((contact, index) => {
                const card = document.createElement('div');
                card.className = 'recent-card';

                // HTML5 Drag and Drop support
                if (!filterLower) {
                    card.draggable = true;
                    card.dataset.contactId = contact.id;
                    card.dataset.index = index;

                    card.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('text/plain', String(index));
                        card.classList.add('is-dragging');
                    });
                    card.addEventListener('dragend', () => {
                        card.classList.remove('is-dragging');
                        listEl.querySelectorAll('.recent-card').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
                    });
                    card.addEventListener('dragover', (e) => {
                        e.preventDefault();
                        const rect = card.getBoundingClientRect();
                        const midY = rect.top + rect.height / 2;
                        if (e.clientY < midY) {
                            card.classList.add('drag-over-top');
                            card.classList.remove('drag-over-bottom');
                        } else {
                            card.classList.add('drag-over-bottom');
                            card.classList.remove('drag-over-top');
                        }
                    });
                    card.addEventListener('dragleave', () => {
                        card.classList.remove('drag-over-top', 'drag-over-bottom');
                    });
                    card.addEventListener('drop', (e) => {
                        e.preventDefault();
                        card.classList.remove('drag-over-top', 'drag-over-bottom');
                        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                        if (!isNaN(fromIdx) && fromIdx !== index) {
                            this.reorderContactByIndex(fromIdx, index);
                        }
                    });
                }

                const left = document.createElement('div');
                left.className = 'recent-left';

                if (!filterLower) {
                    const grip = document.createElement('div');
                    grip.className = 'contact-drag-handle';
                    grip.title = this.currentLang === 'ar' ? 'اسحب لإعادة الترتيب' : 'Drag to reorder';
                    grip.innerHTML = '<svg width="8" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="4" r="2.5"/><circle cx="16" cy="4" r="2.5"/><circle cx="8" cy="12" r="2.5"/><circle cx="16" cy="12" r="2.5"/><circle cx="8" cy="20" r="2.5"/><circle cx="16" cy="20" r="2.5"/></svg>';
                    left.appendChild(grip);
                }

                const avatar = document.createElement('div');
                avatar.className = 'recent-avatar';
                avatar.textContent = (contact.name || 'C').charAt(0).toUpperCase();

                const info = document.createElement('div');
                info.className = 'recent-info';

                const nameSpan = document.createElement('div');
                nameSpan.className = 'recent-name';
                nameSpan.textContent = contact.name || contact.number;
                nameSpan.title = contact.name || contact.number;

                const numSpan = document.createElement('div');
                numSpan.className = 'contact-phone-number';
                numSpan.textContent = contact.number;
                info.appendChild(nameSpan);
                info.appendChild(numSpan);
                left.appendChild(avatar);
                left.appendChild(info);

                const right = document.createElement('div');
                right.className = 'recent-right';
                right.style.cssText = 'display:flex;align-items:center;gap:3px;';


                // Favorite toggle
                const favBtn = document.createElement('button');
                favBtn.type = 'button';
                favBtn.className = 'recent-call-btn btn-fav';
                favBtn.title = contact.isFavorite ? (this.currentLang === 'ar' ? 'إزالة من المفضلة' : 'Remove from favorites') : (this.currentLang === 'ar' ? 'إضافة للمفضلة في الأعلى' : 'Add to top of favorites');
                favBtn.innerHTML = contact.isFavorite ? SVG_ICONS.starFilled : SVG_ICONS.star;
                if (contact.isFavorite) favBtn.style.color = '#f59e0b';
                favBtn.addEventListener('click', () => {
                    this.toggleFavorite(contact.number);
                });

                // Call button
                const callBtn = document.createElement('button');
                callBtn.type = 'button';
                callBtn.className = 'recent-call-btn btn-call';
                callBtn.title = 'Call';
                callBtn.innerHTML = SVG_ICONS.phone;
                callBtn.addEventListener('click', () => {
                    this.dom.dialInput.value = contact.number;
                    this.handleCallAction();
                });

                // Edit button
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'recent-call-btn btn-edit';
                editBtn.title = 'Edit';
                editBtn.innerHTML = SVG_ICONS.edit;
                editBtn.addEventListener('click', () => this.openContactModal(contact));

                // Delete button
                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'recent-call-btn btn-del';
                delBtn.title = 'Delete';
                delBtn.innerHTML = SVG_ICONS.trash;
                delBtn.style.color = 'var(--accent-color)';
                delBtn.addEventListener('click', () => this.deleteContact(contact.id));

                right.appendChild(favBtn);
                right.appendChild(callBtn);
                right.appendChild(editBtn);
                right.appendChild(delBtn);

                card.appendChild(left);
                card.appendChild(right);
                listEl.appendChild(card);
            });
        }

        moveContact(id, direction) {
            let contacts = [...this.getContacts()];
            const idx = contacts.findIndex(c => c.id === id);
            if (idx === -1) return;

            const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
            if (targetIdx < 0 || targetIdx >= contacts.length) return;

            const temp = contacts[idx];
            contacts[idx] = contacts[targetIdx];
            contacts[targetIdx] = temp;

            this.saveContacts(contacts);
            this.renderFavorites();
            this.renderContacts();
            this.renderLine2Contacts();
        }

        reorderContactByIndex(fromIndex, toIndex) {
            let contacts = [...this.getContacts()];
            if (fromIndex < 0 || fromIndex >= contacts.length || toIndex < 0 || toIndex >= contacts.length || fromIndex === toIndex) return;

            const [moved] = contacts.splice(fromIndex, 1);
            contacts.splice(toIndex, 0, moved);

            this.saveContacts(contacts);
            this.renderFavorites();
            this.renderContacts();
            this.renderLine2Contacts();
        }

        openContactModal(contact) {
            const isEdit = Boolean(contact);

            // Create modal dynamically if not present
            let modal = document.getElementById('contactModal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'contactModal';
                modal.className = 'modal-backdrop hidden';
                modal.innerHTML = '<div class="modal-card">' +
                    '<h3 id="contactModalTitle" style="font-size:15px;font-weight:800;margin-bottom:12px;color:var(--accent-color);"></h3>' +
                    '<div class="mb-3">' +
                    '  <label class="text-xs font-bold text-secondary">Name:</label>' +
                    '  <input type="text" id="contactNameInput" class="input-text mt-1" placeholder="John Doe">' +
                    '</div>' +
                    '<div class="mb-3">' +
                    '  <label class="text-xs font-bold text-secondary">Number / Extension:</label>' +
                    '  <input type="text" id="contactNumberInput" class="input-text font-mono mt-1" placeholder="101">' +
                    '</div>' +
                    '<input type="hidden" id="contactIdInput">' +
                    '<div class="flex items-center justify-end gap-2">' +
                    '  <button type="button" id="contactCancelBtn" class="btn btn-secondary text-xs">Cancel</button>' +
                    '  <button type="button" id="contactSaveBtn" class="btn btn-primary text-xs">Save</button>' +
                    '</div>' +
                    '</div>';
                document.body.appendChild(modal);

                document.getElementById('contactCancelBtn').addEventListener('click', () => {
                    modal.classList.add('hidden');
                });
                document.getElementById('contactSaveBtn').addEventListener('click', () => {
                    this.saveContactFromModal();
                });
            }

            document.getElementById('contactModalTitle').textContent = isEdit ? 'Edit Contact' : 'Add Contact';
            document.getElementById('contactIdInput').value = isEdit ? contact.id : '';
            document.getElementById('contactNameInput').value = isEdit ? (contact.name || '') : '';
            document.getElementById('contactNumberInput').value = isEdit ? (contact.number || '') : '';

            modal.classList.remove('hidden');
        }

        async saveContactFromModal() {
            const id = document.getElementById('contactIdInput').value;
            const name = document.getElementById('contactNameInput').value.trim();
            const number = document.getElementById('contactNumberInput').value.trim();

            if (!name || !number) {
                this.showToast(this.currentLang === 'ar' ? 'الاسم ورقم الهاتف مطلوبان' : 'Name and number are required', 'error');
                return;
            }

            const isEdit = Boolean(id);
            const prefix = (typeof window !== 'undefined' && window.location.pathname.startsWith('/phone')) ? '/phone' : '';
            const endpoint = isEdit ? `${prefix}/api/contacts/edit` : `${prefix}/api/contacts/add`;

            let firstName = name;
            let lastName = '';
            const spaceIdx = name.indexOf(' ');
            if (spaceIdx > 0) {
                firstName = name.substring(0, spaceIdx).trim();
                lastName = name.substring(spaceIdx + 1).trim();
            }

            try {
                const resp = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id,
                        firstName,
                        lastName,
                        name,
                        number,
                        phone: number
                    })
                });
                const data = await resp.json();
                if (data.success) {
                    this.showToast(this.currentLang === 'ar' ? 'تم حفظ جهة الاتصال في دليل Sokrat VoIP' : 'Contact saved to Sokrat VoIP address book', 'success');
                }
            } catch (err) {
                console.warn('[SoftphoneUI] Failed to save contact to server:', err?.message);
            }

            let contacts = this.getContacts();
            const existingIdx = contacts.findIndex(c => c.id === id || (id && c.dbId && `contact_${c.dbId}` === id));

            if (existingIdx >= 0) {
                contacts[existingIdx].name = name;
                contacts[existingIdx].firstName = firstName;
                contacts[existingIdx].lastName = lastName;
                contacts[existingIdx].number = number;
            } else {
                contacts.push({
                    id: id || ('contact_' + Date.now()),
                    name: name,
                    firstName: firstName,
                    lastName: lastName,
                    number: number,
                    isFavorite: false
                });
            }

            this.saveContacts(contacts);
            document.getElementById('contactModal').classList.add('hidden');
            this.renderFavorites();
            this.renderContacts();
            this.renderLine2Contacts();

            setTimeout(() => this.loadContacts(), 400);
        }

        async deleteContact(id) {
            const isAr = this.currentLang === 'ar';
            if (!confirm(isAr ? 'هل أنت متأكد من حذف جهة الاتصال؟' : 'Are you sure you want to delete this contact?')) {
                return;
            }

            const prefix = (typeof window !== 'undefined' && window.location.pathname.startsWith('/phone')) ? '/phone' : '';
            try {
                await fetch(`${prefix}/api/contacts/delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
            } catch (err) {
                console.warn('[SoftphoneUI] Server delete failed:', err?.message);
            }

            let contacts = this.getContacts().filter(c => c.id !== id && `contact_${c.dbId}` !== id);
            this.saveContacts(contacts);
            this.renderFavorites();
            this.renderContacts();
            this.renderLine2Contacts();
            this.showToast(isAr ? 'تم حذف جهة الاتصال' : 'Contact deleted', 'info');
        }

        // --- SPEED DIAL / FAVORITES ---
        getFavorites() {
            try {
                return JSON.parse(localStorage.getItem(this.FAVORITES_KEY) || '[]');
            } catch (_) {
                return [];
            }
        }

        saveFavorites(favs) {
            localStorage.setItem(this.FAVORITES_KEY, JSON.stringify(favs));
        }

        toggleFavorite(number) {
            if (!number) return;
            const numStr = String(number);
            let contacts = this.getContacts();
            const idx = contacts.findIndex(c => c.number === numStr);
            if (idx === -1) return;

            const contact = contacts[idx];
            contact.isFavorite = !contact.isFavorite;

            // When favorited, push directly to the top of the contacts list
            if (contact.isFavorite) {
                contacts.splice(idx, 1);
                contacts.unshift(contact);
            } else {
                // If unfavorited, place it below any remaining favorites
                const firstNonFavIdx = contacts.findIndex((c, i) => i !== idx && !c.isFavorite);
                if (firstNonFavIdx > 0 && idx < firstNonFavIdx) {
                    contacts.splice(idx, 1);
                    contacts.splice(firstNonFavIdx, 0, contact);
                }
            }
            this.saveContacts(contacts);

            // Update favorites list
            let favs = this.getFavorites();
            const fIdx = favs.indexOf(numStr);
            if (contact.isFavorite && fIdx === -1) {
                favs.unshift(numStr);
            } else if (!contact.isFavorite && fIdx >= 0) {
                favs.splice(fIdx, 1);
            }
            this.saveFavorites(favs);
            this.renderFavorites();
            this.renderContacts();
            this.renderLine2Contacts();
            this.showToast(contact.isFavorite ? (this.currentLang === 'ar' ? 'تمت الإضافة للمفضلة في الأعلى' : 'Added to favorites at the top') : (this.currentLang === 'ar' ? 'تمت الإزالة من المفضلة' : 'Removed from favorites'), 'info');
        }

        renderFavorites() {
            let section = document.getElementById('favoritesSection');
            const rightCol = document.querySelector('.right-col');
            if (!rightCol) return;

            if (!section) {
                section = document.createElement('div');
                section.id = 'favoritesSection';
                section.style.cssText = 'margin-bottom:4px;';
                // Insert before recent calls or at top of right col
                const recentSec = rightCol.querySelector('.recent-calls-sec');
                if (recentSec) {
                    rightCol.insertBefore(section, recentSec);
                } else {
                    rightCol.appendChild(section);
                }
            }

            section.textContent = '';

            const favNumbers = this.getFavorites();
            const contacts = this.getContacts();
            const favContacts = favNumbers.map(num => contacts.find(c => c.number === num)).filter(Boolean);

            // Also include contacts marked as favorite that might not be in the favorites list
            contacts.forEach(c => {
                if (c.isFavorite && !favContacts.find(fc => fc.number === c.number)) {
                    favContacts.push(c);
                }
            });

            if (favContacts.length === 0) {
                section.style.display = 'none';
                return;
            }

            section.style.display = '';

            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;display:flex;align-items:center;gap:4px;';
            titleEl.innerHTML = SVG_ICONS.starFilled + ' Speed Dial';
            titleEl.querySelector('svg').style.color = '#f59e0b';
            section.appendChild(titleEl);

            const chipsRow = document.createElement('div');
            chipsRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';

            favContacts.forEach(contact => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'btn btn-secondary text-xs';
                chip.style.cssText = 'padding:4px 10px;font-size:10px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;';
                chip.innerHTML = SVG_ICONS.phone + ' <span>' + (contact.name || contact.number) + '</span>';
                chip.title = 'Call ' + contact.number;
                chip.addEventListener('click', () => {
                    this.dom.dialInput.value = contact.number;
                    this.handleCallAction();
                });
                chipsRow.appendChild(chip);
            });

            section.appendChild(chipsRow);
        }

        // --- DOCUMENT PICTURE IN PICTURE ---
        async toggleDocumentPip() {
            if (!window.documentPictureInPicture || typeof window.documentPictureInPicture.requestWindow !== 'function') {
                this.openPersistentWindow();
                return;
            }

            if (this.pipWindow) {
                this.pipWindow.close();
                this.pipWindow = null;
                return;
            }

            try {
                this.pipWindow = await window.documentPictureInPicture.requestWindow({ width: 340, height: 520 });
                document.querySelectorAll('link[rel="stylesheet"], style').forEach(s => this.pipWindow.document.head.appendChild(s.cloneNode(true)));
                const root = document.querySelector('.app-window').cloneNode(true);
                this.pipWindow.document.body.appendChild(root);
            } catch (_) {
                this.openPersistentWindow();
            }
        }

        applySavedTheme() {
            const theme = localStorage.getItem(this.THEME_KEY);
            if (theme === 'light') {
                document.documentElement.classList.add('light-theme');
            } else {
                document.documentElement.classList.remove('light-theme');
            }
        }

        toggleTheme() {
            const isLight = document.documentElement.classList.toggle('light-theme');
            localStorage.setItem(this.THEME_KEY, isLight ? 'light' : 'dark');
            this.showToast(isLight ? 'Switched to Light Theme' : 'Switched to OLED Dark Theme', 'info');
        }

        // --- CLICK-TO-CALL ENGINE (URL params, hash, postMessage, BroadcastChannel) ---
        setupClickToCall() {
            const sanitize = (val) => {
                if (!val) return '';
                try {
                    return decodeURIComponent(String(val)).replace(/["'>].*$/, '').replace(/[^\d+*#]/g, '').trim();
                } catch (_) {
                    return String(val).replace(/["'>].*$/, '').replace(/[^\d+*#]/g, '').trim();
                }
            };

            // 1. Process URL search parameters (?call=101, ?ext=150, ?allowedOrigin=...)
            const handleUrlParams = () => {
                const params = new URLSearchParams(window.location.search);
                const rawCall = params.get('call') || params.get('number') || params.get('phone');
                const rawDial = params.get('dial');
                const auto = params.get('auto') === '1' || params.get('auto') === 'true' || Boolean(rawCall);

                // Whitelist allowed CRM origin if provided in query string
                const allowedOrig = params.get('allowedOrigin') || params.get('origin') || params.get('crmOrigin');
                if (allowedOrig) {
                    this.allowedOrigins = this.allowedOrigins || [];
                    if (!this.allowedOrigins.includes(allowedOrig)) {
                        this.allowedOrigins.push(allowedOrig);
                    }
                }

                // Automatic extension selection and WebRTC connection from CRM URL parameters
                const targetExt = params.get('ext') || params.get('extension');
                const targetSecret = params.get('secret') || params.get('password');
                const autoConnect = params.get('autoConnect') === '1' || params.get('autoConnect') === 'true' || params.get('autoLogin') === '1' || params.get('autoLogin') === 'true';

                if (targetExt) {
                    this.selectPresetByExtension(targetExt);
                    if (targetSecret && this.dom.passwordInput) {
                        this.dom.passwordInput.value = targetSecret;
                        this.lastSessionPassword = targetSecret;
                    }
                    if (autoConnect && targetSecret && this.dom.connectBtn && this.core.regState === 'DISCONNECTED') {
                        setTimeout(() => {
                            if (this.dom.connectBtn && this.core.regState === 'DISCONNECTED') {
                                this.dom.connectBtn.click();
                            }
                        }, 250);
                    }
                }

                const target = sanitize(rawCall || rawDial);
                if (target) {
                    this.clickToCall(target, auto);
                }
            };

            // 2. Process URL hash parameters (#call=101 or #dial=101)
            const handleHash = () => {
                if (!window.location.hash) return;
                const hash = window.location.hash.substring(1);
                const params = new URLSearchParams(hash);
                const rawCall = params.get('call') || params.get('number') || params.get('phone');
                const rawDial = params.get('dial');
                const auto = params.get('auto') === '1' || params.get('auto') === 'true' || Boolean(rawCall);

                let raw = rawCall || rawDial;
                if (!raw && (hash.startsWith('tel:') || hash.startsWith('call:'))) {
                    raw = hash.replace(/^(tel|call):/, '');
                }
                const target = sanitize(raw);
                if (target) {
                    this.clickToCall(target, auto);
                }
            };

            handleUrlParams();
            handleHash();
            window.addEventListener('hashchange', handleHash);

            // 3. Action Dispatcher for CRM postMessage & BroadcastChannel
            const handleAction = (data, source = null, origin = '*') => {
                if (!data) return;
                const type = String(data.type || data.action || '').toLowerCase();
                const activeCalls = this.core.activeCalls ? Array.from(this.core.activeCalls.values()) : [];
                const activeCall = activeCalls[0];
                const incomingCall = activeCalls.find(c => c.direction === 'incoming' && !c.answerTime);
                const outgoingRingingCall = activeCalls.find(c => c.direction === 'outgoing' && !c.answerTime);

                // 1. DIAL / CLICK_TO_CALL (Idle State)
                if (type === 'sokrat.voice.dial' || type === 'click_to_call' || type === 'dial' || type === 'call') {
                    const raw = data.payload?.phone || data.number || data.phone || data.target || data.ext;
                    const autoCall = data.payload ? (data.payload.autoCall !== false) : (data.autoCall !== false && data.auto !== false);
                    const target = sanitize(raw);
                    if (target) this.clickToCall(target, autoCall);
                }
                // 2. ANSWER (Incoming Ringing Call)
                else if (type === 'sokrat.voice.answer' || type === 'answer') {
                    const targetCall = incomingCall || activeCall;
                    if (targetCall) this.core.answerCall(targetCall.id);
                }
                // 3. REJECT / DECLINE (Incoming Ringing Call)
                else if (type === 'sokrat.voice.reject' || type === 'sokrat.voice.decline' || type === 'reject' || type === 'decline') {
                    const targetCall = incomingCall || activeCall;
                    if (targetCall) this.core.hangupCall(targetCall.id);
                }
                // 4. CANCEL (Outgoing Ringing Call)
                else if (type === 'sokrat.voice.cancel' || type === 'cancel') {
                    const targetCall = outgoingRingingCall || activeCall;
                    if (targetCall) this.core.hangupCall(targetCall.id);
                }
                // 5. HANGUP (Active Call)
                else if (type === 'sokrat.voice.hangup' || type === 'hangup' || type === 'terminate') {
                    if (activeCall) this.core.hangupCall(activeCall.id);
                    else this.core.hangupAllCalls();
                }
                // 6. HOLD / UNHOLD (Active Call)
                else if (type === 'sokrat.voice.hold' || type === 'hold') {
                    if (activeCall && !activeCall.isHold) this.core.toggleHold(activeCall.id);
                }
                else if (type === 'sokrat.voice.unhold' || type === 'sokrat.voice.resume' || type === 'unhold' || type === 'resume') {
                    if (activeCall && activeCall.isHold) this.core.toggleHold(activeCall.id);
                }
                else if (type === 'sokrat.voice.toggle_hold' || type === 'toggle_hold') {
                    if (activeCall) this.core.toggleHold(activeCall.id);
                }
                // 7. MUTE / UNMUTE (Active Call)
                else if (type === 'sokrat.voice.mute' || type === 'mute') {
                    if (activeCall && !activeCall.isMuted) this.core.toggleMute(activeCall.id);
                }
                else if (type === 'sokrat.voice.unmute' || type === 'unmute') {
                    if (activeCall && activeCall.isMuted) this.core.toggleMute(activeCall.id);
                }
                else if (type === 'sokrat.voice.toggle_mute' || type === 'toggle_mute') {
                    if (activeCall) this.core.toggleMute(activeCall.id);
                }
                // 8. DTMF (Active Call)
                else if (type === 'sokrat.voice.dtmf' || type === 'sokrat.voice.send_dtmf' || type === 'dtmf' || type === 'send_dtmf') {
                    const digits = String(data.payload?.digits || data.digits || data.digit || '').trim();
                    if (activeCall && digits) {
                        for (const d of digits) this.core.sendDTMF(activeCall.id, d);
                    }
                }
                // 9. TRANSFER / REDIRECT (Active Call)
                else if (type === 'sokrat.voice.transfer' || type === 'transfer' || type === 'redirect' || type === 'forward') {
                    const target = sanitize(data.payload?.destination || data.destination || data.target || data.number);
                    if (activeCall && target) this.core.transferCall(activeCall.id, target);
                }
                // 10. DND (Idle / Universal)
                else if (type === 'sokrat.voice.dnd' || type === 'sokrat.voice.set_dnd' || type === 'dnd' || type === 'set_dnd') {
                    const enabled = data.payload ? Boolean(data.payload.enabled) : Boolean(data.enabled);
                    this.toggleDnd(enabled);
                }
                // 11. LOGIN / CONNECT (From CRM Parent Window)
                else if (type === 'sokrat.voice.login' || type === 'login' || type === 'connect') {
                    const ext = data.payload?.extension || data.payload?.ext || data.extension || data.ext;
                    const secret = data.payload?.secret || data.payload?.password || data.secret || data.password;
                    const auto = data.payload ? (data.payload.autoConnect !== false) : (data.autoConnect !== false);
                    if (ext) this.selectPresetByExtension(ext);
                    if (secret && this.dom.passwordInput) {
                        this.dom.passwordInput.value = secret;
                        this.lastSessionPassword = secret;
                    }
                    if (auto && this.dom.connectBtn && this.core.regState === 'DISCONNECTED') {
                        setTimeout(() => {
                            if (this.dom.connectBtn && this.core.regState === 'DISCONNECTED') {
                                this.dom.connectBtn.click();
                            }
                        }, 100);
                    }
                }
                // 12. LOGOUT / DISCONNECT (From CRM Parent Window)
                else if (type === 'sokrat.voice.logout' || type === 'logout' || type === 'disconnect') {
                    if (this.core.regState === 'REGISTERED' && this.dom.connectBtn) {
                        this.dom.connectBtn.click();
                    }
                }
                // 13. GET_STATE (Universal Query)
                else if (type === 'sokrat.voice.get_state' || type === 'get_state' || type === 'state') {
                    let stateName = 'IDLE';
                    if (incomingCall) stateName = 'RINGING_INCOMING';
                    else if (outgoingRingingCall) stateName = 'RINGING_OUTGOING';
                    else if (activeCall) stateName = activeCall.isHold ? 'HELD' : 'IN_CALL';

                    const statePayload = {
                        version: 1,
                        type: 'sokrat.voice.state',
                        payload: {
                            state: stateName,
                            regState: this.core.regState,
                            extension: this.core.currentExtension || '',
                            activeCallsCount: activeCalls.length,
                            activeCall: activeCall ? {
                                id: activeCall.id,
                                target: activeCall.target,
                                direction: activeCall.direction,
                                duration: activeCall.answerTime ? Math.round((Date.now() - activeCall.answerTime) / 1000) : 0,
                                isMuted: Boolean(activeCall.isMuted),
                                isHold: Boolean(activeCall.isHold)
                            } : null
                        }
                    };
                    if (source && typeof source.postMessage === 'function') {
                        source.postMessage(statePayload, origin || '*');
                    }
                    window.postMessage(statePayload, '*');
                }
            };

            // 4. Cross-Window postMessage Listener (for CRM iframes, popups & host windows)
            window.addEventListener('message', (event) => {
                const isAllowedOrigin = event.origin === window.location.origin ||
                    event.source === window.parent ||
                    /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(event.origin) ||
                    (this.allowedOrigins && (this.allowedOrigins.includes(event.origin) || this.allowedOrigins.includes('*')));

                if (!isAllowedOrigin) {
                    console.warn('[Softphone Security] Blocked cross-origin postMessage from:', event.origin);
                    return;
                }
                handleAction(event.data, event.source, event.origin);
            });

            // 5. BroadcastChannel Listener (for multi-tab / Sokrat VoIP dashboard integration)
            try {
                if (typeof BroadcastChannel !== 'undefined') {
                    const bus = new BroadcastChannel('sokrat_softphone_bus');
                    bus.addEventListener('message', (event) => {
                        handleAction(event.data);
                    });
                }
            } catch (_) {}
            // 5. Global helper functions
            window.sokratClickToCall = (number, autoCall = true) => this.clickToCall(sanitize(number), autoCall);
            window.softphoneClickToCall = (number, autoCall = true) => this.clickToCall(sanitize(number), autoCall);
        }

        clickToCall(number, autoCall = true) {
            const cleanNum = String(number).trim().replace(/[^\d+*#]/g, '');
            if (!cleanNum) return;

            // Switch to dialer tab
            this.switchTab('dialer');

            // Populate input
            this.realDialNumber = cleanNum;
            if (this.dom.dialInput) {
                this.dom.dialInput.value = this.maskPhoneNumbers ? this.maskPhoneNumber(cleanNum) : cleanNum;
            }

            if (autoCall) {
                if (this.core.regState === 'REGISTERED') {
                    this.handleCallAction();
                } else {
                    this.pendingCallTarget = cleanNum;

                    // Check if credentials are present to auto-connect
                    const preset = this.getSelectedPreset();
                    const secret = (preset ? (preset.secret || this.sessionSecrets.get(preset.id) || this.lastSessionPassword || '') : '');

                    if (preset && secret && (this.core.regState === 'DISCONNECTED' || !this.core.ua)) {
                        this.showToast(`Connecting Ext ${preset.extension} to call ${cleanNum}...`, 'info');
                        if (this.dom.connectBtn) this.dom.connectBtn.click();
                    } else if (!secret) {
                        this.updateViewMode('login');
                        this.showToast(`Log in to call ${cleanNum}`, 'warning');
                    } else {
                        this.showToast(`Click-to-call: ${cleanNum}`, 'info');
                    }

                    // Once registered, auto-dial the pending call
                    this.core.once('registered', () => {
                        if (this.pendingCallTarget === cleanNum && this.core.activeCalls.size === 0) {
                            setTimeout(() => {
                                if (this.pendingCallTarget === cleanNum) {
                                    this.handleCallAction();
                                    this.pendingCallTarget = null;
                                }
                            }, 350);
                        }
                    });
                }
            }
        }

    }

    function startSoftphoneApp() {
        if (!window._realSoftphoneUi) {
            window._realSoftphoneUi = new SokratSoftphoneUI();
            window.softphoneUi = window._realSoftphoneUi;
            window._realSoftphoneUi.init();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startSoftphoneApp);
    } else {
        startSoftphoneApp();
    }

})(window, document);
