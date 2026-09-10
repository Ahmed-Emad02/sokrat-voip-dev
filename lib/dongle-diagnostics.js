/**
 * Sokrat VoIP - GSM Dongle Diagnostic & AT Response Explanation Service
 * Interprets raw cellular AT command outputs and provides structured,
 * human-readable explanations for network engineers and PBX administrators.
 */

/**
 * Parses and generates plain-language explanations for common cellular AT commands
 * @param {string} rawCommand AT command string (e.g. 'AT^CARDLOCK?', 'AT+CREG?')
 * @param {string} rawOutput Raw text output returned by modem
 * @param {string} [lang='en'] Language code ('en' or 'ar')
 * @returns {object} { command, rawOutput, summary, badge, severity, details, recommendation }
 */
function explainAtCommandOutput(rawCommand, rawOutput, lang = 'en') {
    const cmd = String(rawCommand || '').trim().toUpperCase();
    const out = String(rawOutput || '').trim();
    const isAr = lang === 'ar';

    // 1. AT^CARDLOCK? (Carrier Network Lock & Attempt Counter)
    if (cmd.includes('CARDLOCK')) {
        const match = out.match(/\^CARDLOCK:\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\w+))?/i);
        if (match) {
            const status = parseInt(match[1], 10);
            const attempts = parseInt(match[2], 10);
            const lockType = match[3] || '0';

            if (status === 3 && attempts === 0) {
                return {
                    command: cmd,
                    rawOutput: out,
                    badge: isAr ? 'قفل شبكة دائم (المحاولات 0)' : 'Permanent Carrier Lock (0 Attempts)',
                    severity: 'danger',
                    summary: isAr 
                        ? 'المودم مقفل على شبكة المشغل الأصلي (Orange) واستنفذ جميع محاولات فك التشفير (0 من 10).'
                        : 'Modem is locked to its original carrier (Orange) and unlock attempts are exhausted (0 of 10).',
                    details: [
                        isAr ? `حالة القفل: 3 (مقفل بصفة دائمة)` : `Lock State: 3 (Permanently Locked)`,
                        isAr ? `المحاولات المتبقية: 0 محاولة` : `Remaining Attempts: 0 / 10`,
                        isAr ? `رمز المشغل المقيد: ${lockType}` : `Lock Operator Code: ${lockType}`,
                        isAr ? `النتيجة: أي شريحة من مشغل آخر (مثل Vodafone) سيتم رفض تسجيلها تلقائياً (+CREG: 2,3).` : `Effect: SIM cards from other carriers (e.g. Vodafone) will be rejected by the baseband.`
                    ],
                    recommendation: isAr
                        ? 'ضع شريحة من نفس مشغل المودم الأصلي (Orange) وستعمل فوراً كـ Free، أو استخدم مودم مفتوح رسمياً لتشغيل فودافون.'
                        : 'Insert a native carrier SIM (Orange) which bypasses the lock and connects to Free immediately, or use an unlocked modem for Vodafone.'
                };
            } else if (status === 2) {
                return {
                    command: cmd,
                    rawOutput: out,
                    badge: isAr ? 'المودم مفتوح لجميع الشبكات' : 'Factory / Fully Unlocked',
                    severity: 'success',
                    summary: isAr 
                        ? 'المودم مفتوح رسمياً وبدون أي قيود، يقبل شرائح جميع شركات الاتصالات.'
                        : 'Modem is factory unlocked without carrier restrictions and accepts SIM cards from all carriers.',
                    details: [
                        isAr ? 'حالة القفل: 2 (مفتوح بالكامل)' : 'Lock State: 2 (Unlocked)',
                        isAr ? `المحاولات المتاحة: ${attempts}` : `Available Attempts: ${attempts}`,
                        isAr ? 'النتيجة: جاهز للاتصال المباشر بأي شبكة خلوية.' : 'Status: Ready for immediate cellular registration on any network.'
                    ],
                    recommendation: isAr
                        ? 'المودم في أفضل حالة تشغيلية ممكنة.'
                        : 'Device is in optimal operating state.'
                };
            } else if (status === 1) {
                return {
                    command: cmd,
                    rawOutput: out,
                    badge: isAr ? 'مقفل على شبكة (محاولات متاحة)' : 'Locked (Attempts Available)',
                    severity: 'warning',
                    summary: isAr 
                        ? `المودم مقفل على شبكة المشغل ولكن يمكن فك تشفيره (متبقي ${attempts} محاولة).`
                        : `Modem is carrier locked, but can be unlocked (${attempts} attempts remaining).`,
                    details: [
                        isAr ? 'حالة القفل: 1 (مقفل - يتطلب رمز NCK)' : 'Lock State: 1 (Locked - Requires NCK code)',
                        isAr ? `المحاولات المتبقية: ${attempts} من 10` : `Remaining Attempts: ${attempts} of 10`
                    ],
                    recommendation: isAr
                        ? 'أدخل رمز NCK الصحيح لفك تشفير المودم.'
                        : 'Enter the valid NCK unlock code to unlock the device.'
                };
            }
        }
    }

    // 2. AT^SYSINFO (System Service State, Domain, Roaming, SIM Status)
    if (cmd.includes('SYSINFO')) {
        const match = out.match(/\^SYSINFO:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (match) {
            const srvStatus = parseInt(match[1], 10);
            const srvDomain = parseInt(match[2], 10);
            const roamStatus = parseInt(match[3], 10);
            const sysMode = parseInt(match[4], 10);
            const simState = parseInt(match[5], 10);

            const modeMap = { 0: 'No Service', 1: 'AMPS', 2: 'CDMA', 3: 'GSM/GPRS/EDGE (2G)', 5: 'WCDMA/UMTS (3G)' };
            const modeName = modeMap[sysMode] || `Mode ${sysMode}`;

            if (srvStatus === 2 && simState === 1) {
                return {
                    command: cmd,
                    rawOutput: out,
                    badge: isAr ? 'خدمة كاملة ونشطة' : 'Valid Full Service',
                    severity: 'success',
                    summary: isAr
                        ? `المودم متصل بنجاح بالشبكة (${modeName}) في وضع الخدمة الكاملة (صوت وبيانات).`
                        : `Modem is fully registered on the cellular network (${modeName}) with active voice/data services.`,
                    details: [
                        isAr ? 'حالة الخدمة: 2 (خدمة صالحة ومستقرة)' : 'Service Status: 2 (Valid Service)',
                        isAr ? 'حالة الشريحة: 1 (شريحة صالحة ومقبولة بالبرج)' : 'SIM State: 1 (Valid SIM accepted by cell tower)',
                        isAr ? `نطاق التجوال: ${roamStatus === 1 ? 'تجوال نشط' : 'شبكة محلية (بدون تجوال)'}` : `Roaming: ${roamStatus === 1 ? 'Roaming Active' : 'Home Network'}`,
                        isAr ? `تقنية الراديو: ${modeName}` : `Radio Mode: ${modeName}`
                    ],
                    recommendation: isAr ? 'الخط في وضع جاهزية كاملة (Free).' : 'Trunk is ready for calls (Free state).'
                };
            } else if (srvStatus === 1 || simState === 0) {
                return {
                    command: cmd,
                    rawOutput: out,
                    badge: isAr ? 'خدمة مقيدة / الشريحة مرفوضة' : 'Restricted Service / SIM Rejected',
                    severity: 'danger',
                    summary: isAr
                        ? 'المودم في وضع "خدمة مقيدة" (طوارئ فقط) والبرج يرفض الشريحة بسبب قفل الجهاز أو إيقاف الخط.'
                        : 'Modem is in Restricted Service mode (emergency calls only); cell tower rejected the SIM due to device lock or deactivated line.',
                    details: [
                        isAr ? 'حالة الخدمة: 1 (خدمة مقيدة / طوارئ فقط)' : 'Service Status: 1 (Restricted Service - Emergency only)',
                        isAr ? 'حالة الشريحة: 0 (شريحة غير صالحة / مرفوضة بالشبكة)' : 'SIM State: 0 (Invalid SIM / Rejected by carrier HLR)',
                        isAr ? `حالة التجوال: ${roamStatus === 1 ? 'محاولة تجوال (Roaming)' : 'محلي'}` : `Roaming State: ${roamStatus === 1 ? 'Roaming' : 'Home'}`,
                        isAr ? `التقنية الملتقطة: ${modeName}` : `Carrier Technology: ${modeName}`
                    ],
                    recommendation: isAr
                        ? 'تأكد من شحن الشريحة وتفعيلها، أو تأكد أن المودم غير مقفل على شبكة أخرى.'
                        : 'Verify line status with operator, or ensure the modem is not carrier-locked.'
                };
            }
        }
    }

    // 3. AT+CREG? (Circuit-Switched GSM Network Registration)
    if (cmd.includes('CREG')) {
        const match = out.match(/\+CREG:\s*\d+\s*,\s*(\d+)/i);
        if (match) {
            const stat = parseInt(match[1], 10);
            const regMap = {
                0: { badge: isAr ? 'غير مسجل' : 'Not Registered', sev: 'warning', text: isAr ? 'المودم غير مسجل ولا يبحث حالياً عن شبكة.' : 'Not registered; modem is not searching for a network.' },
                1: { badge: isAr ? 'مسجل (شبكة محلية)' : 'Registered (Home Network)', sev: 'success', text: isAr ? 'المودم مسجل بنجاح على شبكته الخلوية المحلية وجاهز لإجراء المكالمات.' : 'Successfully registered on home cellular network. Ready for calls.' },
                2: { badge: isAr ? 'جاري البحث عن شبكة' : 'Searching Network...', sev: 'warning', text: isAr ? 'المودم يبحث حالياً عن أبراج شبكة المشغل المتاحة.' : 'Modem is currently scanning and searching for cell towers.' },
                3: { badge: isAr ? 'رفض التسجيل (Denied)' : 'Registration Denied', sev: 'danger', text: isAr ? 'برج الشبكة رفض تسجيل المودم (Location Update Reject) بسبب قفل الجهاز أو إيقاف الخط.' : 'Cell tower explicitly rejected registration (Location Update Reject). SIM may be suspended or modem carrier-locked.' },
                4: { badge: isAr ? 'حالة غير معروفة' : 'Unknown Status', sev: 'warning', text: isAr ? 'حالة التسجيل غير محددة.' : 'Registration status is unknown.' },
                5: { badge: isAr ? 'مسجل (تجوال)' : 'Registered (Roaming)', sev: 'success', text: isAr ? 'المودم مسجل بنجاح عبر شبكة شريكة (تجوال محلي أو دولي).' : 'Registered on a roaming partner network.' }
            };
            const r = regMap[stat] || { badge: `CREG ${stat}`, sev: 'warning', text: out };
            return {
                command: cmd,
                rawOutput: out,
                badge: r.badge,
                severity: r.sev,
                summary: r.text,
                details: [
                    isAr ? `رمز حالة CREG: ${stat}` : `CREG Status Code: ${stat}`,
                    r.text
                ],
                recommendation: stat === 3 
                    ? (isAr ? 'البرج الخلوي يرفض تسجيل الشريحة. تحقق من صلاحية الخط أو استبدل المودم بآخر غير مقفل.' : 'Cell tower denied access. Check line validity or use an unlocked dongle.')
                    : (stat === 1 || stat === 5 ? (isAr ? 'الشبكة متصلة بنجاح.' : 'Cellular connection active.') : (isAr ? 'انتظر اكتمال البحث عن الأبراج.' : 'Wait for network search.'))
            };
        }
    }

    // 4. AT+CSQ (Signal Quality Indicator / RSSI)
    if (cmd.includes('CSQ')) {
        const match = out.match(/\+CSQ:\s*(\d+)\s*,\s*(\d+)/i);
        if (match) {
            const rssi = parseInt(match[1], 10);
            const ber = parseInt(match[2], 10);
            let dbm = -113 + (rssi * 2);
            let quality = 'Poor';
            let qualityAr = 'ضعيفة';
            let sev = 'danger';

            if (rssi >= 20) { quality = 'Excellent'; qualityAr = 'ممتازة جداً'; sev = 'success'; }
            else if (rssi >= 15) { quality = 'Good'; qualityAr = 'جيدة'; sev = 'success'; }
            else if (rssi >= 10) { quality = 'Fair'; qualityAr = 'متوسطة'; sev = 'warning'; }

            if (rssi === 99) {
                dbm = 'Unknown';
                quality = 'No Signal';
                qualityAr = 'لا توجد إشارة';
                sev = 'danger';
            }

            return {
                command: cmd,
                rawOutput: out,
                badge: isAr ? `الإشارة: ${rssi}/31 (${qualityAr})` : `Signal: ${rssi}/31 (${quality})`,
                severity: sev,
                summary: isAr 
                    ? `مستوى قوة الإشارة الخلوية: ${rssi} من 31 (${dbm} dBm - ${qualityAr}).`
                    : `Signal Quality Level: ${rssi} / 31 (~${dbm} dBm - ${quality}).`,
                details: [
                    isAr ? `قيمة RSSI الخام: ${rssi} (النطاق: 0 - 31)` : `Raw RSSI Value: ${rssi} (Range: 0 - 31)`,
                    isAr ? `القدرة المحسوبة: ${dbm} dBm` : `Estimated Power: ${dbm} dBm`,
                    isAr ? `معدل خطأ البتات (BER): ${ber}` : `Bit Error Rate (BER): ${ber}`
                ],
                recommendation: rssi < 10 
                    ? (isAr ? 'الإشارة ضعيفة، يفضل استخدام كابل USB أطول ونقل المودم بالقرب من نافذة.' : 'Signal is weak; use an extended USB cable or move modem closer to a window.')
                    : (isAr ? 'قوة الإشارة ممتازة ومثالية للمكالمات الصوتية.' : 'Signal is healthy for stable voice calls.')
            };
        }
    }

    // 5. AT+COPS? (Operator Selection)
    if (cmd.includes('COPS')) {
        const match = out.match(/\+COPS:\s*(\d+)\s*(?:,\s*(\d+)\s*,\s*"([^"]+)")?/i);
        if (match) {
            const mode = parseInt(match[1], 10);
            const format = match[2];
            const oper = match[3];

            if (oper) {
                return {
                    command: cmd,
                    rawOutput: out,
                    badge: isAr ? `المشغل: ${oper}` : `Operator: ${oper}`,
                    severity: 'success',
                    summary: isAr 
                        ? `المودم ملتقط لشبكة: ${oper} (الوضع: ${mode === 0 ? 'تلقائي' : 'يدوي'}).`
                        : `Modem attached to operator: ${oper} (Selection: ${mode === 0 ? 'Automatic' : 'Manual'}).`,
                    details: [
                        isAr ? `اسم / كود المشغل: ${oper}` : `Operator Name/Code: ${oper}`,
                        isAr ? `وضع الاختيار: ${mode === 0 ? 'تلقائي (Automatic)' : 'يدوي (Manual)'}` : `Selection Mode: ${mode === 0 ? 'Automatic' : 'Manual'}`
                    ],
                    recommendation: isAr ? 'المودم مرتبط بشبكة الاتصالات بنجاح.' : 'Modem successfully attached to cellular carrier.'
                };
            } else {
                return {
                    command: cmd,
                    rawOutput: out,
                    badge: isAr ? 'لا يوجد مشغل متصل' : 'No Operator Attached',
                    severity: 'warning',
                    summary: isAr
                        ? 'البحث التلقائي عن الشبكات مفعل ولكن المودم غير مرتبط بأي مشغل حالياً.'
                        : 'Automatic network selection is active, but modem is not currently attached to any carrier.',
                    details: [
                        isAr ? 'وضع الاختيار: 0 (تلقائي)' : 'Mode: 0 (Automatic)',
                        isAr ? 'حالة الاتصال: غير متصل' : 'State: Detached'
                    ],
                    recommendation: isAr ? 'تأكد من صلاحية الشريحة وقوة التغطية في المكان.' : 'Check SIM card validity and signal coverage.'
                };
            }
        }
    }

    // 6. AT^SYSCFG (Radio Access Mode Preferences & Setting)
    if (cmd.includes('SYSCFG')) {
        const setMatch = cmd.match(/\^SYSCFG\s*=\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9A-F]+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (setMatch) {
            const mode = parseInt(setMatch[1], 10);
            const isOk = /OK/i.test(out);

            const modeLabels = {
                14: { en: '3G Only (WCDMA / UMTS)', ar: 'قفل على الجيل الثالث 3G فقط' },
                13: { en: '2G Only (GSM / GPRS)', ar: 'قفل على الجيل الثاني 2G فقط' },
                2: { en: 'Auto (3G Preferred, 2G Fallback)', ar: 'تلقائي (3G مفضل مع رجوع تلقائي إلى 2G)' }
            };

            const label = modeLabels[mode] || { en: `Mode ${mode}`, ar: `الوضع ${mode}` };

            if (isOk) {
                return {
                    command: cmd,
                    rawOutput: out,
                    badge: isAr ? `تم الضبط: ${label.ar}` : `Configured: ${label.en}`,
                    severity: mode === 2 ? 'success' : (mode === 14 ? 'info' : 'warning'),
                    summary: isAr 
                        ? `تمت برمجة المودم بنجاح للعمل بوضع: ${label.ar}.`
                        : `Successfully reprogrammed modem radio to: ${label.en}.`,
                    details: [
                        isAr ? `الأمر المنفذ: ${cmd}` : `Executed Command: ${cmd}`,
                        isAr ? `وضع الراديو المبرمج: ${label.ar}` : `Programmed Mode: ${label.en}`,
                        isAr ? `استجابة المودم: OK (تم قبول الإعداد وحفظه)` : `Modem Response: OK (Setting applied and saved to NVRAM)`
                    ],
                    recommendation: mode === 2 
                        ? (isAr ? 'الوضع التلقائي هو الخيار الافتراضي الموصى به لضمان استمرار عمل المكالمات والرجوع التلقائي إلى 2G عند انقطاع 3G.' : 'Auto mode is the recommended default for automatic failover between 3G and 2G.')
                        : (mode === 14 
                            ? (isAr ? 'تنبيه: في حال إيقاف شبكة 3G في منطقتك، سيفقد المودم الإشارة ولن يعود تلقائياً لـ 2G.' : 'Warning: If 3G has been sunset in your cell sector, the modem will lose service without falling back to 2G.')
                            : (isAr ? 'المودم يعمل الآن حصراً عبر شبكة 2G GSM.' : 'Modem is now locked to 2G GSM only.'))
                };
            }
        }

        const match = out.match(/\^SYSCFG:\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9A-F]+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (match) {
            const mode = parseInt(match[1], 10);
            const order = parseInt(match[2], 10);
            const band = match[3];
            const roam = parseInt(match[4], 10);
            const domain = parseInt(match[5], 10);

            const modeNames = { 2: 'Auto (2G/3G)', 13: '2G GSM Only', 14: '3G WCDMA Only' };
            const modeNamesAr = { 2: 'تلقائي (2G/3G)', 13: '2G GSM فقط', 14: '3G WCDMA فقط' };

            const is2G = mode === 13;
            const is3G = mode === 14;
            const isAuto = mode === 2;

            return {
                command: cmd,
                rawOutput: out,
                badge: isAr ? `التهيئة: ${modeNamesAr[mode] || mode}` : `Radio: ${modeNames[mode] || mode}`,
                severity: isAuto ? 'success' : 'info',
                summary: isAr
                    ? `إعدادات الراديو: ${modeNamesAr[mode] || mode}، التجوال: ${roam === 1 ? 'معطل' : 'مفعل'}.`
                    : `Radio Mode: ${modeNames[mode] || mode}, Roaming: ${roam === 1 ? 'Disabled' : 'Allowed'}.`,
                details: [
                    isAr ? `الوضع المبرمج: ${modeNamesAr[mode] || mode}` : `Configured Mode: ${modeNames[mode] || mode}`,
                    isAr ? `ترددات الشبكة: ${band} (جميع النطاقات)` : `Supported Bands: ${band} (All bands active)`,
                    isAr ? `سياسة التجوال: ${roam === 1 ? 'ممنوع (No Roaming)' : 'مسموح (Roaming Allowed)'}` : `Roaming Policy: ${roam === 1 ? 'Disallowed' : 'Allowed'}`
                ],
                recommendation: isAr
                    ? 'في مصر، يوصى بالوضع التلقائي (AT^SYSCFG=2,2,3FFFFFFF,2,2) لتجاوز إغلاق شبكات 3G تلقائياً.'
                    : 'Auto mode (AT^SYSCFG=2,2,3FFFFFFF,2,2) is recommended to automatically adapt to 3G sunsets.'
            };
        }
    }

    // 7. AT+CPIN? (SIM Card PIN / Verification State)
    if (cmd.includes('CPIN')) {
        if (out.includes('READY')) {
            return {
                command: cmd,
                rawOutput: out,
                badge: isAr ? 'الشريحة جاهزة ومقبولة' : 'SIM Ready',
                severity: 'success',
                summary: isAr
                    ? 'الشريحة صالحة، مفعلة، ولا تتطلب إدخال رمز PIN.'
                    : 'SIM card is detected, active, and requires no PIN code entry.',
                details: [
                    isAr ? 'حالة PIN: READY (جاهز)' : 'PIN Status: READY',
                    isAr ? 'الشريحة مهيأة للمكالمات والرسائل.' : 'SIM card initialized for voice and SMS.'
                ],
                recommendation: isAr ? 'الشريحة جاهزة للاستخدام.' : 'SIM card is ready for use.'
            };
        } else if (out.includes('SIM PIN')) {
            return {
                command: cmd,
                rawOutput: out,
                badge: isAr ? 'مطلوب رمز PIN للشريحة' : 'SIM PIN Required',
                severity: 'danger',
                summary: isAr
                    ? 'الشريحة مقفلة برمز حماية PIN ويجب إدخال الرمز لتشغيلها.'
                    : 'SIM card is locked with a PIN code. Enter PIN to proceed.',
                details: [
                    isAr ? 'الحالة: SIM PIN' : 'Status: SIM PIN Required'
                ],
                recommendation: isAr ? 'قم بإلغاء قفل PIN من الهاتف أو عبر أمر AT+CPIN="0000".' : 'Disable PIN from phone or via AT+CPIN="<pin>".'
            };
        } else if (out.includes('PH-NET PIN')) {
            return {
                command: cmd,
                rawOutput: out,
                badge: isAr ? 'مطلوب رمز فك تشفير الشبكة (NCK)' : 'Network Unlock PIN (NCK) Required',
                severity: 'danger',
                summary: isAr
                    ? 'المودم يطالب بإدخال رمز فك التشفير للشبكة (NCK).'
                    : 'Modem is prompting for the Network Personalization unlock code (NCK).',
                details: [
                    isAr ? 'الحالة: PH-NET PIN' : 'Status: PH-NET PIN'
                ],
                recommendation: isAr ? 'المودم يحتاج إلى إدخال رمز NCK لفك قفل الشبكة.' : 'Modem requires valid NCK code to unlock network.'
            };
        }
    }

    // Fallback Generic Response
    const isSuccess = /OK/i.test(out);
    const isError = /ERROR/i.test(out);
    return {
        command: cmd,
        rawOutput: out,
        badge: isError ? (isAr ? 'خطأ في التنفيذ' : 'Command Error') : (isSuccess ? (isAr ? 'تم بنجاح' : 'Success') : (isAr ? 'استجابة' : 'Response')),
        severity: isError ? 'danger' : (isSuccess ? 'info' : 'warning'),
        summary: isError 
            ? (isAr ? 'أعاد المودم رسالة خطأ (ERROR) على هذا الأمر.' : 'Modem returned an ERROR response for this command.')
            : (isAr ? 'تم استقبال استجابة المودم بنجاح.' : 'Modem response received successfully.'),
        details: out.split('\n').filter(Boolean),
        recommendation: isAr ? 'راجع دليل أوامر AT الخاصة بمودمات هواوي.' : 'Refer to Huawei AT command reference for this syntax.'
    };
}

module.exports = {
    explainAtCommandOutput
};
