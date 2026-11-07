'use strict';

/**
 * Normalise provider-specific STT payloads into one transcript shape:
 *   { text, language, segments: [{ speaker, start_ms, end_ms, text, confidence }] }
 */

function toMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n);
}

function secondsToMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 1000);
}

function normaliseSpeaker(value) {
    if (value === null || value === undefined) return 'unknown';
    const raw = String(value).trim();
    if (!raw) return 'unknown';
    if (/^(agent|employee|operator|staff|rep|representative)$/i.test(raw)) return 'agent';
    if (/^(customer|caller|client|user|lead)$/i.test(raw)) return 'customer';
    if (/^\d+$/.test(raw)) return `speaker_${raw}`;
    return raw.slice(0, 32);
}

function normaliseSegments(segments, durationSec = 0) {
    if (!Array.isArray(segments)) return [];
    const fallbackEnd = Math.max(0, Math.round(Number(durationSec || 0) * 1000));
    const result = [];
    for (let i = 0; i < segments.length; i++) {
        const item = segments[i] || {};
        const text = String(item.text || item.transcript || '').trim();
        if (!text) continue;
        const start = toMs(item.start_ms ?? item.start ?? item.startTime ?? item.start_time);
        let end = toMs(item.end_ms ?? item.end ?? item.endTime ?? item.end_time);
        if (end !== null && start !== null && end < start) end = start;
        result.push({
            seq: result.length,
            speaker: normaliseSpeaker(item.speaker ?? item.speaker_label ?? item.channel ?? item.role),
            start_ms: start === null ? null : start,
            end_ms: end === null ? (fallbackEnd || null) : end,
            text,
            confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null
        });
    }
    return result;
}

function singleSegment(text, durationSec = 0) {
    const clean = String(text || '').trim();
    if (!clean) return [];
    return [{
        seq: 0,
        speaker: 'unknown',
        start_ms: 0,
        end_ms: durationSec ? Math.round(Number(durationSec) * 1000) : null,
        text: clean,
        confidence: null
    }];
}

function deepgramSegments(data, fallbackText = '') {
    const utterances = data?.results?.utterances;
    if (Array.isArray(utterances) && utterances.length) {
        const segments = utterances.map((u, i) => ({
            seq: i,
            speaker: normaliseSpeaker(u.speaker),
            start_ms: secondsToMs(u.start),
            end_ms: secondsToMs(u.end),
            text: String(u.transcript || '').trim(),
            confidence: Number.isFinite(Number(u.confidence)) ? Number(u.confidence) : null
        })).filter(s => s.text);
        if (segments.length) return segments;
    }

    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    const words = alt?.words;
    if (Array.isArray(words) && words.length) {
        const grouped = [];
        for (const word of words) {
            const speaker = normaliseSpeaker(word.speaker);
            const previous = grouped[grouped.length - 1];
            if (previous && previous.speaker === speaker) {
                previous.text += ` ${word.punctuated_word || word.word || ''}`.trimEnd();
                previous.end_ms = secondsToMs(word.end);
            } else {
                grouped.push({
                    seq: grouped.length,
                    speaker,
                    start_ms: secondsToMs(word.start),
                    end_ms: secondsToMs(word.end),
                    text: String(word.punctuated_word || word.word || '').trim(),
                    confidence: Number.isFinite(Number(word.confidence)) ? Number(word.confidence) : null
                });
            }
        }
        if (grouped.length) return grouped;
    }

    return singleSegment(fallbackText || alt?.transcript || '');
}

function assemblySegments(data, fallbackText = '') {
    let utterances = data?.utterances;
    if (typeof utterances === 'string') {
        try { utterances = JSON.parse(utterances); } catch (_) { utterances = null; }
    }
    if (Array.isArray(utterances) && utterances.length) {
        const segments = utterances.map((u, i) => ({
            seq: i,
            speaker: normaliseSpeaker(u.speaker),
            start_ms: toMs(u.start),
            end_ms: toMs(u.end),
            text: String(u.text || '').trim(),
            confidence: Number.isFinite(Number(u.confidence)) ? Number(u.confidence) : null
        })).filter(s => s.text);
        if (segments.length) return segments;
    }
    return singleSegment(fallbackText || data?.text || '');
}

function transcriptText(segments, fallback = '') {
    const text = (segments || []).map(s => s.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return text || String(fallback || '').trim();
}

function formatTimestamp(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '--:--';
    const total = Math.max(0, Math.round(Number(ms) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTranscriptForPrompt(segments, text) {
    if (Array.isArray(segments) && segments.length) {
        return segments.map(segment => {
            const speaker = segment.speaker || 'unknown';
            return `[${formatTimestamp(segment.start_ms)}] ${speaker}: ${segment.text}`;
        }).join('\n');
    }
    return String(text || '').trim();
}

module.exports = {
    normaliseSpeaker,
    normaliseSegments,
    singleSegment,
    deepgramSegments,
    assemblySegments,
    transcriptText,
    formatTranscriptForPrompt,
    formatTimestamp
};
