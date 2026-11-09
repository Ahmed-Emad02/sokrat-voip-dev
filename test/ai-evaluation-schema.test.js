'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'backend/install_db.sql'), 'utf8');
const upgrade = fs.readFileSync(path.join(root, 'scripts/safe-upgrade.sh'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'scripts/stt-worker.js'), 'utf8');

test('AI evaluation schema exists in the fresh-install SQL', () => {
    for (const table of [
        'ai_evaluation_settings',
        'evaluation_profiles',
        'transcript_segments',
        'evaluation_jobs',
        'call_evaluations',
        'evaluation_scores'
    ]) {
        const qualified = sql.includes('CREATE TABLE IF NOT EXISTS `' + table + '`');
        const prefixed = sql.includes('CREATE TABLE IF NOT EXISTS `asterisk`.`' + table + '`') ||
            sql.includes('CREATE TABLE IF NOT EXISTS `asteriskcdrdb`.`' + table + '`');
        assert.ok(qualified || prefixed, `${table} must exist`);
    }
    assert.match(sql, /`segments_json` LONGTEXT DEFAULT NULL/);
    assert.match(sql, /`provider` VARCHAR\(32\) DEFAULT NULL/);
    assert.match(sql, /`confidence_avg` DECIMAL\(5,4\) DEFAULT NULL/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `ai_agents`/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `asteriskcdrdb`.`ai_sessions`/);
    assert.match(sql, /`agent_kind` ENUM\('human','ai'\)/);
});

test('AI evaluation schema is applied by the in-place upgrader', () => {
    assert.match(upgrade, /CREATE TABLE IF NOT EXISTS \\`asterisk\\`\.\\`ai_evaluation_settings\\`/);
    assert.match(upgrade, /CREATE TABLE IF NOT EXISTS \\`asteriskcdrdb\\`\.\\`evaluation_jobs\\`/);
    assert.match(upgrade, /ALTER TABLE \\`cdr_transcriptions\\` ADD \\`\$col\\` \$def/);
});

test('server initializes AI tables and mounts the AI router', () => {
    assert.ok(server.includes('ai_evaluation_settings'));
    assert.ok(server.includes('transcript_segments'));
    assert.match(server, /require\('\.\/lib\/ai\/access'\)/);
    assert.match(server, /if \(!isRootSession\(req\)\)/);
    assert.match(server, /app\.use\('\/api\/ai', createAiEvaluationRouter\(/);
    assert.match(server, /app\.get\('\/quality'/);
    assert.match(server, /\/quality': 'ai-evaluations'/);
    assert.match(server, /AI campaigns do not reserve a human agent/);
    assert.match(server, /Channel: Local\/s@ai-agent-dial\/n/);
    assert.match(server, /Context: ai-agent-connect/);
});

test('SIP-hosted AI agent dialplan and APIs are present', () => {
    const route = fs.readFileSync(path.join(root, 'routes/ai-evaluation.js'), 'utf8');
    assert.match(route, /router\.get\('\/agents'/);
    assert.match(route, /router\.post\('\/agents'/);
    assert.match(route, /sip_endpoint must be a PJSIP/);
    assert.match(route, /restricted to the root user/);
    for (const file of ['install.sh', 'installer-bundle/install-sokrat.sh', 'scripts/safe-upgrade.sh']) {
        const content = fs.readFileSync(path.join(root, file), 'utf8');
        assert.match(content, /exten => _\[0-9\],1,NoOp\(=== SIP AI Agent/, `${file} must accept one-digit AI agent IDs`);
        assert.match(content, /\[ai-agent-dial\]/, `${file} must install the AI lead context`);
        assert.match(content, /\[ai-agent-connect\]/, `${file} must install the AI post-answer context`);
        assert.match(content, /Dial\(\$\{AI_SIP\}/, `${file} must dial the provider SIP endpoint`);
    }
});

test('STT worker persists diarized segments and processes evaluation jobs', () => {
    assert.match(worker, /transcribeWithCloudAiDetailed/);
    assert.match(worker, /targetUrl\.searchParams\.set\('diarize', 'true'\)/);
    assert.match(worker, /persistSegments\(pool, 'call'/);
    assert.match(worker, /persistSegments\(pool, 'voicemail'/);
    assert.match(worker, /processEvaluationJob\(pool\)/);
    assert.match(worker, /evaluateTranscript\(/);
});

test('quality view is wired to the AI APIs', () => {
    const view = fs.readFileSync(path.join(root, 'views/quality.ejs'), 'utf8');
    assert.match(view, /\/api\/ai/);
    assert.match(view, /qtab-profiles/);
    assert.match(view, /evaluation-profiles|profiles/);
    assert.match(view, /openEvaluation/);
});
