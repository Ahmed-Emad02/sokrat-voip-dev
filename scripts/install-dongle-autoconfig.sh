#!/bin/bash
# Install/refresh the dongle autoconfiguration systemd units for a checkout.
# Usage: sudo bash scripts/install-dongle-autoconfig.sh [--repo /path/to/checkout]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "${1:-}" = "--repo" ] && [ -n "${2:-}" ]; then
    REPO_DIR="$(cd "$2" && pwd)"
fi

if [ ! -f "$REPO_DIR/scripts/dongle-autoconfig.py" ]; then
    echo "ERROR: $REPO_DIR/scripts/dongle-autoconfig.py not found" >&2
    exit 1
fi

install -d -m 0755 /etc/sokrat /var/lib/sokrat/dongle-autoconfig/backups
chmod 0755 "$REPO_DIR/scripts/dongle-autoconfig.py"
find "$REPO_DIR/scripts/dongle_autoconfig" -maxdepth 1 -name '*.py' -exec chmod 0755 {} +

sed "s|/opt/sokrat-voip|$REPO_DIR|g" \
    "$REPO_DIR/scripts/systemd/sokrat-dongle-autoconfig.service" \
    > /etc/systemd/system/sokrat-dongle-autoconfig.service
install -m 0644 "$REPO_DIR/scripts/systemd/sokrat-dongle-autoconfig.timer" \
    /etc/systemd/system/sokrat-dongle-autoconfig.timer
if [ ! -f /etc/sokrat/dongle-slots.example.json ]; then
    install -m 0644 "$REPO_DIR/config/dongle-slots.example.json" \
        /etc/sokrat/dongle-slots.example.json
fi

systemctl daemon-reload
if [ -f /etc/sokrat/dongle-slots.json ]; then
    systemctl enable --now sokrat-dongle-autoconfig.timer
    echo "Enabled sokrat-dongle-autoconfig.timer"
else
    echo "Installed units from $REPO_DIR."
    echo "No /etc/sokrat/dongle-slots.json yet; timer is not enabled."
    echo "Create one with: python3 $REPO_DIR/scripts/dongle-autoconfig.py bootstrap --write"
fi
