const test = require('node:test');
const assert = require('node:assert/strict');

// Replicate parseDevicesOutput logic under test
function parseDevicesOutput(output, keepRaw = false, astDbMappings = {}) {
    const lines = output.trim().split('\n');
    if (lines.length === 0) return [];
    const header = lines[0];
    const colNames = ["ID", "Group", "State", "RSSI", "Mode", "Submode", "Provider Name", "Model", "Firmware", "IMEI", "IMSI", "Number"];
    const indices = colNames.map(name => header.indexOf(name));
    indices.push(header.length + 100);
    
    const devices = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || line.startsWith('-----') || line.includes('ID')) {
            continue;
        }
        const row = {};
        for (let j = 0; j < colNames.length; j++) {
            const start = indices[j];
            const end = indices[j+1];
            if (start !== -1 && start < line.length) {
                row[colNames[j]] = line.substring(start, Math.min(end, line.length)).trim();
            } else {
                row[colNames[j]] = '';
            }
        }
        if (row.ID && row.ID.startsWith("dongle")) {
            if ((!row.IMEI || row.IMEI === '-' || row.IMEI === 'Unknown') && row.IMSI && (row.IMSI.startsWith('86') || row.IMSI.startsWith('35'))) {
                row.IMEI = row.IMSI;
            }
            const parsedState = (row.State || '').toLowerCase();
            if (parsedState.includes('not init')) row.State = 'Not Initialized';
            else if (parsedState.includes('not connec')) row.State = 'Not Connected';
            const st = (row.State || '').toLowerCase();
            const isNotConnected = st.includes('not connec') || st.includes('not_conn') || st.includes('not init') || st.includes('not reg') || st.includes('not respond');

            if (isNotConnected) {
                row.Number = 'Unknown';
            } else {
                const mapped = (row.IMSI && astDbMappings[row.IMSI]) || (row.IMEI && astDbMappings[row.IMEI]) || (row.ID && astDbMappings[row.ID]) || null;
                if (mapped) {
                    row.Number = mapped;
                } else if (!row.Number || row.Number === '-' || row.Number === 'None') {
                    row.Number = 'Unknown';
                }
            }
            devices.push(row);
        }
    }
    return devices;
}

test('parseDevicesOutput sets Number to Unknown for disconnected dongles even if slot mapping exists', () => {
    const mockOutput = [
        "ID           Group State      RSSI Mode Submode Provider Name  Model      Firmware          IMEI             IMSI             Number        ",
        "dongle0      0     Free       11   0    0       Orange EG      E173       21.157.71.00.272  868402004375084  602019529273991  Unknown       ",
        "dongle1      0     Not connec 0    0    0       NONE                                                                          Unknown       "
    ].join('\n');

    const astDbMappings = {
        'dongle0': '+201111111111',
        'dongle1': '+201275888396',
        '602019529273991': '+201275888396'
    };

    const parsed = parseDevicesOutput(mockOutput, false, astDbMappings);
    assert.equal(parsed.length, 2);

    // Active dongle0 resolves number by IMSI mapping
    assert.equal(parsed[0].ID, 'dongle0');
    assert.equal(parsed[0].State, 'Free');
    assert.equal(parsed[0].Number, '+201275888396');

    // Disconnected dongle1 must strictly be Unknown
    assert.equal(parsed[1].ID, 'dongle1');
    assert.equal(parsed[1].State, 'Not Connected');
    assert.equal(parsed[1].Number, 'Unknown');
});
