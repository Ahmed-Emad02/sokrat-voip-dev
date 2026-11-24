#!/bin/bash
# Shared deployment policy. Hardware is assigned only by the application's
# model/udev discovery, never by an install-time ttyUSB numbering assumption.

_dongle_config_helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

dongle_config_install() {
    local template="$1" target="$2" count="$3"
    node - "$template" "$target" "$count" "$_dongle_config_helper_dir/../lib/dongle-provisioning.js" <<'NODE'
const fs = require('fs');
const path = require('path');
const [template, target, rawCount, writer] = process.argv.slice(2);
// Any existing config is operator-owned, even without a dongle0 section.
try {
    fs.lstatSync(target);
    console.log(`  Preserving existing ${target} unchanged`);
    process.exit(0);
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
if (!/^(?:[0-9]|1[0-9]|2[0-5])$/.test(rawCount)) throw new Error('Dongle capacity must be between 0 and 25');
const { updateEmptySlots } = require(writer);
let skip = false;
const defaults = fs.readFileSync(template, 'utf8').split('\n').filter(line => {
    const section = line.trim().match(/^\[([^\]]+)\]/);
    if (section) skip = /^dongle[0-9]+$/i.test(section[1].trim());
    return !skip;
}).join('\n');
fs.mkdirSync(path.dirname(target), { recursive: true });
const stagingDir = fs.mkdtempSync(path.join(path.dirname(target), '.dongle-install-'));
const staged = path.join(stagingDir, 'dongle.conf');
try {
    fs.writeFileSync(staged, defaults, { mode: 0o644, flag: 'wx' });
    updateEmptySlots(staged, { add: Array.from({ length: Number(rawCount) }, (_, i) => `dongle${i}`) });
    // Publish without overwriting a config another writer created meanwhile.
    fs.linkSync(staged, target);
    console.log(`  Created ${rawCount} empty dongle slot(s); assign hardware through safe discovery in the application`);
} finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
}
NODE
}

dongle_deployment_disable_watchdog() {
    local state
    state=$(systemctl show --property=LoadState --value sokrat-watchdog.service) || return 1
    [ "$state" = not-found ] && return 0
    systemctl disable --now sokrat-watchdog.service
}

dongle_deployment_refresh_laya() {
    # Never turn a stopped or disabled maintenance agent into autonomous healing.
    systemctl is-enabled --quiet sokrat-laya.service >/dev/null 2>&1 || return 0
    systemctl is-active --quiet sokrat-laya.service >/dev/null 2>&1 || return 0
    systemctl restart sokrat-laya.service
}
