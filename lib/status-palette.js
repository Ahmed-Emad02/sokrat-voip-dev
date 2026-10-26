/**
 * Single source of truth for call-disposition colours.
 *
 * The CDR filter checklist, the CDR table badges and the dashboard must all use
 * the same palette so "ANSWERED" is not emerald in one place and the theme
 * accent in another. Views receive this through render locals
 * (`statusPalette`, `statusOrder`) and only ever compose class names from it.
 */

const DEFAULT_STATUS_STYLE = {
    key: 'UNKNOWN',
    text: 'text-zinc-400',
    chipBg: 'bg-zinc-500/10',
    border: 'border-zinc-500/30',
    dot: 'bg-zinc-400',
    hex: '#a1a1aa'
};

const STATUS_PALETTE = {
    'ANSWERED': {
        key: 'ANSWERED',
        text: 'text-emerald-400',
        chipBg: 'bg-emerald-500/10',
        border: 'border-emerald-500/30',
        dot: 'bg-emerald-400',
        hex: '#34d399'
    },
    'NO ANSWER': {
        key: 'NO ANSWER',
        text: 'text-red-400',
        chipBg: 'bg-red-500/10',
        border: 'border-red-500/30',
        dot: 'bg-red-400',
        hex: '#f87171'
    },
    'BUSY': {
        key: 'BUSY',
        text: 'text-amber-400',
        chipBg: 'bg-amber-500/10',
        border: 'border-amber-500/30',
        dot: 'bg-amber-400',
        hex: '#fbbf24'
    },
    'FAILED': {
        key: 'FAILED',
        text: 'text-purple-400',
        chipBg: 'bg-purple-500/10',
        border: 'border-purple-500/30',
        dot: 'bg-purple-400',
        hex: '#a855f7'
    },
    'CONGESTION': {
        key: 'CONGESTION',
        text: 'text-slate-300',
        chipBg: 'bg-slate-500/10',
        border: 'border-slate-500/30',
        dot: 'bg-slate-300',
        hex: '#cbd5e1'
    }
};

// Order used by the filter checklist and by legends/aggregations.
const STATUS_ORDER = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED', 'CONGESTION'];

function normalizeDisposition(value) {
    return String(value === undefined || value === null ? '' : value).trim().toUpperCase();
}

function getStatusStyle(value) {
    return STATUS_PALETTE[normalizeDisposition(value)] || DEFAULT_STATUS_STYLE;
}

/** Tailwind text colour for a disposition (table cells, legends). */
function statusTextClass(value) {
    return getStatusStyle(value).text;
}

/** Full pill classes: text + soft background + border, for badges. */
function statusChipClass(value) {
    const style = getStatusStyle(value);
    return `${style.text} ${style.chipBg} ${style.border}`;
}

module.exports = {
    STATUS_PALETTE,
    STATUS_ORDER,
    DEFAULT_STATUS_STYLE,
    normalizeDisposition,
    getStatusStyle,
    statusTextClass,
    statusChipClass
};
