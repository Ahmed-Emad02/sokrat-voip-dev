#!/bin/bash
# ==============================================================================
# Sokrat VoIP — Safe Backup Restoration Script
# Target: Issabel 5 / Asterisk 18 servers running sokrat-voip
# ==============================================================================
# Restores PBX dialplans, hardware configs, and database schemas from the
# snapshot taken immediately prior to the latest upgrade (or a specified timestamp).
# ==============================================================================

set -euo pipefail

INSTALL_DIR="/opt/sokrat-voip"
BACKUP_DIR="${INSTALL_DIR}/backups"
TARGET_TIMESTAMP=""

echo "========================================================"
echo " ⚡ Sokrat VoIP Pre-Upgrade Backup Restoration"
echo " Date: $(date)"
echo "========================================================"

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--timestamp)
            TARGET_TIMESTAMP="$2"
            shift 2
            ;;
        -l|--list)
            if [ -x "${INSTALL_DIR}/scripts/retrieve-backups.sh" ]; then
                exec "${INSTALL_DIR}/scripts/retrieve-backups.sh" --list
            else
                ls -la "$BACKUP_DIR"
                exit 0
            fi
            ;;
        -h|--help)
            echo "Usage: restore-backup.sh [--timestamp <YYYYMMDD_HHMMSS>]"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [ ! -d "$BACKUP_DIR" ]; then
    echo "ERROR: Backup directory not found at $BACKUP_DIR" >&2
    exit 1
fi

# Determine target timestamp if not specified
if [ -z "$TARGET_TIMESTAMP" ]; then
    if [ -f "$BACKUP_DIR/.last_preupgrade_backup" ]; then
        TARGET_TIMESTAMP=$(cat "$BACKUP_DIR/.last_preupgrade_backup" | tr -d '[:space:]')
        echo "Found recorded pre-upgrade timestamp: $TARGET_TIMESTAMP"
    fi
fi

# Fallback: scan for the most recent backup timestamp in $BACKUP_DIR
if [ -z "$TARGET_TIMESTAMP" ] || ! ls "$BACKUP_DIR"/*"$TARGET_TIMESTAMP"* &>/dev/null; then
    LATEST_FILE=$(ls -t "$BACKUP_DIR"/*_pbx.bak_*.sql 2>/dev/null | head -n 1 || true)
    if [ -n "$LATEST_FILE" ]; then
        TARGET_TIMESTAMP=$(basename "$LATEST_FILE" | sed -E 's/.*_pbx\.bak_([0-9_]+)\.sql/\1/')
        echo "Detected most recent snapshot timestamp: $TARGET_TIMESTAMP"
    fi
fi

if [ -z "$TARGET_TIMESTAMP" ]; then
    echo "ERROR: No valid backup snapshot found to restore in $BACKUP_DIR" >&2
    exit 1
fi

echo "Target Snapshot Timestamp: $TARGET_TIMESTAMP"

# Determine MySQL auth parameters
detect_mysql_auth() {
    local pwd
    pwd=$(grep mysqlrootpwd /etc/issabel.conf 2>/dev/null | cut -d= -f2- | xargs || true)
    if [ -z "$pwd" ]; then
        pwd=$(grep AMPDBPASS /etc/amportal.conf 2>/dev/null | cut -d= -f2- | xargs || true)
    fi

    if [ -n "$pwd" ] && mysql -u root -p"$pwd" -e "SELECT 1;" >/dev/null 2>&1; then
        echo "-u root -p$pwd"
    elif mysql -u root -padmin -e "SELECT 1;" >/dev/null 2>&1; then
        echo "-u root -padmin"
    elif mysql -e "SELECT 1;" >/dev/null 2>&1; then
        echo ""
    else
        echo "-u root"
    fi
}

MYSQL_AUTH_STR=$(detect_mysql_auth)
read -r -a MYSQL_AUTH <<< "$MYSQL_AUTH_STR"

# 1. Restore Asterisk Dialplans
echo "[1/5] Restoring Asterisk dialplan configuration..."
CONF_BAK="$BACKUP_DIR/extensions_custom.conf.bak_${TARGET_TIMESTAMP}"
if [ -f "$CONF_BAK" ]; then
    cp -a "$CONF_BAK" /etc/asterisk/extensions_custom.conf
    echo "  Restored /etc/asterisk/extensions_custom.conf"
else
    echo "  Notice: $CONF_BAK not found, keeping current dialplan."
fi

# 2. Restore Dongle Configurations
echo "[2/5] Restoring GSM dongle hardware configuration..."
DONGLE_BAK="$BACKUP_DIR/dongle.conf.bak_${TARGET_TIMESTAMP}"
if [ -f "$DONGLE_BAK" ]; then
    cp -a "$DONGLE_BAK" /etc/asterisk/dongle.conf
    echo "  Restored /etc/asterisk/dongle.conf"
else
    echo "  Notice: $DONGLE_BAK not found, keeping current dongle config."
fi

# 3. Restore Databases
echo "[3/5] Restoring PBX and CDR database schemas..."
PBX_SQL="$BACKUP_DIR/asterisk_pbx.bak_${TARGET_TIMESTAMP}.sql"
if [ -f "$PBX_SQL" ]; then
    mysql "${MYSQL_AUTH[@]}" asterisk < "$PBX_SQL"
    echo "  Restored asterisk PBX database from $PBX_SQL"
else
    echo "  Notice: $PBX_SQL not found, skipping PBX database restore."
fi

CDR_SQL="$BACKUP_DIR/asterisk_cdr.bak_${TARGET_TIMESTAMP}.sql"
if [ -f "$CDR_SQL" ]; then
    mysql "${MYSQL_AUTH[@]}" asteriskcdrdb < "$CDR_SQL"
    echo "  Restored asteriskcdrdb CDR database from $CDR_SQL"
else
    echo "  Notice: $CDR_SQL not found, skipping CDR database restore."
fi

# 4. Reload Asterisk
echo "[4/5] Reloading Asterisk dialplan and dongle drivers..."
if command -v asterisk &>/dev/null && pgrep -x asterisk >/dev/null 2>&1; then
    asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
    asterisk -rx "dongle reload now" >/dev/null 2>&1 || true
    echo "  Asterisk dialplan and dongles reloaded."
fi

# 5. Restart Sokrat Daemons
echo "[5/5] Restarting Sokrat VoIP services..."
systemctl daemon-reload 2>/dev/null || true
systemctl restart sokrat-voip.service 2>/dev/null || true
systemctl restart sokrat-watchdog.service 2>/dev/null || true
systemctl restart sokrat-stt.service 2>/dev/null || true

echo "========================================================"
echo " ✅ Backup restoration completed successfully!"
echo " Snapshot: $TARGET_TIMESTAMP"
echo "========================================================"
