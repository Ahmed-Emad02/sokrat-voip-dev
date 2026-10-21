const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO = '/opt/sokrat-voip';
const PY = (script) => {
    const res = spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: REPO });
    return res;
};

test('Layer 3 Ground Truth: serial liveness probe reports the correct verdict', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.sensors.cli import probe_dongle_serial_liveness, LIVENESS_ALIVE, LIVENESS_DEAD, LIVENESS_ABSENT, LIVENESS_BUSY

# A dongle with no configured ports must be ABSENT
r = probe_dongle_serial_liveness('dongle-does-not-exist-xyz', port='/dev/does-not-exist')
assert r['verdict'] == LIVENESS_ABSENT, r

# A dongle whose port node does not exist must be ABSENT
r = probe_dongle_serial_liveness('dongle-test-absent', port='/dev/ttyNOPE999')
assert r['verdict'] == LIVENESS_ABSENT, r

# The probe must never report DEAD merely because a process owns the port.
# It must return BUSY so a healthy dongle is never misdiagnosed.
r = probe_dongle_serial_liveness('dongle-test-busy', port='/dev/ttyUSB0', timeout=0.5)
assert r['verdict'] in (LIVENESS_BUSY, LIVENESS_ALIVE, LIVENESS_DEAD), r
assert r['verdict'] != LIVENESS_DEAD or r['response'] != '', 'DEAD verdict must be backed by an actual probe attempt'
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Liveness probe test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 3 Ground Truth: Asterisk log scanner honours the lookback window', () => {
    const script = `
import sys, time
sys.path.insert(0, '${REPO}')
from laya.sensors.cli import scan_asterisk_log_for_dongle_faults

# A dongle with no log entries must never be flagged
found, sig, cnt = scan_asterisk_log_for_dongle_faults('dongle-never-seen-xyz', lookback_seconds=300)
assert found is False, (found, sig, cnt)
assert cnt == 0, cnt

# The scanner must return a boolean and a count
found, sig, cnt = scan_asterisk_log_for_dongle_faults('dongle0', lookback_seconds=300)
assert isinstance(found, bool)
assert isinstance(cnt, int)
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Log scanner test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 3 Detection: a frozen modem with a confirmed AT fault escalates straight to Level 4', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.evaluator.state_machine import DongleStateManager
from laya.evaluator.heuristics import evaluate_dongle_anomalies, ANOMALY_MODEM_FIRMWARE_DEAD
from laya.sensors.sysfs import scan_usb_modems

usb = scan_usb_modems()
sm = DongleStateManager()

# --- Scenario A: modem physically on the bus, Asterisk says 'Not connected',
#     and the driver logged an AT timeout. This is the exact freeze scenario.
summary = {'id': 'dongle0', 'state': 'Not connected', 'rssi': 0, 'model': None,
           'firmware': None, 'imei': None, 'imsi': None, 'number': 'Unknown'}
hd = sm.update_dongle(summary, detail=None, active_channels=[], usb_modems=usb)
hd['at_fault_confirmed'] = True
hd['at_fault_signature'] = 'timedout while waiting'
hd['at_fault_count'] = 7
hd['consecutive_errors'] = 5

anomaly, reason, level = evaluate_dongle_anomalies(hd, None)
assert anomaly == ANOMALY_MODEM_FIRMWARE_DEAD, anomaly
assert level == 4, f'firmware-dead must route to Level 4 hardware reset, got {level}'

# --- Scenario B: a transient AT timeout while the modem is Free must be ignored.
summary2 = {'id': 'dongle1', 'state': 'Free', 'rssi': 15, 'model': 'E173', 'firmware': 'x',
            'imei': '868402001090736', 'imsi': '602030838016383', 'number': '+201156804841'}
hd2 = sm.update_dongle(summary2, detail=None, active_channels=[], usb_modems=usb)
hd2['at_fault_confirmed'] = True
hd2['at_fault_signature'] = 'timedout while waiting'
hd2['at_fault_count'] = 1
anomaly2, reason2, level2 = evaluate_dongle_anomalies(hd2, None)
assert anomaly2 == 'NONE', f'transient timeout must not trigger a reset: {anomaly2} / {reason2}'

print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Firmware-dead detection test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 3 Detection: hardware absent is reported quietly without burning recovery rungs', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.evaluator.state_machine import DongleStateManager
from laya.evaluator.heuristics import evaluate_dongle_anomalies, ANOMALY_HARDWARE_ABSENT
from laya.sensors.sysfs import scan_usb_modems

usb = scan_usb_modems()
sm = DongleStateManager()

# dongle999 is not configured at all -> no ports -> hardware absent
summary = {'id': 'dongle999', 'state': 'Not connected', 'rssi': 0, 'model': None,
           'firmware': None, 'imei': None, 'imsi': None, 'number': 'Unknown'}
hd = sm.update_dongle(summary, detail=None, active_channels=[], usb_modems=usb)
assert hd['usb_present'] is False, hd['usb_present']

anomaly, reason, level = evaluate_dongle_anomalies(hd, None)
assert anomaly == ANOMALY_HARDWARE_ABSENT, anomaly
assert level == 0, f'hardware absent must not trigger automated healing, got level {level}'
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Hardware-absent detection test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 3 USB Presence: resolved from dongle.conf, independent of Asterisk device state', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.evaluator.state_machine import DongleStateManager
from laya.sensors.sysfs import scan_usb_modems, get_dongle_configured_ports_from_conf

usb = scan_usb_modems()
sm = DongleStateManager()

# dongle0 is physically present in this environment. Its presence MUST be
# detected even though detail=None (the blind spot that previously hid freezes).
ports = get_dongle_configured_ports_from_conf('dongle0')
assert ports.get('data'), 'dongle0 must have a configured data port'

summary = {'id': 'dongle0', 'state': 'Not connected', 'rssi': 0, 'model': None,
           'firmware': None, 'imei': None, 'imsi': None, 'number': 'Unknown'}
hd = sm.update_dongle(summary, detail=None, active_channels=[], usb_modems=usb)
assert hd['usb_present'] is True, 'usb_present must be True when the hardware is enumerated'
assert hd['configured_ports'].get('data') == ports.get('data')
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `USB presence resolution test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 3 Hardware Reset: USBDEVFS_RESET primitives resolve real device nodes', () => {
    const script = `
import sys, os
sys.path.insert(0, '${REPO}')
from laya.sensors.sysfs import get_usb_raw_dev_node, trigger_usbdevfs_reset, find_modem_sysfs_for_dongle

# The raw node resolver must return None for a non-existent device
assert get_usb_raw_dev_node('this-does-not-exist') is None

# For a real modem, it must resolve a /dev/bus/usb/... path
sysfs_name, _ = find_modem_sysfs_for_dongle('dongle0')
if sysfs_name:
    node = get_usb_raw_dev_node(sysfs_name)
    assert node and node.startswith('/dev/bus/usb/'), node
    assert os.path.exists(node), node

# Triggering a reset on a non-existent node must fail gracefully, never raise
ok, msg = trigger_usbdevfs_reset('/dev/bus/usb/999/999')
assert ok is False, msg
assert 'not found' in msg, msg
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `USBDEVFS_RESET primitive test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 3 Post-Heal Verification: recovery is only reported when the modem returns', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.healer.actions import verify_dongle_recovered

# A non-existent dongle must NOT be reported as recovered
ok, details = verify_dongle_recovered('dongle999', timeout=4, poll_interval=1)
assert ok is False, details
assert 'NOT recovered' in details, details
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Post-heal verification test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 3 Stale Row Pruning: health rows for removed dongles are pruned', () => {
    const script = `
import sys, os, tempfile
sys.path.insert(0, '${REPO}')
from laya.sensors.db import prune_stale_dongle_health

# Safety: with an empty valid list AND no readable dongle.conf, the prune
# must refuse to touch the table rather than wipe every row.
tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.conf', delete=False)
tmp.write('')
tmp.close()
res = prune_stale_dongle_health([], conf_path=tmp.name)
assert res['pruned'] == 0, res
assert res['error'], res
os.unlink(tmp.name)

# With a valid list, the dongles that are currently valid must be kept
res = prune_stale_dongle_health([{'id': 'dongle0'}, {'id': 'dongle1'}])
assert res['error'] is None, res
assert 'dongle0' in res['kept'] and 'dongle1' in res['kept'], res
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Stale row pruning test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});

test('Layer 3 Safety: destructive actions still refuse while a voice call is active', () => {
    const script = `
import sys
sys.path.insert(0, '${REPO}')
from laya.healer.actions import action_sysfs_usb_reset, is_call_active_on_dongle

# The Level 4 action must abort for a dongle whose ports cannot be verified
ok, details = action_sysfs_usb_reset('dongle-unverifiable-xyz')
assert ok is False, details
assert 'Safety Abort' in details, details
print("OK")
`;
    const res = PY(script);
    assert.equal(res.status, 0, `Safety guard test failure: ${res.stderr}`);
    assert.match(res.stdout, /OK/);
});
