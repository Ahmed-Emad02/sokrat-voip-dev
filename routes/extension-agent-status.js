'use strict';

/**
 * Extension-scoped PJSIP agent status API.
 *
 * The extension is always taken from the verified HMAC signature; the body may
 * contain only the requested status. This keeps one agent from changing
 * another agent's status by spoofing an extension number.
 */

const express = require('express');
const { requireExtensionSignature } = require('../lib/extension-auth');
const agentStatus = require('../lib/agent-status');

function errorResponse(res, error, fallback) {
    const status = Number(error && error.statusCode) || 500;
    if (status >= 500) console.error('[extension-agent-status]', error && error.stack || error);
    return res.status(status).json({
        success: false,
        error: (error && error.message) || fallback || 'Agent status request failed.',
        code: (error && error.code) || 'agent_status_error',
    });
}

module.exports = function createExtensionAgentStatusRouter(pool, options = {}) {
    const router = express.Router();
    router.use(requireExtensionSignature(pool));

    router.get('/status', async (req, res) => {
        try {
            const result = await agentStatus.readAgentStatus(pool, req.sokratExtension, {
                getPresence: options.getPresence,
            });
            res.set('Cache-Control', 'no-store');
            return res.json(result);
        } catch (error) {
            return errorResponse(res, error, 'Failed to read the agent status.');
        }
    });

    router.post('/status', async (req, res) => {
        try {
            const requestedStatus = req.body && req.body.status;
            const result = await agentStatus.setAgentStatus(
                pool,
                req.sokratExtension,
                requestedStatus,
                {
                    getPresence: options.getPresence,
                    execFileAsync: options.execFileAsync,
                },
            );

            if (typeof options.onStatusChanged === 'function') {
                try {
                    options.onStatusChanged({
                        extension: req.sokratExtension,
                        status: result.status,
                        display_name: result.display_name,
                        startTime: result.last_update,
                        source: 'extension',
                        warnings: result.warnings,
                    });
                } catch (_) {}
            }

            return res.json(result);
        } catch (error) {
            return errorResponse(res, error, 'Failed to update the agent status.');
        }
    });

    return router;
};
