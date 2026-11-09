'use strict';

const express = require('express');

function requestBaseUrl(req, service) {
    if (service.config && service.config.publicBaseUrl) {
        return String(service.config.publicBaseUrl).replace(/\/+$/, '');
    }
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim() || 'https';
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').trim();
    return `${proto}://${host}`;
}

function requestHostWithPort(req) {
    return String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
}

function requestHost(req) {
    return requestHostWithPort(req).split(':')[0] || '';
}

function decorateLink(link, req, service) {
    if (!link) return link;
    return {
        ...link,
        public_url: `${requestBaseUrl(req, service)}/c/${encodeURIComponent(link.slug)}`
    };
}

function decorateTenant(tenant, req, service) {
    if (!tenant) return tenant;
    const result = { ...tenant };
    if (Array.isArray(result.links)) {
        result.links = result.links.map(link => decorateLink(link, req, service));
    }
    return result;
}

function decorateSession(session, req, service) {
    if (!session) return session;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim() || 'https';
    const host = requestHost(req) || 'localhost';
    const hostWithPort = requestHostWithPort(req) || host;
    const configuredWss = service.config && service.config.wssUrl;
    const configuredDomain = service.config && service.config.sipDomain;
    return {
        ...session,
        // Default to the same origin that served the call page. That origin's
        // Apache vhost already proxies /ws to Asterisk, so the browser reuses
        // the certificate it accepted for the page instead of failing on the
        // separate :8443 certificate.
        wss_url: configuredWss || `${proto === 'https' ? 'wss' : 'ws'}://${hostWithPort}/ws`,
        sip_domain: configuredDomain || host
    };
}

function publicError(res, error) {
    const status = Number(error && error.status) || (error && error.code === 'POOL_EXHAUSTED' ? 503 : 400);
    if (error && error.retryAfterSec) res.set('Retry-After', String(error.retryAfterSec));
    return res.status(status).json({
        success: false,
        code: (error && error.code) || 'TENANT_CALL_ERROR',
        error: (error && error.message) || 'Call could not be started.'
    });
}

function createTenantCallsRouter(service, options = {}) {
    if (!service) throw new Error('createTenantCallsRouter requires a TenantCallService');
    const router = express.Router();
    const isRootRequest = typeof options.isRootRequest === 'function'
        ? options.isRootRequest
        : (req => Boolean(req.session && (req.session.isRoot || req.session.username === 'root')));

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    function requireRoot(req, res, next) {
        if (isRootRequest(req)) return next();
        return res.status(403).json({ success: false, error: 'Root access is required for tenant management.' });
    }

    // ---------------------------------------------------------------------
    // Public visitor session API
    // ---------------------------------------------------------------------
    router.post('/public/call-session', async (req, res) => {
        try {
            const body = req.body || {};
            const tenantSlug = String(body.tenant || body.tenant_slug || '').trim();
            const linkSlug = String(body.link || body.link_slug || '').trim();
            if (!tenantSlug && !linkSlug) {
                return res.status(400).json({ success: false, code: 'TENANT_REQUIRED', error: 'A tenant or link is required.' });
            }
            const origin = req.get('origin') || req.get('referer') || '';
            const session = await service.allocateSession({
                tenantSlug,
                linkSlug,
                origin,
                selfOrigin: requestBaseUrl(req, service),
                source: body.source,
                ip: req.ip,
                userAgent: req.get('user-agent')
            });
            return res.json({ success: true, session: decorateSession(session, req, service) });
        } catch (error) {
            console.error('[tenant-calls] public session:', error.message);
            return publicError(res, error);
        }
    });

    router.get('/public/call-session/:id', async (req, res) => {
        try {
            const session = await service.getSession(req.params.id);
            return res.json({ success: true, session });
        } catch (error) {
            return publicError(res, error);
        }
    });

    router.post('/public/call-session/:id/end', async (req, res) => {
        try {
            const body = req.body || {};
            const session = await service.endSession(req.params.id, {
                status: body.status,
                duration: body.duration,
                hangupCause: body.hangup_cause || body.hangupCause
            });
            return res.json({ success: true, session });
        } catch (error) {
            return publicError(res, error);
        }
    });

    // ---------------------------------------------------------------------
    // Platform-admin tenant management
    // ---------------------------------------------------------------------
    router.get('/admin/tenants', requireRoot, async (req, res) => {
        try {
            const tenants = await service.listTenants();
            for (const tenant of tenants) {
                const detail = await service.getTenant(tenant.id);
                tenant.links = detail ? detail.links : [];
                tenant.agents = detail ? detail.agents : [];
            }
            return res.json({ success: true, tenants: tenants.map(t => decorateTenant(t, req, service)) });
        } catch (error) {
            console.error('[tenant-calls] list tenants:', error.message);
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/admin/tenants', requireRoot, async (req, res) => {
        try {
            const result = await service.createTenant(req.body || {});
            return res.status(201).json({
                success: true,
                tenant: decorateTenant(result.tenant, req, service),
                link: decorateLink(result.link, req, service)
            });
        } catch (error) {
            console.error('[tenant-calls] create tenant:', error.message);
            return res.status(error.status || 400).json({
                success: false,
                code: error.code || 'TENANT_CREATE_FAILED',
                error: error.message
            });
        }
    });

    router.get('/admin/tenants/:id', requireRoot, async (req, res) => {
        try {
            const tenant = await service.getTenant(req.params.id);
            if (!tenant) return res.status(404).json({ success: false, error: 'Tenant not found.' });
            return res.json({ success: true, tenant: decorateTenant(tenant, req, service) });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    router.put('/admin/tenants/:id', requireRoot, async (req, res) => {
        try {
            const tenant = await service.updateTenant(req.params.id, req.body || {});
            return res.json({ success: true, tenant: decorateTenant(tenant, req, service) });
        } catch (error) {
            return res.status(error.status || 400).json({
                success: false,
                code: error.code || 'TENANT_UPDATE_FAILED',
                error: error.message
            });
        }
    });

    router.delete('/admin/tenants/:id', requireRoot, async (req, res) => {
        try {
            await service.deleteTenant(req.params.id);
            return res.json({ success: true });
        } catch (error) {
            return res.status(error.status || 400).json({ success: false, error: error.message });
        }
    });

    router.post('/admin/tenants/:id/links', requireRoot, async (req, res) => {
        try {
            const link = await service.createLink(req.params.id, req.body || {});
            return res.status(201).json({ success: true, link: decorateLink(link, req, service) });
        } catch (error) {
            return res.status(error.status || 400).json({
                success: false,
                code: error.code || 'LINK_CREATE_FAILED',
                error: error.message
            });
        }
    });

    router.put('/admin/tenant-links/:id', requireRoot, async (req, res) => {
        try {
            const link = await service.updateLink(req.params.id, req.body || {});
            return res.json({ success: true, link: decorateLink(link, req, service) });
        } catch (error) {
            return res.status(error.status || 400).json({ success: false, error: error.message });
        }
    });

    router.delete('/admin/tenant-links/:id', requireRoot, async (req, res) => {
        try {
            await service.deleteLink(req.params.id);
            return res.json({ success: true });
        } catch (error) {
            return res.status(error.status || 400).json({ success: false, error: error.message });
        }
    });

    router.get('/admin/tenants/:id/sessions', requireRoot, async (req, res) => {
        try {
            const tenant = await service.getTenant(req.params.id);
            if (!tenant) return res.status(404).json({ success: false, error: 'Tenant not found.' });
            return res.json({ success: true, sessions: tenant.sessions || [] });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    router.get('/admin/tenants/:id/usage', requireRoot, async (req, res) => {
        try {
            const usage = await service.getUsage(req.params.id);
            return res.json({ success: true, usage });
        } catch (error) {
            return res.status(error.status || 500).json({ success: false, error: error.message });
        }
    });

    router.post('/admin/tenants/:id/sync', requireRoot, async (req, res) => {
        try {
            const result = await service.syncConfig();
            return res.json({ success: true, result });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    return router;
}

module.exports = createTenantCallsRouter;
