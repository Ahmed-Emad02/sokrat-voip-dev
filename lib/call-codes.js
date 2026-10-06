/**
 * Sokrat-VoIP Call Control Codes Management Module
 * Manages all 36 Asterisk telephony codes shown in the Live Operator Panel.
 * Handles database persistence, FreePBX featurecode synchronization,
 * dynamic dialplan generation, and factory default resets.
 */

const fs = require('fs');
const path = require('path');

const DIALPLAN_CUSTOM_CODES_FILE = '/etc/asterisk/extensions_sokrat_callcodes.conf';

const DEFAULT_CALL_CODES = [
    // 1. IN-CALL DTMF
    {
        id: 'incall_blindxfer',
        cat: 'incall',
        code: '##',
        default_code: '##',
        timing: 'incall',
        dial: 0,
        example_en: '## + [Target Extension]',
        example_ar: '## + [رقم التحويلة]',
        name_en: 'In-Call Blind Transfer',
        name_ar: 'تحويل أعمى مباشر (Blind Transfer)',
        desc_en: 'Transfers active call immediately to another extension without announcing.',
        desc_ar: 'تحويل المكالمة الجارية فوراً إلى رقم داخلي أو خارجي دون انتظار رده.',
        backend_type: 'featurecode',
        backend_module: 'core',
        backend_feature: 'blindxfer',
        backend_feature_secondary: null,
        sort_order: 1
    },
    {
        id: 'incall_atxfer',
        cat: 'incall',
        code: '*2',
        default_code: '*2',
        timing: 'incall',
        dial: 0,
        example_en: '*2 + [Target Extension]',
        example_ar: '*2 + [رقم التحويلة]',
        name_en: 'In-Call Attended Transfer',
        name_ar: 'تحويل مشروط بعد استئذان (Attended)',
        desc_en: 'Puts caller on hold, calls recipient to announce, then bridges upon hangup.',
        desc_ar: 'وضع المتصل في الانتظار والتحدث مع المستلم أولاً قبل تأكيد التحويل.',
        backend_type: 'featurecode',
        backend_module: 'core',
        backend_feature: 'atxfer',
        backend_feature_secondary: null,
        sort_order: 2
    },
    {
        id: 'incall_recording',
        cat: 'incall',
        code: '*1',
        default_code: '*1',
        timing: 'incall',
        dial: 0,
        example_en: '*1',
        example_ar: '*1',
        name_en: 'One-Touch Call Recording',
        name_ar: 'تسجيل المكالمة الحالية (One-Touch)',
        desc_en: 'Toggles on-demand live audio recording for the active conversation.',
        desc_ar: 'بدء أو إيقاف تسجيل المكالمة الجارية يدوياً أثناء التحدث.',
        backend_type: 'featurecode',
        backend_module: 'core',
        backend_feature: 'automon',
        backend_feature_secondary: null,
        sort_order: 3
    },
    {
        id: 'incall_disconnect',
        cat: 'incall',
        code: '**',
        default_code: '**',
        timing: 'incall',
        dial: 0,
        example_en: '**',
        example_ar: '**',
        name_en: 'Keypad Call Disconnect',
        name_ar: 'إنهاء وفصل المكالمة عبر اللوحة',
        desc_en: 'Immediately terminates the current active call via phone DTMF.',
        desc_ar: 'إنهاء المكالمة الحالية فوراً من لوحة المفاتيح دون لمس زر السماعة.',
        backend_type: 'featurecode',
        backend_module: 'core',
        backend_feature: 'disconnect',
        backend_feature_secondary: null,
        sort_order: 4
    },
    {
        id: 'incall_campon_busy',
        cat: 'incall',
        code: '6',
        default_code: '6',
        timing: 'busy',
        dial: 0,
        example_en: 'Press 6 during busy tone',
        example_ar: 'اضغط 6 أثناء نغمة المشغول',
        name_en: 'Camp-On Callback (When Busy)',
        name_ar: 'حجز التحويلة المشغولة (Camp-On)',
        desc_en: 'While hearing busy tone on an internal extension, press 6 to auto-callback when free.',
        desc_ar: 'عند سماع نغمة المشغول، اضغط 6 لحجز التحويلة والاتصال بك تلقائياً عند فراغها.',
        backend_type: 'dialplan_campon_busy',
        backend_module: null,
        backend_feature: null,
        backend_feature_secondary: null,
        sort_order: 5
    },

    // 2. CAMP-ON & PICKUP
    {
        id: 'campon_activate',
        cat: 'campon',
        code: '*82',
        default_code: '*82',
        timing: 'precall',
        dial: 1,
        example_en: '*82',
        example_ar: '*82',
        name_en: 'Camp-On Activate (Post-Hangup)',
        name_ar: 'طلب معاودة الاتصال التلقائي (*82)',
        desc_en: 'Dial after hanging up on a busy extension to schedule automatic callback.',
        desc_ar: 'اطلب *82 بعد إغلاق الخط مع تحويلة مشغولة لحجز معاودة الاتصال التلقائي.',
        backend_type: 'dialplan_campon_act',
        backend_module: null,
        backend_feature: null,
        backend_feature_secondary: null,
        sort_order: 6
    },
    {
        id: 'campon_cancel',
        cat: 'campon',
        code: '*83',
        default_code: '*83',
        timing: 'precall',
        dial: 1,
        example_en: '*83',
        example_ar: '*83',
        name_en: 'Camp-On Cancel',
        name_ar: 'إلغاء حجز معاودة الاتصال (*83)',
        desc_en: 'Cancels any pending automatic callbacks queued for your extension.',
        desc_ar: 'إلغاء كافة طلبات معاودة الاتصال التلقائي المحجوزة لتحويلتك.',
        backend_type: 'dialplan_campon_cancel',
        backend_module: null,
        backend_feature: null,
        backend_feature_secondary: null,
        sort_order: 7
    },
    {
        id: 'campon_pickup_group',
        cat: 'campon',
        code: '*',
        default_code: '*',
        timing: 'precall',
        dial: 1,
        example_en: '*',
        example_ar: '*',
        name_en: 'Group Call Pickup (*)',
        name_ar: 'التقاط مكالمة المجموعة (*)',
        desc_en: 'Answers any incoming call currently ringing in your department/pickup group.',
        desc_ar: 'الرد على أي مكالمة ترن حالياً داخل قسمك أو مجموعة الرنين الخاصة بك.',
        backend_type: 'featurecode',
        backend_module: 'core',
        backend_feature: 'pickupexten',
        backend_feature_secondary: null,
        sort_order: 8
    },
    {
        id: 'campon_pickup_directed',
        cat: 'campon',
        code: '*[Ext]',
        default_code: '*[Ext]',
        timing: 'precall',
        dial: 0,
        example_en: '*102 / **102',
        example_ar: '*102 / **102',
        name_en: 'Directed Call Pickup',
        name_ar: 'سحب مكالمة تحويلة محددة (* + الرقم)',
        desc_en: 'Intercepts and answers a call currently ringing on a specific colleague\'s phone.',
        desc_ar: 'سحب مكالمة ترن على هاتف زميل معين والرد عليها من جهازك (مثال: 102* أو 102**).',
        backend_type: 'featurecode',
        backend_module: 'core',
        backend_feature: 'pickup',
        backend_feature_secondary: null,
        sort_order: 9
    },

    // 3. SPYING & COACHING
    {
        id: 'spy_listen',
        cat: 'spy',
        code: '222[Ext]',
        default_code: '222[Ext]',
        timing: 'precall',
        dial: 0,
        example_en: '222102',
        example_ar: '222102',
        name_en: 'Spy: Listen-Only Mode',
        name_ar: 'تنصت صامت (استماع فقط)',
        desc_en: 'Silently listens to an active call on target extension without either party hearing.',
        desc_ar: 'الاستماع لمكالمة الموظف الجارية بسرية تامة دون أن يعلم أي طرف بوجودك.',
        backend_type: 'dialplan_spy',
        backend_module: null,
        backend_feature: 'listen',
        backend_feature_secondary: null,
        sort_order: 10
    },
    {
        id: 'spy_whisper',
        cat: 'spy',
        code: '223[Ext]',
        default_code: '223[Ext]',
        timing: 'precall',
        dial: 0,
        example_en: '223102',
        example_ar: '223102',
        name_en: 'Whisper: Coaching Mode',
        name_ar: 'تدريب وتوجيه الموظف (همس)',
        desc_en: 'Speaks only into agent\'s headset for live guidance without client hearing.',
        desc_ar: 'التحدث مع الموظف فقط لتوجيهه وتدريبه دون أن يسمع العميل صوتك.',
        backend_type: 'dialplan_spy',
        backend_module: null,
        backend_feature: 'whisper',
        backend_feature_secondary: null,
        sort_order: 11
    },
    {
        id: 'spy_barge',
        cat: 'spy',
        code: '224[Ext]',
        default_code: '224[Ext]',
        timing: 'precall',
        dial: 0,
        example_en: '224102',
        example_ar: '224102',
        name_en: 'Barge: Conference In',
        name_ar: 'اقتحام المكالمة (مكالمة ثلاثية)',
        desc_en: 'Barges into active conversation as a 3rd party where all participants can speak.',
        desc_ar: 'الدخول في المكالمة كمشارك ثالث يتحدث مع الطرفين ويسمعه الجميع.',
        backend_type: 'dialplan_spy',
        backend_module: null,
        backend_feature: 'barge',
        backend_feature_secondary: null,
        sort_order: 12
    },
    {
        id: 'spy_hijack',
        cat: 'spy',
        code: '225[Ext]',
        default_code: '225[Ext]',
        timing: 'precall',
        dial: 0,
        example_en: '225102',
        example_ar: '225102',
        name_en: 'Instant Call Hijack',
        name_ar: 'سحب وفصل المكالمة (Hijack)',
        desc_en: 'Immediately disconnects the agent and redirects the customer leg to your phone.',
        desc_ar: 'فصل الموظف فوراً وتحويل مكالمة العميل إلى هاتفك لمتابعتها بنفسك.',
        backend_type: 'dialplan_spy',
        backend_module: null,
        backend_feature: 'hijack',
        backend_feature_secondary: null,
        sort_order: 13
    },
    {
        id: 'spy_chanspy_menu',
        cat: 'spy',
        code: '555',
        default_code: '555',
        timing: 'precall',
        dial: 1,
        example_en: '555',
        example_ar: '555',
        name_en: 'ChanSpy Interactive Menu',
        name_ar: 'قائمة تصفح المكالمات النشطة',
        desc_en: 'Interactive Asterisk menu to cycle through all live channels (press * to skip).',
        desc_ar: 'الدخول لقائمة استعراض جميع القنوات النشطة والتنقل بينها بالزر *.',
        backend_type: 'featurecode',
        backend_module: 'core',
        backend_feature: 'chanspy',
        backend_feature_secondary: null,
        sort_order: 14
    },

    // 4. INTERCOM & PAGING
    {
        id: 'intercom_direct',
        cat: 'intercom',
        code: '*80[Ext]',
        default_code: '*80[Ext]',
        timing: 'precall',
        dial: 0,
        example_en: '*80102',
        example_ar: '*80102',
        name_en: 'Direct 1-to-1 Intercom',
        name_ar: 'نداء داخلي فوري (1 إلى 1)',
        desc_en: 'Auto-answers destination extension on speakerphone for instant two-way voice.',
        desc_ar: 'فتح مكبر صوت هاتف الزميل فوراً والتحدث معه مباشرة دون انتظار رنين.',
        backend_type: 'featurecode',
        backend_module: 'paging',
        backend_feature: 'intercom-prefix',
        backend_feature_secondary: null,
        sort_order: 15
    },
    {
        id: 'intercom_mass',
        cat: 'intercom',
        code: '*800 / 800',
        default_code: '*800 / 800',
        timing: 'precall',
        dial: 1,
        example_en: '*800',
        example_ar: '*800',
        name_en: 'Mass Intercom / Paging',
        name_ar: 'إذاعة صوتية جماعية (Paging)',
        desc_en: 'Broadcasts audio announcement across all available deskphone speakerphones.',
        desc_ar: 'بث نداء صوتي جماعي عبر مكبرات صوت كافة الهواتف المتاحة في الشركة.',
        backend_type: 'dialplan_paging',
        backend_module: null,
        backend_feature: null,
        backend_feature_secondary: null,
        sort_order: 16
    },

    // 5. CALL PARKING
    {
        id: 'parking_lot',
        cat: 'parking',
        code: '70',
        default_code: '70',
        timing: 'precall',
        dial: 1,
        example_en: 'Transfer to 70',
        example_ar: 'تحويل المكالمة إلى 70',
        name_en: 'Park Call (Lot 70)',
        name_ar: 'تعليق المكالمة في الموقف (70)',
        desc_en: 'Transfer call to 70 to park it; system announces assigned parking slot (71-78).',
        desc_ar: 'تحويل المكالمة إلى 70 لتعليقها؛ يعلن النظام صوتياً رقم الموقف (71-78).',
        backend_type: 'parking_lot',
        backend_module: null,
        backend_feature: null,
        backend_feature_secondary: null,
        sort_order: 17
    },
    {
        id: 'parking_retrieve',
        cat: 'parking',
        code: '71 – 78',
        default_code: '71 – 78',
        timing: 'precall',
        dial: 0,
        example_en: '71, 72, 73...',
        example_ar: '71, 72, 73...',
        name_en: 'Retrieve Parked Call',
        name_ar: 'استرجاع المكالمة المعلقة (71-78)',
        desc_en: 'Dial announced slot number (71 through 78) from any phone to resume the call.',
        desc_ar: 'طلب رقم الموقف المعلن (من 71 حتى 78) من أي هاتف لاستئناف المكالمة.',
        backend_type: 'parking_retrieve',
        backend_module: null,
        backend_feature: null,
        backend_feature_secondary: null,
        sort_order: 18
    },

    // 6. FORWARDING & DND
    {
        id: 'cf_all_on',
        cat: 'forward',
        code: '*72',
        default_code: '*72',
        timing: 'precall',
        dial: 0,
        example_en: '*72 + [Destination]',
        example_ar: '*72 + [الرقم المراد التحويل إليه]',
        name_en: 'Call Forward All - Activate',
        name_ar: 'تحويل كافة المكالمات - تفعيل',
        desc_en: 'Unconditionally forwards all incoming calls to another internal or external number.',
        desc_ar: 'تحويل كافة المكالمات الواردة دائماً إلى رقم داخلي أو رقم خارجي.',
        backend_type: 'featurecode',
        backend_module: 'callforward',
        backend_feature: 'cfon',
        backend_feature_secondary: null,
        sort_order: 19
    },
    {
        id: 'cf_all_off',
        cat: 'forward',
        code: '*73',
        default_code: '*73',
        timing: 'precall',
        dial: 1,
        example_en: '*73',
        example_ar: '*73',
        name_en: 'Call Forward All - Deactivate',
        name_ar: 'إلغاء تحويل كافة المكالمات (*73)',
        desc_en: 'Cancels unconditional call forwarding and resumes normal ringing.',
        desc_ar: 'إلغاء التحويل الدائم وإعادة استقبال المكالمات على جهازك.',
        backend_type: 'featurecode',
        backend_module: 'callforward',
        backend_feature: 'cfoff',
        backend_feature_secondary: null,
        sort_order: 20
    },
    {
        id: 'cf_toggle',
        cat: 'forward',
        code: '*740',
        default_code: '*740',
        timing: 'precall',
        dial: 1,
        example_en: '*740',
        example_ar: '*740',
        name_en: 'Call Forward Toggle',
        name_ar: 'تبديل حالة التحويل (Toggle)',
        desc_en: 'One-touch toggle for preconfigured call forward destination.',
        desc_ar: 'تشغيل أو إيقاف التحويل المسبق بضغطة زر واحدة.',
        backend_type: 'featurecode',
        backend_module: 'callforward',
        backend_feature: 'cf_toggle',
        backend_feature_secondary: null,
        sort_order: 21
    },
    {
        id: 'cf_busy',
        cat: 'forward',
        code: '*90 / *91',
        default_code: '*90 / *91',
        timing: 'precall',
        dial: 0,
        example_en: '*90 + [Number] / *91',
        example_ar: '*90 + [الرقم] / *91',
        name_en: 'Call Forward Busy (On / Off)',
        name_ar: 'تحويل عند الانشغال (تشغيل/إلغاء)',
        desc_en: 'Forwards incoming calls only when line is engaged on another call.',
        desc_ar: 'تحويل المكالمات الواردة فقط إذا كان خطك مشغولاً بمكالمة أخرى.',
        backend_type: 'featurecode_pair',
        backend_module: 'callforward',
        backend_feature: 'cfbon',
        backend_feature_secondary: 'cfboff',
        sort_order: 22
    },
    {
        id: 'cf_noanswer',
        cat: 'forward',
        code: '*52 / *53',
        default_code: '*52 / *53',
        timing: 'precall',
        dial: 0,
        example_en: '*52 + [Number] / *53',
        example_ar: '*52 + [الرقم] / *53',
        name_en: 'Call Forward No Answer (On / Off)',
        name_ar: 'تحويل عند عدم الرد (تشغيل/إلغاء)',
        desc_en: 'Forwards calls when not answered within the configured ring duration.',
        desc_ar: 'تحويل المكالمة بعد انتهاء مدة الرنين المحددة دون رد.',
        backend_type: 'featurecode_pair',
        backend_module: 'callforward',
        backend_feature: 'cfuon',
        backend_feature_secondary: 'cfuoff',
        sort_order: 23
    },
    {
        id: 'dnd_on_off',
        cat: 'forward',
        code: '*78 / *79',
        default_code: '*78 / *79',
        timing: 'precall',
        dial: 1,
        example_en: '*78 / *79',
        example_ar: '*78 / *79',
        name_en: 'Do Not Disturb (DND On / Off)',
        name_ar: 'وضع عدم الإزعاج (تشغيل/إلغاء)',
        desc_en: 'Blocks all incoming calls and directs callers to busy signal or voicemail.',
        desc_ar: 'رفض كافة المكالمات الواردة تلقائياً وتحويلها للمشغول أو البريد.',
        backend_type: 'featurecode_pair',
        backend_module: 'donotdisturb',
        backend_feature: 'dnd_on',
        backend_feature_secondary: 'dnd_off',
        sort_order: 24
    },
    {
        id: 'dnd_toggle',
        cat: 'forward',
        code: '*76',
        default_code: '*76',
        timing: 'precall',
        dial: 1,
        example_en: '*76',
        example_ar: '*76',
        name_en: 'DND Toggle',
        name_ar: 'تبديل وضع عدم الإزعاج (*76)',
        desc_en: 'One-touch toggle for Do Not Disturb availability state.',
        desc_ar: 'تبديل وضع عدم الإزعاج (تشغيل / إيقاف) بالتناوب.',
        backend_type: 'featurecode',
        backend_module: 'donotdisturb',
        backend_feature: 'dnd_toggle',
        backend_feature_secondary: null,
        sort_order: 25
    },
    {
        id: 'cw_on_off',
        cat: 'forward',
        code: '*70 / *71',
        default_code: '*70 / *71',
        timing: 'precall',
        dial: 1,
        example_en: '*70 / *71',
        example_ar: '*70 / *71',
        name_en: 'Call Waiting (On / Off)',
        name_ar: 'انتظار المكالمات (تفعيل/إلغاء)',
        desc_en: 'Enables or disables receiving a second incoming call while talking.',
        desc_ar: 'السماح باستقبال مكالمة ثانية أثناء التحدث في مكالمة أولى.',
        backend_type: 'featurecode_pair',
        backend_module: 'callwaiting',
        backend_feature: 'cwon',
        backend_feature_secondary: 'cwoff',
        sort_order: 26
    },
    {
        id: 'queue_agent_toggle',
        cat: 'forward',
        code: '*45',
        default_code: '*45',
        timing: 'precall',
        dial: 1,
        example_en: '*45',
        example_ar: '*45',
        name_en: 'Queue Agent Login / Logout',
        name_ar: 'تسجيل دخول/خروج من الطابور (*45)',
        desc_en: 'Toggles customer care queue dynamic agent membership.',
        desc_ar: 'تسجيل دخول أو خروج الموظف من طابور خدمة العملاء.',
        backend_type: 'featurecode',
        backend_module: 'queues',
        backend_feature: 'que_toggle',
        backend_feature_secondary: null,
        sort_order: 27
    },
    {
        id: 'queue_agent_pause',
        cat: 'forward',
        code: '*46',
        default_code: '*46',
        timing: 'precall',
        dial: 1,
        example_en: '*46',
        example_ar: '*46',
        name_en: 'Queue Agent Pause / Resume',
        name_ar: 'استراحة مؤقتة في الطابور (*46)',
        desc_en: 'Puts agent on temporary break pause without unregistering from queue.',
        desc_ar: 'أخذ استراحة مؤقتة داخل الطابور دون تسجيل خروج كامل.',
        backend_type: 'featurecode',
        backend_module: 'queues',
        backend_feature: 'que_pause_toggle',
        backend_feature_secondary: null,
        sort_order: 28
    },

    // 7. DIAGNOSTICS & AI
    {
        id: 'diag_echo_test',
        cat: 'diagnostics',
        code: '*43',
        default_code: '*43',
        timing: 'precall',
        dial: 1,
        example_en: '*43',
        example_ar: '*43',
        name_en: 'Audio Echo & Latency Test',
        name_ar: 'اختبار صدى الصوت وزمن الاستجابة (*43)',
        desc_en: 'Echoes back spoken voice in real-time to assess network latency and audio fidelity.',
        desc_ar: 'إعادة سماع صوتك فوراً لفحص زمن استجابة الشبكة وجودة الصوت.',
        backend_type: 'featurecode',
        backend_module: 'infoservices',
        backend_feature: 'echotest',
        backend_feature_secondary: null,
        sort_order: 29
    },
    {
        id: 'diag_rnnoise_vad',
        cat: 'diagnostics',
        code: '*88',
        default_code: '*88',
        timing: 'precall',
        dial: 1,
        example_en: '*88',
        example_ar: '*88',
        name_en: 'AI RNNoise + VAD Gate Echo Test',
        name_ar: 'فحص عزل الضوضاء الذكي مع كتم الصمت (*88)',
        desc_en: 'Live test of neural noise suppression with VAD gate (total silence on breath/pauses).',
        desc_ar: 'اختبار عزل الضوضاء بالذكاء الاصطناعي مع كتم تام أثناء الوقفات.',
        backend_type: 'dialplan_rnnoise',
        backend_module: null,
        backend_feature: 'vad',
        backend_feature_secondary: null,
        sort_order: 30
    },
    {
        id: 'diag_rnnoise_cont',
        cat: 'diagnostics',
        code: '*87',
        default_code: '*87',
        timing: 'precall',
        dial: 1,
        example_en: '*87',
        example_ar: '*87',
        name_en: 'AI RNNoise Continuous Echo Test',
        name_ar: 'فحص عزل الضوضاء المستمر (*87)',
        desc_en: 'Live test of continuous neural noise cancellation without hard silence gate.',
        desc_ar: 'اختبار فلترة التشويش والضوضاء العصبية المستمرة دون كتم تام.',
        backend_type: 'dialplan_rnnoise',
        backend_module: null,
        backend_feature: 'cont',
        backend_feature_secondary: null,
        sort_order: 31
    },
    {
        id: 'diag_rnnoise_raw',
        cat: 'diagnostics',
        code: '*89',
        default_code: '*89',
        timing: 'precall',
        dial: 1,
        example_en: '*89',
        example_ar: '*89',
        name_en: 'Raw Audio Baseline Test',
        name_ar: 'اختبار الصوت الخام للمقارنة (*89)',
        desc_en: 'Raw unfiltered microphone stream to benchmark noise cancellation performance.',
        desc_ar: 'سماع الصوت الطبيعي بدون فلترة لمقارنة فاعلية الذكاء الاصطناعي.',
        backend_type: 'dialplan_rnnoise',
        backend_module: null,
        backend_feature: 'raw',
        backend_feature_secondary: null,
        sort_order: 32
    },
    {
        id: 'diag_my_voicemail',
        cat: 'diagnostics',
        code: '*97',
        default_code: '*97',
        timing: 'precall',
        dial: 1,
        example_en: '*97',
        example_ar: '*97',
        name_en: 'My Voicemail',
        name_ar: 'صندوق البريد الصوتي الشخصي (*97)',
        desc_en: 'Direct access to your extension\'s voicemail inbox.',
        desc_ar: 'الدخول إلى صندوق البريد الصوتي الخاص بتحويلتك لسماع الرسائل.',
        backend_type: 'featurecode',
        backend_module: 'voicemail',
        backend_feature: 'myvoicemail',
        backend_feature_secondary: null,
        sort_order: 33
    },
    {
        id: 'diag_blacklist',
        cat: 'diagnostics',
        code: '*30 / *32',
        default_code: '*30 / *32',
        timing: 'precall',
        dial: 1,
        example_en: '*30 / *32',
        example_ar: '*30 / *32',
        name_en: 'Blacklist Caller (*30 / *32)',
        name_ar: 'إضافة رقم للقائمة السوداء (*30 / *32)',
        desc_en: 'Blocks nuisance numbers from calling your PBX (*32 blocks the last caller immediately).',
        desc_ar: 'حظر الأرقام المزعجة من الاتصال بالمقسم (*32 لحظر آخر متصل فوراً).',
        backend_type: 'featurecode_pair',
        backend_module: 'blacklist',
        backend_feature: 'blacklist_add',
        backend_feature_secondary: 'blacklist_last',
        sort_order: 34
    },
    {
        id: 'diag_speak_exten',
        cat: 'diagnostics',
        code: '*65',
        default_code: '*65',
        timing: 'precall',
        dial: 1,
        example_en: '*65',
        example_ar: '*65',
        name_en: 'Speak Extension Number',
        name_ar: 'نطق رقم التحويلة (*65)',
        desc_en: 'Speaks out the registered internal extension number of this phone.',
        desc_ar: 'ينطق النظام صوتياً رقم تحويلتك المسجلة للتأكد من هويتها.',
        backend_type: 'featurecode',
        backend_module: 'infoservices',
        backend_feature: 'speakextennum',
        backend_feature_secondary: null,
        sort_order: 35
    },
    {
        id: 'diag_speaking_clock',
        cat: 'diagnostics',
        code: '*60',
        default_code: '*60',
        timing: 'precall',
        dial: 1,
        example_en: '*60',
        example_ar: '*60',
        name_en: 'Speaking Server Clock',
        name_ar: 'ساعة النظام الرسمية (*60)',
        desc_en: 'Speaks current official server date and time.',
        desc_ar: 'سماع التوقيت الرسمي المسجل على سيرفر المقسم صوتياً.',
        backend_type: 'featurecode',
        backend_module: 'infoservices',
        backend_feature: 'speakingclock',
        backend_feature_secondary: null,
        sort_order: 36
    }
];

/**
 * Initialize table and seed default records
 * @param {object} conn Database connection or pool
 */
async function initSokratCallCodes(conn) {
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`asterisk\`.\`sokrat_call_codes\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`cat\` VARCHAR(32) NOT NULL,
            \`code\` VARCHAR(32) NOT NULL,
            \`default_code\` VARCHAR(32) NOT NULL,
            \`name_en\` VARCHAR(128) NOT NULL,
            \`name_ar\` VARCHAR(128) NOT NULL,
            \`desc_en\` TEXT NOT NULL,
            \`desc_ar\` TEXT NOT NULL,
            \`example_en\` VARCHAR(128) NOT NULL,
            \`example_ar\` VARCHAR(128) NOT NULL,
            \`timing\` VARCHAR(32) NOT NULL DEFAULT 'precall',
            \`dial\` TINYINT(1) NOT NULL DEFAULT 1,
            \`enabled\` TINYINT(1) NOT NULL DEFAULT 1,
            \`sort_order\` INT NOT NULL DEFAULT 0,
            \`backend_type\` VARCHAR(32) NOT NULL,
            \`backend_module\` VARCHAR(64) DEFAULT NULL,
            \`backend_feature\` VARCHAR(64) DEFAULT NULL,
            \`backend_feature_secondary\` VARCHAR(64) DEFAULT NULL,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX \`idx_scc_cat\` (\`cat\`),
            INDEX \`idx_scc_sort\` (\`sort_order\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Ensure all 36 items are seeded
    for (const c of DEFAULT_CALL_CODES) {
        await conn.execute(`
            INSERT INTO \`asterisk\`.\`sokrat_call_codes\`
                (id, cat, code, default_code, name_en, name_ar, desc_en, desc_ar, example_en, example_ar, timing, dial, enabled, sort_order, backend_type, backend_module, backend_feature, backend_feature_secondary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                default_code = VALUES(default_code),
                name_en = VALUES(name_en),
                name_ar = VALUES(name_ar),
                desc_en = VALUES(desc_en),
                desc_ar = VALUES(desc_ar),
                timing = VALUES(timing),
                dial = VALUES(dial),
                sort_order = VALUES(sort_order),
                backend_type = VALUES(backend_type),
                backend_module = VALUES(backend_module),
                backend_feature = VALUES(backend_feature),
                backend_feature_secondary = VALUES(backend_feature_secondary)
        `, [
            c.id, c.cat, c.code, c.default_code, c.name_en, c.name_ar, c.desc_en, c.desc_ar, c.example_en, c.example_ar,
            c.timing, c.dial, c.sort_order, c.backend_type, c.backend_module || null, c.backend_feature || null, c.backend_feature_secondary || null
        ]);
    }

    // Ensure dialplan file exists on disk
    try {
        if (!fs.existsSync(DIALPLAN_CUSTOM_CODES_FILE)) {
            fs.writeFileSync(DIALPLAN_CUSTOM_CODES_FILE, '[sokrat-call-codes-custom]\n; Dynamic user-configured call control codes\n', 'utf8');
            try {
                const { execSync } = require('child_process');
                execSync(`chown asterisk:asterisk "${DIALPLAN_CUSTOM_CODES_FILE}" 2>/dev/null; chmod 664 "${DIALPLAN_CUSTOM_CODES_FILE}" 2>/dev/null`);
            } catch (_) {}
        }
    } catch (e) {
        console.warn('Could not initialize extensions_sokrat_callcodes.conf:', e.message);
    }

    // Generate dialplan for any custom codes currently in DB
    await syncSokratCallCodesDialplan(conn);
}

/**
 * Fetch all call codes from database
 * @param {object} pool
 */
async function getCallCodes(pool) {
    const [rows] = await pool.query(
        'SELECT id, cat, code, default_code, name_en, name_ar, desc_en, desc_ar, example_en, example_ar, timing, dial, enabled, sort_order, backend_type, backend_module, backend_feature, backend_feature_secondary FROM `asterisk`.`sokrat_call_codes` ORDER BY sort_order ASC'
    );
    return rows.map(r => ({
        ...r,
        dial: Boolean(r.dial),
        enabled: Boolean(r.enabled),
        is_custom: (r.code !== r.default_code || !r.enabled)
    }));
}

/**
 * Generate Asterisk dialplan in /etc/asterisk/extensions_sokrat_callcodes.conf
 * for user-configured custom dialplan codes
 * @param {object} pool
 */
async function syncSokratCallCodesDialplan(pool) {
    try {
        const [rows] = await pool.query(
            'SELECT id, code, default_code, enabled, backend_type, backend_feature FROM `asterisk`.`sokrat_call_codes`'
        );
        const map = {};
        rows.forEach(r => { map[r.id] = r; });

        let dialplanLines = [];
        dialplanLines.push('[sokrat-call-codes-custom]');
        dialplanLines.push('; Dynamic user-configured call control codes');
        dialplanLines.push('; Auto-generated by Sokrat-VoIP Call Codes Engine\n');

        // Helper to extract clean prefix from code like "222[Ext]" or "222"
        const cleanPrefix = (str) => String(str || '').replace(/\[Ext\]/gi, '').trim();

        // 1. ChanSpy supervisory codes (listen, whisper, barge, hijack)
        const spyListen = map['spy_listen'];
        if (spyListen && spyListen.enabled) {
            const p = cleanPrefix(spyListen.code);
            if (p) {
                dialplanLines.push(`; Spy Listen: ${p}`);
                dialplanLines.push(`exten => _${p}X.,1,NoOp(Spying on extension \${EXTEN:${p.length}} in Listen-only mode)`);
                dialplanLines.push(`same => n,Answer()`);
                dialplanLines.push(`same => n,Set(spyee_dial=\${DB(DEVICE/\${EXTEN:${p.length}}/dial)})`);
                dialplanLines.push(`same => n,GotoIf(\$["\${spyee_dial}" = ""]?fallback)`);
                dialplanLines.push(`same => n,ChanSpy(\${spyee_dial},q)`);
                dialplanLines.push(`same => n,Hangup()`);
                dialplanLines.push(`same => n(fallback),ChanSpy(PJSIP/\${EXTEN:${p.length}},q)`);
                dialplanLines.push(`same => n,ChanSpy(SIP/\${EXTEN:${p.length}},q)`);
                dialplanLines.push(`same => n,Hangup()\n`);
            }
        }

        const spyWhisper = map['spy_whisper'];
        if (spyWhisper && spyWhisper.enabled) {
            const p = cleanPrefix(spyWhisper.code);
            if (p) {
                dialplanLines.push(`; Spy Whisper: ${p}`);
                dialplanLines.push(`exten => _${p}X.,1,NoOp(Spying on extension \${EXTEN:${p.length}} in Whisper mode)`);
                dialplanLines.push(`same => n,Answer()`);
                dialplanLines.push(`same => n,Set(spyee_dial=\${DB(DEVICE/\${EXTEN:${p.length}}/dial)})`);
                dialplanLines.push(`same => n,GotoIf(\$["\${spyee_dial}" = ""]?fallback)`);
                dialplanLines.push(`same => n,ChanSpy(\${spyee_dial},qw)`);
                dialplanLines.push(`same => n,Hangup()`);
                dialplanLines.push(`same => n(fallback),ChanSpy(PJSIP/\${EXTEN:${p.length}},qw)`);
                dialplanLines.push(`same => n,ChanSpy(SIP/\${EXTEN:${p.length}},qw)`);
                dialplanLines.push(`same => n,Hangup()\n`);
            }
        }

        const spyBarge = map['spy_barge'];
        if (spyBarge && spyBarge.enabled) {
            const p = cleanPrefix(spyBarge.code);
            if (p) {
                dialplanLines.push(`; Spy Barge: ${p}`);
                dialplanLines.push(`exten => _${p}X.,1,NoOp(Spying on extension \${EXTEN:${p.length}} in Barge mode)`);
                dialplanLines.push(`same => n,Answer()`);
                dialplanLines.push(`same => n,Set(spyee_dial=\${DB(DEVICE/\${EXTEN:${p.length}}/dial)})`);
                dialplanLines.push(`same => n,GotoIf(\$["\${spyee_dial}" = ""]?fallback)`);
                dialplanLines.push(`same => n,ChanSpy(\${spyee_dial},qB)`);
                dialplanLines.push(`same => n,Hangup()`);
                dialplanLines.push(`same => n(fallback),ChanSpy(PJSIP/\${EXTEN:${p.length}},qB)`);
                dialplanLines.push(`same => n,ChanSpy(SIP/\${EXTEN:${p.length}},qB)`);
                dialplanLines.push(`same => n,Hangup()\n`);
            }
        }

        const spyHijack = map['spy_hijack'];
        if (spyHijack && spyHijack.enabled) {
            const p = cleanPrefix(spyHijack.code);
            if (p) {
                dialplanLines.push(`; Spy Hijack: ${p}`);
                dialplanLines.push(`exten => _${p}X.,1,NoOp(--- Instant AGI Hijack Call for Extension \${EXTEN:${p.length}} ---)`);
                dialplanLines.push(`same => n,Answer()`);
                dialplanLines.push(`same => n,AGI(hijack_call.py,\${EXTEN:${p.length}})`);
                dialplanLines.push(`same => n,Hangup()\n`);
            }
        }

        // 2. Camp-On activate/cancel
        const campAct = map['campon_activate'];
        if (campAct && campAct.enabled && campAct.code) {
            const c = campAct.code.trim();
            dialplanLines.push(`; Camp-On Activate: ${c}`);
            dialplanLines.push(`exten => ${c},1,NoOp(--- Feature Code ${c}: Camp-On Request from \${CALLERID(num)} Channel: \${CHANNEL} ---)`);
            dialplanLines.push(`same => n,Set(CALLER_EXT=\${CALLERID(num)})`);
            dialplanLines.push(`same => n,ExecIf(\$["\${CALLER_EXT}" = ""]?Set(CALLER_EXT=\${DB(DEVICE/\${CUT(CUT(CHANNEL,-,1),/,2)}/user)}))`);
            dialplanLines.push(`same => n,ExecIf(\$["\${CALLER_EXT}" = ""]?Set(CALLER_EXT=\${CUT(CUT(CHANNEL,-,1),/,2)}))`);
            dialplanLines.push(`same => n,Answer()`);
            dialplanLines.push(`same => n,Set(EXTTOCALL=\${DB(CAMP_ON_LAST_BUSY/\${CALLER_EXT})})`);
            dialplanLines.push(`same => n,ExecIf(\$["\${EXTTOCALL}" = ""]?Set(EXTTOCALL=\${DB(CAMP_ON_LAST_TARGET/\${CALLER_EXT})}))`);
            dialplanLines.push(`same => n,GotoIf(\$["\${EXTTOCALL}" = "" | "\${EXTTOCALL}" = "\${CALLER_EXT}"]?no_target)`);
            dialplanLines.push(`same => n,AGI(sokrat-campon.py,register,\${CALLER_EXT},\${EXTTOCALL})`);
            dialplanLines.push(`same => n,Playback(beep)`);
            dialplanLines.push(`same => n,Playback(activated)`);
            dialplanLines.push(`same => n,Wait(1)`);
            dialplanLines.push(`same => n,Hangup()`);
            dialplanLines.push(`same => n(no_target),Playback(beeperr)`);
            dialplanLines.push(`same => n,Playback(cannot-complete-as-dialed)`);
            dialplanLines.push(`same => n,Hangup()\n`);
        }

        const campCancel = map['campon_cancel'];
        if (campCancel && campCancel.enabled && campCancel.code) {
            const c = campCancel.code.trim();
            dialplanLines.push(`; Camp-On Cancel: ${c}`);
            dialplanLines.push(`exten => ${c},1,NoOp(--- Feature Code ${c}: Camp-On Cancel from \${CALLERID(num)} Channel: \${CHANNEL} ---)`);
            dialplanLines.push(`same => n,Set(CALLER_EXT=\${CALLERID(num)})`);
            dialplanLines.push(`same => n,ExecIf(\$["\${CALLER_EXT}" = ""]?Set(CALLER_EXT=\${DB(DEVICE/\${CUT(CUT(CHANNEL,-,1),/,2)}/user)}))`);
            dialplanLines.push(`same => n,ExecIf(\$["\${CALLER_EXT}" = ""]?Set(CALLER_EXT=\${CUT(CUT(CHANNEL,-,1),/,2)}))`);
            dialplanLines.push(`same => n,Answer()`);
            dialplanLines.push(`same => n,AGI(sokrat-campon.py,cancel,\${CALLER_EXT})`);
            dialplanLines.push(`same => n,Playback(beep)`);
            dialplanLines.push(`same => n,Playback(cancelled)`);
            dialplanLines.push(`same => n,Wait(1)`);
            dialplanLines.push(`same => n,Hangup()\n`);
        }

        // 3. AI RNNoise Echo Tests
        const vadEcho = map['diag_rnnoise_vad'];
        if (vadEcho && vadEcho.enabled && vadEcho.code) {
            const c = vadEcho.code.trim();
            dialplanLines.push(`; RNNoise VAD Gate Echo Test: ${c}`);
            dialplanLines.push(`exten => ${c},1,NoOp(--- RNNoise AI Noise Suppression + VAD Gate Live Echo Test ---)`);
            dialplanLines.push(`same => n,Answer()`);
            dialplanLines.push(`same => n,Wait(0.5)`);
            dialplanLines.push(`same => n,Set(RNNOISE(both,gate=on)=on)`);
            dialplanLines.push(`same => n,Playback(beep)`);
            dialplanLines.push(`same => n,Echo()`);
            dialplanLines.push(`same => n,Hangup()\n`);
        }

        const contEcho = map['diag_rnnoise_cont'];
        if (contEcho && contEcho.enabled && contEcho.code) {
            const c = contEcho.code.trim();
            dialplanLines.push(`; RNNoise Continuous Echo Test: ${c}`);
            dialplanLines.push(`exten => ${c},1,NoOp(--- RNNoise AI Noise Suppression Continuous Echo Test ---)`);
            dialplanLines.push(`same => n,Answer()`);
            dialplanLines.push(`same => n,Wait(0.5)`);
            dialplanLines.push(`same => n,Set(RNNOISE(both,gate=off)=on)`);
            dialplanLines.push(`same => n,Playback(beep)`);
            dialplanLines.push(`same => n,Echo()`);
            dialplanLines.push(`same => n,Hangup()\n`);
        }

        const rawEcho = map['diag_rnnoise_raw'];
        if (rawEcho && rawEcho.enabled && rawEcho.code) {
            const c = rawEcho.code.trim();
            dialplanLines.push(`; Raw Audio Echo Test: ${c}`);
            dialplanLines.push(`exten => ${c},1,NoOp(--- Raw Audio Echo Test (Unfiltered A/B Comparison) ---)`);
            dialplanLines.push(`same => n,Answer()`);
            dialplanLines.push(`same => n,Wait(0.5)`);
            dialplanLines.push(`same => n,Set(RNNOISE(both)=off)`);
            dialplanLines.push(`same => n,Playback(beep)`);
            dialplanLines.push(`same => n,Echo()`);
            dialplanLines.push(`same => n,Hangup()\n`);
        }

        const content = dialplanLines.join('\n');
        fs.writeFileSync(DIALPLAN_CUSTOM_CODES_FILE, content, 'utf8');
        try {
            const { execSync } = require('child_process');
            execSync(`chown asterisk:asterisk "${DIALPLAN_CUSTOM_CODES_FILE}" 2>/dev/null; chmod 664 "${DIALPLAN_CUSTOM_CODES_FILE}" 2>/dev/null`);
        } catch (_) {}
    } catch (e) {
        console.warn('Error syncing call codes dialplan:', e.message);
    }
}

/**
 * Apply FreePBX / Asterisk changes for an updated call code
 * @param {object} pool
 * @param {object} row Existing row in sokrat_call_codes
 * @param {string} newCode
 * @param {number} isEnabled (1 or 0)
 */
async function applyCallCodeBackendUpdate(pool, row, newCode, isEnabled) {
    const cleanPrefix = (str) => String(str || '').replace(/\[Ext\]/gi, '').trim();

    if (row.backend_type === 'featurecode') {
        const clean = cleanPrefix(newCode);
        // If code is default and default is not '*', customcode can be NULL, else clean
        const customCode = (clean === row.default_code && row.default_code !== '*') ? null : clean;
        await pool.query(
            'UPDATE `asterisk`.`featurecodes` SET customcode = ?, enabled = ? WHERE modulename = ? AND featurename = ?',
            [customCode, isEnabled ? 1 : 0, row.backend_module, row.backend_feature]
        );
    } else if (row.backend_type === 'featurecode_pair') {
        const parts = newCode.split('/').map(p => p.trim());
        const part1 = parts[0] || '';
        const part2 = parts[1] || '';

        if (row.backend_feature && part1) {
            await pool.query(
                'UPDATE `asterisk`.`featurecodes` SET customcode = ?, enabled = ? WHERE modulename = ? AND featurename = ?',
                [part1, isEnabled ? 1 : 0, row.backend_module, row.backend_feature]
            );
        }
        if (row.backend_feature_secondary && part2) {
            await pool.query(
                'UPDATE `asterisk`.`featurecodes` SET customcode = ?, enabled = ? WHERE modulename = ? AND featurename = ?',
                [part2, isEnabled ? 1 : 0, row.backend_module, row.backend_feature_secondary]
            );
        }
    } else if (row.backend_type === 'parking_lot') {
        const clean = newCode.trim();
        await pool.query(
            'UPDATE `asterisk`.`parkplus` SET parkext = ? WHERE defaultlot = "yes"',
            [clean]
        );
    } else if (row.backend_type === 'parking_retrieve') {
        const firstPos = newCode.split(/[^0-9]/)[0] || '71';
        await pool.query(
            'UPDATE `asterisk`.`parkplus` SET parkpos = ? WHERE defaultlot = "yes"',
            [firstPos]
        );
    }

    // Always re-generate dialplan file for custom codes
    await syncSokratCallCodesDialplan(pool);
}

/**
 * Reset all call control codes to factory default configurations
 * @param {object} pool
 */
async function resetCallCodesToDefaults(pool) {
    // 1. Reset all rows in sokrat_call_codes
    await pool.query('UPDATE `asterisk`.`sokrat_call_codes` SET code = default_code, enabled = 1');

    // 2. Reset FreePBX featurecodes
    await pool.query('UPDATE `asterisk`.`featurecodes` SET customcode = NULL WHERE NOT (modulename = "core" AND featurename IN ("pickupexten", "pickup")) AND NOT (modulename = "voicemail" AND featurename = "directdialvoicemail")');
    await pool.query('UPDATE `asterisk`.`featurecodes` SET customcode = "*", enabled = 1 WHERE modulename = "core" AND featurename IN ("pickupexten", "pickup")');
    await pool.query('UPDATE `asterisk`.`featurecodes` SET customcode = "**", enabled = 0 WHERE modulename = "voicemail" AND featurename = "directdialvoicemail"');
    await pool.query('UPDATE `asterisk`.`featurecodes` SET enabled = 1 WHERE modulename IN ("core", "callforward", "donotdisturb", "callwaiting", "queues", "infoservices", "blacklist")');

    // 3. Reset parking lot
    await pool.query('UPDATE `asterisk`.`parkplus` SET parkext = "70", parkpos = "71" WHERE defaultlot = "yes"');

    // 4. Re-sync dialplan
    await syncSokratCallCodesDialplan(pool);
}

module.exports = {
    DEFAULT_CALL_CODES,
    initSokratCallCodes,
    getCallCodes,
    syncSokratCallCodesDialplan,
    applyCallCodeBackendUpdate,
    resetCallCodesToDefaults
};
