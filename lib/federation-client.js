'use strict';

/**
 * Signed HTTP client for server-to-server federation calls.
 *
 * The central node uses this for live state and inventory polling. Keeping the
 * signing logic here (rather than in the hub) makes every future resource
 * endpoint inherit the same authentication and timeout behavior.
 */

const http = require('http');
const https = require('https');
const axios = require('axios');
const { buildSignatureHeaders, normalizeFederationBaseUrl } = require('./federation-auth');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false });

function getPeerApiBaseUrl(peer) {
    if (!peer) return '';
    return normalizeFederationBaseUrl(peer.api_base_url || peer.host);
}

async function federationRequest(peer, path, options = {}) {
    const {
        method = 'GET',
        body = null,
        localSiteCode = '10',
        decryptFn,
        actor = null,
        timeout = 4000
    } = options;

    if (!peer) throw new Error('Federation peer is required');
    const apiKey = typeof decryptFn === 'function' ? decryptFn(peer.api_key_enc) : null;
    if (!apiKey) throw new Error(`Federation API key unavailable for site ${peer.site_code || '?'}`);

    const base = getPeerApiBaseUrl(peer);
    if (!base) throw new Error(`Federation API URL unavailable for site ${peer.site_code || '?'}`);

    const signPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${base}${signPath}`;
    const bodyText = body == null
        ? ''
        : (typeof body === 'string' ? body : JSON.stringify(body));

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
        validateStatus: (status) => status >= 200 && status < 300
    };

    if (bodyText) {
        config.data = bodyText;
        config.headers['Content-Type'] = 'application/json';
        config.transformRequest = [(data) => data];
    }

    try {
        const response = await axios.request(config);
        return response.data;
    } catch (err) {
        const status = err.response ? err.response.status : null;
        const detail = err.response && err.response.data
            ? (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data))
            : err.message;
        const wrapped = new Error(`Federation ${method} ${signPath} via site ${peer.site_code || '?'} failed${status ? ` (${status})` : ''}: ${detail}`);
        wrapped.status = status;
        wrapped.code = err.code;
        throw wrapped;
    }
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
    federationPost
};
