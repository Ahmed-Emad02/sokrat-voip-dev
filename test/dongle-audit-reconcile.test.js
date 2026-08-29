const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Replicate audit comparison engine logic for deterministic unit testing
function compareConfVsLive(confDongles, liveDevices) {
    const liveMap = new Map();
    for (const dev of liveDevices) {
        if (dev.ID) {
            liveMap.set(String(dev.ID).toLowerCase(), dev);
        }
    }

    const slots = [];
    let syncedCount = 0;
    let issuesCount = 0;
    let unpinnedCount = 0;
    let disconnectedCount = 0;

    for (const slotId in confDongles) {
        const conf = confDongles[slotId];
        const live = liveMap.get(slotId.toLowerCase()) || null;

        const slotReport = {
            slotId,
            config: {
                audio: conf.audio || '',
                data: conf.data || '',
                imei: conf.imei || '',
                imsi: conf.imsi || ''
            },
            live: live ? {
                state: live.State || 'Unknown',
                imei: live.IMEI && live.IMEI !== '-' && live.IMEI !== 'Unknown' ? live.IMEI : '',
                imsi: live.IMSI && live.IMSI !== '-' && live.IMSI !== 'Unknown' ? live.IMSI : ''
            } : null,
            status: 'unknown',
            issues: [],
            actionNeeded: false
        };

        const isLiveConnected = live && !['not connected', 'not initialized', 'unknown'].includes(String(live.State || '').toLowerCase());

        if (!live || !isLiveConnected) {
            slotReport.status = 'disconnected';
            slotReport.issues.push({
                type: 'disconnected',
                severity: 'warning',
                message: 'No active hardware responding on configured ports'
            });
            disconnectedCount++;
        } else {
            const confImei = slotReport.config.imei;
            const confImsi = slotReport.config.imsi;
            const liveImei = slotReport.live.imei;
            const liveImsi = slotReport.live.imsi;

            let hasMismatch = false;

            if (confImei && liveImei && confImei !== liveImei) {
                slotReport.issues.push({
                    type: 'imei_mismatch',
                    severity: 'critical',
                    message: `Configured IMEI (${confImei}) does not match live hardware IMEI (${liveImei})`
                });
                hasMismatch = true;
            }

            if (confImsi && liveImsi && confImsi !== liveImsi) {
                slotReport.issues.push({
                    type: 'imsi_mismatch',
                    severity: 'warning',
                    message: `Configured IMSI (${confImsi}) does not match live SIM IMSI (${liveImsi})`
                });
                hasMismatch = true;
            }

            if (!confImei && liveImei) {
                slotReport.issues.push({
                    type: 'missing_imei',
                    severity: 'info',
                    message: `Live IMEI (${liveImei}) detected but not populated in dongle.conf`
                });
                slotReport.actionNeeded = true;
            }

            if (!confImsi && liveImsi) {
                slotReport.issues.push({
                    type: 'missing_imsi',
                    severity: 'info',
                    message: `Live IMSI (${liveImsi}) detected but not populated in dongle.conf`
                });
                slotReport.actionNeeded = true;
            }

            if (hasMismatch) {
                slotReport.status = 'mismatch';
                slotReport.actionNeeded = true;
                issuesCount++;
            } else if (!confImei && !confImsi) {
                slotReport.status = 'unpinned';
                unpinnedCount++;
            } else if (confImei === liveImei && (!confImsi || confImsi === liveImsi)) {
                slotReport.status = 'synced';
                syncedCount++;
            } else {
                slotReport.status = 'partial';
                issuesCount++;
            }
        }

        slots.push(slotReport);
    }

    return {
        summary: {
            totalSlots: slots.length,
            syncedCount,
            issuesCount,
            unpinnedCount,
            disconnectedCount,
            healthy: issuesCount === 0 && disconnectedCount === 0
        },
        slots
    };
}

test('compareConfVsLive accurately categorizes synchronized, missing IMEI, mismatch, and disconnected slots', () => {
    const confDongles = {
        'dongle0': { audio: '/dev/ttyUSB1', data: '/dev/ttyUSB2', imei: '', imsi: '' },
        'dongle1': { audio: '/dev/ttyUSB4', data: '/dev/ttyUSB5', imei: '868402004375084', imsi: '602019529273999' },
        'dongle2': { audio: '/dev/ttyUSB7', data: '/dev/ttyUSB8', imei: '111111111111111', imsi: '222222222222222' },
        'dongle3': { audio: '/dev/ttyUSB10', data: '/dev/ttyUSB11', imei: '', imsi: '' }
    };

    const liveDevices = [
        { ID: 'dongle0', State: 'Free', IMEI: '868402004375084', IMSI: '602019529273999' },
        { ID: 'dongle1', State: 'Free', IMEI: '868402004375084', IMSI: '602019529273999' },
        { ID: 'dongle2', State: 'Free', IMEI: '999999999999999', IMSI: '888888888888888' },
        { ID: 'dongle3', State: 'Not Connected', IMEI: '-', IMSI: '-' }
    ];

    const audit = compareConfVsLive(confDongles, liveDevices);

    assert.equal(audit.summary.totalSlots, 4);
    assert.equal(audit.summary.syncedCount, 1);
    assert.equal(audit.summary.issuesCount, 1);
    assert.equal(audit.summary.unpinnedCount, 1);
    assert.equal(audit.summary.disconnectedCount, 1);

    // dongle0: unpinned + missing_imei / missing_imsi actionNeeded
    const d0 = audit.slots.find(s => s.slotId === 'dongle0');
    assert.equal(d0.status, 'unpinned');
    assert.equal(d0.actionNeeded, true);
    assert.ok(d0.issues.some(i => i.type === 'missing_imei'));
    assert.ok(d0.issues.some(i => i.type === 'missing_imsi'));

    // dongle1: fully synced
    const d1 = audit.slots.find(s => s.slotId === 'dongle1');
    assert.equal(d1.status, 'synced');
    assert.equal(d1.actionNeeded, false);

    // dongle2: imei_mismatch
    const d2 = audit.slots.find(s => s.slotId === 'dongle2');
    assert.equal(d2.status, 'mismatch');
    assert.equal(d2.actionNeeded, true);
    assert.ok(d2.issues.some(i => i.type === 'imei_mismatch'));

    // dongle3: disconnected
    const d3 = audit.slots.find(s => s.slotId === 'dongle3');
    assert.equal(d3.status, 'disconnected');
    assert.equal(d3.actionNeeded, false);
});

test('server.js defines auditDongleConfVsLive and exposes GET /api/gsm-dongles/audit and POST /api/gsm-dongles/reconcile-conf', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    assert.match(serverJs, /async function auditDongleConfVsLive\(\)/, 'server.js must define auditDongleConfVsLive');
    assert.match(serverJs, /app\.get\('\/api\/gsm-dongles\/audit'/, 'server.js must define GET /api/gsm-dongles/audit');
    assert.match(serverJs, /app\.post\('\/api\/gsm-dongles\/reconcile-conf'/, 'server.js must define POST /api/gsm-dongles/reconcile-conf');
    assert.match(serverJs, /updateDongleImeiImsiInConf/, 'reconcile-conf must invoke updateDongleImeiImsiInConf');
    assert.match(serverJs, /io\.emit\('usbDevicesUpdated'\)/, 'reconcile-conf must emit socket update event');
});

test('views/gsm-dongles.ejs includes global audit header button, audit modal, and reconciliation handlers', () => {
    const viewContent = fs.readFileSync(path.join(__dirname, '../views/gsm-dongles.ejs'), 'utf8');

    // Header audit button
    assert.match(viewContent, /id="global-audit-btn"/, 'View must render global-audit-btn');
    assert.match(viewContent, /onclick="openDongleAuditModal\(\)"/, 'global-audit-btn must open audit modal');

    // Audit modal structure
    assert.match(viewContent, /id="dongle-audit-modal"/, 'View must contain dongle-audit-modal');
    assert.match(viewContent, /id="audit-kpi-total"/, 'Modal must have total slots KPI');
    assert.match(viewContent, /id="audit-kpi-synced"/, 'Modal must have synced KPI');
    assert.match(viewContent, /id="audit-kpi-issues"/, 'Modal must have issues KPI');
    assert.match(viewContent, /id="audit-kpi-disconnected"/, 'Modal must have disconnected KPI');
    assert.match(viewContent, /id="audit-action-banner"/, 'Modal must have reconcile action banner');
    assert.match(viewContent, /id="audit-reconcile-all-btn"/, 'Modal must have reconcile-all button');
    assert.match(viewContent, /id="audit-slots-table-body"/, 'Modal must have slots table body');

    // Client handlers
    assert.match(viewContent, /window\.openDongleAuditModal = function/, 'View must define openDongleAuditModal');
    assert.match(viewContent, /window\.closeDongleAuditModal = function/, 'View must define closeDongleAuditModal');
    assert.match(viewContent, /window\.runDongleAudit = function/, 'View must define runDongleAudit');
    assert.match(viewContent, /window\.reconcileSlot = function/, 'View must define reconcileSlot');
    assert.match(viewContent, /window\.reconcileAllDongles = function/, 'View must define reconcileAllDongles');

    // Translations
    assert.match(viewContent, /btnAuditHardware/, 'View must define btnAuditHardware translation key');
    assert.match(viewContent, /auditModalTitle/, 'View must define auditModalTitle translation key');
    assert.match(viewContent, /auditReconcileAllBtn/, 'View must define auditReconcileAllBtn translation key');
});
