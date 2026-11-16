'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const config = fs.readFileSync(path.join(root, 'views/config.ejs'), 'utf8');
const page = fs.readFileSync(path.join(root, 'views/scripts/config-page.ejs'), 'utf8');

test('trunk API exposes the outbound routes attached to each trunk', () => {
    assert.match(server, /outboundRoutesByTrunk/);
    assert.match(server, /outbound_route_trunks/);
    assert.match(server, /trunk\.outboundRoutes = outboundRoutesByTrunk/);
});

test('trunks table has an outbound-routes column linked to highlighted routes', () => {
    assert.match(config, /Outbound Routes/);
    assert.match(page, /t\.outboundRoutes/);
    assert.match(page, /tab=outbound&highlightTrunk=/);
    assert.match(page, /outbound-route-highlight/);
    assert.match(config, /\.outbound-route-highlight/);
});

test('outbound rendering highlights all routes using the highlighted trunk', () => {
    assert.match(page, /highlightedRouteIds/);
    assert.match(page, /route\.trunks\.some\(trunk => String\(trunk\.trunk_id\) === String\(highlightTrunkId\)\)/);
    assert.match(page, /tr\.classList\.add\('outbound-route-highlight'\)/);
});

test('trunk sequence entries link back to the trunk page and highlight for seven seconds', () => {
    assert.match(page, /tab=trunks&highlightTrunk=/);
    assert.match(page, /View this trunk in the Trunks tab/);
    assert.match(page, /}, 7000\);/);
});
