#!/bin/bash
# Bounded FRP recovery: tolerate transient TCP misses, then restart once.
set -euo pipefail

CONF=/etc/frp/frpc.toml
[ -r "$CONF" ] || exit 0

server=$(awk -F= '/^[[:space:]]*serverAddr[[:space:]]*=/{gsub(/[[:space:]"]/,"",$2); print $2; exit}' "$CONF")
port=$(awk -F= '/^[[:space:]]*serverPort[[:space:]]*=/{gsub(/[[:space:]]/,"",$2); print $2; exit}' "$CONF")
[ -n "$server" ] || exit 0
port="${port:-7000}"
case "$server" in *[!A-Za-z0-9.:-]*) exit 0 ;; esac
case "$port" in *[!0-9]*) exit 0 ;; esac

STATE_DIR=/run/sokrat-frpc-watchdog
mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"

FAILURE_FILE="$STATE_DIR/failures"
RESTART_FILE="$STATE_DIR/last-restart"
now=$(date +%s)
last_restart=$(cat "$RESTART_FILE" 2>/dev/null || printf '0')
case "$last_restart" in *[!0-9]*) last_restart=0 ;; esac

# Never enter a restart loop while FRPS is still clearing the prior session.
if [ $((now - last_restart)) -lt 90 ]; then
    exit 0
fi

if timeout 8 bash -c "exec 3<>/dev/tcp/$server/$port" 2>/dev/null; then
    printf '0\n' > "$FAILURE_FILE"
    exit 0
fi

failures=$(cat "$FAILURE_FILE" 2>/dev/null || printf '0')
case "$failures" in *[!0-9]*) failures=0 ;; esac
failures=$((failures + 1))
printf '%s\n' "$failures" > "$FAILURE_FILE"
logger -t sokrat-frpc-watchdog "FRP server $server:$port probe failed ($failures/3)"

if [ "$failures" -lt 3 ]; then
    exit 0
fi

printf '%s\n' "$now" > "$RESTART_FILE"
printf '0\n' > "$FAILURE_FILE"
systemctl restart frpc.service
logger -t sokrat-frpc-watchdog "FRP server $server:$port unreachable three times; restarted frpc"
exit 0
