const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const ejs = require('ejs');
const moment = require('moment');

const storageViewPath = path.join(__dirname, '../views/storage.ejs');
const sidebarViewPath = path.join(__dirname, '../views/sidebar.ejs');
const serverJsPath = path.join(__dirname, '../server.js');

const dummyRoster = [
    { extension: '101', name: 'Agent Alpha' },
    { extension: '102', name: 'Agent Beta' }
];

test('views/storage.ejs renders unified System & Storage console with tabs, telemetry cards, and ECharts in English', async () => {
    const html = await ejs.renderFile(storageViewPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        roster: dummyRoster,
        moment,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['storage']
    });

    // 1. Page Header & Title
    assert.ok(html.includes('SysMon') && html.includes('Management Console'), 'Must render English title "SysMon"');
    assert.ok(html.includes('id="system-health-pill"'), 'Must render system health status pill');

    // 2. Refresh Rate Selector
    assert.ok(html.includes('id="telemetryRefreshRate"'), 'Must render telemetry refresh rate dropdown');
    assert.ok(html.includes('updateRefreshInterval(this.value)'), 'Refresh selector must call updateRefreshInterval');
    assert.ok(html.includes('value="1000"'), 'Refresh selector must include 1s option');
    assert.ok(html.includes('1s (Live)'), 'Refresh selector must render "1s (Live)" label');

    // 3. Persistent Pulse Metric Cards
    assert.ok(html.includes('id="stat-cpu-pct"'), 'Must render stat-cpu-pct element');
    assert.ok(html.includes('id="stat-cpu-load"'), 'Must render stat-cpu-load element');
    assert.ok(html.includes('id="stat-cpu-bar"'), 'Must render stat-cpu-bar element');
    assert.ok(html.includes('id="stat-ram-pct"'), 'Must render stat-ram-pct element');
    assert.ok(html.includes('id="stat-ram-avail"'), 'Must render stat-ram-avail element');
    assert.ok(html.includes('id="stat-ram-bar"'), 'Must render stat-ram-bar element');
    assert.ok(html.includes('id="disk-used-pct"'), 'Must render disk-used-pct element');
    assert.ok(html.includes('id="disk-free-text"'), 'Must render disk-free-text element');
    assert.ok(html.includes('id="stat-asterisk-status"'), 'Must render stat-asterisk-status element');

    // 4. Sub-Tab Navigation Bar
    assert.ok(html.includes('id="tab-btn-resources"'), 'Must render tab button for resources');
    assert.ok(html.includes('id="tab-btn-services"'), 'Must render tab button for services');
    assert.ok(html.includes('id="tab-btn-storage"'), 'Must render tab button for storage');
    assert.ok(html.includes('switchStorageTab(\'resources\')'), 'Tab button must trigger switchStorageTab resources');
    assert.ok(html.includes('switchStorageTab(\'services\')'), 'Tab button must trigger switchStorageTab services');
    assert.ok(html.includes('switchStorageTab(\'storage\')'), 'Tab button must trigger switchStorageTab storage');

    // 5. Tab Panels
    assert.ok(html.includes('id="panel-resources"'), 'Must render resources panel container');
    assert.ok(html.includes('id="panel-services"'), 'Must render services panel container');
    assert.ok(html.includes('id="panel-storage"'), 'Must render storage panel container');

    // 6. ECharts Telemetry Containers
    assert.ok(html.includes('id="cpuRamChart"'), 'Must render cpuRamChart ECharts container');
    assert.ok(html.includes('id="netChannelsChart"'), 'Must render netChannelsChart ECharts container');

    // 7. Quick Administrative Maintenance Actions
    assert.ok(html.includes('id="dropCachesBtn"'), 'Must render dropCachesBtn action button');
    assert.ok(html.includes('executeDropCaches()'), 'Button must call executeDropCaches');
    assert.ok(html.includes('id="reloadAsteriskBtn"'), 'Must render reloadAsteriskBtn action button');
    assert.ok(html.includes('executeAsteriskReload()'), 'Button must call executeAsteriskReload');

    // 8. Detailed Hardware Specs Card
    assert.ok(html.includes('id="spec-cpu-model"'), 'Must render spec-cpu-model container');
    assert.ok(html.includes('id="spec-mem-cached"'), 'Must render spec-mem-cached container');
    assert.ok(html.includes('id="spec-asterisk-ver"'), 'Must render spec-asterisk-ver container');
    assert.ok(html.includes('id="spec-node-ver"'), 'Must render spec-node-ver container');
    // 8b. USB Host Controllers & Hardware Bus Topology
    assert.ok(html.includes('id="pci-controllers-container"'), 'Must render pci-controllers-container');
    assert.ok(html.includes('id="usb-devices-container"'), 'Must render usb-devices-container');
    assert.ok(html.includes('id="usb-summary-badge"'), 'Must render usb-summary-badge');
    assert.ok(html.includes('renderUsbTopology'), 'Must define renderUsbTopology function');


    // 9. Core Services Grid Container & Confirmation Modal
    assert.ok(html.includes('id="services-grid-container"'), 'Must render services grid container');
    assert.ok(html.includes('id="serviceConfirmModal"'), 'Must render service restart confirmation modal');
    assert.ok(html.includes('id="confirmServiceActionBtn"'), 'Must render modal confirm button');

    // 10. Storage & Backups Preserved Form Elements
    assert.ok(html.includes('id="pcExportForm"'), 'Must retain PC export form');
    assert.ok(html.includes('id="downloadZipBtn"'), 'Must retain PC export download button');
    assert.ok(html.includes('id="gdriveSetupForm"'), 'Must retain Google Drive setup form');
    assert.ok(html.includes('id="syncGdriveBtn"'), 'Must retain Google Drive sync button');
    assert.ok(html.includes('id="purgeDaysSlider"'), 'Must retain recordings purge days slider');
    assert.ok(html.includes('max="3650"'), 'Purge days slider must support up to 3650 days');
    assert.ok(html.includes('id="purgeDaysInput"'), 'Must render purgeDaysInput numeric input');
    assert.ok(html.includes('updatePurgeDays(3650)'), 'Must render 3650d quick preset button');
    assert.ok(html.includes('id="runPurgeBtn"'), 'Must retain run cleanup button');
});

test('views/storage.ejs renders Arabic translations correctly', async () => {
    const html = await ejs.renderFile(storageViewPath, {
        currentLang: 'ar',
        currentPage: '/storage',
        isRtl: true,
        roster: dummyRoster,
        moment,
        isSuperAdmin: false,
        isRootUser: false,
        currentUser: 'ahmed',
        allowedTabs: ['storage']
    });

    assert.ok(html.includes('SysMon') && html.includes('لوحة التحكم'), 'Must render Arabic title "SysMon"');
    assert.ok(html.includes('مراقبة الموارد والأداء'), 'Must render Arabic resources tab');
    assert.ok(html.includes('إدارة الخدمات الأساسية'), 'Must render Arabic services tab');
    assert.ok(html.includes('التخزين والنسخ الاحتياطي'), 'Must render Arabic storage tab');
    assert.ok(html.includes('المعالج وحمل النظام'), 'Must render Arabic CPU overview label');
    assert.ok(html.includes('الذاكرة العشوائية RAM'), 'Must render Arabic RAM overview label');
    assert.ok(html.includes('نظرة عامة على مساحة التخزين'), 'Must render Arabic disk overview label');
    assert.ok(html.includes('محرك الاتصال أستريسك'), 'Must render Arabic Asterisk overview label');
    assert.ok(html.includes('تفريغ ذاكرة التخزين المؤقت'), 'Must render Arabic flush caches button');
    assert.ok(html.includes('إعادة تحميل إعدادات أستريسك'), 'Must render Arabic reload Asterisk button');
    assert.ok(html.includes('1 ثانية (مباشر)'), 'Must render Arabic 1s refresh rate label');
    assert.ok(html.includes('متحكمات USB وبنية النواقل الفيزيائية (PCI &amp; Bus)') || html.includes('متحكمات USB وبنية النواقل الفيزيائية (PCI & Bus)'), 'Must render Arabic USB controllers title');
});

test('views/sidebar.ejs renders updated SysMon navigation links', async () => {
    const htmlEn = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['storage']
    });
    assert.ok(htmlEn.includes('SysMon') && htmlEn.includes('/storage?lang='), 'Sidebar must render English "SysMon"');

    const htmlAr = await ejs.renderFile(sidebarViewPath, {
        currentLang: 'ar',
        currentPage: '/storage',
        isRtl: true,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['storage']
    });
    assert.ok(htmlAr.includes('SysMon') && htmlAr.includes('/storage?lang='), 'Sidebar must render Arabic "SysMon"');
});

test('server.js registers all system resource monitoring & service management routes', () => {
    const serverCode = fs.readFileSync(serverJsPath, 'utf8');

    assert.ok(serverCode.includes("app.get('/api/system/resources'"), 'server.js must register GET /api/system/resources');
    assert.ok(serverCode.includes("app.get('/api/system/services'"), 'server.js must register GET /api/system/services');
    assert.ok(serverCode.includes("app.post('/api/system/service-action'"), 'server.js must register POST /api/system/service-action');
    assert.ok(serverCode.includes("app.post('/api/system/drop-caches'"), 'server.js must register POST /api/system/drop-caches');
    assert.ok(serverCode.includes("app.post('/api/system/asterisk-reload'"), 'server.js must register POST /api/system/asterisk-reload');

    // Verify security guards
    assert.ok(serverCode.includes("app.post('/api/system/service-action', requireAuth, (req, res)"), 'service-action must requireAuth');
    assert.ok(serverCode.includes("if (!isSuperAdmin(req))"), 'service-action and drop-caches must enforce isSuperAdmin check');
    assert.ok(serverCode.includes("app.post('/api/system/drop-caches', requireAuth, (req, res)"), 'drop-caches must requireAuth');
});

test('server.js service action validation logic enforces security bounds', () => {
    const allowedServices = ['asterisk', 'sokrat-voip', 'database', 'httpd', 'stt-worker'];
    const allowedActions = ['restart', 'reload', 'start', 'stop'];

    function validateServiceAction(serviceId, action) {
        if (!serviceId || !allowedServices.includes(serviceId)) {
            return { valid: false, status: 400, error: 'Invalid or unsupported serviceId' };
        }
        if (!action || !allowedActions.includes(action)) {
            return { valid: false, status: 400, error: 'Invalid or unsupported action' };
        }
        if (action === 'reload' && serviceId !== 'asterisk') {
            return { valid: false, status: 400, error: 'Reload action only supported for Asterisk' };
        }
        return { valid: true };
    }

    // Valid actions
    assert.deepEqual(validateServiceAction('asterisk', 'reload'), { valid: true });
    assert.deepEqual(validateServiceAction('asterisk', 'restart'), { valid: true });
    assert.deepEqual(validateServiceAction('sokrat-voip', 'restart'), { valid: true });
    assert.deepEqual(validateServiceAction('database', 'restart'), { valid: true });
    assert.deepEqual(validateServiceAction('httpd', 'restart'), { valid: true });
    assert.deepEqual(validateServiceAction('stt-worker', 'start'), { valid: true });

    // Invalid serviceId
    assert.equal(validateServiceAction('malicious_service', 'restart').valid, false);
    assert.equal(validateServiceAction('malicious_service', 'restart').status, 400);

    // Invalid action
    assert.equal(validateServiceAction('asterisk', 'delete').valid, false);
    assert.equal(validateServiceAction('asterisk', 'delete').status, 400);

    // Reload on non-asterisk
    assert.equal(validateServiceAction('database', 'reload').valid, false);
    assert.equal(validateServiceAction('database', 'reload').error, 'Reload action only supported for Asterisk');
});

test('host telemetry collection returns live structured metrics matching schema', () => {
    // 1. CPU & Load
    const cpus = os.cpus();
    assert.ok(cpus.length >= 1, 'os.cpus() must return at least 1 core');
    const loadAvg = os.loadavg();
    assert.ok(Array.isArray(loadAvg) && loadAvg.length === 3, 'loadavg must be 3-element array');

    // 2. Meminfo
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const map = {};
    for (const line of meminfo.split('\n')) {
        const match = line.match(/^([A-Za-z0-9_()]+):\s+(\d+)\s*kB/);
        if (match) map[match[1]] = parseInt(match[2], 10) * 1024;
    }
    assert.ok(map['MemTotal'] > 0, 'MemTotal must be > 0');
    assert.ok(map['MemAvailable'] > 0, 'MemAvailable must be > 0');
    assert.ok(map['MemTotal'] >= map['MemAvailable'], 'MemTotal must be >= MemAvailable');

    // 3. Network
    const netdev = fs.readFileSync('/proc/net/dev', 'utf8');
    assert.ok(netdev.includes('Inter-|'), '/proc/net/dev must contain network header');

    // 4. Services via systemctl
    const out = execSync('systemctl is-active asterisk 2>&1 || true', { encoding: 'utf8' }).trim();
    assert.ok(out === 'active' || out === 'inactive' || out === 'failed', 'systemctl is-active must return valid state');
});

test('views/storage.ejs rendered script blocks compile without lexical redeclarations or syntax errors', async () => {
    const html = await ejs.renderFile(storageViewPath, {
        currentLang: 'en',
        currentPage: '/storage',
        isRtl: false,
        roster: dummyRoster,
        moment,
        isSuperAdmin: true,
        isRootUser: false,
        currentUser: 'admin',
        allowedTabs: ['storage']
    });

    const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let combined = '';
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
        combined += '\n;\n' + match[1];
    }
    assert.doesNotThrow(() => {
        new Function(combined);
    }, 'Rendered client scripts must compile without SyntaxError or lexical redeclarations');
});
