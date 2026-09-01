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
