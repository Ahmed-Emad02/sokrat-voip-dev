const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const configPagePath = path.join(__dirname, '../views/scripts/config-page.ejs');
const operatorPath = path.join(__dirname, '../views/operator.ejs');
const configPage = fs.readFileSync(configPagePath, 'utf8');
const operator = fs.readFileSync(operatorPath, 'utf8');

test('config page persists the active tab in the URL', () => {
    assert.ok(
        configPage.includes("url.searchParams.set('tab', tabId)"),
        'switchTab should write the selected tab to the query string'
    );
    assert.ok(
        configPage.includes('history.replaceState({ tab: tabId }'),
        'switchTab should replace the current history entry instead of adding one per tab'
    );
});

test('config page restores the tab from the URL without rewriting a clean default URL', () => {
    assert.ok(
        configPage.includes('new URLSearchParams(window.location.search)'),
        'initConfigPage should read the query string'
    );
    assert.ok(
        configPage.includes("urlParams.get('tab')"),
        'initConfigPage should read the tab parameter'
    );
    assert.ok(
        configPage.includes('switchTab(defaultTab, { updateUrl: false })'),
        'the initial default tab should not force a tab query parameter into the URL'
    );
});

test('config page clears stale trunk highlight parameters when switching tabs', () => {
    assert.ok(configPage.includes("url.searchParams.delete('highlightTrunk')"), 'should clear highlightTrunk');
    assert.ok(configPage.includes("url.searchParams.delete('trunkId')"), 'should clear trunkId');
    assert.ok(configPage.includes("url.searchParams.delete('highlight')"), 'should clear highlight');
});

test('operator PBX Config link opens the Feature Codes tab', () => {
    assert.ok(operator.includes('href="/config?tab=callcodes"'), 'operator link should target the callcodes tab');
    assert.equal(operator.includes('subtab=callcodes'), false, 'operator link should not use the ignored subtab parameter');
});
