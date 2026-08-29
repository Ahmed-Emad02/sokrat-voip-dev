const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Replicate updateDongleImeiImsiInConf logic for pure deterministic unit testing
function updateDongleImeiImsiInContent(content, dongleName, imei, imsi) {
    const dName = String(dongleName || '').trim().toLowerCase();
    if (!dName) throw new Error('Dongle name is required.');

    const cleanImei = String(imei || '').trim();
    const cleanImsi = String(imsi || '').trim();

    let lines = content.split(/\r?\n/);
    let sectionHeaderLineIdx = {};

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        let secMatch = line.match(/^\[([^\]]+)\]/);
        if (secMatch) {
            sectionHeaderLineIdx[secMatch[1].trim().toLowerCase()] = i;
        }
    }

    if (!sectionHeaderLineIdx.hasOwnProperty(dName)) {
        throw new Error(`Section [${dName}] not found in dongle.conf`);
    }

    const headerIdx = sectionHeaderLineIdx[dName];
    let endIdx = lines.length;
    for (let j = headerIdx + 1; j < lines.length; j++) {
        if (lines[j].trim().match(/^\[([^\]]+)\]/)) {
            endIdx = j;
            break;
        }
    }

    let imeiFound = false;
    let imsiFound = false;

    for (let j = headerIdx + 1; j < endIdx; j++) {
        let lineTrim = lines[j].trim();
        if (lineTrim.startsWith('imei=') || lineTrim.startsWith('imei =')) {
            lines[j] = `imei=${cleanImei}`;
            imeiFound = true;
        } else if (lineTrim.startsWith('imsi=') || lineTrim.startsWith('imsi =')) {
            lines[j] = `imsi=${cleanImsi}`;
            imsiFound = true;
        }
    }

    if (!imeiFound) {
        lines.splice(endIdx, 0, `imei=${cleanImei}`);
        endIdx++;
    }
    if (!imsiFound) {
        lines.splice(endIdx, 0, `imsi=${cleanImsi}`);
        endIdx++;
    }

    return lines.join('\n');
}

function updateDonglePortsInContent(content, dongleName, audioPort, dataPort) {
    const dName = String(dongleName || '').trim().toLowerCase();
    if (!dName) throw new Error('Dongle name is required.');

    let cleanAudio = String(audioPort || '').trim();
    let cleanData = String(dataPort || '').trim();

    if (!cleanAudio.startsWith('/dev/')) cleanAudio = '/dev/' + cleanAudio;
    if (!cleanData.startsWith('/dev/')) cleanData = '/dev/' + cleanData;

    if (!/^\/dev\/ttyUSB\d+$/i.test(cleanAudio)) {
        throw new Error(`Invalid audio TTY port: "${cleanAudio}". Must be in format /dev/ttyUSBX.`);
    }
    if (!/^\/dev\/ttyUSB\d+$/i.test(cleanData)) {
        throw new Error(`Invalid data TTY port: "${cleanData}". Must be in format /dev/ttyUSBX.`);
    }
    if (cleanAudio.toLowerCase() === cleanData.toLowerCase()) {
        throw new Error('Audio port and Data port cannot be the same ttyUSB device.');
    }

    let lines = content.split(/\r?\n/);
    let sectionHeaderLineIdx = {};

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        let secMatch = line.match(/^\[([^\]]+)\]/);
        if (secMatch) {
            sectionHeaderLineIdx[secMatch[1].trim().toLowerCase()] = i;
        }
    }

    if (!sectionHeaderLineIdx.hasOwnProperty(dName)) {
        throw new Error(`Section [${dName}] not found in dongle.conf`);
    }

    const headerIdx = sectionHeaderLineIdx[dName];
    let endIdx = lines.length;
    for (let j = headerIdx + 1; j < lines.length; j++) {
        if (lines[j].trim().match(/^\[([^\]]+)\]/)) {
            endIdx = j;
            break;
        }
    }

    let audioFound = false;
    let dataFound = false;

    for (let j = headerIdx + 1; j < endIdx; j++) {
        let lineTrim = lines[j].trim();
        if (lineTrim.startsWith('audio=') || lineTrim.startsWith('audio =')) {
            lines[j] = `audio=${cleanAudio}`;
            audioFound = true;
        } else if (lineTrim.startsWith('data=') || lineTrim.startsWith('data =')) {
            lines[j] = `data=${cleanData}`;
            dataFound = true;
        }
    }

    if (!audioFound) {
        lines.splice(endIdx, 0, `audio=${cleanAudio}`);
        endIdx++;
    }
    if (!dataFound) {
        lines.splice(endIdx, 0, `data=${cleanData}`);
        endIdx++;
    }

    return lines.join('\n');
}


test('updateDongleImeiImsi populates empty imei/imsi fields in targeted section while preserving all other sections and comments', () => {
    const sampleConf = `[general]
interval = 15

[defaults]
context=from-dongle-custom
rxgain=3
txgain=3

[dongle0]
txgain=3
rxgain=3
audio=/dev/ttyUSB1
data=/dev/ttyUSB2
imei=
imsi=

[dongle1]
txgain=3
rxgain=3
audio=/dev/ttyUSB4
data=/dev/ttyUSB5
imei=111111111111111
imsi=222222222222222
`;

    const updated = updateDongleImeiImsiInContent(sampleConf, 'dongle0', '868402004375084', '602019529273999');

    // Section dongle0 has updated values
    assert.match(updated, /\[dongle0\][\s\S]*?imei=868402004375084/);
    assert.match(updated, /\[dongle0\][\s\S]*?imsi=602019529273999/);
    assert.match(updated, /\[dongle0\][\s\S]*?audio=\/dev\/ttyUSB1/);
    assert.match(updated, /\[dongle0\][\s\S]*?txgain=3/);

    // Section dongle1 remains intact and unmodified
    assert.match(updated, /\[dongle1\][\s\S]*?imei=111111111111111/);
    assert.match(updated, /\[dongle1\][\s\S]*?imsi=222222222222222/);

    // General and defaults sections remain intact
    assert.match(updated, /\[general\][\s\S]*?interval = 15/);
    assert.match(updated, /\[defaults\][\s\S]*?context=from-dongle-custom/);
});

test('updateDongleImeiImsi inserts imei and imsi if they were omitted in the section', () => {
    const sampleConf = `[dongle2]
txgain=3
rxgain=3
audio=/dev/ttyUSB7
data=/dev/ttyUSB8
`;

    const updated = updateDongleImeiImsiInContent(sampleConf, 'dongle2', '358941002233445', '602029988776655');

    assert.match(updated, /\[dongle2\][\s\S]*?imei=358941002233445/);
    assert.match(updated, /\[dongle2\][\s\S]*?imsi=602029988776655/);
    assert.match(updated, /\[dongle2\][\s\S]*?audio=\/dev\/ttyUSB7/);
});

test('updateDongleImeiImsi throws an error if the targeted dongle section does not exist', () => {
    const sampleConf = `[dongle0]\naudio=/dev/ttyUSB1\n`;
    assert.throws(() => {
        updateDongleImeiImsiInContent(sampleConf, 'dongle99', '123', '456');
    }, /Section \[dongle99\] not found/);
});

test('server.js defines updateDongleImeiImsiInConf and exposes POST /api/gsm-dongles/populate-hardware/:dongleId', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    assert.match(serverJs, /function updateDongleImeiImsiInConf\(dongleName, imei, imsi\)/, 'server.js must define updateDongleImeiImsiInConf');
    assert.match(serverJs, /app\.post\('\/api\/gsm-dongles\/populate-hardware\/:dongleId'/, 'server.js must define populate-hardware route');
    assert.match(serverJs, /getUserAllowedDongles/, 'Route must enforce user allowed dongles permission check');
    assert.match(serverJs, /updateDongleImeiImsiInConf\(dongleId, imei, imsi\)/, 'Route must invoke updateDongleImeiImsiInConf');
    assert.match(serverJs, /io\.emit\('usbDevicesUpdated'\)/, 'Route must emit usbDevicesUpdated socket event');
});

test('views/gsm-dongles.ejs includes populate-hardware button in Card View only and defines client handler', () => {
    const viewContent = fs.readFileSync(path.join(__dirname, '../views/gsm-dongles.ejs'), 'utf8');

    // Button rendered in card view
    assert.match(viewContent, /data-dongle-action="populate-hardware"/, 'View must render populate-hardware action button');
    assert.match(viewContent, /id="populateBtn-\$\{escapeHtml\(id\)\}"/, 'View must set populateBtn ID');

    // Confirm it is only in the Card View section and not inside the minimal list view template
    const minimalViewBlockMatch = viewContent.match(/if \(currentViewMode === 'minimal'\) \{([\s\S]*?)\} else \{/);
    assert.ok(minimalViewBlockMatch, 'Minimal view branch must exist');
    assert.equal(minimalViewBlockMatch[1].includes('data-dongle-action="populate-hardware"'), false, 'Minimal view must NOT contain populate-hardware button');

    // Translations exist
    assert.match(viewContent, /btnPopulateHardware/, 'View must define btnPopulateHardware translation key');
    assert.match(viewContent, /legendPopulateDesc/, 'View must define legendPopulateDesc translation key');
    assert.match(viewContent, /populateHardwareConfirm/, 'View must define populateHardwareConfirm translation key');
    assert.match(viewContent, /populateHardwareSuccess/, 'View must define populateHardwareSuccess translation key');

    // Client handler defined
    assert.match(viewContent, /window\.populateDongleHardware = function/, 'View must define window.populateDongleHardware function');
    assert.match(viewContent, /fetch\('\/api\/gsm-dongles\/populate-hardware\/'/, 'populateDongleHardware must call /api/gsm-dongles/populate-hardware endpoint');
});

test('updateDonglePorts updates audio and data ports in targeted section while preserving other configurations', () => {
    const sampleConf = `[general]
interval = 15

[dongle0]
txgain=3
rxgain=3
audio=/dev/ttyUSB1
data=/dev/ttyUSB2
imei=868402004375084
imsi=602019529273999

[dongle1]
txgain=3
rxgain=3
audio=/dev/ttyUSB4
data=/dev/ttyUSB5
`;

    const updated = updateDonglePortsInContent(sampleConf, 'dongle0', '/dev/ttyUSB10', '/dev/ttyUSB11');

    assert.match(updated, /\[dongle0\][\s\S]*?audio=\/dev\/ttyUSB10/);
    assert.match(updated, /\[dongle0\][\s\S]*?data=\/dev\/ttyUSB11/);
    assert.match(updated, /\[dongle0\][\s\S]*?imei=868402004375084/);

    // Section dongle1 remains intact
    assert.match(updated, /\[dongle1\][\s\S]*?audio=\/dev\/ttyUSB4/);
    assert.match(updated, /\[dongle1\][\s\S]*?data=\/dev\/ttyUSB5/);
});

test('updateDonglePorts validates TTY device paths and rejects invalid or identical ports', () => {
    const sampleConf = `[dongle0]\naudio=/dev/ttyUSB1\ndata=/dev/ttyUSB2\n`;

    assert.throws(() => {
        updateDonglePortsInContent(sampleConf, 'dongle0', 'invalid_port', '/dev/ttyUSB2');
    }, /Invalid audio TTY port/);

    assert.throws(() => {
        updateDonglePortsInContent(sampleConf, 'dongle0', '/dev/ttyUSB1', '/dev/ttyUSB1');
    }, /cannot be the same ttyUSB device/);
});

test('server.js defines updateDonglePortsInConf and exposes POST /api/gsm-dongles/update-ports/:dongleId', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    assert.match(serverJs, /function updateDonglePortsInConf\(dongleName, audioPort, dataPort\)/, 'server.js must define updateDonglePortsInConf');
    assert.match(serverJs, /app\.post\('\/api\/gsm-dongles\/update-ports\/:dongleId'/, 'server.js must define update-ports route');
    assert.match(serverJs, /getUserAllowedDongles/, 'Route must enforce allowed dongles check');
    assert.match(serverJs, /updateDonglePortsInConf\(dongleId, audio, data\)/, 'Route must invoke updateDonglePortsInConf');
});

test('views/gsm-dongles.ejs includes edit-ports button in Card View only and defines edit-ports-modal and handlers', () => {
    const viewContent = fs.readFileSync(path.join(__dirname, '../views/gsm-dongles.ejs'), 'utf8');

    // Button rendered in card view
    assert.match(viewContent, /data-dongle-action="edit-ports"/, 'View must render edit-ports action button');
    assert.match(viewContent, /id="editPortsBtn-\$\{escapeHtml\(id\)\}"/, 'View must set editPortsBtn ID');

    // Confirm it is only in the Card View section and not inside the minimal list view template
    const minimalViewBlockMatch = viewContent.match(/if \(currentViewMode === 'minimal'\) \{([\s\S]*?)\} else \{/);
    assert.ok(minimalViewBlockMatch, 'Minimal view branch must exist');
    assert.equal(minimalViewBlockMatch[1].includes('data-dongle-action="edit-ports"'), false, 'Minimal view must NOT contain edit-ports button');

    // Modal rendered
    assert.match(viewContent, /id="edit-ports-modal"/, 'View must render edit-ports-modal');
    assert.match(viewContent, /id="edit-ports-audio"/, 'Modal must have audio port input');
    assert.match(viewContent, /id="edit-ports-data"/, 'Modal must have data port input');
    assert.match(viewContent, /id="detected-ports-chips"/, 'Modal must have detected ports chips container');

    // Translations exist
    assert.match(viewContent, /btnEditPorts/, 'View must define btnEditPorts translation key');
    assert.match(viewContent, /legendEditPortsDesc/, 'View must define legendEditPortsDesc translation key');
    assert.match(viewContent, /editPortsModalTitle/, 'View must define editPortsModalTitle translation key');
    assert.match(viewContent, /editPortsSuccess/, 'View must define editPortsSuccess translation key');

    // Handlers defined
    assert.match(viewContent, /window\.openEditPortsModal = function/, 'View must define openEditPortsModal function');
    assert.match(viewContent, /window\.closeEditPortsModal = function/, 'View must define closeEditPortsModal function');
    assert.match(viewContent, /window\.saveDonglePorts = function/, 'View must define saveDonglePorts function');
    assert.match(viewContent, /fetch\('\/api\/gsm-dongles\/update-ports\/'/, 'saveDonglePorts must call /api/gsm-dongles/update-ports endpoint');
});

test('server.js defines getDongleSiblingPorts and filters ports per dongle in /api/gsm-dongles/ttyusb-devices', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    assert.match(serverJs, /function getDongleSiblingPorts\(dongleId\)/, 'server.js must define getDongleSiblingPorts');
    assert.match(serverJs, /const dongleId = req\.query\.dongleId/, 'ttyusb-devices endpoint must accept dongleId query parameter');
    assert.match(serverJs, /getDongleSiblingPorts\(dongleId\)/, 'ttyusb-devices endpoint must filter sibling ports for dongleId');

    const viewContent = fs.readFileSync(path.join(__dirname, '../views/gsm-dongles.ejs'), 'utf8');
    assert.match(viewContent, /ttyusb-devices\?dongleId=/, 'loadDetectedPortsList must request ports for specific dongleId');
});
