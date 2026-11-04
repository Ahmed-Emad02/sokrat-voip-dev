'use strict';

/**
 * Bicolor Header Typography Engine for Sokrat VOIP.
 *
 * Divides every word in half:
 * - First half of characters: white in dark theme / black in light theme (var(--text-primary))
 * - Second half of characters: red (var(--accent-color, #ef4444))
 *
 * Supports English (LTR) and Arabic (RTL). For Arabic script, zero-width
 * joiners (\u200D) are injected at the span seam so cursive letterforms
 * (ligatures and medial/final glyph shaping) remain 100% connected.
 */

function splitBicolorWord(word) {
    if (!word) return '';
    const isArabic = /[\u0600-\u06FF]/.test(word);
    let chars;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        chars = Array.from(new Intl.Segmenter(isArabic ? 'ar' : 'en', { granularity: 'grapheme' }).segment(word)).map(s => s.segment);
    } else {
        chars = Array.from(word);
    }
    const len = chars.length;
    if (len <= 1) {
        return `<span class="bicolor-word inline-block whitespace-nowrap"><span class="bicolor-first">${word}</span></span>`;
    }
    const mid = Math.ceil(len / 2);
    let first = chars.slice(0, mid).join('');
    let second = chars.slice(mid).join('');
    if (isArabic) {
        first += '\u200D';
        second = '\u200D' + second;
    }
    return `<span class="bicolor-word inline-block whitespace-nowrap"><span class="bicolor-first">${first}</span><span class="bicolor-second">${second}</span></span>`;
}

function formatBicolorText(text) {
    if (!text || typeof text !== 'string') return text || '';
    return text.split(/([\s\u2013\u2014\-]+)/).map(token => {
        if (/^[\s\u2013\u2014\-]+$/.test(token)) {
            return token;
        }
        return splitBicolorWord(token);
    }).join('');
}

function formatBicolorHeader(title, subtitle) {
    const full = [title, subtitle].filter(Boolean).join(' ').trim();
    return formatBicolorText(full);
}

module.exports = {
    splitBicolorWord,
    formatBicolorText,
    formatBicolorHeader
};
