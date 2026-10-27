const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const vm = require('vm');

const viewsDir = path.join(__dirname, '../views');
const configEjsPath = path.join(viewsDir, 'config.ejs');

// Walks HTML tracking <div> nesting while skipping <script>/<style>/comments.
// Returns line-accurate records for unclosed and orphaned tags.
function analyzeDivNesting(html) {
    const stack = [];
    const nestedModals = [];
    const orphanCloses = [];
    let inScript = false;
    let inStyle = false;

    // Strip EJS tags while preserving line breaks for accurate line reporting
    const cleanHtml = html.replace(/<%[\s\S]*?%>/g, (m) => '\n'.repeat((m.match(/\n/g) || []).length));
    const re = /<\/?div\b[^>]*>?|<script\b[^>]*>|<\/script>|<style\b[^>]*>|<\/style>|<!--[\s\S]*?-->/gi;
    let m;

    while ((m = re.exec(cleanHtml)) !== null) {
        const t = m[0];
        const line = cleanHtml.slice(0, m.index).split('\n').length;

        if (t.startsWith('<!--')) continue;
        if (/^<script/i.test(t)) { inScript = true; continue; }
        if (/^<\/script/i.test(t)) { inScript = false; continue; }
        if (/^<style/i.test(t)) { inStyle = true; continue; }
        if (/^<\/style/i.test(t)) { inStyle = false; continue; }
        if (inScript || inStyle) continue;

        if (/^<\//.test(t)) {
            if (stack.length > 0) {
                stack.pop();
            } else {
                orphanCloses.push({ line, tag: '</div>' });
            }
            continue;
        }

        // Skip self-closing tags (<div ... />)
        if (/\/\s*>$/.test(t)) continue;

        const idM = t.match(/id=["']([^"']+)["']/i);
        const tagPreview = t.replace(/\s+/g, ' ').slice(0, 60);

        if (idM && /^[a-zA-Z]+Modal$/.test(idM[1])) {
            const enclosing = [...stack].reverse().find(s => s.id && /Modal$/.test(s.id));
            if (enclosing) {
                nestedModals.push(`${idM[1]} (line ${line}) nested inside ${enclosing.id} (line ${enclosing.line})`);
            }
        }
        stack.push({ id: idM ? idM[1] : null, line, tag: tagPreview });
    }

    return {
        finalDepth: stack.length,
        extraCloses: orphanCloses.length,
        unclosedDivs: stack.map(s => `line ${s.line}: ${s.tag}`),
        orphanCloses: orphanCloses.map(c => `line ${c.line}: ${c.tag}`),
        nestedModals
    };
}

test('config.ejs renders fully balanced markup with no unclosed wrapper divs (en + ar)', () => {
    for (const lang of ['en', 'ar']) {
        const content = fs.readFileSync(configEjsPath, 'utf8') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '');
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
        assert.equal(r.finalDepth, 0, `config.ejs [${lang}] has ${r.finalDepth} unclosed <div> element(s): [${r.unclosedDivs.join('; ')}]`);
        assert.equal(r.extraCloses, 0, `config.ejs [${lang}] has ${r.extraCloses} orphan </div> closing tag(s): [${r.orphanCloses.join('; ')}]`);
    }
});

test('no PBX modal in config.ejs is nested inside another modal (they must be body-level siblings)', () => {
    for (const lang of ['en', 'ar']) {
        const content = fs.readFileSync(configEjsPath, 'utf8') + (fs.existsSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs')) ? fs.readFileSync(path.join(__dirname, '..', 'views', 'scripts', 'config-page.ejs'), 'utf8') : '');
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
        assert.deepEqual(r.nestedModals, [], `config.ejs [${lang}]: modals must not nest inside each other — a closed parent modal hides any child modal permanently: [${r.nestedModals.join('; ')}]`);
    }
});

test('all view templates have balanced top-level div structure', () => {
    const problems = [];
    for (const f of fs.readdirSync(viewsDir).filter(x => x.endsWith('.ejs')).sort()) {
        const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
        const r = analyzeDivNesting(src);
        if (r.finalDepth !== 0) {
            problems.push(`${f}: ${r.finalDepth} unclosed <div> [${r.unclosedDivs.join('; ')}]`);
        }
        if (r.extraCloses > 0) {
            problems.push(`${f}: ${r.extraCloses} extra/orphan </div> closing tag(s) [${r.orphanCloses.join('; ')}]`);
        }
        if (r.nestedModals.length > 0) {
            problems.push(`${f}: ${r.nestedModals.join(', ')}`);
        }
    }
    assert.deepEqual(problems, [], 'Unbalanced or nested-modal templates detected:\n' + problems.join('\n'));
});

test('all view templates have balanced interactive tags and valid script syntax', () => {
    const problems = [];

    for (const f of fs.readdirSync(viewsDir).filter(x => x.endsWith('.ejs')).sort()) {
        const content = fs.readFileSync(path.join(viewsDir, f), 'utf8');

        // Check common pair tags
        for (const tag of ['button', 'script', 'select', 'form', 'label', 'textarea']) {
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
            const contextName = `${f} script block #${idx + 1}`;

            // Clean EJS expressions for VM evaluation while preserving lines
            let vmCode = code.replace(/<%[=-]?([\s\S]*?)%>/g, '"placeholder"');
            vmCode = vmCode.replace(/<%([\s\S]*?)%>/g, (m) => '\n'.repeat((m.match(/\n/g) || []).length));
            try {
                new vm.Script(vmCode);
            } catch (err) {
                const msg = err.message || '';
                const isBracketOrSyntaxError = msg.includes('missing')
                    || msg.includes('Unterminated')
                    || msg.includes('Unexpected end of input')
                    || msg.includes("Unexpected token '}'")
                    || msg.includes("Unexpected token ')'")
                    || msg.includes("Unexpected token ']'");
                if (isBracketOrSyntaxError) {
                    problems.push(`${contextName} syntax/bracket error: ${msg}`);
                }
            }
        });
    }

    assert.deepEqual(problems, [], 'Interactive tag or script bracket issues detected:\n' + problems.join('\n'));
});
