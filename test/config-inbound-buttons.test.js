const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const configEjsPath = path.join(__dirname, '../views/config.ejs');

test('views/config.ejs defines non-blocking openInboundModal and editInboundRoute handlers with window bindings', () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    // Ensure openInboundModal and editInboundRoute exist
    assert.ok(content.includes('function openInboundModal('), 'Should define openInboundModal');
    assert.ok(content.includes('function editInboundRoute('), 'Should define editInboundRoute');
    assert.ok(content.includes('function editInboundRouteByIndex('), 'Should define editInboundRouteByIndex');

    // Ensure window attachments exist
    assert.ok(content.includes('window.openInboundModal = openInboundModal;'), 'Should attach openInboundModal to window');
    assert.ok(content.includes('window.editInboundRouteByIndex = editInboundRouteByIndex;'), 'Should attach editInboundRouteByIndex to window');
    assert.ok(content.includes('window.editInboundRoute = editInboundRoute;'), 'Should attach editInboundRoute to window');
    assert.ok(content.includes('window.saveInboundRoute = saveInboundRoute;'), 'Should attach saveInboundRoute to window');
    assert.ok(content.includes('window.deleteInboundRoute = deleteInboundRoute;'), 'Should attach deleteInboundRoute to window');

    // Ensure modal open is called immediately in openInboundModal and editInboundRoute
    const openInboundSnippet = content.substring(content.indexOf('function openInboundModal('), content.indexOf('function editInboundRoute('));
    assert.ok(openInboundSnippet.includes("openModal('inboundModal')"), 'openInboundModal must call openModal');
    assert.ok(!openInboundSnippet.includes('await ensureAllConfigListsLoaded()'), 'openInboundModal should not block on await ensureAllConfigListsLoaded');

    const editInboundSnippet = content.substring(content.indexOf('function editInboundRoute('), content.indexOf('function saveInboundRoute('));
    assert.ok(editInboundSnippet.includes("openModal('inboundModal')"), 'editInboundRoute must call openModal');
    assert.ok(!editInboundSnippet.includes('await ensureAllConfigListsLoaded()'), 'editInboundRoute should not block on await ensureAllConfigListsLoaded');
});

test('views/config.ejs renders inboundModal form with all required fields', async () => {
    const html = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        isSuperAdmin: true,
        isRoot: true,
        user: { username: 'admin', isRoot: true },
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['inbound'],
        isTabAllowed: (t) => true
    });

    assert.ok(html.includes('id="inboundModal"'), 'HTML must contain inboundModal container');
    assert.ok(html.includes('id="inboundForm"'), 'HTML must contain inboundForm form element');
    assert.ok(html.includes('id="inDescription"'), 'HTML must contain inDescription input');
    assert.ok(html.includes('id="inExtension"'), 'HTML must contain inExtension input');
    assert.ok(html.includes('id="inDestination"'), 'HTML must contain inDestination input');
    assert.ok(html.includes('id="inDestComponentContainer"'), 'HTML must contain inDestComponentContainer');
    assert.ok(html.includes('onclick="openInboundModal()"'), 'HTML must contain Add Inbound Route button with onclick handler');
});

test('views/config.ejs ensures DestinationSelect updates dialplan on category change and inbound modal triggers list loading', () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    // DestinationSelect updates dialplanString when switching categories
    assert.ok(content.includes('this.dialplanString = category.targets[0].dialplanString;'), 'DestinationSelect category change must update dialplanString to first target');

    // openInboundModal and editInboundRoute trigger ensureAllConfigListsLoaded
    const openInboundSnippet = content.substring(content.indexOf('function openInboundModal('), content.indexOf('function editInboundRoute('));
    assert.ok(openInboundSnippet.includes('ensureAllConfigListsLoaded()'), 'openInboundModal must trigger ensureAllConfigListsLoaded');

    const editInboundSnippet = content.substring(content.indexOf('function editInboundRoute('), content.indexOf('function saveInboundRoute('));
    assert.ok(editInboundSnippet.includes('ensureAllConfigListsLoaded()'), 'editInboundRoute must trigger ensureAllConfigListsLoaded');

    // closeAllModals hides inboundDongleInfoPopup
    const closeAllModalsSnippet = content.substring(content.indexOf('function closeAllModals('), content.indexOf('function switchTab('));
    assert.ok(closeAllModalsSnippet.includes('inboundDongleInfoPopup'), 'closeAllModals must hide inboundDongleInfoPopup');
});

test('from-dongle-custom routes both specific DIDs and blank catch-all inbound routes to from-trunk', () => {
    const customDialplan = fs.readFileSync('/etc/asterisk/extensions_custom.conf', 'utf8');
    const installerDialplan = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');

    for (const [name, content] of [['extensions_custom.conf', customDialplan], ['install.sh', installerDialplan]]) {
        assert.ok(content.includes('[from-dongle-custom]'), `${name} must define [from-dongle-custom]`);
        assert.ok(content.includes('Goto(from-trunk,${MY_SIM_NUMBER},1)'), `${name} must forward specific DIDs to from-trunk`);
        assert.ok(content.includes('Goto(from-trunk,s,1)'), `${name} must forward blank/catch-all calls to from-trunk,s,1`);
        assert.equal(content.includes('DIALPLAN_EXISTS(from-trunk,${MY_SIM_NUMBER},1)'), false, `${name} must not gate dongle routing on literal DIALPLAN_EXISTS matching`);
    }
});
