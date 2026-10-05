const { execFile } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Execute git command with argument array safely using execFile
 */
function runGit(args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile('git', args, {
            cwd: REPO_ROOT,
            maxBuffer: 25 * 1024 * 1024, // 25MB max buffer for diffs
            encoding: 'utf8',
            ...options
        }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                return reject(error);
            }
            resolve(stdout ? stdout.trim() : '');
        });
    });
}

/**
 * Get overall Git repository health and status overview
 */
async function getRepoOverview() {
    try {
        const [
            branch,
            currentSha,
            totalCommitsStr,
            statusPorcelain,
            authorsRaw,
            lastCommitRaw
        ] = await Promise.all([
            runGit(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'unknown'),
            runGit(['rev-parse', 'HEAD']).catch(() => ''),
            runGit(['rev-list', '--count', 'HEAD']).catch(() => '0'),
            runGit(['status', '--porcelain']).catch(() => ''),
            runGit(['log', '--format=%an', 'HEAD']).catch(() => ''),
            runGit(['log', '-1', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s', 'HEAD']).catch(() => '')
        ]);

        // Calculate sync status relative to upstream tracking branch
        let aheadBehind = { ahead: 0, behind: 0 };
        try {
            const countRaw = await runGit(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
            const parts = countRaw.split(/\s+/);
            if (parts.length >= 2) {
                aheadBehind = {
                    ahead: parseInt(parts[0], 10) || 0,
                    behind: parseInt(parts[1], 10) || 0
                };
            }
        } catch (_) {
            // No upstream or network offline
        }

        // Count modified, staged, and untracked files
        const statusLines = statusPorcelain ? statusPorcelain.split('\n').filter(Boolean) : [];
        const isClean = statusLines.length === 0;
        let stagedCount = 0;
        let modifiedCount = 0;
        let untrackedCount = 0;

        for (const line of statusLines) {
            const x = line[0];
            const y = line[1];
            if (x === '?' && y === '?') untrackedCount++;
            else {
                if (x !== ' ' && x !== '?') stagedCount++;
                if (y !== ' ' && y !== '?') modifiedCount++;
            }
        }

        // Unique authors
        const authors = Array.from(new Set(authorsRaw.split('\n').map(a => a.trim()).filter(Boolean)));

        // Latest commit detail
        let latestCommit = null;
        if (lastCommitRaw) {
            const [fullHash, shortHash, authorName, authorEmail, date, subject] = lastCommitRaw.split('\x1f');
            latestCommit = {
                fullHash,
                shortHash,
                authorName,
                authorEmail,
                date,
                subject
            };
        }

        return {
            branch,
            currentSha,
            shortSha: currentSha ? currentSha.substring(0, 7) : '',
            totalCommits: parseInt(totalCommitsStr, 10) || 0,
            isClean,
            workingTree: {
                totalChanged: statusLines.length,
                staged: stagedCount,
                modified: modifiedCount,
                untracked: untrackedCount
            },
            aheadBehind,
            authors,
            latestCommit
        };
    } catch (err) {
        throw new Error('Failed to retrieve repository overview: ' + err.message);
    }
}

/**
 * Get paginated list of commits with impact stats (files changed, +insertions, -deletions)
 */
async function getCommitsList({ page = 1, limit = 25, search = '', author = '', since = '', until = '' } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(5, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const baseArgs = ['log'];
    if (search && typeof search === 'string') {
        baseArgs.push(`--grep=${search.trim()}`);
    }
    if (author && typeof author === 'string') {
        baseArgs.push(`--author=${author.trim()}`);
    }
    if (since && typeof since === 'string') {
        baseArgs.push(`--since=${since.trim()}`);
    }
    if (until && typeof until === 'string') {
        baseArgs.push(`--until=${until.trim()}`);
    }

    // 1. Get total matching commits count
    let totalMatching = 0;
    try {
        const countArgs = [...baseArgs, '--format=%H'];
        const countOutput = await runGit(countArgs);
        totalMatching = countOutput ? countOutput.split('\n').filter(Boolean).length : 0;
    } catch (_) {
        totalMatching = 0;
    }

    if (totalMatching === 0) {
        return {
            commits: [],
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: 0,
                totalPages: 0
            }
        };
    }

    // 2. Fetch commits with custom delimiter and shortstat
    // Format: COMMIT_START\n%H\n%h\n%an\n%ae\n%ad\n%s\n%b\n%D\nCOMMIT_BODY_END
    const logArgs = [
        ...baseArgs,
        `--skip=${skip}`,
        `--max-count=${limitNum}`,
        '--date=iso-strict',
        '--decorate=short',
        '--shortstat',
        '--format=___COMMIT_START___%n%H%n%h%n%an%n%ae%n%ad%n%s%n%D%n___COMMIT_MSG___%n%b%n___COMMIT_END___'
    ];

    const rawOutput = await runGit(logArgs);
    const commitChunks = rawOutput.split('___COMMIT_START___\n').filter(Boolean);
    const commits = [];

    for (const chunk of commitChunks) {
        const parts = chunk.split('___COMMIT_END___');
        const metaPart = parts[0] || '';
        const statPart = parts[1] || '';

        const [headerSection, bodySection] = metaPart.split('___COMMIT_MSG___\n');
        const headerLines = headerSection ? headerSection.split('\n') : [];

        const hash = headerLines[0] || '';
        const shortHash = headerLines[1] || '';
        const authorName = headerLines[2] || '';
        const authorEmail = headerLines[3] || '';
        const date = headerLines[4] || '';
        const subject = headerLines[5] || '';
        const refNames = headerLines[6] ? headerLines[6].trim() : '';
        const body = bodySection ? bodySection.trim() : '';

        // Parse shortstat: " 3 files changed, 25 insertions(+), 4 deletions(-)"
        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;

        const statLine = statPart.trim();
        if (statLine) {
            const filesMatch = statLine.match(/(\d+)\s+files?\s+changed/);
            const insMatch = statLine.match(/(\d+)\s+insertions?\(\+\)/);
            const delMatch = statLine.match(/(\d+)\s+deletions?\(-\)/);

            if (filesMatch) filesChanged = parseInt(filesMatch[1], 10) || 0;
            if (insMatch) insertions = parseInt(insMatch[1], 10) || 0;
            if (delMatch) deletions = parseInt(delMatch[1], 10) || 0;
        }

        if (hash) {
            commits.push({
                hash,
                shortHash,
                authorName,
                authorEmail,
                date,
                subject,
                body,
                refNames: refNames ? refNames.split(',').map(r => r.trim()).filter(Boolean) : [],
                stats: {
                    filesChanged,
                    insertions,
                    deletions
                }
            });
        }
    }

    return {
        commits,
        pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalMatching,
            totalPages: Math.ceil(totalMatching / limitNum)
        }
    };
}

/**
 * Get deep details and colored unified file diffs for a specific commit hash
 */
async function getCommitDetails(hash) {
    if (!hash || typeof hash !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(hash.trim())) {
        throw new Error('Invalid commit hash format.');
    }
    const cleanHash = hash.trim();

    // 1. Get commit metadata & list of affected files with status
    const metaRaw = await runGit([
        'show',
        '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%ce%x1f%cd%x1f%P%x1f%s%x1f%b%x1f%D',
        '--name-status',
        '--date=iso-strict',
        cleanHash
    ]);

    const sections = metaRaw.split('\n\n');
    const metaLine = sections[0] ? sections[0].split('\n')[0] : '';
    const [
        fullHash,
        shortHash,
        authorName,
        authorEmail,
        authorDate,
        committerName,
        committerEmail,
        committerDate,
        parentsRaw,
        subject,
        body,
        refNamesRaw
    ] = metaLine.split('\x1f');

    // 2. Parse affected files from name-status and numstat
    const numstatRaw = await runGit(['show', '--numstat', '--format=', cleanHash]);
    const nameStatusRaw = await runGit(['show', '--name-status', '--format=', cleanHash]);

    const numstatMap = new Map();
    for (const line of numstatRaw.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
            const ins = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
            const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
            const file = parts.slice(2).join(' ');
            numstatMap.set(file, { insertions: ins, deletions: del });
        }
    }

    const files = [];
    let totalInsertions = 0;
    let totalDeletions = 0;

    for (const line of nameStatusRaw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const tokens = trimmed.split(/\s+/);
        const statusLetter = tokens[0] ? tokens[0][0] : 'M';
        const filePath = tokens[tokens.length - 1];
        const numstats = numstatMap.get(filePath) || { insertions: 0, deletions: 0 };

        totalInsertions += numstats.insertions;
        totalDeletions += numstats.deletions;

        let statusText = 'Modified';
        let statusBadge = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
        if (statusLetter === 'A') {
            statusText = 'Added';
            statusBadge = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
        } else if (statusLetter === 'D') {
            statusText = 'Deleted';
            statusBadge = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
        } else if (statusLetter === 'R') {
            statusText = 'Renamed';
            statusBadge = 'bg-blue-500/10 text-blue-400 border-blue-500/20';
        }

        files.push({
            path: filePath,
            statusLetter,
            statusText,
            statusBadge,
            insertions: numstats.insertions,
            deletions: numstats.deletions
        });
    }

    // 3. Get file-by-file unified patch
    const patchRaw = await runGit(['show', '--color=never', '-p', cleanHash]);
    const fileDiffs = parseUnifiedDiff(patchRaw);

    return {
        commit: {
            hash: fullHash,
            shortHash,
            authorName,
            authorEmail,
            authorDate,
            committerName,
            committerEmail,
            committerDate,
            parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
            subject,
            body: body ? body.trim() : '',
            refNames: refNamesRaw ? refNamesRaw.split(',').map(r => r.trim()).filter(Boolean) : [],
            totalInsertions,
            totalDeletions,
            totalFiles: files.length
        },
        files,
        diffs: fileDiffs
    };
}

/**
 * Helper to parse raw unified diff into clean structured per-file blocks
 */
function parseUnifiedDiff(patchText) {
    if (!patchText) return [];
    const diffBlocks = [];
    const rawFiles = patchText.split('diff --git ');

    for (const block of rawFiles) {
        if (!block.trim()) continue;
        const lines = block.split('\n');
        const headerLine = lines[0]; // e.g. "a/server.js b/server.js"
        const headerParts = headerLine.split(' ');
        let filename = headerParts[1] ? headerParts[1].replace(/^[ab]\//, '') : 'unknown';

        const hunks = [];
        let currentHunk = null;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('@@')) {
                if (currentHunk) hunks.push(currentHunk);
                currentHunk = { header: line, lines: [] };
            } else if (currentHunk) {
                let type = 'context';
                if (line.startsWith('+') && !line.startsWith('+++')) type = 'add';
                else if (line.startsWith('-') && !line.startsWith('---')) type = 'del';
                currentHunk.lines.push({ type, text: line });
            }
        }
        if (currentHunk) hunks.push(currentHunk);

        diffBlocks.push({
            filename,
            hunks
        });
    }

    return diffBlocks;
}

module.exports = {
    getRepoOverview,
    getCommitsList,
    getCommitDetails
};
