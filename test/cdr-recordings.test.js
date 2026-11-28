'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { attachHistoryRecordings, historyRecordingUrl, lookupSiteRecordings } = require('../lib/cdr-recordings');
const { LOOKUP_PATH, registerHistoryRecordingRoutes } = require('../lib/cdr-recording-routes');
const { federationAuthMiddleware } = require('../lib/federation-auth');
const { federationRequest } = require('../lib/federation-client');

const answered = row => ({ disposition: 'ANSWERED', ...row });
const table = '`cdr`';

test('history prefers the direct owner and same-site legs; only explicitly tagged calls try other sites', async () => {
    const rows = [
        answered({ node_site_code: '10', uniqueid: 'same', linkedid: 'local-parent' }),
        answered({ node_site_code: '20', uniqueid: 'same', linkedid: 'remote-parent' }),
        answered({ node_site_code: '10', uniqueid: 'origin', global_call_id: 'explicit' }),
        answered({ node_site_code: '20', uniqueid: 'direct', sequence: 3, recordingfile: 'direct.wav' }),
        answered({ node_site_code: '30', uniqueid: 'hidden', recordingfile: 'hidden.wav' })
    ];
    const searches = [];
    await attachHistoryRecordings(rows, ['10', '20'], '10', async (site, keys) => {
        searches.push([site, keys]);
        return keys.map(key => key.linkedid === 'remote-parent' ? { uniqueid: 'remote-leg', sequence: 2 }
            : key.global_call_id === 'explicit' ? { uniqueid: 'receiver-recorded', sequence: 5 } : null);
    });
    assert.deepEqual(searches, [
        ['10', [{ uniqueid: 'same', linkedid: 'local-parent' }, { uniqueid: 'origin', linkedid: undefined }]],
        ['20', [{ uniqueid: 'same', linkedid: 'remote-parent' }]],
        ['20', [{ global_call_id: 'explicit' }]]
    ]);
    assert.deepEqual(rows.map(row => row.recording), [undefined,
        { site: '20', uniqueid: 'remote-leg', sequence: 2 },
        { site: '20', uniqueid: 'receiver-recorded', sequence: 5 },
        { site: '20', uniqueid: 'direct', sequence: 3 }, undefined]);
    assert.equal(historyRecordingUrl(rows[2].recording), '/audio/receiver-recorded?site=20&sequence=5');
});

test('raw CDR discovery selects an authorized recorded linked leg behind the counterpart anchor', async () => {
    const raw = [
        { uniqueid: 'anchor', linkedid: 'group', global_call_id: 'fed', accountcode: 'WEB7' },
        { uniqueid: 'hidden-leg', linkedid: 'group', sequence: 8, accountcode: 'WEB9', recordingfile: 'hidden.wav' },
        { uniqueid: 'recorded-leg', linkedid: 'group', sequence: 4, accountcode: 'WEB7', recordingfile: 'found.wav' }
    ];
    const pool = { query: async (sql, [keys, ...params]) => {
        const visible = raw.filter(row => row.accountcode === params.at(-1));
        if (sql.includes('AS global_call_id')) return [visible.filter(row => keys.includes(row.global_call_id))];
        return [visible.filter(row => row.recordingfile && (keys.includes(row.uniqueid) || params[0].includes(row.linkedid)))];
    } };
    assert.deepEqual(await lookupSiteRecordings(pool, table,
        [{ global_call_id: 'fed' }, { global_call_id: 'FED' }, { uniqueid: 'anchor', linkedid: 'group' }],
        { accountcode: 'WEB7' }),
    [{ uniqueid: 'recorded-leg', sequence: 4 }, null, { uniqueid: 'recorded-leg', sequence: 4 }]);
    assert.deepEqual(await lookupSiteRecordings(pool, table, [{ global_call_id: 'fed' }], { accountcode: 'WEB9' }), [null]);
});

test('owner URL streams and downloads only the authorized exact peer segment, including byte ranges', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdr-recording-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'owner.wav'), '0123456789');
    const previous = process.env.SOKRAT_FEDERATION_ALLOW_HTTP;
    process.env.SOKRAT_FEDERATION_ALLOW_HTTP = '1';
    t.after(() => {
        if (previous === undefined) delete process.env.SOKRAT_FEDERATION_ALLOW_HTTP;
        else process.env.SOKRAT_FEDERATION_ALLOW_HTTP = previous;
    });

    const app = express();
    const key = 'test-only-shared-key';
    let reportAllowed = true;
    let selected = ['10', '20'];
    let visibility = { accountcode: 'WEB7' };
    let allowDownload = false;
    const mediaQueries = [];
    const pool = { query: async (sql, params) => {
        if (sql.startsWith('UPDATE') || sql.startsWith('INSERT')) return [[]];
        if (sql.includes('api_key_enc')) return [[{ id: 7, site_code: '10', api_key_enc: key }]];
        if (sql.includes('allow_report_read')) return [reportAllowed ? [{ allowed: 1 }] : []];
        if (Array.isArray(params[0])) return [params[0].includes('group') && params.at(-1) === 'WEB7'
            ? [{ uniqueid: 'receiver-leg', linkedid: 'group', sequence: 42 }] : []];
        mediaQueries.push(params);
        const visible = params[0] === 'receiver-leg' && params[1] === 42 && params[2] === 'WEB7'
            && (params.length === 3 || params[3].includes('101'));
        return [visible ? [{ calldate: '2026-01-01', recordingfile: 'owner.wav' }] : []];
    } };
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use('/api/federation/v1', federationAuthMiddleware({ pool: () => pool, decryptFn: value => value }));
    app.use((req, res, next) => {
        req.session = { userPermissions: ['call_history', ...(allowDownload ? ['cdr-audio-download'] : [])] };
        res.locals.federationScope = { localSiteCode: '10' };
        next();
    });
    let base;
    const pass = (req, res, next) => next();
    registerHistoryRecordingRoutes(app, {
        getPool: () => pool, table, root, requireAuth: pass, requireCdrReadAccess: pass,
        isSuperAdmin: () => false, getVisibility: () => visibility, getReportSites: () => selected,
        getPeers: async () => [{ site_code: '20', api_base_url: base, api_key_enc: key }],
        federationRequest, decrypt: value => value
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    base = `http://127.0.0.1:${server.address().port}`;
    const [displayed] = [answered({ node_site_code: '20', uniqueid: 'mirrored', linkedid: 'group' })];
    await attachHistoryRecordings([displayed], selected, '10', async (site, keys) => {
        const result = await federationRequest({ site_code: site, api_base_url: base, api_key_enc: key }, LOOKUP_PATH, {
            method: 'POST', body: { keys, visibility }, localSiteCode: '10', decryptFn: value => value
        });
        return result.recordings;
    });
    const url = base + historyRecordingUrl(displayed.recording);
    const fetchStatus = async (...args) => {
        const response = await fetch(...args);
        await response.arrayBuffer();
        return response.status;
    };

    assert.equal(await fetchStatus(base + LOOKUP_PATH, { method: 'POST' }), 401);
    const partial = await fetch(url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await partial.text(), '2345');
    assert.deepEqual(mediaQueries, [['receiver-leg', 42, 'WEB7']]);
    assert.equal(await fetchStatus(url + '&download=1'), 403);
    allowDownload = true;
    const download = await fetch(url + '&download=1');
    assert.match(download.headers.get('content-disposition'), /^attachment;.*owner\.wav/);
    assert.equal(await download.text(), '0123456789');
    assert.equal(await fetchStatus(url.replace('sequence=42', 'sequence=43')), 404);
    visibility = { accountcode: 'WEB9' };
    assert.equal(await fetchStatus(url), 404);
    visibility = { accountcode: 'WEB7', extensions: ['999'] };
    assert.equal(await fetchStatus(url), 404, 'matching the tenant must not bypass its extension scope');
    visibility = { accountcode: 'WEB7' };
    reportAllowed = false;
    const count = mediaQueries.length;
    assert.equal(await fetchStatus(url), 404);
    assert.equal(mediaQueries.length, count);
    reportAllowed = true;
    selected = ['10'];
    assert.equal(await fetchStatus(url), 404);
    assert.equal(mediaQueries.length, count);
});
