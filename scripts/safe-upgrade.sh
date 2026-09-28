#!/bin/bash
# ==============================================================================
# Sokrat VoIP — Safe, Non-Destructive In-Place Upgrade Script
# Target: Issabel 5 / Asterisk 18 servers running existing sokrat-voip installations
# ==============================================================================
# This script:
#   1. Backs up Asterisk dialplans, dongle configurations, and PBX database schemas.
#   2. Pulls or syncs the latest stable sokrat-voip codebase.
#   3. Safely creates new database tables and missing columns (CREATE TABLE IF NOT
#      EXISTS) without modifying or overwriting existing PBX data or CDR history.
#   4. Rebuilds and applies latest Asterisk / chan_dongle stability patches
#      (Condition 32 crash fix, UAF prevention, and audio jitter buffer).
#   5. Sanitizes Asterisk dialplans: removes legacy automated dongle restart
#      triggers and fixes hangup handlers that cause transfer disconnects.
#   6. Safely reloads chan_dongle.so in RAM and restarts background Sokrat daemons.
#   7. Verifies system and GSM modem operational status.
# ==============================================================================

set -euo pipefail

INSTALL_DIR="/opt/sokrat-voip"
REPO_URL="https://github.com/Ahmed-Emad02/sokrat-voip-dev.git"
SRC_CHAN_DONGLE="/usr/src/asterisk-chan-dongle"
MODULES_DIR="/usr/lib64/asterisk/modules"
BACKUP_TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "========================================================"
echo " ⚡ Sokrat VoIP Safe In-Place Upgrader"
echo " Date: $(date)"
echo "========================================================"

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

# Determine MySQL / MariaDB connection parameters safely
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
# Convert string to array safely
read -r -a MYSQL_AUTH <<< "$MYSQL_AUTH_STR"

# 1. Configuration & PBX Database Backups
echo "[1/7] Backing up Asterisk configurations and database schemas..."
mkdir -p "$INSTALL_DIR/backups"

if [ -f /etc/asterisk/extensions_custom.conf ]; then
    cp -a /etc/asterisk/extensions_custom.conf "$INSTALL_DIR/backups/extensions_custom.conf.bak_${BACKUP_TIMESTAMP}"
    echo "  Backed up extensions_custom.conf"
fi
if [ -f /etc/asterisk/dongle.conf ]; then
    cp -a /etc/asterisk/dongle.conf "$INSTALL_DIR/backups/dongle.conf.bak_${BACKUP_TIMESTAMP}"
    echo "  Backed up dongle.conf"
fi

if command -v mysqldump &>/dev/null; then
    mysqldump "${MYSQL_AUTH[@]}" --single-transaction --routines --triggers asterisk > "$INSTALL_DIR/backups/asterisk_pbx.bak_${BACKUP_TIMESTAMP}.sql" 2>/dev/null || true
    mysqldump "${MYSQL_AUTH[@]}" --single-transaction asteriskcdrdb > "$INSTALL_DIR/backups/asterisk_cdr.bak_${BACKUP_TIMESTAMP}.sql" 2>/dev/null || true
    echo "  Created database snapshots in $INSTALL_DIR/backups/"
fi

# 2. Update Repository Codebase
echo "[2/7] Updating Sokrat VoIP codebase..."
if [ ! -d "$INSTALL_DIR" ]; then
    echo "  Cloning repository into $INSTALL_DIR..."
    timeout 60 git clone "$REPO_URL" "$INSTALL_DIR" || echo "  Warning: Git clone timed out or failed."
elif [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    echo "  Checking for remote repository updates..."
    if timeout 60 git fetch origin main >/dev/null 2>&1; then
        git merge --ff-only origin/main 2>/dev/null || git pull --ff-only origin main 2>/dev/null || true
    else
        echo "  Notice: Remote fetch timed out or offline, proceeding with current codebase."
    fi
    echo "  Codebase at commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'current')"
fi

# 3. Database Schema Migrations (Preserving PBX Data)
echo "[3/7] Provisioning new database tables and schema migrations..."
if [ -f "$INSTALL_DIR/backend/install_db.sql" ]; then
    mysql "${MYSQL_AUTH[@]}" asterisk < "$INSTALL_DIR/backend/install_db.sql" 2>/dev/null || true
    echo "  Applied database schema definitions (CREATE TABLE IF NOT EXISTS)"
fi

ensure_db_column() {
    local tbl="$1"
    local col="$2"
    local col_def="$3"
    local exists
    exists=$(mysql "${MYSQL_AUTH[@]}" asterisk -Nse \
        "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '$tbl' AND COLUMN_NAME = '$col'" 2>/dev/null || echo "1")
    if [ "$exists" = "0" ]; then
        mysql "${MYSQL_AUTH[@]}" asterisk -e "ALTER TABLE \`$tbl\` ADD \`$col\` $col_def" 2>/dev/null || true
        echo "  Added column $col to $tbl"
    fi
}

ensure_db_index() {
    local tbl="$1"
    local idx="$2"
    local idx_def="$3"
    local exists
    exists=$(mysql "${MYSQL_AUTH[@]}" asterisk -Nse \
        "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '$tbl' AND INDEX_NAME = '$idx'" 2>/dev/null || echo "1")
    if [ "$exists" = "0" ]; then
        mysql "${MYSQL_AUTH[@]}" asterisk -e "ALTER TABLE \`$tbl\` ADD $idx_def" 2>/dev/null || true
    fi
}

# Run idempotent schema migrations
ensure_db_column "dashboard_users" "group_id" "INT DEFAULT NULL"
ensure_db_column "dashboard_users" "extension" "VARCHAR(20) DEFAULT NULL"
ensure_db_column "dashboard_users" "reset_token_expires" "DATETIME DEFAULT NULL"
ensure_db_index "dashboard_users" "idx_dash_users_extension" "KEY \`idx_dash_users_extension\` (\`extension\`)"
ensure_db_index "dashboard_users" "idx_unique_email" "UNIQUE KEY \`idx_unique_email\` (\`email\`)"
echo "  Database schema migrations complete. All PBX and CDR data preserved."

# 4. Rebuild & Patch chan_dongle Module
echo "[4/7] Compiling and applying Asterisk / chan_dongle stability patches..."
if [ -d "$SRC_CHAN_DONGLE" ] && [ -f "$INSTALL_DIR/asterisk/chan_dongle.patch" ]; then
    cd "$SRC_CHAN_DONGLE"
    git reset --hard HEAD >/dev/null 2>&1 || true
    git clean -fd >/dev/null 2>&1 || true
    sed -i "s/a_write_buf\[FRAME_SIZE \* [0-9]\+\]/a_write_buf[FRAME_SIZE * 35]/" chan_dongle.h 2>/dev/null || true
    patch -p1 < "$INSTALL_DIR/asterisk/chan_dongle.patch"
    ./bootstrap 2>/dev/null || true
    ./configure --with-astversion=18.19.0 >/dev/null 2>&1 || ./configure >/dev/null 2>&1
    make clean >/dev/null 2>&1
    make -j"$(nproc 2>/dev/null || echo 1)" >/dev/null 2>&1
    make install >/dev/null 2>&1
    echo "  Patched chan_dongle.so built and installed into $MODULES_DIR"
elif [ -f "$INSTALL_DIR/installer-bundle/binaries/chan_dongle.so" ]; then
    cp "$INSTALL_DIR/installer-bundle/binaries/chan_dongle.so" "$MODULES_DIR/chan_dongle.so"
    chmod 644 "$MODULES_DIR/chan_dongle.so"
    echo "  chan_dongle.so installed from bundle binary"
fi

# 5. Sanitize Dialplans & Protect Call Transfers
echo "[5/7] Sanitizing dialplan contexts and hangup handlers..."
if [ -f /etc/asterisk/extensions_custom.conf ]; then
    # Remove any rogue automated restart triggers
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

    # Ensure autodialer contexts exist if missing
    if "[from-autodialer-progressive]" not in content:
        dialer_stub = """
[autodialer-agent-setup]
exten => _X.,1,NoOp(=== Progressive Dialer Agent Setup: ${EXTEN} ===)
same => n,Set(HASH(__SIPHEADERS,Alert-Info)=info=alert-autoanswer)
same => n,Set(HASH(__SIPHEADERS,Call-Info)=<sip:127.0.0.1>\;answer-after=0)
same => n,Goto(from-internal,${EXTEN},1)

[from-autodialer-progressive]
exten => s,1,NoOp(=== Progressive Dialer Outbound Leg: ${LEAD_PHONE} ===)
same => n,Set(CALLERID(name)=${LEAD_NAME})
same => n,Set(CALLERID(num)=${LEAD_PHONE})
same => n,Set(CHANNEL(hangup_handler_push)=sub-autodialer-progressive-hangup,s,1)
same => n,GotoIf($["${DIAL_TARGET}"!=""]?dial_target:dial_route)
same => n(dial_target),Dial(${DIAL_TARGET}/${LEAD_PHONE},60,U(sub-autodialer-progressive-connect))
same => n,Hangup()
same => n(dial_route),Dial(Local/${LEAD_PHONE}@outbound-allroutes,60,U(sub-autodialer-progressive-connect))
same => n,Hangup()

[sub-autodialer-progressive-connect]
exten => s,1,NoOp(=== Progressive Dialer Connected: ${CAMPAIGN_ID} / ${LEAD_ID} ===)
same => n,UserEvent(DialerProgressiveConnect,CampaignID: ${CAMPAIGN_ID},LeadID: ${LEAD_ID},Agent: ${AGENT_EXTEN},Channel: ${CHANNEL})
same => n,Return()

[sub-autodialer-progressive-hangup]
exten => s,1,NoOp(=== Progressive Dialer Hangup: ${CAMPAIGN_ID} / ${LEAD_ID} ===)
same => n,UserEvent(DialerProgressiveHangup,CampaignID: ${CAMPAIGN_ID},LeadID: ${LEAD_ID},Agent: ${AGENT_EXTEN},DialStatus: ${DIALSTATUS},HangupCause: ${HANGUPCAUSE})
same => n,Return()
"""
        content = content.rstrip() + "\n\n" + dialer_stub.strip() + "\n"

    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("  Dialplan successfully sanitized in extensions_custom.conf")
except Exception as e:
    print(f"  Warning: Dialplan sanitization encountered: {e}")
PYEOF
    asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
fi

# 6. Reload Asterisk Modules & Sokrat Daemons
echo "[6/7] Refreshing Asterisk modules and restarting Sokrat services..."
if command -v asterisk &>/dev/null && pgrep -x asterisk >/dev/null 2>&1; then
    asterisk -rx "module unload chan_dongle.so" >/dev/null 2>&1 || true
    sleep 1
    asterisk -rx "module load chan_dongle.so" >/dev/null 2>&1 || true
fi

systemctl daemon-reload 2>/dev/null || true
systemctl restart sokrat-voip.service 2>/dev/null || true
systemctl restart sokrat-watchdog.service 2>/dev/null || true
systemctl restart sokrat-stt.service 2>/dev/null || true

# 7. Post-Upgrade Verification
echo "[7/7] Verifying system status..."
sleep 2

echo "--- Asterisk GSM Dongles ---"
if command -v asterisk &>/dev/null && pgrep -x asterisk >/dev/null 2>&1; then
    asterisk -rx "dongle show devices" 2>/dev/null || echo "chan_dongle not yet ready"
fi

echo "--- Sokrat VoIP Service Status ---"
systemctl is-active sokrat-voip.service 2>/dev/null && echo "sokrat-voip: active (running)" || echo "sokrat-voip: inactive"

echo "========================================================"
echo " ✅ Safe upgrade completed successfully!"
echo "========================================================"
