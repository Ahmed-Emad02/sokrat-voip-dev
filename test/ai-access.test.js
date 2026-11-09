'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isRootSession, isAiCampaignRow, canAccessAiCampaign } = require('../lib/ai/access');

test('federation-trusted requests are not root sessions', () => {
    const req = {
        isFederationTrusted: true,
        session: { username: 'federation-peer', isRoot: false }
    };
    assert.equal(isRootSession(req), false);
});

test('AI campaign access is denied to a trusted federation peer', () => {
    const req = {
        isFederationTrusted: true,
        session: { username: 'federation-peer' }
    };
    assert.equal(canAccessAiCampaign(req, { agent_kind: 'ai', ai_agent_id: 4 }), false);
});

test('AI campaign access is denied to super-admin sessions that are not root', () => {
    const req = { session: { username: 'admin', userGroup: 'super admins' } };
    assert.equal(canAccessAiCampaign(req, { agent_kind: 'ai' }), false);
});

test('human campaigns remain readable without root', () => {
    const req = { isFederationTrusted: true, session: { username: 'federation-peer' } };
    assert.equal(isAiCampaignRow({ agent_kind: 'human', ai_agent_id: null }), false);
    assert.equal(canAccessAiCampaign(req, { agent_kind: 'human', ai_agent_id: null }), true);
});

test('root session can access AI campaigns', () => {
    const req = { session: { username: 'root', isRoot: true } };
    assert.equal(isRootSession(req), true);
    assert.equal(canAccessAiCampaign(req, { agent_kind: 'ai', ai_agent_id: 4 }), true);
});

test('dialer routes guard AI campaign CRUD/control/reads with isRootSession', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const required = [
        /app\.post\('\/api\/dialer\/campaigns'[\s\S]{0,1200}isRootSession/,
        /app\.put\('\/api\/dialer\/campaigns\/:id'[\s\S]{0,1600}isRootSession/,
        /app\.post\('\/api\/dialer\/campaigns\/:id\/control'[\s\S]{0,1200}isRootSession/,
        /app\.get\('\/api\/dialer\/campaigns\/:id'[\s\S]{0,1000}isRootSession/,
        /app\.get\('\/api\/dialer\/campaigns'[\s\S]{0,2500}visibleCampaigns/
    ];
    for (const pattern of required) assert.match(server, pattern);
});
