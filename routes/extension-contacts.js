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
const dialerFollowup = require('../lib/dialer-followup');

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
                        c.name AS campaign_name, c.lead_fields, c.followup_fields
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
            const followup = dialerFollowup.normalizeFollowupConfig(row.followup_fields);

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
                followup: dialerFollowup.isFollowupConfigEmpty(followup) ? null : followup,
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

    /**
     * Submits (or edits) the post-call follow-up for an attempt. The campaign
     * decides whether the form is mandatory, whether it may be skipped, the
     * edit window and which dispositions are allowed.
     */
    router.post('/dialer/followup', async (req, res) => {
        const extension = String(req.sokratExtension || '').trim();
        const attemptUuid = String(req.body?.attempt_uuid || '').trim();
        if (!attemptUuid) {
            return res.status(400).json({ success: false, error: 'attempt_uuid is required', code: 'missing_attempt' });
        }

        try {
            const [rows] = await pool.query(
                `SELECT a.attempt_uuid, a.agent_extension, a.campaign_id, a.lead_id, a.status,
                        a.updated_at, c.followup_fields, c.wrapup_time_sec, c.name AS campaign_name
                 FROM \`asterisk\`.\`dialer_call_attempts\` a
                 LEFT JOIN \`asterisk\`.\`dialer_campaigns\` c ON c.id = a.campaign_id
                 WHERE a.attempt_uuid = ?
                 LIMIT 1`,
                [attemptUuid],
            );
            if (!rows || rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Call attempt not found', code: 'attempt_not_found' });
            }
            const attempt = rows[0];
            if (String(attempt.agent_extension || '').trim() !== extension) {
                return res.status(403).json({ success: false, error: 'This call belongs to another extension', code: 'attempt_forbidden' });
            }
            const updatedAt = attempt.updated_at ? new Date(attempt.updated_at).getTime() : 0;
            const recent = Date.now() - updatedAt <= 30 * 60 * 1000;
            if (attempt.status !== 'completed' && !recent) {
                return res.status(409).json({ success: false, error: 'The follow-up window for this call has expired', code: 'followup_expired' });
            }

            const config = dialerFollowup.normalizeFollowupConfig(attempt.followup_fields);
            if (dialerFollowup.isFollowupConfigEmpty(config)) {
                return res.status(409).json({ success: false, error: 'This campaign has no follow-up form', code: 'no_followup_form' });
            }

            const [existingRows] = await pool.query(
                'SELECT id, submitted_at FROM \`asterisk\`.\`dialer_followups\` WHERE attempt_uuid = ? LIMIT 1',
                [attemptUuid],
            );
            const existing = existingRows && existingRows[0];
            if (existing) {
                const windowMs = Math.max(0, Number(config.settings.edit_window_minutes) || 0) * 60 * 1000;
                const age = Date.now() - new Date(existing.submitted_at).getTime();
                if (!windowMs || age > windowMs) {
                    return res.status(409).json({ success: false, error: 'This follow-up has already been submitted', code: 'followup_already_submitted' });
                }
            }

            const validation = dialerFollowup.validateFollowupSubmission(config, req.body?.values, {
                disposition: req.body?.disposition,
                skipped: req.body?.skipped === true || req.body?.skipped === 1 || req.body?.skipped === '1',
                skipReason: req.body?.skip_reason,
            });
            if (!validation.ok) {
                return res.status(400).json({
                    success: false,
                    error: 'Please correct the follow-up form',
                    code: 'followup_invalid',
                    field_errors: validation.errors,
                });
            }

            const payload = {
                disposition: validation.disposition || null,
                data: JSON.stringify(validation.values || {}),
                skipped: validation.skipped ? 1 : 0,
                skip_reason: validation.skipReason || null,
            };

            await pool.query(`
                INSERT INTO \`asterisk\`.\`dialer_followups\`
                    (attempt_uuid, campaign_id, lead_id, agent_extension, disposition, data, skipped, skip_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    disposition = VALUES(disposition),
                    data = VALUES(data),
                    skipped = VALUES(skipped),
                    skip_reason = VALUES(skip_reason),
                    submitted_at = CURRENT_TIMESTAMP
            `, [attemptUuid, attempt.campaign_id, attempt.lead_id, extension, payload.disposition, payload.data, payload.skipped, payload.skip_reason]);

            if (payload.disposition) {
                await pool.query('UPDATE \`asterisk\`.\`dialer_leads\` SET disposition = ?, status = "connected" WHERE id = ?', [payload.disposition, attempt.lead_id]);
            }
            await pool.query(
                'UPDATE \`asterisk\`.\`dialer_call_attempts\` SET status = "completed", active_flag = NULL WHERE attempt_uuid = ?',
                [attemptUuid],
            );

            // The agent finished the wrap-up early: release them for the next call.
            await pool.query(`
                INSERT INTO \`asterisk\`.\`dialer_agent_states\` (extension, state, current_lead_id, current_attempt_uuid, wrapup_until)
                VALUES (?, 'idle', NULL, NULL, NULL)
                ON DUPLICATE KEY UPDATE state = 'idle', current_lead_id = NULL, current_attempt_uuid = NULL, wrapup_until = NULL
            `, [extension]);

            try {
                const io = req.app.get('io');
                if (io) io.emit('dialerFollowupSaved', {
                    attempt_uuid: attemptUuid,
                    campaign_id: attempt.campaign_id,
                    lead_id: attempt.lead_id,
                    agent_extension: extension,
                });
            } catch (_) {}

            const [savedRows] = await pool.query(
                'SELECT attempt_uuid, campaign_id, lead_id, agent_extension, disposition, data, skipped, skip_reason, submitted_at FROM \`asterisk\`.\`dialer_followups\` WHERE attempt_uuid = ? LIMIT 1',
                [attemptUuid],
            );

            res.set('Cache-Control', 'no-store');
            return res.json({ success: true, followup: savedRows[0] || null });
        } catch (err) {
            console.error('[extension-dialer-followup]', err && err.message);
            return res.status(500).json({ success: false, error: 'Failed to save the follow-up', code: 'followup_error' });
        }
    });

    /** A submitted follow-up plus its form configuration (read-only history). */
    router.get('/dialer/followup/:attemptUuid', async (req, res) => {
        const extension = String(req.sokratExtension || '').trim();
        const attemptUuid = String(req.params.attemptUuid || '').trim();
        try {
            const [rows] = await pool.query(
                `SELECT a.attempt_uuid, a.agent_extension, a.campaign_id, a.lead_id,
                        l.phone_number, l.first_name, l.last_name, l.company, l.custom_data,
                        c.name AS campaign_name, c.followup_fields
                 FROM \`asterisk\`.\`dialer_call_attempts\` a
                 LEFT JOIN \`asterisk\`.\`dialer_leads\` l ON l.id = a.lead_id
                 LEFT JOIN \`asterisk\`.\`dialer_campaigns\` c ON c.id = a.campaign_id
                 WHERE a.attempt_uuid = ?
                 LIMIT 1`,
                [attemptUuid],
            );
            if (!rows || rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Call attempt not found', code: 'attempt_not_found' });
            }
            const attempt = rows[0];
            if (String(attempt.agent_extension || '').trim() !== extension) {
                return res.status(403).json({ success: false, error: 'This call belongs to another extension', code: 'attempt_forbidden' });
            }
            const [followupRows] = await pool.query(
                'SELECT disposition, data, skipped, skip_reason, submitted_at FROM \`asterisk\`.\`dialer_followups\` WHERE attempt_uuid = ? LIMIT 1',
                [attemptUuid],
            );
            let customData = attempt.custom_data;
            if (typeof customData === 'string') {
                try { customData = JSON.parse(customData); } catch (_) { customData = {}; }
            }
            let saved = followupRows && followupRows[0] ? followupRows[0] : null;
            if (saved && typeof saved.data === 'string') {
                try { saved = { ...saved, data: JSON.parse(saved.data) }; } catch (_) { saved = { ...saved, data: {} }; }
            }
            res.set('Cache-Control', 'no-store');
            return res.json({
                success: true,
                lead: {
                    attempt_uuid: attempt.attempt_uuid,
                    campaign_id: attempt.campaign_id,
                    campaign_name: attempt.campaign_name || '',
                    lead_id: attempt.lead_id,
                    phone: attempt.phone_number || '',
                    first_name: attempt.first_name || '',
                    last_name: attempt.last_name || '',
                    company: attempt.company || '',
                    custom_data: customData || {},
                },
                followup: dialerFollowup.isFollowupConfigEmpty(dialerFollowup.normalizeFollowupConfig(attempt.followup_fields))
                    ? null
                    : dialerFollowup.normalizeFollowupConfig(attempt.followup_fields),
                saved,
            });
        } catch (err) {
            console.error('[extension-dialer-followup-read]', err && err.message);
            return res.status(500).json({ success: false, error: 'Failed to read the follow-up', code: 'followup_read_error' });
        }
    });

    return router;
};
