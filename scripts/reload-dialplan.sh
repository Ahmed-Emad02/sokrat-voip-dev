#!/bin/bash
# Reload Asterisk after FreePBX regenerates its dialplan.
#
# FreePBX can touch extensions_additional.conf several times while writing a
# route or ring-group change. Reloading on the first inotify event can load a
# partially written file, leaving the running dialplan stale until the next
# change. Wait for the watched files to stop changing before reloading.
set -euo pipefail

ASTERISK_BIN="${ASTERISK_BIN:-/usr/sbin/asterisk}"
DIALPLAN_DIR="${DIALPLAN_DIR:-/etc/asterisk}"
LOCK_FILE="${LOCK_FILE:-/run/sokrat-dialplan-reload.lock}"
WATCHED=(
    "$DIALPLAN_DIR/extensions_additional.conf"
    "$DIALPLAN_DIR/extensions.conf"
    "$DIALPLAN_DIR/extensions_custom.conf"
    "$DIALPLAN_DIR/queues_additional.conf"
)

exec 9>"$LOCK_FILE"
flock 9

signature() {
    { sha256sum "${WATCHED[@]}" 2>/dev/null || true; } | sha256sum | cut -d' ' -f1
}

previous=""
for _ in 1 2 3 4 5; do
    current=$(signature)
    if [ -n "$previous" ] && [ "$current" = "$previous" ]; then
        break
    fi
    previous="$current"
    sleep 1
done

if [ -x "$ASTERISK_BIN" ]; then
    "$ASTERISK_BIN" -rx 'dialplan reload' >/dev/null 2>&1 || true
fi
