const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const rootDir = path.join(__dirname, '..');
const gitService = require(path.join(rootDir, 'backend', 'git-history-service.js'));

test('Git History Service: getRepoOverview() returns valid repository health metrics', async () => {
    const overview = await gitService.getRepoOverview();

    assert.ok(typeof overview.branch === 'string' && overview.branch.length > 0, 'branch must be non-empty string');
    assert.ok(typeof overview.currentSha === 'string' && overview.currentSha.length === 40, 'currentSha must be 40-char hex string');
    assert.ok(typeof overview.shortSha === 'string' && overview.shortSha.length === 7, 'shortSha must be 7-char string');
    assert.ok(typeof overview.totalCommits === 'number' && overview.totalCommits > 0, 'totalCommits must be positive integer');
    assert.ok(typeof overview.isClean === 'boolean', 'isClean must be boolean');
    assert.ok(overview.workingTree && typeof overview.workingTree.totalChanged === 'number', 'workingTree metrics must be present');
    assert.ok(Array.isArray(overview.authors) && overview.authors.length > 0, 'authors must be non-empty array');
    assert.ok(overview.latestCommit && overview.latestCommit.fullHash === overview.currentSha, 'latestCommit must match currentSha');
});

test('Git History Service: getCommitsList() returns paginated commits with impact stats', async () => {
    const result = await gitService.getCommitsList({ page: 1, limit: 5 });

    assert.ok(Array.isArray(result.commits), 'result.commits must be array');
    assert.ok(result.commits.length <= 5, 'must respect limit <= 5');
    assert.ok(result.pagination && result.pagination.total > 0, 'pagination total must be > 0');
    assert.strictEqual(result.pagination.limit, 5, 'pagination limit must be 5');
    assert.strictEqual(result.pagination.page, 1, 'pagination page must be 1');

    const first = result.commits[0];
    assert.ok(first.hash && first.hash.length === 40, 'commit hash must be 40 chars');
    assert.ok(first.shortHash && first.shortHash.length === 7, 'shortHash must be 7 chars');
    assert.ok(first.subject && typeof first.subject === 'string', 'subject must be non-empty');
    assert.ok(first.stats && typeof first.stats.filesChanged === 'number', 'stats.filesChanged must be number');
    assert.ok(typeof first.stats.insertions === 'number', 'stats.insertions must be number');
    assert.ok(typeof first.stats.deletions === 'number', 'stats.deletions must be number');
});

test('Git History Service: getCommitDetails() parses file diffs and rejects invalid hashes', async () => {
    const list = await gitService.getCommitsList({ page: 1, limit: 1 });
    assert.ok(list.commits.length > 0, 'must have at least 1 commit to inspect');

    const validHash = list.commits[0].hash;
    const details = await gitService.getCommitDetails(validHash);

    assert.ok(details.commit && details.commit.hash === validHash, 'commit details must match requested hash');
    assert.ok(Array.isArray(details.files), 'details.files must be array');
    assert.ok(Array.isArray(details.diffs), 'details.diffs must be array');

    if (details.files.length > 0) {
        const file = details.files[0];
        assert.ok(file.path && typeof file.path === 'string', 'file path must be string');
        assert.ok(file.statusLetter && typeof file.statusLetter === 'string', 'file statusLetter must be string');
    }

    // Input Sanitization Tests: Must reject malicious / invalid inputs
    await assert.rejects(
        async () => { await gitService.getCommitDetails('; rm -rf /'); },
        /Invalid commit hash format/
    );
    await assert.rejects(
        async () => { await gitService.getCommitDetails('../../etc/passwd'); },
        /Invalid commit hash format/
    );
    await assert.rejects(
        async () => { await gitService.getCommitDetails('xyz123'); }, // too short / non-hex
        /Invalid commit hash format/
    );
});

test('Server & Security: /admin/git-history and API routes strictly enforce root authorization', () => {
    const serverPath = path.join(rootDir, 'server.js');
    const serverCode = fs.readFileSync(serverPath, 'utf8');

    // 1. Page view route defined with requireAuth and isRoot check
    assert.match(serverCode, /app\.get\('\/admin\/git-history',\s*requireAuth/, 'GET /admin/git-history must use requireAuth');
    assert.match(serverCode, /isRoot\s*=\s*Boolean\(req\.session\s*&&/, 'must calculate isRoot authorization');

    // 2. API routes defined and protected
    assert.match(serverCode, /app\.get\('\/api\/admin\/git-history\/overview',\s*requireAuth/, 'overview API must be protected');
    assert.match(serverCode, /app\.get\('\/api\/admin\/git-history\/commits',\s*requireAuth/, 'commits API must be protected');
    assert.match(serverCode, /app\.get\('\/api\/admin\/git-history\/commit\/:hash',\s*requireAuth/, 'commit diff API must be protected');

    // 3. Hash format validation in API route
    assert.match(serverCode, /\[0-9a-fA-F\]\{7,40\}/, 'API must validate hash with regex before service call');
});

test('View Templates: views/git-history.ejs compiles and renders without errors', () => {
    const viewPath = path.join(rootDir, 'views', 'git-history.ejs');
    assert.ok(fs.existsSync(viewPath), 'views/git-history.ejs must exist');
    const template = fs.readFileSync(viewPath, 'utf8');

    // Mock data for compilation test
    const mockOverview = {
        branch: 'main',
        currentSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        shortSha: 'a1b2c3d',
        totalCommits: 42,
        isClean: true,
        workingTree: { totalChanged: 0, staged: 0, modified: 0, untracked: 0 },
        aheadBehind: { ahead: 0, behind: 0 },
        authors: ['Sokrat Developer', 'root'],
        latestCommit: {
            fullHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
            shortSha: 'a1b2c3d',
            authorName: 'Sokrat Developer',
            authorEmail: 'dev@sokrat.com',
            date: '2026-10-05T12:00:00Z',
            subject: 'feat: add git history'
        }
    };

    // Compile in English
    const htmlEn = ejs.render(template, {
        overview: mockOverview,
        currentLang: 'en',
        currentPage: '/admin/git-history',
        currentUser: 'root',
        isRootUser: true,
        isSuperAdmin: true
    }, { filename: viewPath });
    assert.ok(htmlEn.includes('Git Repository History'), 'rendered HTML must contain English title');

    // Compile in Arabic
    const htmlAr = ejs.render(template, {
        overview: mockOverview,
        currentLang: 'ar',
        currentPage: '/admin/git-history',
        currentUser: 'root',
        isRootUser: true,
        isSuperAdmin: true
    }, { filename: viewPath });
    assert.ok(htmlAr.includes('سجل Git للنظام'), 'rendered HTML must contain Arabic title');
});

test('Sidebar Integration: views/sidebar.ejs renders Git History link in root-only administration section', () => {
    const sidebarPath = path.join(rootDir, 'views', 'sidebar.ejs');
    const sidebarCode = fs.readFileSync(sidebarPath, 'utf8');

    assert.match(sidebarCode, /location\.href='\/admin\/git-history'/, 'sidebar must contain navigation to /admin/git-history');
    assert.match(sidebarCode, /gitHistory:\s*"Git History"/, 'sidebarWords.en must define gitHistory');
    assert.match(sidebarCode, /gitHistory:\s*"سجل Git للنظام"/, 'sidebarWords.ar must define gitHistory');
});
