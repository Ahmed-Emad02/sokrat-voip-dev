'use strict';

const {
    CustomerFieldError,
    normalizeFieldDefinitions,
    normalizeCustomerData,
    fieldFromRow,
    parseCustomerData,
    text
} = require('./customer-fields');

const CUSTOMER_TABLE_SQL = [
    `CREATE TABLE IF NOT EXISTS \`sokrat_customer_fields\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\` INT UNSIGNED NOT NULL,
        \`field_key\` VARCHAR(50) NOT NULL,
        \`label_en\` VARCHAR(100) NOT NULL,
        \`label_ar\` VARCHAR(100) DEFAULT NULL,
        \`field_type\` ENUM('text','textarea','number','date','select','checkbox') NOT NULL DEFAULT 'text',
        \`options_json\` TEXT DEFAULT NULL,
        \`required\` TINYINT(1) NOT NULL DEFAULT 0,
        \`sort_order\` SMALLINT NOT NULL DEFAULT 0,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`created_by\` INT UNSIGNED DEFAULT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_sokrat_customer_field\` (\`tenant_id\`, \`field_key\`),
        KEY \`idx_sokrat_customer_fields\` (\`tenant_id\`, \`active\`, \`sort_order\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS \`sokrat_customers\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\` INT UNSIGNED NOT NULL,
        \`owner_user_id\` INT UNSIGNED NOT NULL,
        \`name\` VARCHAR(160) NOT NULL,
        \`phone\` VARCHAR(40) DEFAULT NULL,
        \`email\` VARCHAR(255) DEFAULT NULL,
        \`data_json\` JSON DEFAULT NULL,
        \`source\` VARCHAR(40) NOT NULL DEFAULT 'manual',
        \`last_session_id\` CHAR(32) DEFAULT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        \`deleted_at\` DATETIME DEFAULT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`idx_sokrat_customers_scope\` (\`tenant_id\`, \`owner_user_id\`, \`updated_at\`),
        KEY \`idx_sokrat_customers_phone\` (\`tenant_id\`, \`phone\`),
        KEY \`idx_sokrat_customers_email\` (\`tenant_id\`, \`email\`),
        KEY \`idx_sokrat_customers_session\` (\`last_session_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

class CustomerService {
    constructor({ db, logger = console } = {}) {
        if (!db) throw new Error('CustomerService requires a db pool');
        this.db = db;
        this.logger = logger;
    }

    async ensureSchema() {
        for (const sql of CUSTOMER_TABLE_SQL) {
            await this.db.query(sql);
        }
    }

    async listFields(tenantId, { activeOnly = true } = {}) {
        const [rows] = await this.db.query(
            `SELECT * FROM sokrat_customer_fields
             WHERE tenant_id = ?${activeOnly ? ' AND active = 1' : ''}
             ORDER BY sort_order ASC, id ASC`,
            [tenantId]
        );
        return rows.map(fieldFromRow);
    }

    async replaceFields(tenantId, fields, actorUserId = null) {
        const definitions = normalizeFieldDefinitions(fields);
        const conn = await this.db.getConnection();
        try {
            await conn.beginTransaction();
            for (const field of definitions) {
                await conn.query(
                    `INSERT INTO sokrat_customer_fields
                        (tenant_id, field_key, label_en, label_ar, field_type, options_json,
                         required, sort_order, active, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        label_en = VALUES(label_en),
                        label_ar = VALUES(label_ar),
                        field_type = VALUES(field_type),
                        options_json = VALUES(options_json),
                        required = VALUES(required),
                        sort_order = VALUES(sort_order),
                        active = VALUES(active)`,
                    [
                        tenantId,
                        field.key,
                        field.label_en,
                        field.label_ar,
                        field.field_type,
                        field.field_type === 'select' ? JSON.stringify(field.options) : null,
                        field.required ? 1 : 0,
                        field.sort_order,
                        field.active ? 1 : 0,
                        actorUserId
                    ]
                );
            }
            if (definitions.length === 0) {
                await conn.query('UPDATE sokrat_customer_fields SET active = 0 WHERE tenant_id = ?', [tenantId]);
            } else {
                const keys = definitions.map(field => field.key);
                await conn.query(
                    `UPDATE sokrat_customer_fields SET active = 0
                     WHERE tenant_id = ? AND field_key NOT IN (${keys.map(() => '?').join(',')})`,
                    [tenantId, ...keys]
                );
            }
            await conn.commit();
        } catch (error) {
            try { await conn.rollback(); } catch (_) {}
            throw error;
        } finally {
            conn.release();
        }
        return this.listFields(tenantId, { activeOnly: false });
    }

    async listCustomers({ tenantId, ownerUserId = null, isRoot = false, q = '', limit = 50, offset = 0 } = {}) {
        const where = ['c.tenant_id = ?', 'c.deleted_at IS NULL'];
        const params = [tenantId];
        if (!isRoot) {
            where.push('c.owner_user_id = ?');
            params.push(ownerUserId);
        }
        const search = text(q, 100);
        if (search) {
            const like = `%${search}%`;
            where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
            params.push(like, like, like);
        }
        const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
        const safeOffset = Math.max(0, Number(offset) || 0);
        const [rows] = await this.db.query(
            `SELECT c.id, c.tenant_id, c.owner_user_id, c.name, c.phone, c.email,
                    c.data_json, c.source, c.last_session_id, c.created_at, c.updated_at,
                    u.username AS owner_username
             FROM sokrat_customers c
             LEFT JOIN dashboard_users u ON u.id = c.owner_user_id
             WHERE ${where.join(' AND ')}
             ORDER BY c.updated_at DESC, c.id DESC
             LIMIT ${safeLimit} OFFSET ${safeOffset}`,
            params
        );
        return rows.map(row => this.toCustomer(row));
    }

    async getCustomer({ tenantId, ownerUserId = null, isRoot = false, id } = {}) {
        const where = ['c.id = ?', 'c.tenant_id = ?', 'c.deleted_at IS NULL'];
        const params = [id, tenantId];
        if (!isRoot) {
            where.push('c.owner_user_id = ?');
            params.push(ownerUserId);
        }
        const [rows] = await this.db.query(
            `SELECT c.id, c.tenant_id, c.owner_user_id, c.name, c.phone, c.email,
                    c.data_json, c.source, c.last_session_id, c.created_at, c.updated_at,
                    u.username AS owner_username
             FROM sokrat_customers c
             LEFT JOIN dashboard_users u ON u.id = c.owner_user_id
             WHERE ${where.join(' AND ')}
             LIMIT 1`,
            params
        );
        return rows.length ? this.toCustomer(rows[0]) : null;
    }

    async createCustomer({ tenantId, ownerUserId, name, phone, email, data, source = 'manual' } = {}) {
        if (!Number.isInteger(Number(tenantId)) || !Number.isInteger(Number(ownerUserId))) {
            throw new CustomerFieldError('Tenant and owner are required.', 'SCOPE_REQUIRED');
        }
        const definitions = await this.listFields(tenantId, { activeOnly: true });
        const cleanData = normalizeCustomerData(definitions, data);
        const cleanName = text(name, 160);
        if (!cleanName) throw new CustomerFieldError('Customer name is required.', 'NAME_REQUIRED');
        const cleanPhone = text(phone, 40) || null;
        const cleanEmail = text(email, 255) || null;
        const [result] = await this.db.query(
            `INSERT INTO sokrat_customers
                (tenant_id, owner_user_id, name, phone, email, data_json, source)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [tenantId, ownerUserId, cleanName, cleanPhone, cleanEmail, JSON.stringify(cleanData), text(source, 40) || 'manual']
        );
        return this.getCustomer({ tenantId, ownerUserId, isRoot: true, id: result.insertId });
    }

    async updateCustomer({ tenantId, ownerUserId = null, isRoot = false, id, name, phone, email, data } = {}) {
        const existing = await this.getCustomer({ tenantId, ownerUserId, isRoot, id });
        if (!existing) return null;
        const definitions = await this.listFields(tenantId, { activeOnly: true });
        const cleanData = normalizeCustomerData(definitions, data);
        const cleanName = text(name, 160);
        if (!cleanName) throw new CustomerFieldError('Customer name is required.', 'NAME_REQUIRED');
        const cleanPhone = text(phone, 40) || null;
        const cleanEmail = text(email, 255) || null;
        await this.db.query(
            `UPDATE sokrat_customers
             SET name = ?, phone = ?, email = ?, data_json = ?
             WHERE id = ? AND tenant_id = ?${isRoot ? '' : ' AND owner_user_id = ?'}`,
            isRoot
                ? [cleanName, cleanPhone, cleanEmail, JSON.stringify(cleanData), id, tenantId]
                : [cleanName, cleanPhone, cleanEmail, JSON.stringify(cleanData), id, tenantId, ownerUserId]
        );
        return this.getCustomer({ tenantId, ownerUserId, isRoot, id });
    }

    async deleteCustomer({ tenantId, ownerUserId = null, isRoot = false, id } = {}) {
        const [result] = await this.db.query(
            `UPDATE sokrat_customers SET deleted_at = NOW()
             WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${isRoot ? '' : ' AND owner_user_id = ?'}`,
            isRoot ? [id, tenantId] : [id, tenantId, ownerUserId]
        );
        return Number(result.affectedRows || 0) > 0;
    }

    toCustomer(row) {
        return {
            id: Number(row.id),
            tenant_id: Number(row.tenant_id),
            owner_user_id: Number(row.owner_user_id),
            owner_username: row.owner_username || null,
            name: row.name,
            phone: row.phone || '',
            email: row.email || '',
            data: parseCustomerData(row.data_json),
            source: row.source || 'manual',
            last_session_id: row.last_session_id || null,
            created_at: row.created_at,
            updated_at: row.updated_at
        };
    }
}

module.exports = { CustomerService, CUSTOMER_TABLE_SQL };
