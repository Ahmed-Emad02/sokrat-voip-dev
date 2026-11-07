'use strict';

/**
 * Strict access helpers for AI surfaces.
 *
 * Root means the interactive root session only. In particular, a trusted
 * federation peer is NOT root for AI campaign/agent/evaluation data, even
 * though the legacy dialer uses hasRootAccess() (which trusts peers).
 */

function isRootSession(req) {
    if (!req || !req.session) return false;
    const username = String(req.session.username || '').trim().toLowerCase();
    return req.session.isRoot === true || username === 'root';
}

function isAiCampaignRow(row) {
    if (!row) return false;
    return row.agent_kind === 'ai' || Number(row.ai_agent_id) > 0;
}

function canAccessAiCampaign(req, row) {
    return !isAiCampaignRow(row) || isRootSession(req);
}

module.exports = { isRootSession, isAiCampaignRow, canAccessAiCampaign };
