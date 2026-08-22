const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const configEjsPath = path.join(__dirname, '../views/config.ejs');

test('views/config.ejs exports all CRUD and modal functions to window for all PBX modules', () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    const expectedWindowExports = [
        // Extensions
        'window.openExtensionModal',
        'window.editExtension',
        'window.deleteExtension',
        'window.saveExtension',
        'window.fetchExtensions',

        // Ring Groups
        'window.openRingGroupModal',
        'window.editRingGroup',
        'window.deleteRingGroup',
        'window.saveRingGroup',
        'window.fetchRingGroups',

        // Queues
        'window.openQueueModal',
        'window.editQueue',
        'window.deleteQueue',
        'window.saveQueue',
        'window.fetchQueues',

        // IVRs
        'window.openIvrModal',
        'window.editIvr',
        'window.deleteIvr',
        'window.saveIvr',
        'window.fetchIvrs',
        'window.addIvrEntryRow',

        // Trunks
        'window.openTrunkModal',
        'window.editTrunkByIndex',
        'window.editTrunk',
        'window.deleteTrunk',
        'window.saveTrunk',
        'window.fetchTrunks',

        // Inbound Routes
        'window.openInboundModal',
        'window.editInboundRouteByIndex',
        'window.editInboundRoute',
        'window.deleteInboundRouteByIndex',
        'window.deleteInboundRoute',
        'window.saveInboundRoute',
        'window.fetchInboundRoutes',

        // Outbound Routes
        'window.openOutboundModal',
        'window.editOutboundRouteByIndex',
        'window.editOutboundRoute',
        'window.deleteOutboundRoute',
        'window.saveOutboundRoute',
        'window.fetchOutboundRoutes',

        // Time Groups
        'window.openTimeGroupModal',
        'window.editTimeGroup',
        'window.deleteTimeGroup',
        'window.saveTimeGroup',
        'window.fetchTimeGroups',

        // Time Conditions
        'window.openTimeConditionModal',
        'window.editTimeCondition',
        'window.deleteTimeCondition',
        'window.saveTimeCondition',
        'window.fetchTimeConditions',

        // Announcements
        'window.openAnnouncementModal',
        'window.editAnnouncement',
        'window.deleteAnnouncement',
        'window.saveAnnouncement',
        'window.fetchAnnouncements',

        // Music on Hold
        'window.openMohCategoryModal',
        'window.saveMohCategory',
        'window.deleteMohCategory',
        'window.uploadMohAudio',
        'window.deleteMohFile',
        'window.fetchMohData',

        // System Recordings
        'window.uploadSystemRecording',
        'window.deleteRecording',
        'window.togglePlayRecording',
        'window.fetchRecordings',

        // GSM Dongles & Modem Config
        'window.openAddDongleSlotModal',
        'window.openRemoveDongleSlotModal',
        'window.editDongleTabDid',
        'window.reconcileDonglesNow',
        'window.fetchModemConfig'
    ];

    for (const exp of expectedWindowExports) {
        assert.ok(content.includes(exp), `Expected ${exp} to be attached to window in views/config.ejs`);
    }
});

test('views/config.ejs modal opener functions do not block on await before openModal', () => {
    const content = fs.readFileSync(configEjsPath, 'utf8');

    const modalOpeners = [
        'openExtensionModal',
        'openRingGroupModal',
        'openQueueModal',
        'openIvrModal',
        'openTrunkModal',
        'openInboundModal',
        'openOutboundModal',
        'openTimeGroupModal',
        'openTimeConditionModal',
        'openAnnouncementModal',
        'openMohCategoryModal',
        'openAddDongleSlotModal',
        'openRemoveDongleSlotModal'
    ];

    for (const fn of modalOpeners) {
        const fnIndex = content.indexOf(`function ${fn}(`);
        assert.ok(fnIndex !== -1, `Function ${fn} must exist in views/config.ejs`);
        const fnSnippet = content.substring(fnIndex, fnIndex + 3000);
        assert.ok(fnSnippet.includes('openModal('), `${fn} must invoke openModal`);
        assert.ok(!fnSnippet.includes('await ensureAllConfigListsLoaded()'), `${fn} must not block on await ensureAllConfigListsLoaded()`);
    }
});

test('views/config.ejs renders all PBX modals and forms with correct IDs', async () => {
    const html = await ejs.renderFile(configEjsPath, {
        currentPage: '/config',
        currentLang: 'en',
        isRtl: false,
        isSuperAdmin: true,
        isRoot: true,
        user: { username: 'admin', isRoot: true },
        currentUser: { username: 'admin', isRoot: true },
        allowedTabs: ['extensions', 'ringgroups', 'inbound', 'trunks', 'outbound', 'queues', 'timegroups', 'timeconditions', 'voicemail', 'ivr', 'recordings', 'diagram', 'announcements', 'modem', 'dongles', 'terminal'],
        isTabAllowed: (t) => true
    });

    const expectedModals = [
        'id="extensionModal"',
        'id="ringGroupModal"',
        'id="queueModal"',
        'id="ivrModal"',
        'id="trunkModal"',
        'id="inboundModal"',
        'id="outboundModal"',
        'id="timeGroupModal"',
        'id="timeConditionModal"',
        'id="announcementModal"',
        'id="mohCategoryModal"',
        'id="addDongleSlotModal"',
        'id="removeDongleSlotModal"'
    ];

    for (const m of expectedModals) {
        assert.ok(html.includes(m), `Rendered HTML must include modal container ${m}`);
    }

    const expectedForms = [
        'id="extensionForm"',
        'id="ringGroupForm"',
        'id="queueForm"',
        'id="ivrForm"',
        'id="trunkForm"',
        'id="inboundForm"',
        'id="outboundForm"',
        'id="timeGroupForm"',
        'id="timeConditionForm"',
        'id="announcementForm"',
        'id="mohUploadForm"',
        'id="systemRecordingUploadForm"'
    ];

    for (const f of expectedForms) {
        assert.ok(html.includes(f), `Rendered HTML must include form element ${f}`);
    }
});
