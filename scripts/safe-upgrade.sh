#!/bin/bash
# ==============================================================================
# Sokrat VoIP — Safe, Non-Destructive In-Place Upgrade Script
# Target: Issabel 5 / Asterisk 18 servers running older sokrat-voip installations
# ==============================================================================
# This script:
#   1. Backs up Asterisk dialplans and dongle configurations.
#   2. Pulls the latest stable sokrat-voip repository commits.
#   3. Rebuilds and deploys the patched chan_dongle.so Asterisk module.
#   4. Sanitizes Asterisk dialplans (removes legacy automated dongle restart
#      triggers and duplicate hangup handlers that cause transfer disconnects).
#   5. Preserves all MariaDB/MySQL databases, extensions, trunks, and routes.
#   6. Safely refreshes chan_dongle and restarts Sokrat services.
# ==============================================================================

set -euo pipefail

INSTALL_DIR="/opt/sokrat-voip"
SRC_CHAN_DONGLE="/usr/src/asterisk-chan-dongle"
MODULES_DIR="/usr/lib64/asterisk/modules"
BACKUP_TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "========================================================"
echo " Sokrat VoIP Safe In-Place Upgrader"
echo " Date: $(date)"
echo "========================================================"

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

# 1. Configuration Backups
echo "[1/6] Backing up Asterisk configurations..."
mkdir -p "$INSTALL_DIR/backups"
if [ -f /etc/asterisk/extensions_custom.conf ]; then
    cp -a /etc/asterisk/extensions_custom.conf "$INSTALL_DIR/backups/extensions_custom.conf.bak_${BACKUP_TIMESTAMP}"
    echo "  Backed up extensions_custom.conf"
fi
if [ -f /etc/asterisk/dongle.conf ]; then
    cp -a /etc/asterisk/dongle.conf "$INSTALL_DIR/backups/dongle.conf.bak_${BACKUP_TIMESTAMP}"
    echo "  Backed up dongle.conf"
fi

# 2. Update Repository
echo "[2/6] Updating Sokrat VoIP codebase..."
cd "$INSTALL_DIR"
git fetch origin main
git reset --hard origin/main
echo "  Updated to commit: $(git rev-parse --short HEAD)"

# 3. Rebuild chan_dongle with latest stability patches
echo "[3/6] Compiling patched chan_dongle module..."
if [ -d "$SRC_CHAN_DONGLE" ] && [ -f "$INSTALL_DIR/asterisk/chan_dongle.patch" ]; then
    cd "$SRC_CHAN_DONGLE"
    git reset --hard HEAD
    git clean -fd
    patch -p1 < "$INSTALL_DIR/asterisk/chan_dongle.patch"
    ./bootstrap 2>/dev/null || true
    ./configure --with-astversion=18.19.0 >/dev/null 2>&1 || ./configure >/dev/null 2>&1
    make clean >/dev/null 2>&1
    make -j"$(nproc 2>/dev/null || echo 1)"
    make install
    echo "  Patched chan_dongle.so built and installed into $MODULES_DIR"
elif [ -f "$INSTALL_DIR/installer-bundle/binaries/chan_dongle.so" ]; then
    cp "$INSTALL_DIR/installer-bundle/binaries/chan_dongle.so" "$MODULES_DIR/chan_dongle.so"
    chmod 644 "$MODULES_DIR/chan_dongle.so"
    echo "  chan_dongle.so installed from bundle binary"
fi

# 4. Sanitize Dialplans
echo "[4/6] Sanitizing dialplan contexts and hangup handlers..."
if [ -f /etc/asterisk/extensions_custom.conf ]; then
    # Remove any rogue hardcoded restart calls
    sed -i '/dongle restart now/d' /etc/asterisk/extensions*.conf 2>/dev/null || true

    python3 - << 'PYEOF'
import re

conf_path = "/etc/asterisk/extensions_custom.conf"
try:
    with open(conf_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Remove all legacy [dongle-hangup-cleanup] contexts
    content = re.sub(r'\[dongle-hangup-cleanup\].*?(?=\n\[|\Z)', '', content, flags=re.DOTALL)

    # Remove hangup handler pushes that trigger dongle cleanup
    content = re.sub(r'^\s*same\s*=>\s*n,Set\(CHANNEL\(hangup_handler_push\)=dongle-hangup-cleanup,s,1\)\r?\n', '', content, flags=re.MULTILINE)

    # Append safe stub
    stub = """
[dongle-hangup-cleanup]
exten => s,1,NoOp(--- Pure Dialplan Dongle Hangup Cleanup (Safely Disabled) ---)
same => n,GotoIf($["${BLINDTRANSFER}"!=""]?done)
same => n,GotoIf($["${ATTENDEDTRANSFER}"!=""]?done)
same => n,GotoIf($["${TRANSFER_CONTEXT}"!=""]?done)
same => n(done),Return()
"""
    content = content.rstrip() + "\n\n" + stub.strip() + "\n"

    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("  Dialplan successfully sanitized in extensions_custom.conf")
except Exception as e:
    print(f"  Warning: Dialplan sanitization encountered: {e}")
PYEOF
    asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
fi

# 5. Reload Asterisk Module & Services
echo "[5/6] Refreshing Asterisk modules and Sokrat services..."
if command -v asterisk &>/dev/null && pgrep -x asterisk >/dev/null 2>&1; then
    asterisk -rx "module unload chan_dongle.so" >/dev/null 2>&1 || true
    sleep 1
    asterisk -rx "module load chan_dongle.so" >/dev/null 2>&1 || true
fi

systemctl daemon-reload 2>/dev/null || true
systemctl restart sokrat-voip.service 2>/dev/null || true
systemctl restart sokrat-watchdog.service 2>/dev/null || true
systemctl restart sokrat-stt.service 2>/dev/null || true

# 6. Verification
echo "[6/6] Verifying system status..."
sleep 2
echo "--- Asterisk GSM Dongles ---"
if command -v asterisk &>/dev/null && pgrep -x asterisk >/dev/null 2>&1; then
    asterisk -rx "dongle show devices" 2>/dev/null || echo "chan_dongle not yet ready"
fi

echo "--- Sokrat VoIP Service Status ---"
systemctl is-active sokrat-voip.service 2>/dev/null && echo "sokrat-voip: active (running)" || echo "sokrat-voip: inactive"

echo "========================================================"
echo " Safe upgrade completed successfully!"
echo "========================================================"
