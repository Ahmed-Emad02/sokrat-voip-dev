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

    return router;
};
