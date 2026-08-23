const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('dongles default to rx/tx gain of 3 across add-slot UI, server API, and installer', () => {
    // Add-slot modal prefills 3 dB for both gains
    const configHtml = fs.readFileSync(path.join(__dirname, '../views/config.ejs'), 'utf8');
    assert.ok(configHtml.match(/id="newSlotRxGain" value="3"/), 'Add-slot modal must prefill Rx gain with 3');
    assert.ok(configHtml.match(/id="newSlotTxGain" value="3"/), 'Add-slot modal must prefill Tx gain with 3');

    // Server falls back to 3 when gains are not provided
    const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.ok(serverJs.includes('DEFAULT_DONGLE_GAIN = 3'), 'addDongleSlotToConf must default missing gains to 3');
    assert.ok(serverJs.includes('? parseInt(rxgain, 10) : 3'), 'Add-slot route must default Rx gain to 3');
    assert.ok(serverJs.includes('? parseInt(txgain, 10) : 3'), 'Add-slot route must default Tx gain to 3');
    assert.equal(/rxgain:\s*rxgain \|\| 0/.test(serverJs), false, 'Old zero fallback must be gone');

    // Installer writes explicit gains into every generated dongle section
    const installer = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
    assert.ok(/\[dongle\$i\]\ntxgain=3\nrxgain=3/.test(installer), 'Generated dongle sections must include txgain=3 and rxgain=3');

    // The shipped dongle.conf template defaults (inherited by gain-less sections) are 3
    const template = fs.readFileSync(path.join(__dirname, '../dongle.conf'), 'utf8');
    assert.ok(/^rxgain=3\s*;/m.test(template), 'Template [defaults] must use rxgain=3');
    assert.ok(/^txgain=3\s*;/m.test(template), 'Template [defaults] must use txgain=3');
});
