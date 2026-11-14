'use strict';

// States where the modem/chan_dongle is not usable for SIM/IMSI work.
// "GSM Not Registered" is intentionally not included: the modem can read IMSI
// even when the carrier registration is still pending.
const UNAVAILABLE_STATE_PATTERN = /(?:not\s*connec|not_conn|disconnected|offline|not\s*init|not\s*respond)/i;

function normalizeDongleId(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

function normalizeState(value) {
    return String(value == null ? '' : value).trim();
}

function isDongleUnavailable(rawState) {
    return UNAVAILABLE_STATE_PATTERN.test(normalizeState(rawState));
}

function isUsableImsi(value) {
    const imsi = String(value == null ? '' : value).trim();
    if (!imsi || imsi === '-' || imsi === 'N/A') return false;
    if (/^(unknown|none|null)$/i.test(imsi)) return false;
    return /^\d{5,}$/.test(imsi);
}

function findDongle(devices, dongleId) {
    const id = normalizeDongleId(dongleId);
    if (!id || !Array.isArray(devices)) return null;
    return devices.find(device => normalizeDongleId(device && (device.ID || device.id)) === id) || null;
}

function getDeviceState(device) {
    return normalizeState(device && (device.State || device.state || device.status));
}

function evaluateRestartHealth(device) {
    if (!device) {
        return { healthy: false, reason: 'not_found', state: 'Unknown' };
    }

    const state = getDeviceState(device);
    if (!state) {
        return { healthy: false, reason: 'state_unknown', state: 'Unknown' };
    }
    if (isDongleUnavailable(state)) {
        return { healthy: false, reason: 'dongle_unavailable', state };
    }
    if (!isUsableImsi(device.IMSI)) {
        return { healthy: false, reason: 'imsi_unreadable', state };
    }

    return { healthy: true, reason: 'ready', state };
}

function buildImsiFailureEvent({ dongleId, logTime, device } = {}) {
    const id = normalizeDongleId(dongleId);
    const state = device ? getDeviceState(device) : 'Not Connected';
    const unavailable = !device || isDongleUnavailable(state);

    if (unavailable) {
        return {
            event: 'dongleOffline',
            payload: {
                dongleId: id,
                error: 'dongle_offline',
                state: state || 'Not Connected',
                logTime: String(logTime || '').trim(),
                messageEn: `Dongle ${id} is offline. IMSI reading was not used for a SIM alert while the modem is disconnected.`,
                messageAr: `الدونجل ${id} غير متصل. لم يتم استخدام فشل قراءة IMSI لتنبيه بطاقة SIM أثناء انقطاع المودم.`
            }
        };
    }

    return {
        event: 'dongleSimError',
        payload: {
            dongleId: id,
            error: 'imsi_failed',
            state,
            logTime: String(logTime || '').trim(),
            messageEn: `IMSI read failed on ${id} while the dongle is connected. The modem may be reinitializing; inspect the SIM only if this persists.`,
            messageAr: `فشلت قراءة IMSI على ${id} بينما الدونجل متصل. قد يكون المودم قيد إعادة التهيئة؛ افحص بطاقة SIM فقط إذا استمرت المشكلة.`
        }
    };
}

function buildDongleRecoveredEvent(dongleId, logTime) {
    return {
        dongleId: normalizeDongleId(dongleId),
        state: 'initialized',
        logTime: String(logTime || '').trim()
    };
}

function updateImsiFailureStreak(streak, now, options = {}) {
    const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const threshold = Number.isFinite(Number(options.threshold)) && Number(options.threshold) > 0
        ? Number(options.threshold)
        : 5;
    const windowMs = Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
        ? Number(options.windowMs)
        : 5 * 60 * 1000;

    const next = {
        count: 0,
        firstAt: timestamp,
        lastAt: timestamp,
        escalatedAt: null,
        ...(streak && typeof streak === 'object' ? streak : {})
    };

    if (!Number.isFinite(Number(next.firstAt)) || timestamp - Number(next.firstAt) > windowMs) {
        next.count = 0;
        next.firstAt = timestamp;
        next.escalatedAt = null;
    }

    next.count = Number(next.count) + 1;
    next.lastAt = timestamp;

    const shouldEscalate = next.count >= threshold && !next.escalatedAt;
    if (shouldEscalate) next.escalatedAt = timestamp;

    return { streak: next, shouldEscalate };
}

function buildImsiEscalationEvent({ dongleId, count, state, windowMs } = {}) {
    const id = normalizeDongleId(dongleId);
    const minutes = Math.max(1, Math.round((Number(windowMs) || 5 * 60 * 1000) / 60000));
    return {
        dongleId: id,
        count: Number(count) || 0,
        state: normalizeState(state) || 'Unknown',
        messageEn: `Dongle ${id} failed IMSI initialization ${Number(count) || 0} times in ${minutes} minutes. Automatic restart retries are paused; perform a USB replug or manual modem check.`,
        messageAr: `فشل تهيئة IMSI في الدونجل ${id} ${Number(count) || 0} مرات خلال ${minutes} دقائق. تم إيقاف إعادة المحاولة التلقائية مؤقتاً؛ يلزم إعادة توصيل USB أو فحص المودم يدوياً.`
    };
}

function buildRestartFailedEvent({ dongleId, state, reason, retryAfterSec } = {}) {
    const id = normalizeDongleId(dongleId);
    const wait = Math.max(1, Math.ceil((Number(retryAfterSec) || 300) / 60));
    return {
        dongleId: id,
        state: normalizeState(state) || 'Unknown',
        reason: String(reason || 'unhealthy'),
        retryAfterSec: Number(retryAfterSec) || 300,
        messageEn: `Restart of ${id} did not recover the modem (${normalizeState(state) || 'Unknown'}). Automatic retries are paused for ${wait} minutes; escalate to a USB replug.`,
        messageAr: `لم تؤدِ إعادة تشغيل ${id} إلى استعادة المودم (${normalizeState(state) || 'غير معروف'}). تم إيقاف المحاولات التلقائية لمدة ${wait} دقائق؛ يلزم إعادة توصيل USB.`
    };
}

function buildRestartHealthyEvent({ dongleId, state } = {}) {
    return {
        dongleId: normalizeDongleId(dongleId),
        state: normalizeState(state) || 'Ready'
    };
}

function formatRestartAuditEntry(entry, now) {
    const date = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    const timestamp = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
    return JSON.stringify({ ...(entry && typeof entry === 'object' ? entry : {}), ts: timestamp });
}

module.exports = {
    UNAVAILABLE_STATE_PATTERN,
    normalizeDongleId,
    normalizeState,
    isDongleUnavailable,
    isUsableImsi,
    findDongle,
    getDeviceState,
    evaluateRestartHealth,
    buildImsiFailureEvent,
    buildDongleRecoveredEvent,
    updateImsiFailureStreak,
    buildImsiEscalationEvent,
    buildRestartFailedEvent,
    buildRestartHealthyEvent,
    formatRestartAuditEntry
};
