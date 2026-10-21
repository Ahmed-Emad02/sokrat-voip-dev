#!/usr/bin/env bash
# ==============================================================================
# Sokrat Laya — Hardware Sysfs USB Modem Re-bind Helper
# Performs kernel-level USB device power/driver rebind for wedged modems
# ==============================================================================

set -euo pipefail

TARGET="${1:-}"

if [ -z "$TARGET" ]; then
    echo "Usage: $0 <dongle_id | sysfs_device>"
    echo "Example: $0 dongle0  OR  $0 1-2"
    exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

UNBIND="/sys/bus/usb/drivers/usb/unbind"
BIND="/sys/bus/usb/drivers/usb/bind"

if [ ! -w "$UNBIND" ] || [ ! -w "$BIND" ]; then
    echo "ERROR: Sysfs USB bind/unbind endpoints not writable." >&2
    exit 1
fi

SYSFS_DEV=""

# If given sysfs path directly
if [ -d "/sys/bus/usb/devices/$TARGET" ]; then
    SYSFS_DEV="$TARGET"
else
    # Query strictly via Python helper using configured ports for THIS dongle
    SYSFS_DEV=$(python3 -c "
import sys
sys.path.insert(0, '/opt/sokrat-voip')
from laya.sensors.sysfs import find_modem_sysfs_for_dongle
dev, _ = find_modem_sysfs_for_dongle('$TARGET')
if dev:
    print(dev)
" 2>/dev/null || true)
fi

if [ -z "$SYSFS_DEV" ]; then
    echo "ERROR: Could not resolve physical USB sysfs bus path for target '$TARGET'. Aborting to protect other dongles." >&2
    exit 1
fi

echo "[LAYA-USB-RESET] Target sysfs device: $SYSFS_DEV (for $TARGET)"

# Strict isolation: Check if ANY shared dongle on this USB device or any dongle on Asterisk has active calls
SHARED_DONGLES=$(python3 -c "
import sys
sys.path.insert(0, '/opt/sokrat-voip')
from laya.sensors.sysfs import get_dongles_sharing_sysfs_device
print(' '.join(get_dongles_sharing_sysfs_device('$SYSFS_DEV')))
" 2>/dev/null || echo "$TARGET")

CALL_ACTIVE=$(asterisk -rx "core show channels concise" 2>/dev/null | grep -i "Dongle/" | grep -E "!(Up|Ringing|Dialing)!" || true)
if [ -n "$CALL_ACTIVE" ]; then
    echo "ABORT: Active call detected on cellular dongles ($CALL_ACTIVE). Cannot reset USB to protect ongoing voice." >&2
    exit 2
fi

# Layer 2: Hardware USB Bus Reset via USBDEVFS_RESET ioctl
python3 -c "
import sys
sys.path.insert(0, '/opt/sokrat-voip')
from laya.sensors.sysfs import get_usb_raw_dev_node, trigger_usbdevfs_reset
node = get_usb_raw_dev_node('$SYSFS_DEV')
if node:
    ok, msg = trigger_usbdevfs_reset(node)
    print(f'[LAYA-USB-RESET] Layer 2: {msg}')
" 2>/dev/null || true

echo "[LAYA-USB-RESET] Unbinding $SYSFS_DEV from USB driver..."
echo -n "$SYSFS_DEV" > "$UNBIND"
sleep 2

echo "[LAYA-USB-RESET] Re-binding $SYSFS_DEV to USB driver..."
echo -n "$SYSFS_DEV" > "$BIND"
sleep 3

echo "[LAYA-USB-RESET] Triggering Asterisk restart only for affected dongle(s): $SHARED_DONGLES..."
for d in $SHARED_DONGLES; do
    asterisk -rx "dongle restart now $d" 2>/dev/null || true
done

echo "[LAYA-USB-RESET] OK: USB device $SYSFS_DEV rebound successfully."
