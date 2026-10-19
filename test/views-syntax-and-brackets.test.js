'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const vm = require('vm');

const viewsDir = path.join(__dirname, '../views');

const moment = require('moment');

function createDummyData(filename, lang = 'en') {
    const baseName = path.basename(filename, '.ejs');
    return {
        activeTab: baseName,
        currentLang: lang,
        activeLang: lang,
        isRtl: lang === 'ar',
        currentPage: '/' + baseName,
        moment,
        userPreferences: {},
        isSuperAdmin: true,
        isRootUser: true,
        isRoot: true,
        isSuper: true,
        userExtensions: ['101', '102'],
        userExtension: '101',
        allowedTabs: ['all', 'cdr-delete', 'cdr-export', 'cdr-audio-download'],
        clients: [],
        auditLogs: [],
        session: { username: 'root', isRoot: true, lang, theme: 'dark' },
        user: { username: 'root', role: 'admin', isRoot: true, isSuper: true },
        req: { path: '/' + baseName, session: { username: 'root', isRoot: true } },
        stats: { totalCalls: 0, answeredCalls: 0, inboundCount: 0, outboundCount: 0, internalCount: 0, externalCount: 0, inboundMin: 0, outboundMin: 0, internalMin: 0, externalMin: 0, noAnswerCalls: 0, busyCalls: 0, failedCalls: 0, totalTalkMin: 0, totalTalkSec: 0, avgTalkSec: 0 },
        calls: [],
        roster: [{ extension: '101', name: 'Alice', online: true }, { extension: '102', name: 'Bob', online: false }],
        devices: [
            { ID: 'dongle0', imei: '868402001090736', imsi: '602021234567890', operator_name: 'Vodafone', state: 'Free', rssi: 22, audio_dev: '/dev/ttyUSB1', data_dev: '/dev/ttyUSB2' }
        ],
        dongles: [],
        audioFiles: [],
        currentOperator: 'test',
        layaEnabled: true,
        overview: [{ extension: '101', name: 'Alice', liveStatus: 'idle', onlineSec: 3600, idleSec: 1200, talkSec: 2400, totalTalkSec: 2400, totalCalls: 10, answerRate: 100 }],
        recentCalls: [],
        statusLogs: [],
        availableExtensions: ['101', '102'],
        availableTrunks: [{ id: 'dongle:dongle0', label: 'dongle0' }],
        filters: { startDate: '2026-10-19 00:00:00', endDate: '2026-10-19 23:59:59', targetExtension: 'ALL', statusFilter: 'ALL', directionFilter: 'ALL', callScopeFilter: 'ALL', trunkFilter: 'ALL', searchSrc: '', searchDst: '', searchDid: '', searchUniqueId: '', searchTranscript: '', page: 1, perPage: 25 },
        pagination: { page: 1, perPage: 25, total: 0, totalPages: 1 },
        trendData: JSON.stringify([]),
        dispositionData: JSON.stringify([]),
        hourlyData: JSON.stringify([]),
        topTalkers: JSON.stringify([]),
        durationData: JSON.stringify([]),
        scopeData: JSON.stringify([]),
        groups: [],
        users: [],
        keys: [],
        voicemails: [],
        inboxStats: {},
        systemResources: {},
        serviceStatuses: {},
        contacts: [],
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

test('all dynamic template literals across views have non-empty interpolations and valid brackets', () => {
    const problems = [];

    for (const f of fs.readdirSync(viewsDir).filter(x => x.endsWith('.ejs')).sort()) {
        const content = fs.readFileSync(path.join(viewsDir, f), 'utf8');
        const emptyInterpolations = content.match(/\$\{\s*\}/g);
        if (emptyInterpolations) {
            problems.push(`${f}: contains ${emptyInterpolations.length} empty string interpolation(s) \${}`);
        }

        // Verify all ${...} interpolations in template strings have balanced braces
        let idx = 0;
        const len = content.length;
        while ((idx = content.indexOf('`', idx)) !== -1) {
            let endIdx = idx + 1;
            while (endIdx < len && content[endIdx] !== '`') {
                if (content[endIdx] === '\\') { endIdx += 2; continue; }
                if (content[endIdx] === '$' && content[endIdx + 1] === '{') {
                    // Check balanced expression inside ${...}
                    let depth = 1;
                    let exprIdx = endIdx + 2;
                    while (exprIdx < len && depth > 0) {
                        if (content[exprIdx] === '\\') { exprIdx += 2; continue; }
                        if (content[exprIdx] === '{') depth++;
                        else if (content[exprIdx] === '}') depth--;
                        exprIdx++;
                    }
                    if (depth !== 0) {
                        const line = content.slice(0, endIdx).split('\n').length;
                        problems.push(`${f}: unclosed \${} interpolation starting at line ${line}`);
                    }
                    endIdx = exprIdx;
                    continue;
                }
                endIdx++;
            }
            idx = endIdx + 1;
        }
    }

    assert.deepEqual(problems, [], 'Template literal bracket or interpolation issues found:\n' + problems.join('\n'));
});


test('views/gsm-dongles.ejs renders in English and Arabic with zero JavaScript syntax errors in all inline scripts', () => {
    const ejsPath = path.join(viewsDir, 'gsm-dongles.ejs');
    const template = fs.readFileSync(ejsPath, 'utf8');

    ['en', 'ar'].forEach((lang) => {
        const data = createDummyData(ejsPath, lang);
        let rendered;
        assert.doesNotThrow(() => {
            rendered = ejs.render(template, data, { filename: ejsPath });
        }, `gsm-dongles.ejs should compile in ${lang} without EJS template errors`);

        const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
        let match;
        let count = 0;
        while ((match = scriptRegex.exec(rendered)) !== null) {
            count++;
            const js = match[1];
            if (!js.trim()) continue;
            try {
                new vm.Script(js, { filename: `gsm-dongles-${lang}-script-${count}.js` });
            } catch (err) {
                assert.fail(`Script block #${count} in gsm-dongles.ejs (${lang}) failed JavaScript syntax: ${err.message}`);
            }
        }
        assert.ok(count > 0, `gsm-dongles.ejs in ${lang} should contain script blocks`);
    });
});

test('views/ext-stats.ejs renders in English and Arabic with zero JavaScript syntax errors in all inline scripts', () => {
    const ejsPath = path.join(viewsDir, 'ext-stats.ejs');
    const template = fs.readFileSync(ejsPath, 'utf8');

    ['en', 'ar'].forEach((lang) => {
        const data = createDummyData(ejsPath, lang);
        let rendered;
        assert.doesNotThrow(() => {
            rendered = ejs.render(template, data, { filename: ejsPath });
        }, `ext-stats.ejs should compile in ${lang} without EJS template errors`);

        const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
        let match;
        let count = 0;
        while ((match = scriptRegex.exec(rendered)) !== null) {
            count++;
            const js = match[1];
            if (!js.trim()) continue;
            try {
                new vm.Script(js, { filename: `ext-stats-${lang}-script-${count}.js` });
            } catch (err) {
                assert.fail(`Script block #${count} in ext-stats.ejs (${lang}) failed JavaScript syntax: ${err.message}`);
            }
        }
        assert.ok(count > 0, `ext-stats.ejs in ${lang} should contain script blocks`);
    });
});

test('views/cdr.ejs and views/dashboard.ejs render with zero JavaScript syntax errors across all inline scripts', () => {
    ['cdr.ejs', 'dashboard.ejs'].forEach((file) => {
        const ejsPath = path.join(viewsDir, file);
        const template = fs.readFileSync(ejsPath, 'utf8');

        ['en', 'ar'].forEach((lang) => {
            const data = createDummyData(ejsPath, lang);
            let rendered;
            assert.doesNotThrow(() => {
                rendered = ejs.render(template, data, { filename: ejsPath });
            }, `${file} should compile in ${lang} without EJS errors`);

            const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
            let match;
            let count = 0;
            while ((match = scriptRegex.exec(rendered)) !== null) {
                count++;
                const js = match[1];
                if (!js.trim()) continue;
                try {
                    new vm.Script(js, { filename: `${file}-${lang}-script-${count}.js` });
                } catch (err) {
                    assert.fail(`Script block #${count} in ${file} (${lang}) failed JavaScript syntax: ${err.message}`);
                }
            }
            assert.ok(count > 0, `${file} in ${lang} should contain script blocks`);
        });
    });
});
