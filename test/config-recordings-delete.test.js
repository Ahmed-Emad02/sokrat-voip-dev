const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const configEjsPath = path.join(__dirname, '../views/config.ejs');

test('views/config.ejs renders successfully in both English and Arabic without currentUser reference errors', async () => {
    const enHtml = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        isSuperAdmin: true,
        isRoot: true
    });
    assert.ok(enHtml.includes('id="recordings-table-body"'), 'English render should include recordings table');

    const arHtml = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'ar',
        isRtl: true,
        isSuperAdmin: false,
        isRoot: false
    });
    assert.ok(arHtml.includes('id="recordings-table-body"'), 'Arabic render should include recordings table');
});

test('views/config.ejs has safe delete button markup and deleteRecording implementation', () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    // Verify template string does not have JSON.stringify inside double-quoted onclick
    assert.equal(
        content.includes('deleteRecording(${rec.id}, ${JSON.stringify'),
        false,
        'Should not contain JSON.stringify inside onclick attribute'
    );

    // Verify onclick attribute is cleanly constructed with rec.id
    assert.ok(
        content.includes('onclick="deleteRecording(${rec.id})"'),
        'fetchRecordings should construct onclick="deleteRecording(${rec.id})"'
    );

    // Verify displayname and filename are escaped
    assert.ok(
        content.includes('${escapeHtml(rec.displayname || \'-\')}'),
        'displayname should be escaped with escapeHtml'
    );
    assert.ok(
        content.includes('${escapeHtml(rec.filename || \'-\')}'),
        'filename should be escaped with escapeHtml'
    );

    // Verify deleteRecording(id) signature and implementation
    assert.ok(
        content.includes('function deleteRecording(id) {'),
        'deleteRecording should accept single id parameter'
    );
    assert.ok(
        content.includes('const rec = (loadedRecordingsList || []).find(r => String(r.id) === String(id));'),
        'deleteRecording should look up rec from loadedRecordingsList'
    );
    assert.ok(
        content.includes('if (res.status === 401) { window.location.href = \'/login\'; throw new Error(\'Unauthorized\'); }'),
        'deleteRecording should handle 401 redirects'
    );
});

test('all inline event handlers in rendered views/config.ejs parse with zero syntax errors', async () => {
    for (const lang of ['en', 'ar']) {
        const isRtl = lang === 'ar';
        const html = await ejs.renderFile(configEjsPath, {
            currentPage: '/config',
            currentLang: lang,
            isRtl,
            isSuperAdmin: true,
            isRoot: true
        });

        // Strip <script> tags to inspect HTML element attributes in DOM
        const htmlWithoutScripts = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

        // Match all inline event attributes on HTML elements: on<event>="..." or on<event>='...'
        const inlineHandlerRegex = /\son[a-zA-Z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let match;
        let handlerCount = 0;

        while ((match = inlineHandlerRegex.exec(htmlWithoutScripts)) !== null) {
            const handlerCode = match[1] !== undefined ? match[1] : match[2];
            handlerCount++;
            try {
                // Assert each inline handler compiles into a valid JS function
                new Function('event', handlerCode);
            } catch (err) {
                assert.fail(`Syntax error in inline event handler (${lang}): "${handlerCode}". Error: ${err.message}`);
            }
        }

        assert.ok(handlerCount > 50, `Expected many inline handlers in ${lang} template, found ${handlerCount}`);
    }
});

test('all client script blocks in views/config.ejs parse as valid JavaScript', async () => {
    for (const lang of ['en', 'ar']) {
        const isRtl = lang === 'ar';
        const html = await ejs.renderFile(configEjsPath, {
            currentPage: '/config',
            currentLang: lang,
            isRtl,
            isSuperAdmin: true,
            isRoot: true
        });

        const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
        let scriptMatch;
        let scriptCount = 0;

        while ((scriptMatch = scriptRegex.exec(html)) !== null) {
            const scriptContent = scriptMatch[1].trim();
            if (!scriptContent) continue;
            scriptCount++;
            try {
                new Function(scriptContent);
            } catch (err) {
                assert.fail(`Syntax error in <script> block (${lang}): ${err.message}\nScript sample:\n${scriptContent.slice(0, 200)}...`);
            }
        }

        assert.ok(scriptCount > 0, `Expected script blocks to parse in ${lang}`);
    }
});

test('simulated fetchRecordings row creation produces valid onclick handlers across special characters', () => {
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    const testRecordings = [
        { id: 1, displayname: 'Standard Greeting', filename: 'custom/std-greeting.wav' },
        { id: 2, displayname: 'Double "Quote" Name', filename: 'custom/quote"file.wav' },
        { id: 3, displayname: "Single 'Quote' Name", filename: "custom/single'quote.wav" },
        { id: 4, displayname: '<script>alert("XSS")</script>', filename: '<img src=x onerror=alert(1)>' },
        { id: 5, displayname: 'تسجيل الترحيب الرئيسي', filename: 'custom/arabic-main.wav' },
        { id: 6, displayname: null, filename: null }
    ];

    for (const isRtl of [false, true]) {
        for (const rec of testRecordings) {
            const trHtml = `
                <td class="py-3 px-4 font-mono font-bold text-[var(--text-muted)]">${rec.id}</td>
                <td class="py-3 px-4 font-bold text-[var(--text-primary)]">${escapeHtml(rec.displayname || '-')}</td>
                <td class="py-3 px-4 font-mono text-xs text-blue-400 font-semibold">${escapeHtml(rec.filename || '-')}</td>
                <td class="py-3 px-4 text-center">
                    <div class="flex items-center justify-center gap-2">
                        <button onclick="togglePlayRecording(${rec.id}, this)" class="px-2.5 py-1 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/10 rounded border border-emerald-500/30 flex items-center gap-1 cursor-pointer">
                            <svg class="w-3 h-3 fill-emerald-400" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                            <span>${isRtl ? 'تشغيل' : 'Play'}</span>
                        </button>
                        <a href="/api/config/recordings/audio/${rec.id}?download=1" class="btn-link px-2.5 py-1 text-xs font-semibold text-blue-400 hover:bg-blue-500/10 rounded border border-blue-500/30 flex items-center gap-1 cursor-pointer">
                            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                            <span>${isRtl ? 'تحميل' : 'Download'}</span>
                        </a>
                        <button type="button" onclick="deleteRecording(${rec.id})" class="px-2.5 py-1 text-xs font-semibold text-red-400 hover:bg-red-500/10 rounded border border-red-500/30 cursor-pointer"><span>${isRtl ? 'حذف' : 'Delete'}</span></button>
                    </div>
                </td>
            `;

            // Extract onclick attributes from the generated row markup
            const onclickMatches = [...trHtml.matchAll(/\sonclick="([^"]*)"/g)];
            assert.ok(onclickMatches.length >= 2, 'Row should have togglePlayRecording and deleteRecording buttons');

            for (const match of onclickMatches) {
                const code = match[1];
                assert.doesNotThrow(() => {
                    new Function('event', code);
                }, `Generated onclick code "${code}" should parse without SyntaxError`);
            }

            // Ensure deleteRecording is specifically invoked with rec.id
            const deleteMatch = onclickMatches.find(m => m[1].includes('deleteRecording'));
            assert.ok(deleteMatch, 'Should have deleteRecording onclick');
            assert.equal(deleteMatch[1], `deleteRecording(${rec.id})`);

            // Verify XSS safety on displayname and filename
            assert.equal(trHtml.includes('<script>'), false, 'Should not contain unescaped script tag');
            assert.equal(trHtml.includes('<img src=x'), false, 'Should not contain unescaped img tag');
        }
    }
});
