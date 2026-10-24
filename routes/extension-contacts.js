'use strict';

/**
 * Direct address-book API for the Sokrat Chrome Extension.
 *
 * The contacts live in the same SQLite `address_book.db` used by the dashboard
 * and the inbound caller-ID dialplan, so no CRM is required. Requests are
 * authenticated with the extension's own SIP credentials (HMAC signature, see
 * lib/extension-auth.js) — no CRM pairing and no shared secret are involved.
 */

const express = require('express');
const contactsStore = require('../lib/contacts');
const { requireExtensionSignature } = require('../lib/extension-auth');

function sendContactError(res, err, fallbackMessage) {
    const status = Number(err && err.statusCode) || 500;
    if (status >= 500) console.error('[extension-contacts]', err && err.message);
    return res.status(status).json({
        success: false,
        error: (err && err.message) || fallbackMessage,
        code: (err && err.code) || 'contact_error',
        contact: (err && err.contact) || undefined
    });
}

module.exports = function createExtensionContactsRouter(pool) {
    const router = express.Router();

    router.use(requireExtensionSignature(pool));

    router.get('/contacts', async (req, res) => {
        try {
            const contacts = await contactsStore.listContacts({
                search: req.query.search || req.query.q || '',
                limit: req.query.limit || req.query.per_page || 2000
            });
            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, contacts, generated_at: new Date().toISOString() });
        } catch (err) {
            return sendContactError(res, err, 'Failed to retrieve contacts');
        }
    });

    router.post('/contacts', async (req, res) => {
        try {
            const contact = await contactsStore.createContact(req.body || {});
            return res.status(201).json({ success: true, contact });
        } catch (err) {
            return sendContactError(res, err, 'Failed to create the contact');
        }
    });

    router.put('/contacts/:id', async (req, res) => {
        try {
            const contact = await contactsStore.updateContact(req.params.id, req.body || {});
            return res.json({ success: true, contact });
        } catch (err) {
            return sendContactError(res, err, 'Failed to update the contact');
        }
    });

    router.delete('/contacts/:id', async (req, res) => {
        try {
            const contact = await contactsStore.deleteContact(req.params.id);
            return res.json({ success: true, deleted_id: contact.id, contact });
        } catch (err) {
            return sendContactError(res, err, 'Failed to delete the contact');
        }
    });

    router.get('/whoami', (req, res) => {
        res.json({ success: true, extension: req.sokratExtension });
    });

    /**
     * The campaign lead currently assigned to this extension by the progressive
     * dialer. Used by the desktop softphone for its incoming-call screen pop:
     * the dialer only sends the lead's name/number as caller ID, so the extra
     * campaign fields are fetched here when the agent's phone rings.
     *
     * Authenticated with the extension's own SIP password (HMAC), exactly like
     * the contacts routes above.
     */
    router.get('/dialer/current', async (req, res) => {
        const extension = String(req.sokratExtension || '').trim();
        try {
            const [rows] = await pool.query(
                `SELECT a.attempt_uuid, a.status AS attempt_status, a.campaign_id, a.lead_id,
                        l.phone_number, l.first_name, l.last_name, l.company, l.custom_data,
                        c.name AS campaign_name, c.lead_fields
                 FROM \`asterisk\`.\`dialer_call_attempts\` a
                 JOIN \`asterisk\`.\`dialer_leads\` l ON l.id = a.lead_id
                 LEFT JOIN \`asterisk\`.\`dialer_campaigns\` c ON c.id = a.campaign_id
                 WHERE a.agent_extension = ? AND a.active_flag = 1
                 ORDER BY a.created_at DESC
                 LIMIT 1`,
                [extension],
            );

            if (!rows || rows.length === 0) {
                res.set('Cache-Control', 'no-store');
                return res.json({ success: true, lead: null });
            }

            const row = rows[0];
            let customData = row.custom_data;
            if (typeof customData === 'string') {
                try { customData = JSON.parse(customData); } catch (_) { customData = {}; }
            }
            if (!customData || typeof customData !== 'object') customData = {};

            let leadFields = row.lead_fields;
            if (typeof leadFields === 'string') {
                try { leadFields = JSON.parse(leadFields); } catch (_) { leadFields = []; }
            }
            if (!Array.isArray(leadFields)) leadFields = [];

            res.set('Cache-Control', 'no-store');
            return res.json({
                success: true,
                generated_at: new Date().toISOString(),
                lead: {
                    attempt_uuid: row.attempt_uuid,
                    attempt_status: row.attempt_status,
                    campaign_id: row.campaign_id,
                    campaign_name: row.campaign_name || '',
                    lead_id: row.lead_id,
                    phone: row.phone_number || '',
                    first_name: row.first_name || '',
                    last_name: row.last_name || '',
                    company: row.company || '',
                    custom_data: customData,
                    lead_fields: leadFields,
                },
            });
        } catch (err) {
            console.error('[extension-dialer-lead]', err && err.message);
            return res.status(500).json({
                success: false,
                error: 'Failed to read the dialer lead',
                code: 'dialer_lead_error',
            });
        }
    });

    return router;
};
