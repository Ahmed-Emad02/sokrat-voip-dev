#!/usr/bin/env bash
# Read-only, private incident bundle. Contains subscriber identifiers: do not
# publish it. Usage: dongle-debug-bundle.sh [NEW-output-directory]
# SOKRAT_ROOT redirects collected files for offline fixtures; commands can be
# overridden through ASTERISK_BIN/PATH. No calls, AT commands or reloads.
set -euo pipefail
umask 077

AST="${ASTERISK_BIN:-/usr/sbin/asterisk}"
ROOT="${SOKRAT_ROOT:-}"
LIMIT="${DONGLE_BUNDLE_TIMEOUT:-15s}"
[[ "$LIMIT" =~ ^[0-9]+([.][0-9]+)?[smh]?$ ]] || { echo "Invalid collection timeout" >&2; exit 2; }
duration="${LIMIT%[smh]}"
[[ -n "${duration//[0.]/}" ]] || { echo "Collection timeout must be positive" >&2; exit 2; }
bounded() { timeout --kill-after=1s "$LIMIT" "$@"; }

if [[ $# -gt 1 ]]; then echo "Usage: $0 [NEW-output-directory]" >&2; exit 2; fi
if [[ $# -eq 0 ]]; then
    parent=$(bounded realpath -e -- "${TMPDIR:-/tmp}")
else
    parent=$(bounded realpath -e -- "$(bounded dirname -- "$1")")
    name=$(bounded basename -- "$1")
fi
# Pin the parent inode before checking/creating anything, so renaming an
# ancestor cannot redirect our later output opens. Sticky /tmp is supported.
cd -P -- "$parent"
owner=$(bounded stat -Lc %u -- .)
mode=$(bounded stat -Lc %a -- .)
mode=$((0$mode))
if [[ "$owner" != "$EUID" && "$owner" != 0 ]] ||
   (( (mode & 18) && !(mode & 512) )); then
    echo "Bundle parent directory is not private or sticky" >&2
    exit 1
fi
if [[ $# -eq 0 ]]; then
    name=$(bounded mktemp -d dongle-debug.XXXXXXXXXX)
else
    # mkdir (not mkdir -p) atomically rejects every existing path/symlink.
    bounded mkdir -m 0700 -- "$name" || { echo "Bundle output must be a new directory" >&2; exit 1; }
fi
cd -P -- "$name"
bounded chmod 0700 -- .
OUT="$PWD"
set -C
printf 'file\texit_status\n' >collection-status.tsv
run() {
    local name=$1 status=0
    shift
    # noclobber prevents following any planted output, including symlinks.
    if bounded "$@" >"$name" 2>&1; then status=0; else status=$?; fi
    printf '%s\t%s\n' "$name" "$status" >>collection-status.tsv
}
ast() { local name=$1; shift; run "$name" "$AST" -rx "$*"; }

ast version.txt 'core show version'
ast module.txt 'module show like chan_dongle'
ast devices.txt 'dongle show devices'
ast settings.txt 'core show settings'
ast logger.txt 'logger show channels'

# Reuse the bounded device snapshot instead of an unbounded discovery command.
declare -A seen=()
count=0
while read -r id rest; do
    [[ "$id" =~ ^dongle[0-9]+$ ]] || continue
    [[ -z "${seen[$id]:-}" ]] || continue
    seen[$id]=1
    ((count+=1))
    if ((count > 64)); then
        printf 'device-limit\t1\n' >>collection-status.tsv
        break
    fi
    ast "$id-state.txt" "dongle show device state $id"
    ast "$id-settings.txt" "dongle show device settings $id"
    ast "$id-statistics.txt" "dongle show device statistics $id"
done <devices.txt

# Copy bytes, not source permissions/ownership (even world-readable configs
# become 0600). Missing/unreadable inputs are recorded like command failures.
for name in dongle.conf logger.conf logger_logfiles_additional.conf \
            logger_logfiles_custom.conf asterisk.conf; do
    run "$name" cat -- "$ROOT/etc/asterisk/$name"
done
run logrotate-asterisk.conf cat -- "$ROOT/etc/logrotate.d/asterisk"
run module.sha256 sha256sum -- "$ROOT/usr/lib64/asterisk/modules/chan_dongle.so"
run lsusb.txt lsusb
run usb-devices.txt bash -o pipefail -c '
    for d in "$1"/sys/bus/usb/devices/*; do
        [[ -f "$d/idVendor" ]] || continue
        printf "== %s\n" "$d"
        for f in idVendor idProduct product authorized; do
            [[ ! -f "$d/$f" ]] || { printf "%s=" "$f"; cat -- "$d/$f"; }
        done
    done
' bash "$ROOT"
run dmesg-tail.txt bash -o pipefail -c 'dmesg -T | tail -800'
run journal-asterisk.txt journalctl -u asterisk --no-pager -n 1500
run full-dongle.log bash -o pipefail -c 'grep -aE "\[dongle[0-9]+\]" "$1" | tail -5000' bash "$ROOT/var/log/asterisk/full"
run full-problems.log bash -o pipefail -c 'grep -aE "WARNING|ERROR|timedout|disconnect|CLCC|CVOICE|reconnect|stopping by" "$1" | tail -3000' bash "$ROOT/var/log/asterisk/full"
run full-tail.log tail -5000 -- "$ROOT/var/log/asterisk/full"
run messages-tail.log tail -2000 -- "$ROOT/var/log/asterisk/messages"
printf '%s\n' "$OUT"
