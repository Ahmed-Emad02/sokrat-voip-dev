const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const configEjsPath = path.join(__dirname, '../views/config.ejs');

test('views/config.ejs renders all 16 PBX tab sections as direct siblings at equal DOM depth', async () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    const html = ejs.render(content, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        isSuperAdmin: true,
        isRoot: true,
        user: { username: 'admin', isRoot: true },
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['extensions', 'ringgroups', 'inbound', 'trunks', 'outbound', 'queues', 'timegroups', 'timeconditions', 'voicemail', 'ivr', 'recordings', 'diagram', 'announcements', 'modem', 'dongles', 'terminal', 'federation'],
        isTabAllowed: () => true
    }, { filename: configEjsPath });

    let depth = 0;
    const sectionReport = [];

    const lines = html.split('\n');
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const tags = line.match(/<\/?div\b[^>]*>/gi) || [];
        for (const tag of tags) {
            if (tag.startsWith('</')) {
                depth--;
            } else if (tag.includes('class="tab-section') || tag.includes('id="section-')) {
                const idM = tag.match(/id="([^"]+)"/);
                sectionReport.push({ id: idM ? idM[1] : 'unknown', depthAtOpen: depth });
                depth++;
            } else if (!tag.endsWith('/>')) {
                depth++;
            }
        }
    }

    assert.equal(sectionReport.length, 16, 'Must render exactly 16 tab sections');
    const depths = new Set(sectionReport.map(s => s.depthAtOpen));
    assert.equal(depths.size, 1, `All tab sections must open at the exact same DOM depth (got ${[...depths].join(', ')})`);
});

test('views/config.ejs and server.js provide drag and drop reordering for outbound routes', () => {
    const configContent = fs.readFileSync(configEjsPath, 'utf8');
    const serverPath = path.join(__dirname, '../server.js');
    const serverContent = fs.readFileSync(serverPath, 'utf8');

    // 1. UI Priority column & drag handles
    assert.match(configContent, /<th[^>]*>.*(Priority|الأولوية).*<\/th>/i, 'config.ejs must render Priority column header');
    assert.match(configContent, /renderOutboundRoutesTable/, 'config.ejs must define renderOutboundRoutesTable');
    assert.match(configContent, /moveOutboundRoute/, 'config.ejs must define moveOutboundRoute');
    assert.match(configContent, /saveOutboundRoutesOrder/, 'config.ejs must define saveOutboundRoutesOrder');
    assert.match(configContent, /tr\.setAttribute\('draggable',\s*'true'\)/, 'Outbound route table rows must be draggable');
    assert.match(configContent, /\/api\/config\/routes\/outbound\/reorder/, 'config.ejs must POST to reorder endpoint');

    // 2. Server reorder endpoint & sequence ordering
    assert.match(serverContent, /app\.post\('\/api\/config\/routes\/outbound\/reorder'/, 'server.js must expose POST /api/config/routes/outbound/reorder');
    assert.match(serverContent, /outbound_route_sequence/, 'server.js must persist order to outbound_route_sequence');
    assert.match(serverContent, /ORDER BY COALESCE\(s\.seq,\s*9999\)\s*ASC/, 'GET /api/config/routes/outbound must order by sequence');
});
