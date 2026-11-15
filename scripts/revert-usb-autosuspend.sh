#!/usr/bin/env bash
# Restore the pre-autosuspend USB power policy.
# Usage: revert-usb-autosuspend.sh [backup-dir] [--dry-run]
set -euo pipefail

BACKUP_ROOT="${SOKRAT_USB_AUTOSUSPEND_BACKUP_ROOT:-/var/backups/sokrat-usb-autosuspend}"
DRY_RUN=0
BACKUP_DIR=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -*) echo "Unknown option: $arg" >&2; exit 2 ;;
        *) BACKUP_DIR="$arg" ;;
    esac
done

if [[ -z "$BACKUP_DIR" ]]; then
    BACKUP_DIR="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%p\n' 2>/dev/null | sort -r | head -n1)"
fi
if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
    echo "No autosuspend backup found under $BACKUP_ROOT" >&2
    exit 1
fi

echo "Backup: $BACKUP_DIR"
if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Would restore:"
    echo "  /etc/udev/rules.d/99-disable-usb-autosuspend.rules"
    echo "  /etc/modprobe.d/usbcore.conf"
    echo "  /etc/default/grub"
    echo "  /sys/module/usbcore/parameters/autosuspend = -1"
    echo "  every USB power/control = on"
    echo "Dry run only; nothing changed."
    exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
    echo "Must run as root." >&2
    exit 1
fi

for file in \
    "/etc/udev/rules.d/99-disable-usb-autosuspend.rules" \
    "/etc/modprobe.d/usbcore.conf" \
    "/etc/default/grub"; do
    if [[ -e "$BACKUP_DIR$file" ]]; then
        mkdir -p "$(dirname "$file")"
        cp -a "$BACKUP_DIR$file" "$file"
        echo "restored $file"
    fi
done

echo -1 > /sys/module/usbcore/parameters/autosuspend
for device in /sys/bus/usb/devices/*; do
    [[ -f "$device/power/control" ]] || continue
    echo -1000 > "$device/power/autosuspend_delay_ms" 2>/dev/null || true
    echo on > "$device/power/control" 2>/dev/null || true
done
udevadm control --reload-rules 2>/dev/null || true
if command -v grub2-mkconfig >/dev/null 2>&1; then
    grub2-mkconfig -o /boot/grub2/grub.cfg >/dev/null 2>&1 || true
fi
echo "USB autosuspend disabled again; no service restart performed."
