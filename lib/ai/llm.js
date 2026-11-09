'use strict';

/**
 * Minimal provider-agnostic LLM client for call evaluation.
 *
 * Supported:
 *   - OpenAI-compatible: openai, groq, openrouter, custom
 *   - Anthropic Messages API
 *   - Google Gemini generateContent
 *
 * Secrets must be decrypted by the caller before they reach this module.
 */

const DEFAULT_TIMEOUT_MS = Math.max(15_000, Number(process.env.AI_LLM_TIMEOUT_MS || 120_000));

function trimBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function openAiEndpoint(settings) {
    const base = trimBase(settings.api_url);
    if (base.endsWith('/chat/completions')) return base;
    if (base) return `${base}/chat/completions`;
    if (settings.provider === 'groq') return 'https://api.groq.com/openai/v1/chat/completions';
    if (settings.provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
    return 'https://api.openai.com/v1/chat/completions';
}

function openAiModel(settings) {
    if (settings.model) return settings.model;
    if (settings.provider === 'groq') return 'llama-3.3-70b-versatile';
    if (settings.provider === 'openrouter') return 'openai/gpt-4o-mini';
    return 'gpt-4o-mini';
}

async function readJson(response) {
    const text = await response.text();
    try { return { json: JSON.parse(text), text }; } catch (_) { return { json: null, text }; }
}

function responseError(provider, response, text) {
    return new Error(`${provider} API error (${response.status}): ${String(text || '').slice(0, 500)}`);
}

async function callOpenAiCompatible(settings, systemPrompt, userPrompt) {
    const body = {
        model: openAiModel(settings),
        temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ]
    };
    // JSON mode improves reliability on OpenAI/Groq. Custom gateways may not
    // implement it, so retry once without it if the provider rejects the field.
    const supportsJsonMode = ['openai', 'groq', 'openrouter'].includes(settings.provider);
    if (supportsJsonMode) body.response_format = { type: 'json_object' };

    const endpoint = openAiEndpoint(settings);
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.api_key}`
    };
    if (settings.provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://sokrat-voip.local';
        headers['X-Title'] = 'Sokrat VoIP Call Evaluation';
    }

    let response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
    let { json, text } = await readJson(response);
    if (!response.ok && supportsJsonMode && /response_format|json_object/i.test(text)) {
        delete body.response_format;
        response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
        });
        ({ json, text } = await readJson(response));
    }
    if (!response.ok) throw responseError(settings.provider || 'OpenAI-compatible', response, text);
    const content = json?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) {
        return content.map(part => typeof part === 'string' ? part : part?.text || '').join('');
    }
    return String(content || '').trim();
}

async function callAnthropic(settings, systemPrompt, userPrompt) {
    const endpoint = trimBase(settings.api_url) || 'https://api.anthropic.com/v1/messages';
    const body = {
        model: settings.model || 'claude-3-5-sonnet-latest',
        max_tokens: Math.max(256, Number(settings.max_tokens || 4096)),
        temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
    };
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': settings.api_key,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
    const { json, text } = await readJson(response);
    if (!response.ok) throw responseError('Anthropic', response, text);
    const content = json?.content;
    if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
    return '';
}

async function callGemini(settings, systemPrompt, userPrompt) {
    const base = trimBase(settings.api_url) || 'https://generativelanguage.googleapis.com/v1beta';
    const model = String(settings.model || 'gemini-2.0-flash').replace(/^models\//, '');
    const endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.api_key)}`;
    const body = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
            temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0,
            responseMimeType: 'application/json',
            maxOutputTokens: Math.max(256, Number(settings.max_tokens || 4096))
        }
    };
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
    const { json, text } = await readJson(response);
    if (!response.ok) throw responseError('Gemini', response, text);
    const parts = json?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) return parts.map(part => part?.text || '').join('');
    return '';
}

async function callLlm(settings, systemPrompt, userPrompt) {
    if (!settings || !settings.api_key) {
        throw new Error('LLM API key is not configured.');
    }
    const provider = String(settings.provider || 'openai').toLowerCase();
    if (provider === 'anthropic') return callAnthropic(settings, systemPrompt, userPrompt);
    if (provider === 'gemini' || provider === 'google') return callGemini(settings, systemPrompt, userPrompt);
    return callOpenAiCompatible(settings, systemPrompt, userPrompt);
}

function extractJson(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('LLM returned an empty response.');
    const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(unfenced); } catch (_) {}
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
        const candidate = unfenced.slice(start, end + 1);
        try { return JSON.parse(candidate); } catch (_) {}
    }
    throw new Error('LLM response did not contain valid JSON.');
}

module.exports = {
    callLlm,
    extractJson,
    openAiEndpoint,
    openAiModel
};
