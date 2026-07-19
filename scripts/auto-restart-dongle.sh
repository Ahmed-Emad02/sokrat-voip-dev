#!/bin/bash
# auto-restart-dongle.sh — Auto-restart a specific dongle after USB hotplug
# Triggered by udev when a new ttyUSB device appears.
# Maps the ttyUSB port to a dongle ID via dongle.conf, waits 5 seconds,
# then runs "dongle restart now dongleX" once per plug event.
#
# Usage: auto-restart-dongle.sh <ttyUSB_device_name>
# Example: auto-restart-dongle.sh ttyUSB0

DEVICE_NAME="$1"
DELAY=5
LOCK_TTL=30
ASTERISK_BIN="/usr/sbin/asterisk"
DONGLE_CONF="/etc/asterisk/dongle.conf"
LOCK_DIR="/tmp"
LOG_TAG="auto-restart-dongle"

log_msg() {
    logger -t "$LOG_TAG" "$1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

if [ -z "$DEVICE_NAME" ]; then
    log_msg "ERROR: No device name supplied"
    exit 1
fi

if [ ! -f "$DONGLE_CONF" ]; then
    log_msg "ERROR: $DONGLE_CONF not found"
    exit 1
fi

# Map ttyUSB port → dongle ID from dongle.conf
DONGLE_ID=""
CURRENT_SECTION=""
while IFS= read -r line; do
    # Detect section headers like [dongle0]
    if [[ "$line" =~ ^\[([a-zA-Z0-9]+)\] ]]; then
        CURRENT_SECTION="${BASH_REMATCH[1]}"
    fi
    # Check if this line references our ttyUSB device in audio= or data=
    if [[ -n "$CURRENT_SECTION" ]] && [[ "$CURRENT_SECTION" != "general" ]] && [[ "$CURRENT_SECTION" != "defaults" ]]; then
        if [[ "$line" =~ [[:space:]]audio=.*/dev/${DEVICE_NAME}([[:space:]]|$) ]] || \
           [[ "$line" =~ [[:space:]]data=.*/dev/${DEVICE_NAME}([[:space:]]|$) ]]; then
            DONGLE_ID="$CURRENT_SECTION"
            break
        fi
    fi
done < "$DONGLE_CONF"

if [ -z "$DONGLE_ID" ]; then
    # ttyUSB device not mapped in dongle.conf — not a managed dongle, skip silently
    exit 0
fi

# Debounce: skip if this dongle was restarted within the last LOCK_TTL seconds
LOCK_FILE="$LOCK_DIR/${DONGLE_ID}-restart.lock"
if [ -f "$LOCK_FILE" ]; then
    LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
    if [ "$LOCK_AGE" -lt "$LOCK_TTL" ]; then
        log_msg "SKIP: $DONGLE_ID locked (${LOCK_AGE}s < ${LOCK_TTL}s), another trigger already handled it"
        exit 0
    fi
fi

# Create lock file immediately (prevents parallel triggers for same dongle)
date +%s > "$LOCK_FILE"

log_msg "DETECTED: $DEVICE_NAME belongs to $DONGLE_ID — waiting ${DELAY}s before restart"

# Wait for the USB device to settle and Asterisk to see it
sleep "$DELAY"

# Verify Asterisk is running
if ! pgrep -x asterisk > /dev/null 2>&1; then
    log_msg "ERROR: Asterisk is not running, skipping restart"
    rm -f "$LOCK_FILE"
    exit 1
fi

# Run the targeted restart
log_msg "RESTARTING: $DONGLE_ID"
$ASTERISK_BIN -rx "dongle restart now $DONGLE_ID" 2>&1 | while IFS= read -r line; do
    log_msg "  asterisk: $line"
done

EXIT_CODE=${PIPESTATUS[0]}
if [ "$EXIT_CODE" -eq 0 ]; then
    log_msg "OK: $DONGLE_ID restart command sent successfully"
else
    log_msg "WARN: $DONGLE_ID restart command exited with code $EXIT_CODE"
fi

# Emit Socket.IO event so the dashboard USB grid refreshes in real-time
if command -v node &>/dev/null; then
    node -e "
        const http = require('http');
        const data = JSON.stringify({ event: 'usbDevicesUpdated' });
        const req = http.request({ hostname: '127.0.0.1', port: 8080, path: '/api/gsm-dongles/emit-usb-update', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, () => {});
        req.on('error', () => {});
        req.write(data);
        req.end();
    " 2>/dev/null &
fi

exit 0
