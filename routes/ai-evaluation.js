'use strict';

/**
 * AI call-evaluation APIs.
 *
 * Mounted at /api/ai. Global session auth runs before this router; the router
 * adds the AI-evaluation permission layer and keeps provider secrets out of
 * list responses.
 */

const express = require('express');
const { execFile } = require('child_process');
const { normaliseRubric } = require('../lib/ai/evaluation');
const { callLlm, extractJson } = require('../lib/ai/llm');
const { isRootSession } = require('../lib/ai/access');

const ASTERISK_BIN = process.env.ASTERISK_BIN || '/usr/sbin/asterisk';
const SIP_ENDPOINT_RE = /^(PJSIP|SIP|IAX2)\/[A-Za-z0-9_.@:-]+$/i;
const FALLBACK_RE = /^[A-Za-z0-9_*#+][A-Za-z0-9_.*#+@-]*,[A-Za-z0-9_.-]+,[0-9]+$/;
const PROVIDERS = new Set(['openai', 'groq', 'openrouter', 'anthropic', 'gemini', 'google', 'custom']);
const SCOPES = new Set(['global', 'campaign', 'queue', 'did', 'agent', 'team']);
const DIRECTIONS = new Set(['any', 'inbound', 'outbound', 'internal']);

function parseJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function int(value, fallback, min, max) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function string(value, max = 1000) {
    return String(value === null || value === undefined ? '' : value).trim().slice(0, max);
}

function bool(value, fallback = false) {
    if (value === true || value === 1 || value === '1' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'false') return false;
    return fallback;
}

function normaliseProfileInput(body = {}, existing = null) {
    const rubric = normaliseRubric(body.rubric ?? body.rubric_json ?? parseJson(existing?.rubric_json, []));
    if (!rubric.length) throw new Error('At least one rubric criterion is required.');
    const thresholds = body.thresholds ?? parseJson(existing?.thresholds_json, {});
    return {
        name: string(body.name ?? existing?.name, 120),
        description: string(body.description ?? existing?.description, 4000),
        scope_type: SCOPES.has(body.scope_type) ? body.scope_type : (existing?.scope_type || 'global'),
        scope_id: body.scope_id === undefined ? (existing?.scope_id || null) : (string(body.scope_id, 64) || null),
        direction: DIRECTIONS.has(body.direction) ? body.direction : (existing?.direction || 'any'),
        language: string(body.language ?? existing?.language ?? 'ar', 16) || 'ar',
        context_text: string(body.context_text ?? body.context ?? existing?.context_text, 20000),
        instructions_text: string(body.instructions_text ?? body.instructions ?? existing?.instructions_text, 20000),
        rubric_json: JSON.stringify(rubric),
        thresholds_json: JSON.stringify({
            pass_score: Number.isFinite(Number(thresholds?.pass_score)) ? Number(thresholds.pass_score) : 75,
            critical_fail_fails_call: thresholds?.critical_fail_fails_call === undefined ? true : bool(thresholds.critical_fail_fails_call, true)
        }),
        sampling_percent: int(body.sampling_percent ?? existing?.sampling_percent, 100, 0, 100),
        min_duration_sec: int(body.min_duration_sec ?? existing?.min_duration_sec, 30, 0, 86_400),
        temperature: Math.min(2, Math.max(0, Number(body.temperature ?? existing?.temperature ?? 0) || 0)),
        active: body.active === undefined ? (existing ? Boolean(existing.active) : true) : bool(body.active, true)
    };
}

function serialiseProfile(row) {
    if (!row) return null;
    return {
        ...row,
        active: Boolean(row.active),
        rubric: parseJson(row.rubric_json, []),
        thresholds: parseJson(row.thresholds_json, {}),
        rubric_json: undefined,
        thresholds_json: undefined
    };
}

module.exports = function createAiEvaluationRouter({ pool, encrypt, decrypt, isSuperAdmin, hasRootAccess }) {
    const router = express.Router();

    // AI surfaces are root-only. Deliberately do not accept super-admin
    // group membership, federation trust, or API-key scopes here.
    const canSuper = (req) => isRootSession(req);

    const denyRootOnly = (res) => res.status(403).json({ success: false, error: 'Forbidden: AI features are restricted to the root user.' });
    const gate = (req, res, next) => canSuper(req) ? next() : denyRootOnly(res);
    const gateManage = gate;
    const gateRun = gate;


    function runAsterisk(command) {
        return new Promise(resolve => {
            execFile(ASTERISK_BIN, ['-rx', command], { timeout: 5000 }, () => resolve());
        });
    }

    function normaliseAgent(body = {}, existing = null) {
        const sipEndpoint = string(body.sip_endpoint ?? existing?.sip_endpoint, 255);
        if (!SIP_ENDPOINT_RE.test(sipEndpoint)) {
            throw new Error('sip_endpoint must be a PJSIP/, SIP/, or IAX2/ endpoint name without spaces.');
        }
        const direction = ['inbound', 'outbound', 'both'].includes(body.direction)
            ? body.direction
            : (existing?.direction || 'both');
        const fallbackTarget = string(body.fallback_target ?? existing?.fallback_target, 128) || null;
        if (fallbackTarget && !FALLBACK_RE.test(fallbackTarget)) {
            throw new Error('fallback_target must be exten,context,priority.');
        }
        return {
            name: string(body.name ?? existing?.name, 120),
            description: string(body.description ?? existing?.description, 4000),
            direction,
            language: string(body.language ?? existing?.language ?? 'ar', 16) || 'ar',
            voice: string(body.voice ?? existing?.voice, 80) || null,
            persona_prompt: string(body.persona_prompt ?? existing?.persona_prompt, 20000),
            sip_endpoint: sipEndpoint,
            transfer_target: string(body.transfer_target ?? existing?.transfer_target, 128) || null,
            fallback_target: fallbackTarget,
            max_concurrency: int(body.max_concurrency ?? existing?.max_concurrency, 1, 1, 1000),
            recording_disclosure: body.recording_disclosure === undefined
                ? Boolean(existing ? existing.recording_disclosure : true)
                : bool(body.recording_disclosure, true),
            active: body.active === undefined ? (existing ? Boolean(existing.active) : true) : bool(body.active, true)
        };
    }

    async function syncAgentAstdb(agent) {
        const prefix = `AI_AGENT ${agent.id}`;
        await runAsterisk(`database put AI_AGENT ${agent.id}/sip_endpoint ${agent.sip_endpoint}`);
        await runAsterisk(`database put AI_AGENT ${agent.id}/direction ${agent.direction}`);
        await runAsterisk(`database put AI_AGENT ${agent.id}/active ${agent.active ? '1' : '0'}`);
        if (agent.transfer_target) await runAsterisk(`database put AI_AGENT ${agent.id}/transfer_target ${agent.transfer_target}`);
        else await runAsterisk(`database del AI_AGENT ${agent.id}/transfer_target`);
        if (agent.fallback_target) await runAsterisk(`database put AI_AGENT ${agent.id}/fallback_target ${agent.fallback_target}`);
        else await runAsterisk(`database del AI_AGENT ${agent.id}/fallback_target`);
    }

    router.get('/agents', gate, async (req, res) => {
        try {
            const [rows] = await pool.query('SELECT * FROM `asterisk`.`ai_agents` ORDER BY active DESC, id DESC');
            res.json({
                success: true,
                agents: rows.map(row => ({ ...row, active: Boolean(row.active), recording_disclosure: Boolean(row.recording_disclosure) }))
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/agents', gateManage, async (req, res) => {
        try {
            const agent = normaliseAgent(req.body || {});
            if (!agent.name) return res.status(400).json({ success: false, error: 'Agent name is required.' });
            const [result] = await pool.query(
                `INSERT INTO \`asterisk\`.\`ai_agents\`
                 (name, description, direction, language, voice, persona_prompt, sip_endpoint,
                  transfer_target, fallback_target, max_concurrency, recording_disclosure, active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [agent.name, agent.description, agent.direction, agent.language, agent.voice,
                 agent.persona_prompt, agent.sip_endpoint, agent.transfer_target, agent.fallback_target,
                 agent.max_concurrency, agent.recording_disclosure ? 1 : 0, agent.active ? 1 : 0]
            );
            await syncAgentAstdb({ ...agent, id: result.insertId });
            const [rows] = await pool.query('SELECT * FROM `asterisk`.`ai_agents` WHERE id = ?', [result.insertId]);
            res.status(201).json({ success: true, agent: rows[0] });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.put('/agents/:id', gateManage, async (req, res) => {
        try {
            const id = int(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
            const [rows] = await pool.query('SELECT * FROM `asterisk`.`ai_agents` WHERE id = ?', [id]);
            if (!rows?.length) return res.status(404).json({ success: false, error: 'AI agent not found.' });
            const agent = normaliseAgent(req.body || {}, rows[0]);
            if (!agent.name) return res.status(400).json({ success: false, error: 'Agent name is required.' });
            await pool.query(
                `UPDATE \`asterisk\`.\`ai_agents\`
                 SET name = ?, description = ?, direction = ?, language = ?, voice = ?, persona_prompt = ?,
                     sip_endpoint = ?, transfer_target = ?, fallback_target = ?, max_concurrency = ?,
                     recording_disclosure = ?, active = ?
                 WHERE id = ?`,
                [agent.name, agent.description, agent.direction, agent.language, agent.voice,
                 agent.persona_prompt, agent.sip_endpoint, agent.transfer_target, agent.fallback_target,
                 agent.max_concurrency, agent.recording_disclosure ? 1 : 0, agent.active ? 1 : 0, id]
            );
            await syncAgentAstdb({ ...agent, id });
            const [updated] = await pool.query('SELECT * FROM `asterisk`.`ai_agents` WHERE id = ?', [id]);
            res.json({ success: true, agent: updated[0] });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.delete('/agents/:id', gateManage, async (req, res) => {
        try {
            const id = int(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
            await pool.query('UPDATE `asterisk`.`ai_agents` SET active = 0 WHERE id = ?', [id]);
            await runAsterisk(`database deltree AI_AGENT ${id}`);
            res.json({ success: true, message: 'AI agent deactivated.' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/sessions', gate, async (req, res) => {
        try {
            const limit = int(req.query.limit, 100, 1, 500);
            const [rows] = await pool.query(
                `SELECT s.*, a.name AS agent_name
                 FROM \`asteriskcdrdb\`.\`ai_sessions\` s
                 LEFT JOIN \`asterisk\`.\`ai_agents\` a ON a.id = s.agent_id
                 ORDER BY s.id DESC LIMIT ?`,
                [limit]
            );
            res.json({ success: true, sessions: rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/settings', gate, async (req, res) => {
        try {
            const [rows] = await pool.query('SELECT * FROM `asterisk`.`ai_evaluation_settings` WHERE id = 1');
            const row = rows?.[0] || {};
            res.json({
                success: true,
                settings: {
                    enabled: Boolean(row.enabled),
                    provider: row.provider || 'openai',
                    api_url: row.api_url || 'https://api.openai.com/v1',
                    model: row.model || 'gpt-4o-mini',
                    temperature: Number(row.temperature || 0),
                    max_tokens: Number(row.max_tokens || 4096),
                    monthly_budget_usd: Number(row.monthly_budget_usd || 0),
                    require_evidence: Boolean(Number(row.require_evidence ?? 1)),
                    has_api_key: Boolean(row.api_key_enc)
                }
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.put('/settings', gateManage, async (req, res) => {
        try {
            const body = req.body || {};
            const provider = PROVIDERS.has(String(body.provider || '').toLowerCase())
                ? String(body.provider).toLowerCase()
                : 'openai';
            const [rows] = await pool.query('SELECT * FROM `asterisk`.`ai_evaluation_settings` WHERE id = 1');
            const existing = rows?.[0] || {};
            const apiKeyEnc = body.api_key === undefined || String(body.api_key).trim() === ''
                ? (existing.api_key_enc || null)
                : encrypt(String(body.api_key).trim());
            const apiUrl = string(body.api_url ?? existing.api_url, 255) || '';
            const model = string(body.model ?? existing.model, 128) || 'gpt-4o-mini';
            await pool.query(
                `INSERT INTO \`asterisk\`.\`ai_evaluation_settings\`
                 (id, enabled, provider, api_key_enc, api_url, model, temperature, max_tokens, monthly_budget_usd, require_evidence)
                 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                  enabled = VALUES(enabled), provider = VALUES(provider), api_key_enc = VALUES(api_key_enc),
                  api_url = VALUES(api_url), model = VALUES(model), temperature = VALUES(temperature),
                  max_tokens = VALUES(max_tokens), monthly_budget_usd = VALUES(monthly_budget_usd),
                  require_evidence = VALUES(require_evidence)`,
                [
                    bool(body.enabled, Boolean(existing.enabled)) ? 1 : 0,
                    provider,
                    apiKeyEnc,
                    apiUrl,
                    model,
                    Math.min(2, Math.max(0, Number(body.temperature ?? existing.temperature ?? 0) || 0)),
                    int(body.max_tokens ?? existing.max_tokens, 4096, 256, 32_000),
                    Math.max(0, Number(body.monthly_budget_usd ?? existing.monthly_budget_usd ?? 0) || 0),
                    bool(body.require_evidence, Boolean(Number(existing.require_evidence ?? 1))) ? 1 : 0
                ]
            );
            res.json({ success: true, message: 'AI evaluation settings saved.' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/settings/test', gateManage, async (req, res) => {
        try {
            const [rows] = await pool.query('SELECT * FROM `asterisk`.`ai_evaluation_settings` WHERE id = 1');
            const row = rows?.[0];
            if (!row?.api_key_enc) return res.status(400).json({ success: false, error: 'No LLM API key configured.' });
            const apiKey = decrypt(row.api_key_enc);
            if (!apiKey) return res.status(400).json({ success: false, error: 'Stored LLM API key could not be decrypted.' });
            const started = Date.now();
            const text = await callLlm({
                provider: row.provider,
                api_key: apiKey,
                api_url: row.api_url,
                model: row.model,
                temperature: 0,
                max_tokens: 64
            }, 'Return JSON only.', 'Return exactly {"ok":true} and nothing else.');
            let ok = false;
            try { ok = extractJson(text)?.ok === true; } catch (_) {}
            res.json({ success: ok, latencyMs: Date.now() - started, sample: String(text).slice(0, 300) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/profiles', gate, async (req, res) => {
        try {
            const [rows] = await pool.query(
                'SELECT * FROM `asterisk`.`evaluation_profiles` ORDER BY active DESC, updated_at DESC, id DESC'
            );
            res.json({ success: true, profiles: rows.map(serialiseProfile) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/profiles', gateManage, async (req, res) => {
        try {
            const profile = normaliseProfileInput(req.body || {});
            if (!profile.name) return res.status(400).json({ success: false, error: 'Profile name is required.' });
            const [result] = await pool.query(
                `INSERT INTO \`asterisk\`.\`evaluation_profiles\`
                 (name, description, scope_type, scope_id, direction, language, context_text,
                  instructions_text, rubric_json, thresholds_json, sampling_percent,
                  min_duration_sec, temperature, active, version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                [
                    profile.name, profile.description, profile.scope_type, profile.scope_id,
                    profile.direction, profile.language, profile.context_text, profile.instructions_text,
                    profile.rubric_json, profile.thresholds_json, profile.sampling_percent,
                    profile.min_duration_sec, profile.temperature, profile.active ? 1 : 0
                ]
            );
            const [rows] = await pool.query('SELECT * FROM `asterisk`.`evaluation_profiles` WHERE id = ?', [result.insertId]);
            res.status(201).json({ success: true, profile: serialiseProfile(rows[0]) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.put('/profiles/:id', gateManage, async (req, res) => {
        try {
            const id = int(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
            const [rows] = await pool.query('SELECT * FROM `asterisk`.`evaluation_profiles` WHERE id = ?', [id]);
            if (!rows?.length) return res.status(404).json({ success: false, error: 'Profile not found.' });
            const existing = rows[0];
            const profile = normaliseProfileInput(req.body || {}, existing);
            await pool.query(
                `UPDATE \`asterisk\`.\`evaluation_profiles\`
                 SET name = ?, description = ?, scope_type = ?, scope_id = ?, direction = ?, language = ?,
                     context_text = ?, instructions_text = ?, rubric_json = ?, thresholds_json = ?,
                     sampling_percent = ?, min_duration_sec = ?, temperature = ?, active = ?,
                     version = version + 1
                 WHERE id = ?`,
                [
                    profile.name, profile.description, profile.scope_type, profile.scope_id,
                    profile.direction, profile.language, profile.context_text, profile.instructions_text,
                    profile.rubric_json, profile.thresholds_json, profile.sampling_percent,
                    profile.min_duration_sec, profile.temperature, profile.active ? 1 : 0, id
                ]
            );
            const [updated] = await pool.query('SELECT * FROM `asterisk`.`evaluation_profiles` WHERE id = ?', [id]);
            res.json({ success: true, profile: serialiseProfile(updated[0]) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.delete('/profiles/:id', gateManage, async (req, res) => {
        try {
            const id = int(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
            await pool.query('UPDATE `asterisk`.`evaluation_profiles` SET active = 0 WHERE id = ?', [id]);
            res.json({ success: true, message: 'Profile deactivated.' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/evaluations', gate, async (req, res) => {
        try {
            const limit = int(req.query.limit, 50, 1, 500);
            const where = [];
            const params = [];
            if (req.query.uniqueid) { where.push('e.uniqueid = ?'); params.push(string(req.query.uniqueid, 64)); }
            if (req.query.profile_id) { where.push('e.profile_id = ?'); params.push(int(req.query.profile_id, 0, 1, Number.MAX_SAFE_INTEGER)); }
            if (req.query.pass === '1' || req.query.pass === '0') { where.push('e.pass = ?'); params.push(Number(req.query.pass)); }
            if (req.query.from) { where.push('e.created_at >= ?'); params.push(req.query.from); }
            if (req.query.to) { where.push('e.created_at <= ?'); params.push(req.query.to); }
            const sql = `
                SELECT e.*, p.name AS profile_name,
                       c.src, c.dst, c.calldate, c.billsec, c.disposition, c.recordingfile
                FROM \`asteriskcdrdb\`.\`call_evaluations\` e
                LEFT JOIN \`asterisk\`.\`evaluation_profiles\` p ON p.id = e.profile_id
                LEFT JOIN \`asteriskcdrdb\`.\`cdr\` c ON c.uniqueid = e.uniqueid
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY e.id DESC LIMIT ?`;
            const [rows] = await pool.query(sql, [...params, limit]);
            res.json({ success: true, evaluations: rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/evaluations/:id', gate, async (req, res) => {
        try {
            const id = int(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
            const [rows] = await pool.query(
                `SELECT e.*, p.name AS profile_name, p.context_text, p.instructions_text
                 FROM \`asteriskcdrdb\`.\`call_evaluations\` e
                 LEFT JOIN \`asterisk\`.\`evaluation_profiles\` p ON p.id = e.profile_id
                 WHERE e.id = ?`,
                [id]
            );
            if (!rows?.length) return res.status(404).json({ success: false, error: 'Evaluation not found.' });
            const evaluation = rows[0];
            const [scores] = await pool.query(
                'SELECT * FROM `asteriskcdrdb`.`evaluation_scores` WHERE evaluation_id = ? ORDER BY id ASC',
                [id]
            );
            let transcript = null;
            let segments = [];
            if (evaluation.target_type === 'call' && evaluation.uniqueid) {
                const [tr] = await pool.query(
                    'SELECT * FROM `asteriskcdrdb`.`cdr_transcriptions` WHERE uniqueid = ? ORDER BY id DESC LIMIT 1',
                    [evaluation.uniqueid]
                );
                transcript = tr?.[0] || null;
            }
            if (!transcript && evaluation.target_type === 'voicemail') {
                const [vm] = await pool.query(
                    `SELECT * FROM \`asteriskcdrdb\`.\`voicemail_transcriptions\`
                     WHERE CONCAT(mailbox, '/', msg_file) = ? OR msg_file = ? ORDER BY id DESC LIMIT 1`,
                    [evaluation.target_id, evaluation.target_id]
                );
                transcript = vm?.[0] || null;
            }
            if (transcript) {
                const [segmentRows] = await pool.query(
                    `SELECT seq, speaker, start_ms, end_ms, text, confidence
                     FROM \`asteriskcdrdb\`.\`transcript_segments\`
                     WHERE transcription_type = ? AND transcription_id = ?
                     ORDER BY seq ASC`,
                    [evaluation.target_type, transcript.id]
                );
                segments = segmentRows;
            }
            res.json({ success: true, evaluation, scores, transcript, segments });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/evaluations/run', gateRun, async (req, res) => {
        try {
            const profileId = int(req.body?.profile_id, 0, 1, Number.MAX_SAFE_INTEGER);
            if (!profileId) return res.status(400).json({ success: false, error: 'profile_id is required.' });
            const [profiles] = await pool.query('SELECT * FROM `asterisk`.`evaluation_profiles` WHERE id = ? AND active = 1', [profileId]);
            if (!profiles?.length) return res.status(404).json({ success: false, error: 'Active profile not found.' });
            const profile = profiles[0];
            const targetType = req.body?.target_type === 'voicemail' ? 'voicemail' : 'call';
            let transcriptionId;
            let targetId;
            let uniqueid = null;
            if (targetType === 'call') {
                uniqueid = string(req.body?.uniqueid, 64);
                if (!uniqueid) return res.status(400).json({ success: false, error: 'uniqueid is required.' });
                const [rows] = await pool.query(
                    'SELECT id FROM `asteriskcdrdb`.`cdr_transcriptions` WHERE uniqueid = ? AND status = "completed" ORDER BY id DESC LIMIT 1',
                    [uniqueid]
                );
                if (!rows?.length) return res.status(404).json({ success: false, error: 'Completed call transcript not found.' });
                transcriptionId = rows[0].id;
                targetId = uniqueid;
            } else {
                const mailbox = string(req.body?.mailbox, 20);
                const msgFile = string(req.body?.msg_file, 100);
                if (!mailbox || !msgFile) return res.status(400).json({ success: false, error: 'mailbox and msg_file are required.' });
                const [rows] = await pool.query(
                    'SELECT id FROM `asteriskcdrdb`.`voicemail_transcriptions` WHERE mailbox = ? AND msg_file = ? AND status = "completed" ORDER BY id DESC LIMIT 1',
                    [mailbox, msgFile]
                );
                if (!rows?.length) return res.status(404).json({ success: false, error: 'Completed voicemail transcript not found.' });
                transcriptionId = rows[0].id;
                targetId = `${mailbox}/${msgFile}`;
            }
            await pool.query(
                `INSERT IGNORE INTO \`asteriskcdrdb\`.\`evaluation_jobs\`
                 (target_type, target_id, transcription_id, uniqueid, profile_id, profile_version,
                  profile_snapshot_json, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [targetType, targetId, transcriptionId, uniqueid, profileId, profile.version || 1,
                 JSON.stringify({
                     name: profile.name,
                     context_text: profile.context_text,
                     instructions_text: profile.instructions_text,
                     rubric_json: profile.rubric_json,
                     thresholds_json: profile.thresholds_json,
                     language: profile.language,
                     temperature: profile.temperature
                 })]
            );
            const [jobs] = await pool.query(
                `SELECT id, status FROM \`asteriskcdrdb\`.\`evaluation_jobs\`
                 WHERE profile_id = ? AND target_type = ? AND target_id = ? AND profile_version = ?`,
                [profileId, targetType, targetId, profile.version || 1]
            );
            res.json({ success: true, job: jobs?.[0] || null });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/evaluations/:id/override', gateManage, async (req, res) => {
        try {
            const id = int(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
            const score = Number(req.body?.human_score);
            if (!Number.isFinite(score) || score < 0 || score > 100) {
                return res.status(400).json({ success: false, error: 'human_score must be 0-100.' });
            }
            await pool.query(
                `UPDATE \`asteriskcdrdb\`.\`call_evaluations\`
                 SET human_score = ?, human_notes = ?, reviewer_id = ?, reviewed_at = NOW()
                 WHERE id = ?`,
                [score, string(req.body?.human_notes, 8000), req.session?.userId || null, id]
            );
            res.json({ success: true, message: 'Human review saved.' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/scorecards', gate, async (req, res) => {
        try {
            const [profiles] = await pool.query(`
                SELECT e.profile_id, p.name AS profile_name, COUNT(*) AS evaluations,
                       ROUND(AVG(e.overall_score), 1) AS avg_score,
                       ROUND(SUM(e.pass = 1) / COUNT(*) * 100, 1) AS pass_rate,
                       SUM(e.critical_fail = 1) AS critical_fails,
                       ROUND(AVG(e.human_score), 1) AS avg_human_score
                FROM \`asteriskcdrdb\`.\`call_evaluations\` e
                LEFT JOIN \`asterisk\`.\`evaluation_profiles\` p ON p.id = e.profile_id
                GROUP BY e.profile_id, p.name
                ORDER BY evaluations DESC`
            );
            const [agents] = await pool.query(`
                SELECT c.src AS agent_extension, COUNT(*) AS evaluations,
                       ROUND(AVG(e.overall_score), 1) AS avg_score,
                       ROUND(SUM(e.pass = 1) / COUNT(*) * 100, 1) AS pass_rate,
                       SUM(e.critical_fail = 1) AS critical_fails
                FROM \`asteriskcdrdb\`.\`call_evaluations\` e
                JOIN \`asteriskcdrdb\`.\`cdr\` c ON c.uniqueid = e.uniqueid
                WHERE c.src IS NOT NULL AND c.src != ''
                GROUP BY c.src
                ORDER BY evaluations DESC
                LIMIT 100`
            );
            res.json({ success: true, profiles, agents });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/transcripts/:uniqueid', gate, async (req, res) => {
        try {
            const uniqueid = string(req.params.uniqueid, 64);
            const [rows] = await pool.query(
                'SELECT * FROM `asteriskcdrdb`.`cdr_transcriptions` WHERE uniqueid = ? ORDER BY id DESC LIMIT 1',
                [uniqueid]
            );
            const transcript = rows?.[0] || null;
            if (!transcript) return res.status(404).json({ success: false, error: 'Transcript not found.' });
            const [segments] = await pool.query(
                `SELECT seq, speaker, start_ms, end_ms, text, confidence
                 FROM \`asteriskcdrdb\`.\`transcript_segments\`
                 WHERE transcription_type = 'call' AND transcription_id = ? ORDER BY seq ASC`,
                [transcript.id]
            );
            const [evaluations] = await pool.query(
                'SELECT id, profile_id, overall_score, pass, critical_fail, summary, created_at FROM `asteriskcdrdb`.`call_evaluations` WHERE uniqueid = ? ORDER BY id DESC',
                [uniqueid]
            );
            res.json({ success: true, transcript, segments, evaluations });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
