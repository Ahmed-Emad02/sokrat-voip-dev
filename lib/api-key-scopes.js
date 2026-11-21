'use strict';

/**
 * Scope semantics for static API keys.
 *
 * Static keys predate the CRM integration token scopes. Keep the historical
 * aliases working, but expose/consume one canonical read-only vocabulary in
 * new code. A key is considered read-only only when every scope it holds is a
 * read scope; "*" is always a full-access key.
 */

const READ_SCOPES = new Set([
    'calls:read',
    'recordings:read',
    'extensions:read',
    'stats:read',
    'cdr',
    'cdr-export',
    'live:read',
    'cdr:read',
    'cdr:audio'
]);

// Legacy UI scopes retained for keys created before the vocabulary was aligned.
const ALIASES = new Map([
    ['cdr:read', ['calls:read', 'cdr']],
    ['cdr:audio', ['recordings:read']]
]);

// A read-only key may POST only to endpoints that mint a short-lived read
// session. Everything else that mutates state stays GET-only.
const READ_ONLY_POST_PATHS = new Set([
    '/api/integrations/v1/embed-tickets'
]);

function splitScopes(value) {
    return String(value || '')
        .split(',')
        .map(scope => scope.trim().toLowerCase())
        .filter(Boolean);
}

function scopeMatches(scope, required) {
    const wanted = String(required || '').trim().toLowerCase();
    if (!wanted) return false;
    if (scope === '*' || scope === wanted) return true;
    const aliases = ALIASES.get(scope);
    return Boolean(aliases && aliases.includes(wanted));
}

function hasScope(scopesOrValue, required) {
    const scopes = Array.isArray(scopesOrValue)
        ? scopesOrValue.map(scope => String(scope).trim().toLowerCase())
        : splitScopes(scopesOrValue);
    return scopes.some(scope => scopeMatches(scope, required));
}

function hasAnyScope(scopesOrValue, requiredScopes) {
    return (Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes])
        .some(required => hasScope(scopesOrValue, required));
}

function isReadOnlyScopes(scopesOrValue) {
    const scopes = Array.isArray(scopesOrValue)
        ? scopesOrValue.map(scope => String(scope).trim().toLowerCase()).filter(Boolean)
        : splitScopes(scopesOrValue);
    if (scopes.length === 0) return false;
    return scopes.every(scope => scope !== '*' && READ_SCOPES.has(scope));
}

function getApiKeyScopes(req) {
    return splitScopes(req && req.apiKey && req.apiKey.scopes);
}

function requireApiScopes(...requiredScopes) {
    return (req, res, next) => {
        if (req && req.isApiKeyAuthenticated && req.apiKey) {
            if (hasAnyScope(getApiKeyScopes(req), requiredScopes)) return next();
            return res.status(403).json({
                success: false,
                error: `Forbidden. API key missing required scope: ${requiredScopes.join(' or ')}`
            });
        }
        return next();
    };
}

function enforceReadOnlyApiKey(req, res, next) {
    if (!req || !req.isApiKeyAuthenticated || !req.apiKey) return next();
    const scopes = getApiKeyScopes(req);
    if (scopes.includes('*') || !isReadOnlyScopes(scopes)) return next();

    const method = String(req.method || 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();
    if (READ_ONLY_POST_PATHS.has(req.path)) return next();

    return res.status(403).json({
        success: false,
        error: 'Forbidden. This API key is read-only.'
    });
}

module.exports = {
    READ_SCOPES,
    READ_ONLY_POST_PATHS,
    splitScopes,
    hasScope,
    hasAnyScope,
    isReadOnlyScopes,
    getApiKeyScopes,
    requireApiScopes,
    enforceReadOnlyApiKey
};
