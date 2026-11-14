'use strict';

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');
const { normalizeBranding, isPngBuffer } = require('../lib/branding');

function httpError(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function createCustomersRouter({ service, isRootRequest, getTenantId }) {
    if (!service) throw new Error('createCustomersRouter requires a customer service');
    const router = express.Router();
    const LOGO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'tenant-logos');
    const logoUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 2 * 1024 * 1024 },
        fileFilter: (req, file, cb) => cb(null, /^image\/png$/i.test(file.mimetype))
    });

    function parseBranding(raw) {
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    async function readBranding(tenantId) {
        const [rows] = await service.db.query('SELECT branding_json FROM sokrat_tenants WHERE id = ? LIMIT 1', [tenantId]);
        if (!rows.length) throw httpError(404, 'TENANT_NOT_FOUND', 'Tenant not found.');
        return parseBranding(rows[0].branding_json);
    }

    async function writeBranding(tenantId, branding) {
        await service.db.query('UPDATE sokrat_tenants SET branding_json = ? WHERE id = ?', [JSON.stringify(branding), tenantId]);
        return branding;
    }

    async function removeTenantLogos(tenantId, keep) {
        try {
            const names = await fs.readdir(LOGO_DIR);
            await Promise.all(names
                .filter(name => name.startsWith(`tenant-${tenantId}-`) && name.endsWith('.png') && name !== keep)
                .map(name => fs.unlink(path.join(LOGO_DIR, name)).catch(() => {})));
        } catch (_) {}
    }

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    router.use((req, res, next) => {
        // This router is mounted at /api. Its auth guard must not swallow
        // unrelated unauthenticated API namespaces such as /api/federation/v1.
        const path = String(req.path || '');
        if (!/^\/(?:customers(?:\/|$)|customer-fields(?:\/|$)|tenant\/branding(?:\/|$))/.test(path)) {
            return next();
        }
        if (!req.session || !req.session.userId) {
            return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Authentication is required.' });
        }
        next();
    });

    function resolveScope(req, rawTenantId) {
        const root = Boolean(isRootRequest(req));
        const userId = Number(req.session.userId);
        let tenantId;
        if (root) {
            tenantId = Number(
                rawTenantId != null
                    ? rawTenantId
                    : (req.query.tenant_id != null ? req.query.tenant_id : (req.body && req.body.tenant_id))
            );
        } else {
            tenantId = Number(getTenantId(req));
        }
        if (!Number.isInteger(tenantId) || tenantId <= 0) {
            throw httpError(root ? 400 : 403, 'TENANT_REQUIRED', 'A tenant is required.');
        }
        return { root, userId, tenantId };
    }

    function handle(handler) {
        return async (req, res, next) => {
            try {
                await handler(req, res);
            } catch (error) {
                if (res.headersSent) return next(error);
                const status = Number(error && error.status) || 500;
                return res.status(status).json({
                    success: false,
                    code: (error && error.code) || 'CUSTOMER_ERROR',
                    error: (error && error.message) || 'Customer operation failed.'
                });
            }
        };
    }

    function customerId(req) {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            throw httpError(400, 'INVALID_CUSTOMER', 'Invalid customer id.');
        }
        return id;
    }

    // Tenant selector support. Root sees all active tenants; a tenant user sees only theirs.
    router.get('/customers/tenants', handle(async (req, res) => {
        if (isRootRequest(req)) {
            const [rows] = await service.db.query(
                "SELECT id, name, status FROM sokrat_tenants WHERE status = 'active' ORDER BY name ASC"
            );
            return res.json({ success: true, tenants: rows.map(row => ({ id: Number(row.id), name: row.name, status: row.status })) });
        }
        const tenantId = Number(getTenantId(req));
        if (!Number.isInteger(tenantId) || tenantId <= 0) {
            throw httpError(403, 'TENANT_REQUIRED', 'A tenant is required.');
        }
        const [rows] = await service.db.query(
            "SELECT id, name, status FROM sokrat_tenants WHERE id = ? AND status = 'active' LIMIT 1",
            [tenantId]
        );
        return res.json({
            success: true,
            tenants: rows.map(row => ({ id: Number(row.id), name: row.name, status: row.status }))
        });
    }));

    router.get('/customers/fields', handle(async (req, res) => {
        const scope = resolveScope(req, req.query.tenant_id);
        const includeInactive = req.query.all === '1' || req.query.include_inactive === '1';
        const fields = await service.listFields(scope.tenantId, { activeOnly: !includeInactive });
        return res.json({ success: true, fields });
    }));

    router.put('/customers/fields', handle(async (req, res) => {
        const scope = resolveScope(req, req.body && req.body.tenant_id);
        const actorUserId = scope.userId > 0 ? scope.userId : 0;
        const fields = await service.replaceFields(scope.tenantId, req.body && req.body.fields, actorUserId);
        return res.json({ success: true, fields });
    }));

    router.get('/customers', handle(async (req, res) => {
        const scope = resolveScope(req, req.query.tenant_id);
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
        const customers = await service.listCustomers({
            tenantId: scope.tenantId,
            ownerUserId: scope.userId,
            isRoot: scope.root,
            q: req.query.q || '',
            limit,
            offset: (page - 1) * limit
        });
        return res.json({ success: true, customers, page, limit });
    }));

    router.post('/customers', handle(async (req, res) => {
        const scope = resolveScope(req, req.body && req.body.tenant_id);
        const customer = await service.createCustomer({
            tenantId: scope.tenantId,
            ownerUserId: scope.userId > 0 ? scope.userId : 0,
            name: req.body && req.body.name,
            phone: req.body && req.body.phone,
            email: req.body && req.body.email,
            data: req.body && req.body.data,
            source: 'manual'
        });
        return res.status(201).json({ success: true, customer });
    }));

    router.get('/customers/:id', handle(async (req, res) => {
        const scope = resolveScope(req, req.query.tenant_id);
        const customer = await service.getCustomer({
            tenantId: scope.tenantId,
            ownerUserId: scope.userId,
            isRoot: scope.root,
            id: customerId(req)
        });
        if (!customer) throw httpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
        return res.json({ success: true, customer });
    }));

    router.put('/customers/:id', handle(async (req, res) => {
        const scope = resolveScope(req, req.body && req.body.tenant_id);
        const customer = await service.updateCustomer({
            tenantId: scope.tenantId,
            ownerUserId: scope.userId,
            isRoot: scope.root,
            id: customerId(req),
            name: req.body && req.body.name,
            phone: req.body && req.body.phone,
            email: req.body && req.body.email,
            data: req.body && req.body.data
        });
        if (!customer) throw httpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
        return res.json({ success: true, customer });
    }));

    router.delete('/customers/:id', handle(async (req, res) => {
        const scope = resolveScope(req, req.body && req.body.tenant_id);
        const deleted = await service.deleteCustomer({
            tenantId: scope.tenantId,
            ownerUserId: scope.userId,
            isRoot: scope.root,
            id: customerId(req)
        });
        if (!deleted) throw httpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
        return res.json({ success: true });
    }));

    // Per-business guest-page branding (colors + PNG logo).
    router.get('/tenant/branding', handle(async (req, res) => {
        const scope = resolveScope(req, req.query.tenant_id);
        const branding = await readBranding(scope.tenantId);
        return res.json({ success: true, branding });
    }));

    router.put('/tenant/branding', handle(async (req, res) => {
        const scope = resolveScope(req, req.body && req.body.tenant_id);
        const current = await readBranding(scope.tenantId);
        const branding = normalizeBranding(req.body && req.body.branding, current);
        if (branding.logo_url && branding.logo_url.startsWith('/uploads/tenant-logos/')
            && !branding.logo_url.startsWith(`/uploads/tenant-logos/tenant-${scope.tenantId}-`)) {
            delete branding.logo_url;
        }
        await writeBranding(scope.tenantId, branding);
        return res.json({ success: true, branding });
    }));

    router.post('/tenant/branding/logo', (req, res, next) => {
        logoUpload.single('logo')(req, res, (error) => {
            if (error) {
                return res.status(400).json({ success: false, code: 'INVALID_LOGO', error: 'Upload a PNG logo up to 2 MB.' });
            }
            next();
        });
    }, handle(async (req, res) => {
        const scope = resolveScope(req, req.body && req.body.tenant_id);
        if (!req.file || !isPngBuffer(req.file.buffer)) {
            throw httpError(400, 'INVALID_LOGO', 'A valid PNG logo is required.');
        }
        const current = await readBranding(scope.tenantId);
        await fs.mkdir(LOGO_DIR, { recursive: true });
        const filename = `tenant-${scope.tenantId}-${Date.now()}.png`;
        await fs.writeFile(path.join(LOGO_DIR, filename), req.file.buffer, { mode: 0o644 });
        await removeTenantLogos(scope.tenantId, filename);
        const logoUrl = `/uploads/tenant-logos/${filename}`;
        const branding = normalizeBranding({ logo_url: logoUrl }, current);
        await writeBranding(scope.tenantId, branding);
        return res.json({ success: true, branding, logo_url: logoUrl });
    }));

    router.delete('/tenant/branding/logo', handle(async (req, res) => {
        const scope = resolveScope(req, req.query.tenant_id);
        await removeTenantLogos(scope.tenantId);
        const current = await readBranding(scope.tenantId);
        const branding = normalizeBranding({ logo_url: '' }, current);
        await writeBranding(scope.tenantId, branding);
        return res.json({ success: true, branding });
    }));

    return router;
}

module.exports = createCustomersRouter;
