'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normaliseRubric,
    buildPrompt,
    validateEvaluation
} = require('../lib/ai/evaluation');
const {
    deepgramSegments,
    normaliseSegments,
    formatTranscriptForPrompt
} = require('../lib/ai/transcripts');
const { extractJson } = require('../lib/ai/llm');

const profile = {
    context_text: 'Company sells broadband plans.',
    instructions_text: 'Score only from the transcript.',
    language: 'ar-EG',
    thresholds: { pass_score: 75 },
    rubric: [
        { key: 'greeting', label: 'Greeting', weight: 20, scale: [1, 5] },
        { key: 'compliance', label: 'Compliance', weight: 30, scale: [0, 1], critical: true },
        { key: 'resolution', label: 'Resolution', weight: 50, scale: [1, 5] }
    ]
};

const transcript = 'Agent: Welcome to Sokrat. Customer: I need help with my plan. Agent: I can help.';
const segments = [
    { speaker: 'agent', start_ms: 0, end_ms: 2000, text: 'Welcome to Sokrat.' },
    { speaker: 'customer', start_ms: 2000, end_ms: 5000, text: 'I need help with my plan.' },
    { speaker: 'agent', start_ms: 5000, end_ms: 8000, text: 'I can help.' }
];

test('normaliseRubric fills defaults and clamps invalid scales', () => {
    const rubric = normaliseRubric([
        { key: 'a', weight: 2 },
        { key: 'b', scale: [1, 1] }
    ]);
    assert.equal(rubric.length, 2);
    assert.deepEqual(rubric[0].scale, [1, 5]);
    assert.deepEqual(rubric[1].scale, [1, 5]);
    assert.equal(rubric[0].weight, 2);
});

test('buildPrompt includes context, rubric keys, and speaker/timestamp transcript', () => {
    const prompt = buildPrompt(profile, transcript, segments, { uniqueid: 'abc' });
    assert.match(prompt.systemPrompt, /untrusted data/i);
    assert.match(prompt.userPrompt, /Company sells broadband plans/);
    assert.match(prompt.userPrompt, /"key": "greeting"/);
    assert.match(prompt.userPrompt, /\[0:00\] agent: Welcome to Sokrat/);
    assert.match(prompt.userPrompt, /\[0:02\] customer: I need help/);
});

test('validateEvaluation computes weighted score, pass, and critical fail', () => {
    const prompt = buildPrompt(profile, transcript, segments, {});
    const raw = {
        overall_score: 99,
        summary: 'Good call.',
        criteria: [
            { key: 'greeting', score: 5, evidence: [{ quote: 'Welcome to Sokrat.', start_ms: 0, speaker: 'agent' }], comment: 'Clear.' },
            { key: 'compliance', score: 0, evidence: [{ quote: 'I can help.', start_ms: 5000, speaker: 'agent' }], comment: 'Missing disclosure.' },
            { key: 'resolution', score: 4, evidence: [{ quote: 'I can help.', start_ms: 5000, speaker: 'agent' }], comment: 'Resolved.' }
        ],
        strengths: ['Clear greeting'],
        improvements: ['Disclose recording'],
        coaching: ['Read the disclosure'],
        compliance_flags: ['missing_disclosure'],
        critical_fail: false
    };
    const result = validateEvaluation(raw, prompt, profile, transcript);
    assert.equal(result.overall_score, 57.5);
    assert.equal(result.pass, false);
    assert.equal(result.critical_fail, true);
    assert.equal(result.criteria.length, 3);
    assert.ok(result.criteria.every(item => item.evidence.length === 1));
});

test('validateEvaluation rejects missing rubric criteria', () => {
    const prompt = buildPrompt(profile, transcript, segments, {});
    assert.throws(() => validateEvaluation({
        summary: 'Bad response',
        criteria: [{ key: 'greeting', score: 5 }]
    }, prompt, profile, transcript), /Missing criterion/);
});

test('evidence quotes not present in transcript are dropped with a warning', () => {
    const prompt = buildPrompt(profile, transcript, segments, {});
    const result = validateEvaluation({
        summary: 'Mostly good.',
        criteria: [
            { key: 'greeting', score: 5, evidence: [{ quote: 'Welcome to Sokrat.', start_ms: 0 }] },
            { key: 'compliance', score: 1, evidence: [{ quote: 'We record calls.', start_ms: 1 }] },
            { key: 'resolution', score: 5, evidence: [{ quote: 'I can help.', start_ms: 5000 }] }
        ]
    }, prompt, profile, transcript);
    assert.equal(result.criteria.find(item => item.key === 'compliance').evidence.length, 0);
    assert.ok(result.warnings.some(w => /Evidence quote not found/.test(w)));
});

test('Deepgram utterances are normalized into speaker segments', () => {
    const segments = deepgramSegments({
        results: {
            channels: [{ detected_language: 'ar', alternatives: [{ transcript: 'hello' }] }],
            utterances: [
                { speaker: 0, start: 0.5, end: 2.2, transcript: 'hello', confidence: 0.91 },
                { speaker: 1, start: 2.2, end: 4.0, transcript: 'hi', confidence: 0.88 }
            ]
        }
    });
    assert.equal(segments.length, 2);
    assert.equal(segments[0].speaker, 'speaker_0');
    assert.equal(segments[0].start_ms, 500);
    assert.equal(segments[1].speaker, 'speaker_1');
});

test('normaliseSegments and prompt formatting handle millisecond timestamps', () => {
    const normalized = normaliseSegments([{ speaker: 'agent', start_ms: 61000, end_ms: 62000, text: 'hello' }]);
    assert.equal(formatTranscriptForPrompt(normalized), '[1:01] agent: hello');
});

test('extractJson tolerates markdown fences and surrounding prose', () => {
    assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true });
    assert.deepEqual(extractJson('Result: {"ok":true} done'), { ok: true });
});

test('quality view renders in English and Arabic with valid inline JavaScript', async () => {
    const ejs = require('ejs');
    const path = require('path');
    const moment = require('moment');
    const templatePath = path.join(__dirname, '../views/quality.ejs');
    for (const lang of ['en', 'ar']) {
        const html = await ejs.renderFile(templatePath, {
            currentLang: lang,
            isRtl: lang === 'ar',
            currentPage: '/quality',
            moment,
            isSuperAdmin: true,
            isRootUser: true,
            allowedTabs: ['ai-evaluations'],
            currentUser: 'admin'
        });
        const scripts = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)];
        assert.ok(scripts.length > 0, `quality.ejs must render inline scripts for ${lang}`);
        for (const match of scripts) {
            if (!match[1].trim()) continue;
            assert.doesNotThrow(() => new Function(match[1]), `quality.ejs script must parse for ${lang}`);
        }
        assert.ok(html.includes('/api/ai'), 'quality view must call the AI API');
        assert.ok(html.includes('qtab-profiles'), 'quality view must expose the profiles tab');
    }
});
