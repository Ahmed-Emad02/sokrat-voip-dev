/**
 * Sokrat Standalone WebRTC Softphone UI Controller v3.0
 * Full-screen call view, quality badge, recording indicator,
 * browser notifications, attended transfer, contacts, favorites
 */

(function (window, document) {
    'use strict';

    const SVG_ICONS = {
        phone: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
        phoneOff: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.5 16.5l3.5 3.5a2 2 0 0 0 2.18-2 19.79 19.79 0 0 0-8.63-3.07"/><path d="M4.11 2a2 2 0 0 0-2 2.18 19.79 19.79 0 0 0 3.07 8.63l3.5 3.5"/><path d="M14.05 9.05a12.84 12.84 0 0 0-.7-2.81 2 2 0 0 0-2-1.72h-3a2 2 0 0 0-1.72.98"/></svg>',
        mic: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
        micOff: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
        pause: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
        play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
        transfer: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
        dnd: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
        autoAnswer: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        headphones: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
        users: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        voicemail: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="4"/><circle cx="18" cy="12" r="4"/><line x1="6" y1="16" x2="18" y2="16"/></svg>',
        settings: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        star: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        starFilled: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        contact: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
        plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
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
            dialPlaceholder: '1-555-0199',
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
            toastError: 'خطأ: {msg}'
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
            dialPlaceholder: '1-555-0199',
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
            toastError: 'Error: {msg}'
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
        constructor() {
            this.currentLang = (document.documentElement.lang === 'ar') ? 'ar' : 'en';
            this.t = I18N[this.currentLang] || I18N.en;
            this.core = new SokratSoftphoneCore();

            this.PRESETS_KEY = 'sokrat_softphone_presets_v2';
            this.LOGS_KEY = 'sokrat_softphone_call_logs_v2';
            this.THEME_KEY = 'sokrat_softphone_theme';
            this.CONTACTS_KEY = 'sokrat_softphone_contacts_v2';
            this.FAVORITES_KEY = 'sokrat_softphone_favorites_v2';
            this.serverExtensionsList = [];
            this.serverWebrtcList = [];
            this.serverHost = window.location.hostname || '127.0.0.1';
            this.serverDefaultWss = `wss://${this.serverHost}:8089/ws`;

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
            this.enumerateAudioDevices();
            this.checkMicrophonePermissionInitial();
            this.requestNotificationPermissionInitial();
            this.startCallTimerTicker();
            this.updateInCallButtonStates();
            this.updateViewMode(this.core.regState === 'REGISTERED' ? 'console' : 'login');
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
            this.dom.activeCallContainer = document.getElementById('activeCallContainer');
            this.dom.callHistoryList = document.getElementById('callHistoryList');
            this.dom.micBanner = document.getElementById('micBanner');
            this.dom.takeOverOverlay = document.getElementById('takeOverOverlay');
            this.dom.toastContainer = document.getElementById('toastContainer');
            this.dom.remoteAudio = document.getElementById('remoteAudio');
            this.dom.audioInputSelect = document.getElementById('audioInputSelect');
            this.dom.audioOutputSelect = document.getElementById('audioOutputSelect');
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
                    content.style.display = (tab === tabName) ? 'block' : 'none';
                }
            });

            if (tabName === 'contacts') {
                this.renderContacts();
            } else if (tabName === 'history') {
                this.loadCallLogs();
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
                passInput.value = matchingPreset.secret || '';
            }
        }
        async submitLogin() {
            const extInput = document.getElementById('loginExtInput');
            const passInput = document.getElementById('loginPasswordInput');
            const rememberCheckbox = document.getElementById('loginRememberCheckbox');

            const extension = extInput ? extInput.value.trim() : '';
            const password = passInput ? passInput.value.trim() : '';
            const remember = rememberCheckbox ? rememberCheckbox.checked : true;

            if (!extension) {
                this.showToast('Please select or enter an extension number', 'error');
                return;
            }
            if (!password) {
                this.showToast('Please enter the extension password', 'error');
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
                this.sessionSecrets.set(preset.id, password);
            }

            try {
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<span>Connecting...</span>';
                }
                await this.core.connect(preset, password);
            } catch (err) {
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>Login & Connect</span>';
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
                emptyMsg.textContent = this.currentLang === 'ar' ? 'لا توجد تحويلات محفوظة بعد.' : 'No saved extensions yet.';
                listEl.appendChild(emptyMsg);
                return;
            }

            presets.forEach(p => {
                const card = document.createElement('div');
                card.className = 'saved-login-card';

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
                const dotSpan = document.createElement('span');
                dotSpan.textContent = '● Ext ' + p.extension;
                const sepSpan = document.createElement('span');
                sepSpan.className = 'text-muted';
                sepSpan.textContent = ' • ' + (p.sipDomain || 'PBX');
                extSpan.appendChild(dotSpan);
                extSpan.appendChild(sepSpan);

                details.appendChild(nameSpan);
                details.appendChild(extSpan);
                left.appendChild(avatar);
                left.appendChild(details);

                const actions = document.createElement('div');
                actions.className = 'saved-login-actions';

                const loginBtn = document.createElement('button');
                loginBtn.type = 'button';
                loginBtn.className = 'saved-quick-btn';
                loginBtn.textContent = '1-Click Login ↗';
                loginBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.quickLoginAccount(p.id);
                });

                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'saved-edit-btn';
                editBtn.title = 'Edit account credentials';
                editBtn.innerHTML = SVG_ICONS.edit;
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openPresetModal(p);
                });

                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'saved-del-btn';
                deleteBtn.title = 'Remove saved account';
                deleteBtn.innerHTML = SVG_ICONS.trash;
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    let updated = this.getPresets().filter(pr => pr.id !== p.id);
                    this.savePresets(updated);
                    this.renderSavedAccountsLoginList();
                    this.showToast('Account removed', 'info');
                });

                actions.appendChild(loginBtn);
                actions.appendChild(editBtn);
                actions.appendChild(deleteBtn);
                card.appendChild(left);
                card.appendChild(actions);

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
            if (extSelect) extSelect.value = preset.extension;
            if (passInput) passInput.value = preset.secret || '';
            if (passInput && !preset.secret) passInput.focus();
        }

        async quickLoginAccount(presetId) {
            const presets = this.getPresets();
            const preset = presets.find(p => p.id === presetId);
            if (!preset) return;

            this.selectAccountForLogin(preset);
            const secret = preset.secret || (document.getElementById('loginPasswordInput') ? document.getElementById('loginPasswordInput').value.trim() : '');

            if (!secret) {
                this.showToast('Please enter the password for extension ' + preset.extension, 'warning');
                if (document.getElementById('loginPasswordInput')) document.getElementById('loginPasswordInput').focus();
                return;
            }

            try {
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<span>Connecting Ext ' + preset.extension + '...</span>';
                }
                await this.core.connect(preset, secret);
            } catch (err) {
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>Login & Connect</span>';
                }
                this.showToast(err.message, 'error');
            }
        }

        logout() {
            this.core.disconnect();
            this.updateViewMode('login');
            this.renderSavedAccountsLoginList();
            this.showToast('Logged out of extension', 'info');
        }

        updateViewMode(mode) {
            const loginPage = document.getElementById('loginPage');
            const mainAppWindow = document.getElementById('mainAppWindow');
            if (mode === 'console') {
                if (loginPage) loginPage.style.display = 'none';
                if (mainAppWindow) mainAppWindow.style.display = 'flex';
                const titleEl = document.getElementById('activeAccountHeaderTitle');
                if (titleEl && this.core.activePreset) {
                    titleEl.textContent = 'Ext ' + this.core.activePreset.extension + (this.core.activePreset.label ? ' - ' + this.core.activePreset.label : '');
                }
            } else {
                if (loginPage) loginPage.style.display = 'flex';
                if (mainAppWindow) mainAppWindow.style.display = 'none';
                const submitBtn = document.getElementById('loginSubmitBtn');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>Login & Connect</span>';
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
                line2.style.cssText = 'border-left: 2px solid var(--border-primary); flex: 1; min-width: 360px; display: flex; flex-direction: column; overflow-y: auto;';
                appBody.appendChild(line2);
            }
            line2.style.display = 'flex';
            line2.innerHTML = '<div class="workspace-header">' +
                '<div class="header-title-area"><span class="header-title" style="color:var(--accent-green);font-size:13px;">LINE 2 / EXTENSION 2</span></div>' +
                '<div class="header-status-strip">' +
                '  <select id="line2PresetSelect" class="input-text font-mono font-bold" style="padding:4px 6px;font-size:11px;"></select>' +
                '  <input type="password" id="line2PasswordInput" placeholder="Password" class="input-text font-mono" style="width:75px;padding:4px 6px;font-size:11px;">' +
                '  <button type="button" id="line2ConnectBtn" class="btn btn-primary" style="padding:5px 12px;font-size:11px;min-width:75px;">Connect</button>' +
                '  <div id="line2StatusBadge" class="status-pill"><span style="font-size:7px;">●</span><span id="line2StatusText">Offline</span></div>' +
                '</div>' +
                '</div>' +
                '<div id="line2ActiveCallContainer" style="display:none;padding:8px 12px;"></div>' +
                '<div style="padding:10px 14px;max-width:440px;margin:0 auto;width:100%;">' +
                '  <div class="dialer-input-box">' +
                '    <input type="text" id="line2DialInput" placeholder="Dial extension..." class="dialer-input" autocomplete="off">' +
                '    <button type="button" class="clear-input-btn" onclick="document.getElementById(\'line2DialInput\').value=document.getElementById(\'line2DialInput\').value.slice(0,-1)">✕</button>' +
                '  </div>' +
                '  <div class="keypad-grid" id="line2KeypadGrid"></div>' +
                '  <div class="keypad-action-row">' +
                '    <button type="button" id="line2CallBtn" class="call-pill-btn" style="flex:1;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>Call</span></button>' +
                '    <button type="button" class="call-aux-btn" onclick="document.getElementById(\'line2DialInput\').value=\'\'"><span>Clear</span></button>' +
                '  </div>' +
                '</div>';

            // Populate Line 2 presets
            const line2Select = document.getElementById('line2PresetSelect');
            const presets = this.getPresets();
            if (line2Select && presets.length > 0) {
                line2Select.innerHTML = '';
                presets.forEach((p, idx) => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.label || ('Ext ' + p.extension);
                    if (idx === 1 || (idx === 0 && presets.length === 1)) opt.selected = true;
                    line2Select.appendChild(opt);
                });
            }

            // Render Line 2 Keypad
            const keypadGrid = document.getElementById('line2KeypadGrid');
            if (keypadGrid) {
                ['1','2','3','4','5','6','7','8','9','*','0','#'].forEach(d => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'keypad-btn';
                    btn.textContent = d;
                    btn.addEventListener('click', () => {
                        document.getElementById('line2DialInput').value += d;
                    });
                    keypadGrid.appendChild(btn);
                });
            }

            // Setup Line 2 Core
            if (!this.line2Core) {
                this.line2Core = new SokratSoftphoneCore({ busName: 'sokrat_sp_line2_bus' });
                const audio2 = document.createElement('audio');
                audio2.autoplay = true;
                audio2.playsInline = true;
                document.body.appendChild(audio2);
                this.line2Core.setRemoteAudioElement(audio2);

                this.line2Core.on('regStateChange', ({ state }) => {
                    const badge = document.getElementById('line2StatusBadge');
                    const text = document.getElementById('line2StatusText');
                    const btn = document.getElementById('line2ConnectBtn');
                    if (!badge || !text || !btn) return;
                    badge.className = 'status-pill';
                    if (state === 'REGISTERED') {
                        badge.classList.add('online');
                        text.textContent = 'Available';
                        btn.textContent = 'Disconnect';
                        btn.className = 'btn btn-danger';
                    } else {
                        text.textContent = state === 'CONNECTING' ? 'Connecting...' : 'Offline';
                        btn.textContent = 'Connect';
                        btn.className = 'btn btn-primary';
                    }
                });
            }

            const line2ConnectBtn = document.getElementById('line2ConnectBtn');
            if (line2ConnectBtn) {
                line2ConnectBtn.onclick = async () => {
                    if (this.line2Core.regState === 'REGISTERED') {
                        this.line2Core.disconnect();
                    } else {
                        const selId = document.getElementById('line2PresetSelect').value;
                        const preset = presets.find(p => p.id === selId) || presets[0];
                        const secret = document.getElementById('line2PasswordInput').value.trim() || (preset ? preset.secret : '');
                        if (preset && secret) {
                            await this.line2Core.connect(preset, secret);
                        } else {
                            this.showToast('Please enter password for Line 2', 'error');
                        }
                    }
                };
            }

            const line2CallBtn = document.getElementById('line2CallBtn');
            if (line2CallBtn) {
                line2CallBtn.onclick = () => {
                    const num = document.getElementById('line2DialInput').value.trim();
                    if (num) {
                        this.line2Core.makeCall(num);
                    }
                };
            }
        }



        // --- EXTENSIONS DISCOVERY & PRESETS ---
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
            }

            this.onPresetChanged();
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

            if (this.dom.dndCheckbox) this.dom.dndCheckbox.checked = Boolean(preset.dnd);
            if (this.dom.autoAnswerCheckbox) this.dom.autoAnswerCheckbox.checked = Boolean(preset.autoAnswer);

            if (this.dom.toolBtnDnd) this.dom.toolBtnDnd.classList.toggle('active-dnd', Boolean(preset.dnd));
            if (this.dom.toolBtnAuto) this.dom.toolBtnAuto.classList.toggle('active-auto', Boolean(preset.autoAnswer));

            const secret = preset.secret || this.sessionSecrets.get(preset.id) || '';
            if (this.dom.passwordInput) this.dom.passwordInput.value = secret;

            if (preset.autoConnect && secret && this.core.regState === 'DISCONNECTED') {
                setTimeout(() => {
                    if (this.core.regState === 'DISCONNECTED' && this.dom.connectBtn) {
                        this.dom.connectBtn.click();
                    }
                }, 100);
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

        async openPresetModal(presetToEdit = null) {
            const isEdit = Boolean(presetToEdit);
            await this.fetchServerExtensions();

            document.getElementById('modalPresetTitle').textContent = isEdit ? this.t.editPreset : this.t.addPreset;
            document.getElementById('presetIdInput').value = isEdit ? presetToEdit.id : '';
            document.getElementById('presetLabelInput').value = isEdit ? presetToEdit.label : '';
            document.getElementById('presetExtInput').value = isEdit ? presetToEdit.extension : '';
            document.getElementById('presetDomainInput').value = isEdit ? presetToEdit.sipDomain : this.serverHost;
            document.getElementById('presetWssInput').value = isEdit ? presetToEdit.wssUrl : this.serverDefaultWss;
            document.getElementById('presetDefaultCheckbox').checked = isEdit ? Boolean(presetToEdit.isDefault) : false;
            const secretInput = document.getElementById('presetSecretInput');
            if (secretInput) secretInput.value = isEdit ? (presetToEdit.secret || '') : '';
            const autoConnectCheckbox = document.getElementById('presetAutoConnectCheckbox');
            if (autoConnectCheckbox) autoConnectCheckbox.checked = isEdit ? Boolean(presetToEdit.autoConnect) : true;
            // Populate Extension Selector Dropdown with WebRTC extensions
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

            this.dom.presetModal.classList.remove('hidden');
        }

        closePresetModal() {
            this.dom.presetModal.classList.add('hidden');
        }

        savePresetFromModal() {
            const id = document.getElementById('presetIdInput').value || ('preset_' + Date.now());
            const label = document.getElementById('presetLabelInput').value.trim() || 'Office Ext';
            const extension = document.getElementById('presetExtInput').value.trim();
            const sipDomain = document.getElementById('presetDomainInput').value.trim();
            const wssUrl = document.getElementById('presetWssInput').value.trim();
            const isDefault = document.getElementById('presetDefaultCheckbox').checked;
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
                label,
                extension,
                sipDomain,
                wssUrl,
                dnd: false,
                autoAnswer: false,
                secret,
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
            this.closePresetModal();
            this.loadPresets();
            this.renderSavedAccountsLoginList();
            if (this.dom.presetSelect) this.dom.presetSelect.value = id;
            this.onPresetChanged();
            this.showToast('Account saved', 'success');
        }

        deleteCurrentPreset() {
            const preset = this.getSelectedPreset();
            if (!preset) return;
            let presets = this.getPresets().filter(p => p.id !== preset.id);
            this.savePresets(presets);
            this.sessionSecrets.delete(preset.id);
            this.loadPresets();
            this.renderSavedAccountsLoginList();
            this.showToast('Account deleted', 'info');
        }

        // --- CORE EVENT BINDINGS ---
        bindCoreEvents() {
            this.core.on('regStateChange', ({ state }) => this.updateStatusUi(state));
            this.core.on('registered', () => {
                this.updateViewMode('console');
            });
            this.core.on('unregistered', () => {
                this.updateViewMode('login');
            });
            this.core.on('authFailed', () => {
                this.updateViewMode('login');
                this.showToast(this.t.toastAuthFailed, 'error');
            });
            this.core.on('vuLevel', (level) => {
                if (this.dom.vuMeterBar) this.dom.vuMeterBar.style.width = `${level}%`;
            });
            this.core.on('incomingCall', (callEntry) => {
                this.renderActiveCalls();
                this.updateInCallButtonStates();
                this.showIncomingNotification(callEntry);
            });
            this.core.on('callProgress', () => {
                this.renderActiveCalls();
                this.updateInCallButtonStates();
            });
            this.core.on('callAnswered', () => {
                this.renderActiveCalls();
                this.updateInCallButtonStates();
                this.dismissNotification();
            });
            this.core.on('callUpdated', () => {
                this.renderActiveCalls();
                this.updateInCallButtonStates();
            });
            this.core.on('callEnded', () => {
                this.renderActiveCalls();
                this.updateInCallButtonStates();
                this.dismissNotification();
                this.currentCallQuality = null;
                this.attendedTransferState = null;
            });
            this.core.on('callLog', (logEntry) => this.addCallLog(logEntry));
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
                    this.dom.connectBtn.textContent = this.t.disconnect;
                    this.dom.connectBtn.className = 'btn btn-danger';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = false;
                    break;
                case 'CONNECTING':
                    this.dom.statusBadge.classList.add('ringing');
                    this.dom.statusText.textContent = this.t.statusConnecting;
                    this.dom.connectBtn.textContent = this.t.cancel || 'Cancel';
                    this.dom.connectBtn.className = 'btn btn-danger';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = true;
                    break;
                case 'RETRY_WAIT':
                    this.dom.statusBadge.classList.add('ringing');
                    this.dom.connectBtn.textContent = this.t.cancel || 'Cancel';
                    this.dom.connectBtn.className = 'btn btn-danger';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = true;
                    break;
                case 'AUTH_FAILED':
                    this.dom.statusBadge.classList.add('incall');
                    this.dom.statusText.textContent = this.t.statusAuthFailed;
                    this.dom.connectBtn.textContent = this.t.connect;
                    this.dom.connectBtn.className = 'btn btn-primary';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = true;
                    break;
                case 'DISCONNECTED':
                default:
                    this.dom.statusText.textContent = this.t.statusOffline;
                    this.dom.connectBtn.textContent = this.t.connect;
                    this.dom.connectBtn.className = 'btn btn-primary';
                    if (this.dom.callBtn) this.dom.callBtn.disabled = true;
                    break;
            }
        }

        // In-Call Button State Management (Clickable only while in a call)
        updateInCallButtonStates() {
            const inCall = this.core.activeCalls.size > 0;
            const calls = Array.from(this.core.activeCalls.values());
            const currentCall = calls[0] || null;

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

        // --- LIVE CALL TIMER TICKER ---
        startCallTimerTicker() {
            if (this.callTimerInterval) clearInterval(this.callTimerInterval);
            this.callTimerInterval = setInterval(() => {
                document.querySelectorAll('[data-timer-start]').forEach(el => {
                    const start = parseInt(el.dataset.timerStart, 10);
                    if (start > 0) {
                        const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
                        const h = String(Math.floor(sec / 3600)).padStart(2, '0');
                        const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
                        const s = String(sec % 60).padStart(2, '0');
                        el.textContent = `${h}:${m}:${s}`;
                    }
                });
            }, 1000);
        }

        // --- ACTIVE CALL HERO CARD RENDERING ---
        renderActiveCalls() {
            const container = this.dom.activeCallContainer;
            if (!container) return;
            container.textContent = '';

            const calls = Array.from(this.core.activeCalls.values());
            if (calls.length === 0) {
                container.style.display = 'none';
                return;
            }

            container.style.display = 'flex';
            calls.forEach(call => {
                const card = document.createElement('div');
                card.className = `active-call-hero ${call.status === 'ringing' ? 'ringing' : ''}`;

                // Title Area with badges
                const titleRow = document.createElement('div');
                titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

                const cardTitle = document.createElement('div');
                cardTitle.className = 'text-xs font-bold text-muted';
                if (!call.answerTime) {
                    if (call.direction === 'incoming') {
                        cardTitle.textContent = (this.currentLang === 'ar' ? 'مكالمة واردة من: ' : 'Incoming Call from: ') + call.target;
                        cardTitle.style.color = '#10b981';
                    } else {
                        cardTitle.textContent = (this.currentLang === 'ar' ? 'جاري الاتصال بـ: ' : 'Calling: ') + call.target;
                    }
                } else {
                    cardTitle.textContent = `${this.t.activeCallTitle} ${call.target}`;
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

                const avatar = document.createElement('div');
                avatar.className = 'hero-avatar';
                avatar.textContent = (call.target || 'A').charAt(0).toUpperCase();

                const nameCol = document.createElement('div');
                const nameDiv = document.createElement('div');
                nameDiv.className = 'hero-name font-mono';
                nameDiv.textContent = call.target;

                // Look up contact name
                const contactMatch = this.findContactByNumber(call.target);
                if (contactMatch) {
                    nameDiv.textContent = contactMatch.name;
                    const numDiv = document.createElement('div');
                    numDiv.className = 'text-xs text-muted font-mono';
                    numDiv.textContent = call.target;
                    nameCol.appendChild(nameDiv);
                    nameCol.appendChild(numDiv);
                } else {
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
                const actionsRow = document.createElement('div');
                actionsRow.className = 'hero-actions-row';

                const isIncomingRinging = (call.direction === 'incoming' && !call.answerTime);

                if (isIncomingRinging) {
                    const answerBtn = document.createElement('button');
                    answerBtn.className = 'end-call-btn';
                    answerBtn.style.cssText = 'background:#10b981 !important; color:#ffffff !important; box-shadow:0 4px 12px rgba(16,185,129,0.35); flex:1.5; font-weight:800;';
                    setButtonContent(answerBtn, SVG_ICONS.phone, this.t.answer || 'Answer');
                    answerBtn.addEventListener('click', () => this.core.answerCall(call.id));

                    const declineBtn = document.createElement('button');
                    declineBtn.className = 'end-call-btn';
                    declineBtn.style.cssText = 'background:#ef4444 !important; color:#ffffff !important; flex:1; font-weight:800;';
                    setButtonContent(declineBtn, SVG_ICONS.phoneOff, this.t.decline || 'Decline');
                    declineBtn.addEventListener('click', () => this.core.hangupCall(call.id));

                    actionsRow.appendChild(answerBtn);
                    actionsRow.appendChild(declineBtn);
                } else {
                    // End Call Button
                    const endBtn = document.createElement('button');
                    endBtn.className = 'end-call-btn';
                    setButtonContent(endBtn, SVG_ICONS.phoneOff, this.t.endCall);
                    endBtn.addEventListener('click', () => this.core.hangupCall(call.id));

                    // Mute Button (With active-mute class)
                    const muteBtn = document.createElement('button');
                    muteBtn.className = `hero-pill-action ${call.isMuted ? 'active-mute' : ''}`;
                    setButtonContent(muteBtn, call.isMuted ? SVG_ICONS.micOff : SVG_ICONS.mic, call.isMuted ? this.t.unmute : this.t.mute);
                    muteBtn.addEventListener('click', () => {
                        this.core.toggleMute(call.id);
                    });

                    // Hold Button (With active-hold class)
                    const holdBtn = document.createElement('button');
                    holdBtn.className = `hero-pill-action ${call.isHeld ? 'active-hold' : ''}`;
                    setButtonContent(holdBtn, call.isHeld ? SVG_ICONS.play : SVG_ICONS.pause, call.isHeld ? this.t.unhold : this.t.hold);
                    holdBtn.addEventListener('click', () => {
                        this.core.toggleHold(call.id);
                    });

                    // Transfer Button
                    const transferBtn = document.createElement('button');
                    transferBtn.className = 'hero-pill-action';
                    setButtonContent(transferBtn, SVG_ICONS.transfer, this.t.transfer);
                    transferBtn.addEventListener('click', () => this.openTransferModal(call.id));

                    actionsRow.appendChild(endBtn);
                    actionsRow.appendChild(muteBtn);
                    actionsRow.appendChild(holdBtn);
                    actionsRow.appendChild(transferBtn);
                }

                card.appendChild(actionsRow);

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
            const contactMatch = this.findContactByNumber(callerName);
            const title = 'Incoming Call';
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

        addCallLog(logEntry) {
            let logs = this.getCallLogs();
            logs.unshift(logEntry);
            if (logs.length > 50) logs = logs.slice(0, 50);
            localStorage.setItem(this.LOGS_KEY, JSON.stringify(logs));
            this.loadCallLogs();
        }

        clearCallLogs() {
            localStorage.removeItem(this.LOGS_KEY);
            this.loadCallLogs();
            this.showToast('Call history cleared', 'info');
        }

        loadCallLogs() {
            const listEl = this.dom.callHistoryList;
            if (!listEl) return;
            listEl.textContent = '';
            const logs = this.getCallLogs();

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

                const avatar = document.createElement('div');
                avatar.className = 'recent-avatar';
                avatar.textContent = (log.target || 'U').charAt(0).toUpperCase();

                const info = document.createElement('div');
                info.className = 'recent-info';

                const nameSpan = document.createElement('div');
                nameSpan.className = 'recent-name font-mono';
                nameSpan.textContent = log.target;

                const dirSpan = document.createElement('div');
                const isMissed = log.status === 'failed' || log.status === 'busy' || log.status === 'rejected_dnd';
                const dirClass = isMissed ? 'missed' : (log.direction === 'incoming' ? 'incoming' : 'outgoing');
                const dirArrow = isMissed ? '✕' : (log.direction === 'incoming' ? '↗' : '↙');
                dirSpan.className = `recent-dir ${dirClass}`;
                dirSpan.textContent = `${dirArrow} ${this.t[dirClass] || log.status}`;

                info.appendChild(nameSpan);
                info.appendChild(dirSpan);
                left.appendChild(avatar);
                left.appendChild(info);

                const right = document.createElement('div');
                right.className = 'recent-right';

                const timeSpan = document.createElement('span');
                timeSpan.className = 'recent-time';
                timeSpan.textContent = formatTimeAgo(log.timestamp);

                const callBtn = document.createElement('button');
                callBtn.className = 'recent-call-btn';
                setButtonContent(callBtn, SVG_ICONS.phone, '');
                callBtn.title = 'Call';
                callBtn.addEventListener('click', () => {
                    this.dom.dialInput.value = log.target;
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
        async openAudioModal() {
            document.getElementById('audioModal').classList.remove('hidden');
            await this.enumerateAudioDevices();
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

                this.dom.audioInputSelect.textContent = '';
                this.dom.audioOutputSelect.textContent = '';

                const audioInputs = devices.filter(d => d.kind === 'audioinput');
                const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

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
            } catch (err) {
                console.warn('Device enumeration warning:', err);
            }
        }

        testSpeakerOutput() {
            this.core.playTestChime();
            this.showToast(this.currentLang === 'ar' ? 'جاري تشغيل نغمة اختبار الصوت 🔔' : 'Playing audio test chime 🔔', 'info');
        }

        async checkMicrophonePermissionInitial() {
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
            if (this.dom.micBanner) this.dom.micBanner.style.display = 'flex';
        }

        // --- DOM ACTIONS & HOTKEYS ---
        bindDomEvents() {
            this.dom.presetSelect.addEventListener('change', () => this.onPresetChanged());
            this.dom.passwordInput.addEventListener('input', () => {
                const preset = this.getSelectedPreset();
                if (preset) {
                    this.sessionSecrets.set(preset.id, this.dom.passwordInput.value);
                }
            });

            this.dom.connectBtn.addEventListener('click', async () => {
                if (this.core.regState === 'REGISTERED' || this.core.regState === 'CONNECTING' || this.core.regState === 'RETRY_WAIT') {
                    this.core.disconnect();
                } else {
                    const preset = this.getSelectedPreset();
                    const secret = this.dom.passwordInput.value.trim();
                    if (!preset || !secret) {
                        this.showToast('Please select account and enter password', 'error');
                        return;
                    }
                    try {
                        await this.core.connect(preset, secret);
                    } catch (err) {
                        this.showToast(err.message, 'error');
                    }
                }
            });

            this.dom.callBtn.addEventListener('click', () => this.handleCallAction());
            this.dom.dialInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.handleCallAction();
                }
            });

            // Keypad clicks
            document.querySelectorAll('.keypad-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const digit = btn.dataset.digit;
                    if (!digit) return;
                    this.dom.dialInput.value += digit;
                    const activeCall = Array.from(this.core.activeCalls.values())[0];
                    if (activeCall) {
                        this.core.sendDtmf(activeCall.id, digit);
                    } else {
                        this.core.playDtmfSidetone(digit);
                    }
                });
            });

            // Preferences
            this.dom.dndCheckbox.addEventListener('change', () => {
                const preset = this.getSelectedPreset();
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

            this.dom.autoAnswerCheckbox.addEventListener('change', () => {
                const preset = this.getSelectedPreset();
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
            const num = this.dom.dialInput.value.trim();
            if (!num) return;
            try {
                this.core.makeCall(num);
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        }

        // --- PERSISTENT POPOUT WINDOW ---
        openPersistentWindow() {
            const width = 960;
            const height = 800;
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
        async openTransferModal(callId) {
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
                this.core.blindTransfer(callId, target);
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
                this.core.attendedTransfer(callId, target);
                this.attendedTransferState = { callId: callId, target: target };
                this.closeTransferModal();
                this.renderActiveCalls();
                this.showToast('Consulting ' + target + '...', 'info');
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        }

        // --- CONTACTS / PHONEBOOK ---
        loadContacts() {
            let contacts;
            try {
                contacts = JSON.parse(localStorage.getItem(this.CONTACTS_KEY) || '[]');
            } catch (_) {
                contacts = [];
            }

            // Auto-populate from server extensions if contacts empty
            if (contacts.length === 0 && this.serverExtensionsList && this.serverExtensionsList.length > 0) {
                this.serverExtensionsList.forEach(ext => {
                    contacts.push({
                        id: 'ext_' + ext.extension,
                        name: ext.name && ext.name !== ext.extension ? ext.name : 'Ext ' + ext.extension,
                        number: String(ext.extension),
                        isFavorite: false
                    });
                });
                this.saveContacts(contacts);
            }

            this._contacts = contacts;
            return contacts;
        }

        saveContacts(contacts) {
            this._contacts = contacts || [];
            localStorage.setItem(this.CONTACTS_KEY, JSON.stringify(this._contacts));
        }

        getContacts() {
            if (!this._contacts) this.loadContacts();
            return this._contacts || [];
        }

        findContactByNumber(number) {
            if (!number) return null;
            const numStr = String(number);
            const contacts = this.getContacts();
            return contacts.find(c => c.number === numStr) || null;
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
            addBtn.style.cssText = 'background:none;border:none;font-size:10px;color:var(--text-muted);cursor:pointer;display:flex;align-items:center;gap:3px;';
            addBtn.innerHTML = SVG_ICONS.plus + '<span>Add</span>';
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

            filtered.forEach(contact => {
                const card = document.createElement('div');
                card.className = 'recent-card';

                const left = document.createElement('div');
                left.className = 'recent-left';

                const avatar = document.createElement('div');
                avatar.className = 'recent-avatar';
                avatar.textContent = (contact.name || 'C').charAt(0).toUpperCase();

                const info = document.createElement('div');
                info.className = 'recent-info';

                const nameSpan = document.createElement('div');
                nameSpan.className = 'recent-name';
                nameSpan.textContent = contact.name || contact.number;

                const numSpan = document.createElement('div');
                numSpan.className = 'recent-dir font-mono';
                numSpan.style.color = 'var(--text-muted)';
                numSpan.textContent = contact.number;

                info.appendChild(nameSpan);
                info.appendChild(numSpan);
                left.appendChild(avatar);
                left.appendChild(info);

                const right = document.createElement('div');
                right.className = 'recent-right';
                right.style.cssText = 'display:flex;align-items:center;gap:4px;';

                // Favorite toggle
                const favBtn = document.createElement('button');
                favBtn.className = 'recent-call-btn';
                favBtn.title = contact.isFavorite ? 'Remove from favorites' : 'Add to favorites';
                favBtn.innerHTML = contact.isFavorite ? SVG_ICONS.starFilled : SVG_ICONS.star;
                if (contact.isFavorite) favBtn.style.color = '#f59e0b';
                favBtn.addEventListener('click', () => {
                    this.toggleFavorite(contact.number);
                });

                // Call button
                const callBtn = document.createElement('button');
                callBtn.className = 'recent-call-btn';
                callBtn.title = 'Call';
                callBtn.innerHTML = SVG_ICONS.phone;
                callBtn.addEventListener('click', () => {
                    this.dom.dialInput.value = contact.number;
                    this.handleCallAction();
                });

                // Edit button
                const editBtn = document.createElement('button');
                editBtn.className = 'recent-call-btn';
                editBtn.title = 'Edit';
                editBtn.innerHTML = SVG_ICONS.edit;
                editBtn.addEventListener('click', () => this.openContactModal(contact));

                // Delete button
                const delBtn = document.createElement('button');
                delBtn.className = 'recent-call-btn';
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

        saveContactFromModal() {
            const id = document.getElementById('contactIdInput').value || ('contact_' + Date.now());
            const name = document.getElementById('contactNameInput').value.trim();
            const number = document.getElementById('contactNumberInput').value.trim();

            if (!name || !number) {
                this.showToast('Name and number are required', 'error');
                return;
            }

            let contacts = this.getContacts();
            const existingIdx = contacts.findIndex(c => c.id === id);

            if (existingIdx >= 0) {
                contacts[existingIdx].name = name;
                contacts[existingIdx].number = number;
            } else {
                contacts.push({ id: id, name: name, number: number, isFavorite: false });
            }

            this.saveContacts(contacts);
            document.getElementById('contactModal').classList.add('hidden');
            this.renderFavorites();
            this.renderContacts();
            this.showToast('Contact saved', 'success');
        }

        deleteContact(id) {
            let contacts = this.getContacts().filter(c => c.id !== id);
            this.saveContacts(contacts);
            this.renderFavorites();
            this.renderContacts();
            this.showToast('Contact deleted', 'info');
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
            const contact = contacts.find(c => c.number === numStr);

            // Update contact record
            if (contact) {
                contact.isFavorite = !contact.isFavorite;
                this.saveContacts(contacts);
            }

            // Update favorites list
            let favs = this.getFavorites();
            const idx = favs.indexOf(numStr);
            if (idx >= 0) {
                favs.splice(idx, 1);
            } else {
                favs.push(numStr);
            }
            this.saveFavorites(favs);
            this.renderFavorites();
            this.renderContacts();
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
    }

    function startSoftphoneApp() {
        if (!window.softphoneUi) {
            window.softphoneUi = new SokratSoftphoneUI();
            window.softphoneUi.init();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startSoftphoneApp);
    } else {
        startSoftphoneApp();
    }

})(window, document);
