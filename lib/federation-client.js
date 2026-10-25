'use strict';

/**
 * Signed HTTP client for server-to-server federation calls.
 *
 * The central node uses this for live state, inventory, and remote actions.
 * Every request is signed with the per-peer API key; GET requests retry
 * transient failures and a per-peer circuit breaker prevents a dead node from
 * consuming every polling cycle.
 */

const http = require('http');
const https = require('https');
const axios = require('axios');
const { buildSignatureHeaders, normalizeFederationBaseUrl } = require('./federation-auth');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false });

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 4000;
const circuitBreakers = new Map(); // peer key -> { failures, openUntil, lastError }

function getPeerApiBaseUrl(peer) {
    if (!peer) return '';
    return normalizeFederationBaseUrl(peer.api_base_url || peer.host);
}

function peerKey(peer) {
    return String(peer && (peer.id || peer.site_code || peer.host) || 'unknown');
}

function getCircuit(peer) {
    const key = peerKey(peer);
    let state = circuitBreakers.get(key);
    if (!state) {
        state = { failures: 0, openUntil: 0, lastError: null };
        circuitBreakers.set(key, state);
    }
    return state;
}

function isCircuitOpen(peer, now = Date.now()) {
    const state = getCircuit(peer);
    if (state.openUntil && state.openUntil > now) return true;
    if (state.openUntil && state.openUntil <= now) {
        state.openUntil = 0;
        state.failures = 0;
    }
    return false;
}

function recordCircuitSuccess(peer) {
    const state = getCircuit(peer);
    state.failures = 0;
    state.openUntil = 0;
    state.lastError = null;
}

function recordCircuitFailure(peer, err) {
    const state = getCircuit(peer);
    state.failures += 1;
    state.lastError = err && err.message ? err.message : 'request failed';
    if (state.failures >= CIRCUIT_THRESHOLD) {
        state.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    }
}

function shouldCountAsFailure(err) {
    if (!err) return true;
    if (!err.response) return true;
    return err.response.status >= 500 || err.response.status === 429;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function federationRequest(peer, path, options = {}) {
    const {
        method = 'GET',
        body = null,
        rawBody = null,
        contentType = null,
        localSiteCode = '10',
        decryptFn,
        actor = null,
        timeout = DEFAULT_TIMEOUT_MS,
        retries,
        withMeta = false
    } = options;

    if (!peer) throw new Error('Federation peer is required');
    const apiKey = typeof decryptFn === 'function' ? decryptFn(peer.api_key_enc) : null;
    if (!apiKey) throw new Error(`Federation API key unavailable for site ${peer.site_code || '?'}`);

    const base = getPeerApiBaseUrl(peer);
    if (!base) throw new Error(`Federation API URL unavailable for site ${peer.site_code || '?'}`);

    if (isCircuitOpen(peer)) {
        const state = getCircuit(peer);
        const err = new Error(`Federation circuit open for site ${peer.site_code || '?'} (${state.lastError || 'peer unavailable'})`);
        err.code = 'FEDERATION_CIRCUIT_OPEN';
        throw err;
    }

    const signPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${base}${signPath}`;
    const bodyText = rawBody != null
        ? (Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody))
        : (body == null
            ? ''
            : (typeof body === 'string' ? body : JSON.stringify(body)));
    const isRead = String(method).toUpperCase() === 'GET';
    const attempts = Math.max(1, Number.isFinite(retries) ? retries : (isRead ? 2 : 1));

    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        // A retry must be re-signed: timestamp and nonce are single-use.
        const headers = buildSignatureHeaders({
            apiKey,
            siteCode: localSiteCode,
            method,
            url: signPath,
            body: bodyText,
            actor,
            nodeVersion: require('../package.json').version
        });

        const config = {
            method,
            url,
            timeout,
            headers: {
                Accept: 'application/json',
                ...headers
            },
            httpAgent,
            httpsAgent,
            maxRedirects: 0,
            validateStatus: withMeta ? () => true : (status) => status >= 200 && status < 300
        };

        if (bodyText) {
            config.data = rawBody != null ? rawBody : bodyText;
            config.headers['Content-Type'] = contentType || 'application/json';
            config.transformRequest = [(data) => data];
        }

        try {
            const response = await axios.request(config);
            recordCircuitSuccess(peer);
            return withMeta
                ? { status: response.status, data: response.data, headers: response.headers }
                : response.data;
        } catch (err) {
            lastError = err;
            if (shouldCountAsFailure(err)) recordCircuitFailure(peer, err);
            if (attempt < attempts - 1) await delay(250 * (attempt + 1));
        }
    }

    const status = lastError && lastError.response ? lastError.response.status : null;
    const detail = lastError && lastError.response && lastError.response.data
        ? (typeof lastError.response.data === 'string' ? lastError.response.data : JSON.stringify(lastError.response.data))
        : (lastError ? lastError.message : 'request failed');
    const wrapped = new Error(`Federation ${method} ${signPath} via site ${peer.site_code || '?'} failed${status ? ` (${status})` : ''}: ${detail}`);
    wrapped.status = status;
    wrapped.code = lastError && lastError.code;
    throw wrapped;
}

async function federationGet(peer, path, options = {}) {
    return federationRequest(peer, path, { ...options, method: 'GET', body: null });
}

async function federationPost(peer, path, body, options = {}) {
    return federationRequest(peer, path, { ...options, method: 'POST', body });
}

module.exports = {
    getPeerApiBaseUrl,
    federationRequest,
    federationGet,
    federationPost,
    isCircuitOpen,
    _resetCircuits: () => circuitBreakers.clear(),
    _getCircuitState: (peer) => ({ ...getCircuit(peer) }),
    CIRCUIT_THRESHOLD,
    CIRCUIT_OPEN_MS
};
