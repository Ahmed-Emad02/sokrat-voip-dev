'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'backend', 'install_db.sql'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('installer carries one canonical call ID from push to SIP INVITE', () => {
    assert.match(installer, /uuidgen --sha1 --namespace b32a7f28-4bcc-5a56-a51f-2ad6f65f746b/);
    assert.match(installer, /incoming-call\?[^"\n]*callId=\$\{SOKRAT_CALL_ID\}/);
    assert.match(installer, /PJSIP_HEADER\(add,X-Sokrat-Call-ID\)=\$\{SOKRAT_CALL_ID\}/);
});

test('push hook polls for a WebRTC contact with a five-second bound', () => {
    assert.match(installer, /PJSIP_DIAL_CONTACTS\(\$\{TARGET_EXT\}\)/);
    assert.match(installer, /Wait\(0\.2\)/);
    assert.match(installer, /SOKRAT_WAIT_COUNT}<25/);
});

test('WebRTC configuration enforces multi-contact registration stability without direct media', () => {
    assert.match(server, /direct_media=no/);
    assert.match(server, /max_contacts=10\\nremove_existing=no\\nremove_unavailable=yes/);
    assert.match(installer, /case 'remove_unavailable':/);
    assert.match(installer, /UPDATE sip SET data='10' WHERE keyword IN \('maxcontacts','max_contacts'\)/);
    assert.match(installer, /SELECT id, 'direct_media', 'no'/);
});

test('mobile device registry is unique per platform and install', () => {
    assert.match(schema, /device_uuid` VARCHAR\(128\) NOT NULL/);
    assert.match(schema, /UNIQUE KEY `uniq_platform_device` \(`platform`, `device_uuid`\)/);
    assert.match(installer, /ensure_db_index "mobile_devices" "uniq_platform_device"/);
});
