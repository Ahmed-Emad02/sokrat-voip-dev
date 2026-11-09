'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('extension update updates DEVICE AstDB dial and tech with the new channel driver', () => {
    const put = serverJs.match(/app\.put\('\/api\/config\/extensions\/:extension',[\s\S]*?\n\}\);/);
    assert.ok(put, 'PUT /api/config/extensions/:extension must exist');
    assert.match(put[0], /database put DEVICE\/\$\{extNum\} dial "\$\{devDial\}"`/);
    assert.match(put[0], /database put DEVICE\/\$\{extNum\} tech "\$\{devTech\}"`/);
    assert.match(put[0], /UPDATE `asterisk`\.`devices` SET tech = \?, dial = \?/);
});
