const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const rootDir = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(rootDir, relative), 'utf8');
const palette = require('../lib/status-palette');

test('status palette is the single source of truth for dispositions', () => {
    assert.deepEqual(palette.STATUS_ORDER, ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED', 'CONGESTION']);

    // Text + hex must agree with the Tailwind shade used in the UI.
    const expected = {
        'ANSWERED': ['text-emerald-400', '#34d399'],
        'NO ANSWER': ['text-red-400', '#f87171'],
        'BUSY': ['text-amber-400', '#fbbf24'],
        'FAILED': ['text-purple-400', '#a855f7'],
        'CONGESTION': ['text-slate-300', '#cbd5e1']
    };
    for (const [status, [text, hex]] of Object.entries(expected)) {
        assert.equal(palette.STATUS_PALETTE[status].text, text, `${status} text class`);
        assert.equal(palette.STATUS_PALETTE[status].hex, hex, `${status} chart colour`);
    }

    // Unknown/empty dispositions fall back instead of throwing.
    assert.equal(palette.statusTextClass(''), 'text-zinc-400');
    assert.equal(palette.statusTextClass('anything'), 'text-zinc-400');
    assert.equal(palette.statusTextClass('answered'), 'text-emerald-400');
});

test('CDR filter and CDR table use the same status colours', async () => {
    const html = await ejs.renderFile(path.join(rootDir, 'views', 'cdr.ejs'), {
        currentPage: '/cdr', currentLang: 'en', lang: 'en', isRtl: false, theme: 'dark',
        currentUser: 'root', isRoot: true, isSuperAdmin: true, userGroup: 'super admins',
        userPermissions: ['cdr'], allowedTabs: ['cdr'], isTabAllowed: () => true,
        calls: [{
            calldate: new Date('2026-10-26T10:00:00Z'), clid: 'x', src: '101', dst: '102',
            dcontext: 'from-internal', did: '', disposition: 'ANSWERED', duration: 10, billsec: 5,
            channel: 'SIP/101', dstchannel: 'SIP/102', lastapp: 'Dial', lastdata: '',
            uniqueid: '1', recordingfile: null, is_local: 1, trunk: '', direction: 'internal', transcript: ''
        }],
        filters: {
            startDate: new Date(), endDate: new Date(), targetExtension: 'ALL', statusFilter: ['ALL'],
            searchSrc: '', searchDst: '', searchDid: '', searchUniqueId: '', searchTranscript: '',
            directionFilter: 'ALL', callScopeFilter: 'ALL', trunkFilter: ['ALL'], page: 1, perPage: 50
        },
        pagination: { total: 1, totalPages: 1, page: 1, perPage: 50 },
        availableTrunks: [], moment: require('moment'),
        statusPalette: palette.STATUS_PALETTE,
        statusOrder: palette.STATUS_ORDER,
        statusTextClass: palette.statusTextClass,
        statusChipClass: palette.statusChipClass
    });

    // Filter checklist: every disposition from the palette, with its text colour.
    for (const status of palette.STATUS_ORDER) {
        assert.ok(html.includes(`value="${status}"`), `filter must offer ${status}`);
        assert.ok(html.includes(`font-mono ${palette.STATUS_PALETTE[status].text} font-bold`),
            `filter label for ${status} must use ${palette.STATUS_PALETTE[status].text}`);
    }
    // Table badge for the rendered ANSWERED row uses the same colour + chip.
    assert.ok(html.includes('text-emerald-400 bg-emerald-500/10 border-emerald-500/30'),
        'ANSWERED badge must use the shared chip classes');
    assert.ok(html.includes('font-mono text-red-400 font-bold'), 'NO ANSWER filter label must be red');
    assert.ok(!/font-mono text-teal-400 font-bold/.test(html), 'NO ANSWER filter label must not stay teal');

    // The old mismatched accent/text-only colours are gone.
    assert.ok(!/dispColors\s*=\s*\{[^}]*--accent-color/.test(html), 'ANSWERED must not use the theme accent');
});

test('dashboard status filter and pie chart use the same palette', () => {
    const view = read('views/dashboard.ejs');
    assert.ok(!/'ANSWERED': accentColor/.test(view), 'pie chart must not use the theme accent for ANSWERED');
    assert.ok(/'CONGESTION': '#f97316'/.test(view) === false, 'CONGESTION must not be orange in the chart');
    assert.match(view, /typeof statusPalette !== 'undefined'/);
    assert.match(view, /dashText\(st\)/);
    assert.match(view, /dash_status_chk_<%=/);
});

test('server passes the shared palette to the CDR and dashboard views', () => {
    const server = read('server.js');
    assert.match(server, /require\('\.\/lib\/status-palette'\)/);
    for (const view of ['cdr', 'dashboard']) {
        const render = server.match(new RegExp(`res\\.render\\('${view}',[\\s\\S]*?\\n        \\}\\);`));
        assert.ok(render, `${view} render call must exist`);
        assert.match(render[0], /statusPalette: STATUS_PALETTE/, `${view} must receive statusPalette`);
        assert.match(render[0], /statusOrder: STATUS_ORDER/, `${view} must receive statusOrder`);
    }
});
