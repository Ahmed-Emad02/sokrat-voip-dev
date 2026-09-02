const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const configEjsPath = path.join(__dirname, '../views/config.ejs');

async function renderDiagramTab() {
    return ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        isSuperAdmin: true,
        isRoot: true,
        user: { username: 'admin', isRoot: true },
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['diagram'],
        isTabAllowed: () => true
    });
}

test('config diagram uses graph-derived layered layout instead of fixed category columns', async () => {
    const html = await renderDiagramTab();
    const content = fs.readFileSync(configEjsPath, 'utf8');

    assert.ok(content.includes('computeDiagramLayout'), 'Layered layout engine must exist');
    assert.ok(content.includes('Longest-path layering'), 'Layout must derive layers from the link graph');
    assert.ok(content.includes('barycenter ordering'), 'Layout must reorder layers to reduce crossings');
    assert.equal(/x: 50 \+ colSpacing \* \d/.test(content), false, 'Fixed per-category column slots must be gone');
    assert.ok(html.includes('section-diagram'), 'Diagram section must still render');
});

test('config diagram cards are draggable with persisted positions and auto-arrange reset', async () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    assert.ok(content.includes('initDiagramNodeDragging'), 'Node drag initializer must exist');
    assert.ok(content.includes("addEventListener('pointerdown'"), 'Drag must start from card pointer events');
    assert.ok(content.includes('saveDiagramNodePosition'), 'Dragged positions must be saved');
    assert.ok(content.includes('config_diagram_layout_v1'), 'Positions must persist under a versioned key');
    assert.ok(content.includes('resetDiagramLayout'), 'Auto Arrange reset must be exposed');
    assert.ok(content.includes('makeWirePath(src, tgt)'), 'Attached wires must re-route while dragging');
});

test('config diagram wires render arrowheads, dashed failure paths and a faint global mesh', async () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    assert.ok(content.includes('marker-end'), 'Wires must carry directional arrows');
    assert.ok(content.includes('auto-start-reverse'), 'Arrow markers must be defined');
    assert.ok(content.includes("FAILING_WIRES.has(link.type)"), 'Failure wires must be styled distinctly');
    assert.ok(content.includes("'7 5'"), 'Dashed stroke for failure paths');
    assert.ok(content.includes('isGlobalMesh ? \'0.16\' : \'0.55\''), 'Global outbound mesh must be de-emphasized');
});

test('diagram cards stay attached to their wires while dragging (no arrow split)', () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    // Drag session must freeze wire transitions, otherwise the path morphs
    // 200ms behind the card and the arrowhead separates from the line
    assert.ok(content.includes('wires-live'), 'Drag sessions must toggle a wires-live class');
    assert.ok(content.includes('#diagramSvg.wires-live .diagram-wire'), 'wires-live must disable wire transitions');
    const startAdds = content.includes("svgEl.classList.add('wires-live')");
    const endRemoves = content.includes("svgEl.classList.remove('wires-live')");
    assert.ok(startAdds && endRemoves, 'wires-live must be added on drag start and removed on drag end');

    // The draw-in dash animation is gone entirely — no stroke-dasharray residue can
    // ever fragment a stretched wire (attribute OR style)
    assert.equal(content.includes('setDashoffset'), false, 'Dash-draw entrance must not be used');
    assert.ok(content.includes("opacity: [0, (el) => parseFloat(el && el.style ? el.style.opacity : '0.55')"), 'Wires must fade in via opacity');
    assert.ok(content.includes("wire.removeAttribute('stroke-dasharray')"), 'Drag re-routing strips attribute-level dash state too');

    // Canvas grows on demand so cards can be dragged past the auto-layout edge
    assert.ok(content.includes("svgEl.setAttribute('width', String(Math.ceil(needW)))"), 'Dragging toward an edge must expand the canvas');

    // No walls on ANY side: crossing the origin shifts the whole board
    assert.ok(content.includes('shifts the WHOLE board'), 'Origin-crossing drags must shift all nodes/cards/wires');
    assert.ok(content.includes('diagramNodesList.forEach(n => { n.x += shiftX; n.y += shiftY; })'), 'Board shift must move every node');
    assert.ok(content.includes("svgNodes.querySelectorAll('foreignObject')"), 'Board shift must reposition every card element');
});

test('light theme diagram cards are high-visibility and canvas fills the viewport', async () => {
    const html = await renderDiagramTab();
    const content = fs.readFileSync(configEjsPath, 'utf8');

    // Cards expose their node type so light-theme CSS can apply strong accent borders
    assert.ok(html.includes('data-node-type='), 'Cards must carry their node type');
    for (const type of ['inbound', 'ringgroup', 'queue', 'extension', 'outbound', 'trunk', 'timecondition', 'ivr']) {
        assert.ok(content.includes(`[data-node-type="${type}"]`), `Light theme must define an accent border for ${type}`);
    }
    assert.ok(content.includes('box-shadow: 0 3px 12px rgba(15, 23, 42, 0.12)'), 'Light cards must use solid shadows for visibility');

    // Canvas consumes remaining viewport space instead of a fixed estimate
    assert.ok(content.includes('sizeDiagramCanvas'), 'Canvas sizing helper must exist');
    assert.ok(content.includes("window.addEventListener('resize'"), 'Canvas must resize with the window');
    assert.ok(content.includes('Math.max(560, Math.floor(available))'), 'Canvas height must track available space with a sane floor');
});
test('config diagram renders view switcher and supports 4-quadrant radial topology map', async () => {
    const html = await renderDiagramTab();
    const content = fs.readFileSync(configEjsPath, 'utf8');

    // View Switcher controls in toolbar
    assert.ok(html.includes('id="btnDiagramViewRadial"'), 'Must render Radial Topology view toggle button');
    assert.ok(html.includes('id="btnDiagramViewPipeline"'), 'Must render Pipeline Flow view toggle button');

    // Functions and state
    assert.ok(content.includes('function setDiagramViewMode('), 'Must define setDiagramViewMode');
    assert.ok(content.includes('function renderDiagramRadial()'), 'Must define renderDiagramRadial');
    assert.ok(content.includes('function renderDiagramPipeline()'), 'Must define renderDiagramPipeline');
    assert.ok(content.includes('CORE ROUTING HUB'), 'Radial topology must render CORE ROUTING HUB central node');

    // Dedicated Config-Based Segmentation Area Headers (Every config type takes its own area)
    assert.ok(content.includes('EXTERNAL GATEWAYS (SIP TRUNKS)'), 'Must render External Gateways zone header');
    assert.ok(content.includes('INBOUND ROUTES (DIDs)'), 'Must render Inbound Routes zone header');
    assert.ok(content.includes('TIME CONDITIONS & SCHEDULES'), 'Must render Time Conditions zone header');
    assert.ok(content.includes('APPLICATION SERVERS (IVR & QUEUES)'), 'Must render IVR / App zone header');
    assert.ok(content.includes('CALL QUEUES (ACD)'), 'Must render Call Queues zone header');
    assert.ok(content.includes('RING GROUPS (HUNT GROUPS)'), 'Must render Ring Groups zone header');
    assert.ok(content.includes('ROUTING RULES (OUTBOUND)'), 'Must render Outbound Routing Rules zone header');
    assert.ok(content.includes('INTERNAL USER EXTENSIONS'), 'Must render Internal User Extensions zone header');

    // Cards filled with category colors like GSM dongle cards
    assert.ok(content.includes('CARD_THEMES'), 'Must define rich color themes for all node types');
    assert.ok(content.includes('style="background-color: ${theme.bg} !important;"'), 'Cards must have full-bleed category color fills');
});
