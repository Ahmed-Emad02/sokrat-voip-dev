'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const viewsDir = path.join(__dirname, '../views');

function createDummyData(filename, lang = 'en') {
    return {
        activeTab: 'dialer',
        currentLang: lang,
        activeLang: lang,
        isRtl: lang === 'ar',
        currentPage: '/dialer',
        moment: () => ({ format: () => '2026-10-10' }),
        userPreferences: {},
        isSuperAdmin: true,
        isRootUser: true,
        isRoot: true,
        userExtensions: null,
        userExtension: null,
        clients: [],
        auditLogs: [],
        session: { username: 'root', isRoot: true, lang, theme: 'dark' },
        req: { path: '/dialer', session: { username: 'root', isRoot: true } },
        filename
    };
}

test('views/dialer.ejs renders in English and Arabic with zero JavaScript syntax errors', (t) => {
    const ejsPath = path.join(viewsDir, 'dialer.ejs');
    const template = fs.readFileSync(ejsPath, 'utf8');

    ['en', 'ar'].forEach((lang) => {
        const data = createDummyData(ejsPath, lang);
        let rendered;
        assert.doesNotThrow(() => {
            rendered = ejs.render(template, data, { filename: ejsPath });
        }, `dialer.ejs should compile in ${lang} without EJS template errors`);

        // Assert no empty template literal interpolations ${} exist in the rendered output
        const emptyInterpolationMatch = rendered.match(/\$\{\s*\}/g);
        assert.equal(
            emptyInterpolationMatch,
            null,
            `Rendered dialer.ejs in ${lang} must not contain empty template literal interpolations (\${})`
        );

        // Extract every <script> block and assert clean JavaScript syntax
        const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
        let match;
        let count = 0;
        while ((match = scriptRegex.exec(rendered)) !== null) {
            count++;
            const js = match[1];
            if (!js.trim()) continue;
            try {
                new Function(js);
            } catch (err) {
                assert.fail(`Script block ${count} in dialer.ejs (${lang}) failed JavaScript syntax: ${err.message}`);
            }
        }
        assert.ok(count > 0, `dialer.ejs in ${lang} should contain script blocks`);
    });
});

test('views/dialer.ejs card template has balanced HTML tags and brackets', () => {
    const ejsPath = path.join(viewsDir, 'dialer.ejs');
    const content = fs.readFileSync(ejsPath, 'utf8');

    // Extract the card template definition
    const cardTemplateMatch = content.match(/card\.innerHTML\s*=\s*`([\s\S]*?)`;/);
    assert.ok(cardTemplateMatch, 'dialer.ejs must contain card.innerHTML template literal');

    const cardHtml = cardTemplateMatch[1];

    // Check balanced <div> tags in card template
    const openDivs = (cardHtml.match(/<div(\s+[^>]*)?>/gi) || []).length;
    const closeDivs = (cardHtml.match(/<\/div>/gi) || []).length;
    assert.equal(
        openDivs,
        closeDivs,
        `Campaign card template must have perfectly balanced <div> tags (open: ${openDivs}, close: ${closeDivs})`
    );

    // Check balanced <button> tags in card template
    const openButtons = (cardHtml.match(/<button(\s+[^>]*)?>/gi) || []).length;
    const closeButtons = (cardHtml.match(/<\/button>/gi) || []).length;
    assert.equal(
        openButtons,
        closeButtons,
        `Campaign card template must have perfectly balanced <button> tags (open: ${openButtons}, close: ${closeButtons})`
    );

    // Assert no dangerous empty string interpolation ${} inside the template literal
    assert.doesNotMatch(cardHtml, /\$\{\s*\}/, 'Card template must not contain empty ${} interpolation');
});

test('views/crm-admin.ejs renders cleanly with zero script syntax errors and balanced tags', () => {
    const ejsPath = path.join(viewsDir, 'crm-admin.ejs');
    const template = fs.readFileSync(ejsPath, 'utf8');

    ['en', 'ar'].forEach((lang) => {
        const data = createDummyData(ejsPath, lang);
        let rendered;
        assert.doesNotThrow(() => {
            rendered = ejs.render(template, data, { filename: ejsPath });
        }, `crm-admin.ejs should compile in ${lang} without EJS errors`);

        // Validate all scripts inside crm-admin.ejs
        const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
        let match;
        let count = 0;
        while ((match = scriptRegex.exec(rendered)) !== null) {
            count++;
            const js = match[1];
            if (!js.trim()) continue;
            try {
                new Function(js);
            } catch (err) {
                assert.fail(`Script block ${count} in crm-admin.ejs (${lang}) failed JS syntax: ${err.message}`);
            }
        }
        assert.ok(count > 0, `crm-admin.ejs in ${lang} should contain script blocks`);
    });
});
