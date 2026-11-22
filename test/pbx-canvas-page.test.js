'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const config = fs.readFileSync(path.join(root, 'views/config.ejs'), 'utf8');
const sidebar = fs.readFileSync(path.join(root, 'views/sidebar.ejs'), 'utf8');
const configScript = fs.readFileSync(path.join(root, 'views/scripts/config-page.ejs'), 'utf8');
const canvasJs = fs.readFileSync(path.join(root, 'public/js/pbx-canvas.js'), 'utf8');
const formsJs = fs.readFileSync(path.join(root, 'public/js/pbx-canvas-forms.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'views/config-canvas.ejs'), 'utf8');

test('canvas is an isolated authenticated route with a classic-config entry point', () => {
    assert.match(server, /app\.get\('\/config\/canvas', requireAuth/);
    assert.match(server, /!isRootSession\(req\)/);
    assert.match(server, /res\.render\('config-canvas'/);
    assert.match(sidebar, /<% if \(isRoot\) \{ %>[\s\S]*?href="\/config\/canvas\?lang=/);
    assert.match(sidebar, /PBX Canvas/);
    assert.match(page, /id="pbx-canvas"/);
    assert.match(page, /id="canvas-undo-btn"/);
    assert.match(page, /id="canvas-redo-btn"/);
    assert.match(page, /id="canvas-review-modal"/);
    assert.match(canvasJs, /openCanvasEditor/);
    assert.match(canvasJs, /submitNativeForm/);
    assert.match(formsJs, /function build\(/);
    assert.match(formsJs, /PBX APIs/);
    assert.match(page, /canvas-native-form/);
    assert.doesNotMatch(page, /canvas-inspector/);
    assert.match(page, /canvas-editor-delete/);
    assert.match(page, /canvas-editor-classic/);
    assert.doesNotMatch(page, /<iframe/i);
    assert.match(page, /\/js\/pbx-canvas-model\.js/);
    assert.match(page, /\/js\/pbx-canvas-forms\.js/);
    assert.match(page, /\/js\/pbx-canvas\.js/);
    assert.match(page, /\/css\/pbx-canvas\.css/);
});
