/**
 * Safe Confidential Media ID Resolution & Byte-Range Audio Streamer
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_RECORDING_ROOT = process.env.RECORDING_ROOT || '/var/spool/asterisk/monitor';

function getMediaHmacKey() {
    const rawKey = process.env.ENCRYPTION_KEY || 'sokrat-default-key-fallback-32c';
    return crypto.createHash('sha256').update(rawKey + ':media-token-v2').digest();
}

/**
 * Generate a confidential opaque media ID token
 * Contains ONLY uniqueid + HMAC. NO filename or directory paths exposed!
 * @param {string} uniqueid
 * @returns {string} Opaque media ID token
 */
function createMediaId(uniqueid) {
    const cleanId = String(uniqueid || '').trim();
    if (!cleanId) return '';
    const hmac = crypto.createHmac('sha256', getMediaHmacKey()).update(cleanId).digest('hex').substring(0, 24);
    const enc = Buffer.from(cleanId).toString('base64url');
    return `${enc}.${hmac}`;
}

/**
 * Verify and decode a confidential media ID token
 * @param {string} mediaId
 * @returns {string|null} Resolved uniqueid or null if invalid/tampered
 */
function decodeMediaId(mediaId) {
    if (!mediaId || typeof mediaId !== 'string') return null;
    const parts = mediaId.trim().split('.');
    if (parts.length !== 2) return null;
    const [enc, hmac] = parts;
    try {
        const uniqueid = Buffer.from(enc, 'base64url').toString('utf8');
        const expectedHmac = crypto.createHmac('sha256', getMediaHmacKey()).update(uniqueid).digest('hex').substring(0, 24);
        
        const bufA = Buffer.from(hmac, 'hex');
        const bufB = Buffer.from(expectedHmac, 'hex');
        if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
            return null;
        }
        return uniqueid;
    } catch (_) {
        return null;
    }
}

/**
 * Safely verify that a target path resides strictly inside real RECORDING_ROOT
 * Resolves symlinks using fs.realpathSync to prevent traversal/symlink escape.
 * @param {string} targetPath
 * @param {string} [rootDir=DEFAULT_RECORDING_ROOT]
 * @returns {boolean}
 */
function isPathUnderRoot(targetPath, rootDir = DEFAULT_RECORDING_ROOT) {
    try {
        let realRoot = rootDir;
        if (fs.existsSync(rootDir)) {
            realRoot = fs.realpathSync(rootDir);
        } else {
            realRoot = path.resolve(rootDir);
        }

        let realTarget = targetPath;
        if (fs.existsSync(targetPath)) {
            realTarget = fs.realpathSync(targetPath);
        } else {
            realTarget = path.resolve(targetPath);
        }

        const relative = path.relative(realRoot, realTarget);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return false;
        }

        if (fs.existsSync(realTarget)) {
            const stat = fs.statSync(realTarget);
            return stat.isFile();
        }

        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Resolve audio file path for a CDR uniqueid or opaque mediaId
 * @param {string} identifier (uniqueid or mediaId)
 * @param {object} pool MySQL connection pool
 * @param {string} [rootDir=DEFAULT_RECORDING_ROOT]
 * @returns {Promise<string|null>} Absolute resolved file path
 */
async function resolveRecordingPath(identifier, pool, rootDir = DEFAULT_RECORDING_ROOT) {
    if (!identifier || typeof identifier !== 'string') return null;

    let uniqueid = identifier.trim();

    // Check if token is an opaque mediaId
    if (identifier.includes('.')) {
        const decoded = decodeMediaId(identifier);
        if (decoded) {
            uniqueid = decoded;
        } else {
            return null;
        }
    }

    let recordingfile = null;
    let calldate = null;

    if (pool && uniqueid) {
        try {
            const [rows] = await pool.query(
                `SELECT recordingfile, calldate FROM asteriskcdrdb.cdr
                 WHERE (uniqueid = ? OR linkedid = ?)
                   AND recordingfile IS NOT NULL AND recordingfile != ''
                 ORDER BY billsec DESC, calldate DESC
                 LIMIT 1`,
                [uniqueid, uniqueid]
            );

            if (rows.length > 0) {
                recordingfile = rows[0].recordingfile.trim();
                calldate = rows[0].calldate;
            }
        } catch (_) {}
    }

    if (!recordingfile) return null;

    const baseName = path.basename(recordingfile);
    const candidatePaths = [];

    if (calldate) {
        const d = new Date(calldate);
        if (!isNaN(d.getTime())) {
            const yyyy = String(d.getFullYear());
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            candidatePaths.push(path.join(rootDir, yyyy, mm, dd, baseName));
        }
    }

    if (recordingfile.includes('/')) {
        candidatePaths.push(path.join(rootDir, recordingfile));
    }

    candidatePaths.push(path.join(rootDir, baseName));

    for (const cand of candidatePaths) {
        if (isPathUnderRoot(cand, rootDir) && fs.existsSync(cand)) {
            try {
                const stat = fs.statSync(cand);
                if (stat.isFile()) return cand;
            } catch (_) {}
        }
    }

    return null;
}

/**
 * Stream an audio file with HTTP Byte-Range support (206 Partial Content)
 * @param {object} req Express request object
 * @param {object} res Express response object
 * @param {string} filePath Absolute file path
 */
function streamRecordingFile(req, res, filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            return res.status(404).json({ success: false, error: 'Recording file not found' });
        }
    } catch (_) {
        return res.status(404).json({ success: false, error: 'Recording file not found' });
    }

    const fileSize = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    let contentType = 'audio/wav';
    if (ext === '.mp3') contentType = 'audio/mpeg';
    else if (ext === '.gsm') contentType = 'audio/x-gsm';
    else if (ext === '.ogg') contentType = 'audio/ogg';

    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.status(416).json({ success: false, error: 'Requested range not satisfiable' });
        }

        const chunksize = (end - start) + 1;
        const stream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
            'Content-Disposition': 'inline'
        });

        stream.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Content-Disposition': 'inline'
        });

        fs.createReadStream(filePath).pipe(res);
    }
}

module.exports = {
    createMediaId,
    decodeMediaId,
    isPathUnderRoot,
    resolveRecordingPath,
    streamRecordingFile
};
