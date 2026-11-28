'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const moment = require('moment');
const { isPathUnderRoot } = require('./recordings');
const { lookupSiteRecordings, recordingScopeSql } = require('./cdr-recordings');

const LOOKUP_PATH = '/api/federation/v1/cdr/recordings/lookup';
const STREAM_PATH = '/api/federation/v1/cdr/recordings/stream';

function canAccessHistoryAudio(req, isSuperAdmin, download = false) {
    if (isSuperAdmin(req)) return true;
    const perms = req.session?.userPermissions || [];
    return download ? perms.includes('cdr-audio-download')
        : perms.includes('cdr-audio-listen') || perms.includes('call_history') || perms.includes('cdr');
}

function isId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 150;
}

function validVisibility(scope) {
    return scope && (scope.accountcode == null || (typeof scope.accountcode === 'string' && /^WEB[1-9]\d*$/.test(scope.accountcode)))
        && (scope.extensions == null || (Array.isArray(scope.extensions)
            && scope.extensions.every(ext => typeof ext === 'string' && ext.length > 0)));
}

async function streamLocal(req, res, pool, table, root, { uniqueid, sequence, visibility, download }) {
    const { sql, params } = recordingScopeSql(visibility);
    const [rows] = await pool.query(
        `SELECT c.calldate, c.recordingfile FROM ${table} c
         WHERE c.uniqueid = ? ${sequence == null ? '' : 'AND COALESCE(c.sequence, 0) = ?'}
           AND TRIM(c.recordingfile) <> ''${sql}
         ORDER BY c.billsec DESC, c.calldate ASC, c.sequence DESC LIMIT 1`,
        [uniqueid, ...(sequence == null ? [] : [sequence]), ...params]
    );
    if (!rows.length) return res.status(404).send('Audio not found.');

    const raw = rows[0].recordingfile.trim();
    const base = path.basename(raw);
    const datedDir = path.join(root, moment(rows[0].calldate).format('YYYY/MM/DD'));
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    const extensions = ext ? [ext, ext.toUpperCase(), ext.toLowerCase()] : ['.wav', '.WAV', '.gsm', '.mp3', '.ogg', '.sln'];
    const candidates = [datedDir, root].flatMap(dir => extensions.map(e => path.join(dir, stem + e)));
    candidates.push(path.resolve(root, raw));
    const target = candidates.find(candidate => fs.existsSync(candidate) && isPathUnderRoot(candidate, root));
    if (!target) return res.status(404).send('Audio file missing on server.');

    const types = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wma': 'audio/x-ms-wma', '.sln': 'audio/wav', '.wav49': 'audio/wav', '.gsm': 'audio/x-gsm' };
    res.set('Content-Type', types[path.extname(target).toLowerCase()] || 'audio/wav');
    res.set('Cache-Control', 'private, no-store');
    const done = err => {
        if (!err) return;
        if (res.headersSent) return res.destroy(err);
        if (err.headers?.['Content-Range']) res.set('Content-Range', err.headers['Content-Range']);
        res.status(err.status || 500).end();
    };
    if (download) return res.download(target, base, done);
    return res.sendFile(target, done);
}

function registerHistoryRecordingRoutes(app, deps) {
    const { getPool, table, root, requireAuth, requireCdrReadAccess, isSuperAdmin, getVisibility,
        getReportSites, getPeers, federationRequest, decrypt } = deps;
    const stream = (req, res, request) => streamLocal(req, res, getPool(), table, root, request);
    const checkPeerReport = async (req, res, next) => {
        try {
            if (!req.isFederationAuthenticated || !req.federationPeer) return res.sendStatus(401);
            const [rows] = await getPool().query(
                'SELECT 1 FROM `asterisk`.`sokrat_federation_peers` WHERE id = ? AND allow_report_read = 1 LIMIT 1',
                [req.federationPeer.id]
            );
            if (!rows.length) return res.sendStatus(403);
            next();
        } catch (error) { next(error); }
    };
    const route = (handle, failureStatus = 500) => async (req, res) => {
        try { await handle(req, res); }
        catch (error) {
            console.error('[CDR] Recording request failed:', error.message);
            if (res.headersSent) res.destroy(error);
            else res.sendStatus(failureStatus);
        }
    };

    // The mirror feed omits Local and shorter duplicate segments, so search
    // the owning PBX's raw CDR without the report's presentation filters.
    app.post(LOOKUP_PATH, checkPeerReport, route(async (req, res) => {
        const { keys, visibility } = req.body || {};
        if (!validVisibility(visibility) || !Array.isArray(keys) || keys.length > 200
            || !keys.every(key => key && [key.uniqueid, key.linkedid, key.global_call_id].every(id => id == null || id === '' || isId(id)))) {
            return res.sendStatus(400);
        }
        res.json({ recordings: await lookupSiteRecordings(getPool(), table, keys, visibility) });
    }));
    app.post(STREAM_PATH, checkPeerReport, route(async (req, res) => {
        const { uniqueid, sequence, visibility, download } = req.body || {};
        if (!isId(uniqueid) || !Number.isSafeInteger(sequence) || !validVisibility(visibility)) return res.sendStatus(400);
        await stream(req, res, { uniqueid, sequence, visibility, download: download === true });
    }));
    app.get('/audio/:uniqueid', requireAuth, requireCdrReadAccess, route(async (req, res) => {
        const download = req.query.download === '1';
        if (!canAccessHistoryAudio(req, isSuperAdmin, download)) return res.sendStatus(403);
        const { uniqueid } = req.params;
        if (!isId(uniqueid)) return res.sendStatus(400);
        const scope = res.locals.federationScope;
        const localSite = String(scope?.localSiteCode || '10');
        const visibility = getVisibility(req);
        const { site, sequence: sequenceParam } = req.query;
        // Old local links omit the owner selector. History links always give
        // the owning PBX and segment so playback uses the discovered CDR.
        if (site === undefined && sequenceParam === undefined) {
            return await stream(req, res, { uniqueid, sequence: null, visibility, download });
        }
        const sequence = Number(sequenceParam);
        if (typeof site !== 'string' || typeof sequenceParam !== 'string'
            || !/^-?\d+$/.test(sequenceParam) || !Number.isSafeInteger(sequence)) return res.sendStatus(400);
        if (!getReportSites(scope).includes(site)) return res.sendStatus(404);
        const request = { uniqueid, sequence, visibility, download };
        if (site === localSite) return await stream(req, res, request);

        const peer = (await getPeers(scope)).find(row => String(row.site_code) === site);
        if (!peer) return res.sendStatus(404);
        const { status, headers, data } = await federationRequest(peer, STREAM_PATH, {
            method: 'POST', body: request, localSiteCode: localSite, decryptFn: decrypt,
            withMeta: true, responseType: 'stream', range: req.headers.range
        });
        res.set('Cache-Control', 'private, no-store');
        if (status !== 200 && status !== 206) {
            data.destroy();
            if (status === 416 && headers['content-range']) res.set('Content-Range', headers['content-range']);
            return res.sendStatus(status === 416 ? 416 : status === 404 || status === 403 ? 404 : 502);
        }
        for (const name of ['accept-ranges', 'content-range', 'content-type', 'content-length', 'content-disposition']) {
            if (headers[name]) res.set(name, headers[name]);
        }
        res.status(status);
        pipeline(data, res, error => {
            if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[CDR] Peer audio interrupted:', error.message);
        });
    }, 502));
}

module.exports = { canAccessHistoryAudio, LOOKUP_PATH, registerHistoryRecordingRoutes };
