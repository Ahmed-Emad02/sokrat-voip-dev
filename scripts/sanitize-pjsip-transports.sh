#!/bin/bash
# Keep FreePBX-generated PJSIP transport sections from shadowing the dedicated
# Sokrat transports. FreePBX can regenerate pjsip_transport_additional.conf
# after this repository's installer has cleared it, which makes PJSIP load zero
# transports and breaks WebRTC calls with "500 Server Internal Error".
#
# This script is safe to run repeatedly. It changes the generated file only
# when an actual transport section is present, preserves ownership/mode, and
# reloads PJSIP only after a change. It never restarts Asterisk.
set -euo pipefail

ASTERISK_DIR="${ASTERISK_DIR:-/etc/asterisk}"
ASTERISK_BIN="${ASTERISK_BIN:-/usr/sbin/asterisk}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sokrat-voip}"
CUSTOM="$ASTERISK_DIR/pjsip_transport_custom.conf"
ADDITIONAL="$ASTERISK_DIR/pjsip_transport_additional.conf"

[ -f "$CUSTOM" ] || {
    echo "PJSIP sanitizer: custom transport file missing; refusing to modify generated config." >&2
    exit 1
}
[ -f "$ADDITIONAL" ] || exit 0

# Only clear generated transport sections when the managed source of truth
# actually defines the WSS transport used by mobile endpoints.
if ! grep -qE '^\[transport-wss\][[:space:]]*$' "$CUSTOM"; then
    echo "PJSIP sanitizer: transport-wss is not defined in $CUSTOM; refusing to modify generated config." >&2
    exit 1
fi

if ! grep -qE '^[[:space:]]*\[transport-[^]]+\][[:space:]]*$' "$ADDITIONAL"; then
    exit 0
fi

install -d -m 700 "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$BACKUP_DIR/pjsip_transport_additional.conf.sokrat-sanitize-$stamp"
cp -a "$ADDITIONAL" "$backup"

tmp="${ADDITIONAL}.sokrat-sanitize.$$"
trap 'rm -f "$tmp"' EXIT
printf '; Dedicated transports managed via pjsip_transport_custom.conf\n' > "$tmp"
chown --reference="$ADDITIONAL" "$tmp" 2>/dev/null || true
chmod --reference="$ADDITIONAL" "$tmp" 2>/dev/null || true
mv -f "$tmp" "$ADDITIONAL"
trap - EXIT

echo "PJSIP sanitizer: cleared conflicting generated transports; backup=$backup"
if [ -x "$ASTERISK_BIN" ]; then
    "$ASTERISK_BIN" -rx 'pjsip reload' >/dev/null 2>&1 || true
fi
