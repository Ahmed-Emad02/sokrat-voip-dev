'use strict';

const express = require('express');

function httpError(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function createCustomersRouter({ service, isRootRequest, getTenantId }) {
    if (!service) throw new Error('createCustomersRouter requires a customer service');
    const router = express.Router();

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    router.use((req, res, next) => {
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

    return router;
}

module.exports = createCustomersRouter;
