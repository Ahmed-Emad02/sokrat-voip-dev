const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const viewsDir = path.join(__dirname, '../views');
const configEjsPath = path.join(viewsDir, 'config.ejs');

// Walks HTML tracking <div> nesting while skipping <script>/<style>/comments.
// Returns { finalDepth, nestedModals } where nestedModals lists modal elements
// that opened while another [id$="Modal"] element was still open on the stack.
function analyzeDivNesting(html) {
    const stack = [];
    const nestedModals = [];
    let extraCloses = 0;
    let inScript = false;
    let inStyle = false;
    html = html.replace(/<%[\s\S]*?%>/g, '');
    const re = /<\/?div\b[^>]*>?|<script\b[^>]*>|<\/script>|<style\b[^>]*>|<\/style>|<!--[\s\S]*?-->/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const t = m[0];
        if (t.startsWith('<!--')) continue;
        if (/^<script/.test(t)) { inScript = true; continue; }
        if (/^<\/script/.test(t)) { inScript = false; continue; }
        if (/^<style/.test(t)) { inStyle = true; continue; }
        if (/^<\/style/.test(t)) { inStyle = false; continue; }
        if (inScript || inStyle) continue;
        if (/^<\//.test(t)) {
            if (stack.length > 0) {
                stack.pop();
            } else {
                extraCloses++;
            }
            continue;
        }
        if (/\/>$/.test(t)) continue;
        const idM = t.match(/id="([^"]+)"/);
        if (idM && /^[a-zA-Z]+Modal$/.test(idM[1])) {
            const enclosing = [...stack].reverse().find(s => s.id && /Modal$/.test(s.id));
            if (enclosing) nestedModals.push(`${idM[1]} nested inside ${enclosing.id}`);
        }
        stack.push({ id: idM ? idM[1] : null });
    }
    return { finalDepth: stack.length, extraCloses, nestedModals };
}

test('config.ejs renders fully balanced markup with no unclosed wrapper divs (en + ar)', () => {
    for (const lang of ['en', 'ar']) {
        const content = fs.readFileSync(configEjsPath, 'utf8');
        const html = ejs.render(content, {
            currentPage: '/config',
            currentLang: lang,
            isRtl: lang === 'ar',
            isSuperAdmin: true,
            isRoot: true,
            user: { username: 'admin', isRoot: true },
            currentUser: 'admin',
            allowedTabs: ['extensions', 'ringgroups', 'inbound', 'trunks', 'outbound', 'queues', 'timegroups', 'timeconditions', 'voicemail', 'ivr', 'recordings', 'diagram', 'announcements', 'modem', 'dongles', 'terminal'],
            isTabAllowed: () => true
        }, { filename: configEjsPath });

        const r = analyzeDivNesting(html);
        assert.equal(r.finalDepth, 0, `config.ejs [${lang}] has ${r.finalDepth} unclosed <div> element(s) — an unclosed modal wrapper swallows every later sibling modal into its display:none shell`);
    }
});

test('no PBX modal in config.ejs is nested inside another modal (they must be body-level siblings)', () => {
    for (const lang of ['en', 'ar']) {
        const content = fs.readFileSync(configEjsPath, 'utf8');
        const html = ejs.render(content, {
            currentPage: '/config',
            currentLang: lang,
            isRtl: lang === 'ar',
            isSuperAdmin: true,
            isRoot: true,
            user: { username: 'admin', isRoot: true },
            currentUser: 'admin',
            allowedTabs: ['extensions', 'ringgroups', 'inbound', 'trunks', 'outbound', 'queues', 'timegroups', 'timeconditions', 'voicemail', 'ivr', 'recordings', 'diagram', 'announcements', 'modem', 'dongles', 'terminal'],
            isTabAllowed: () => true
        }, { filename: configEjsPath });

        const r = analyzeDivNesting(html);
        assert.deepEqual(r.nestedModals, [], `config.ejs [${lang}]: modals must not nest inside each other — a closed parent modal (display:none !important from closeAllModals) hides any child modal permanently`);
    }
});

test('all view templates have balanced top-level div structure', () => {
    const problems = [];
    for (const f of fs.readdirSync(viewsDir).filter(x => x.endsWith('.ejs')).sort()) {
        const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
        const r = analyzeDivNesting(src);
        if (r.finalDepth !== 0) {
            problems.push(`${f}: ${r.finalDepth} unclosed <div>`);
        }
        if (r.extraCloses > 0) {
            problems.push(`${f}: ${r.extraCloses} extra/orphan </div> closing tag(s)`);
        }
        if (r.nestedModals.length > 0) {
            problems.push(`${f}: ${r.nestedModals.join(', ')}`);
        }
    }
    assert.deepEqual(problems, [], 'Unbalanced or nested-modal templates detected:\n' + problems.join('\n'));
});

test('all view templates have balanced interactive tags and valid script syntax', () => {
    const vm = require('vm');
    const problems = [];

    for (const f of fs.readdirSync(viewsDir).filter(x => x.endsWith('.ejs')).sort()) {
        const content = fs.readFileSync(path.join(viewsDir, f), 'utf8');

        // Check common pair tags
        for (const tag of ['button', 'script', 'select', 'form', 'label']) {
            const openRegex = new RegExp(`<${tag}[\\s>]`, 'gi');
            const closeRegex = new RegExp(`</${tag}>`, 'gi');
            const opens = (content.match(openRegex) || []).length;
            const closes = (content.match(closeRegex) || []).length;
            if (opens !== closes) {
                problems.push(`${f}: <${tag}> tag mismatch (${opens} opens vs ${closes} closes)`);
            }
        }

        // Validate syntax of client-side <script> blocks
        const scripts = content.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
        scripts.forEach((scr, idx) => {
            let code = scr.replace(/<script\b[^>]*>/i, '').replace(/<\/script>/i, '');
            code = code.replace(/<%[=-]?([\s\S]*?)%>/g, '"placeholder"');
            code = code.replace(/<%([\s\S]*?)%>/g, '');
            try {
                new vm.Script(code);
            } catch (err) {
                if (err.message.includes('missing') || err.message.includes('Unterminated') || err.message.includes('Unexpected end of input')) {
                    problems.push(`${f} script block #${idx + 1} syntax/bracket error: ${err.message}`);
                }
            }
        });
    }

    assert.deepEqual(problems, [], 'Interactive tag or script bracket issues detected:\n' + problems.join('\n'));
});
