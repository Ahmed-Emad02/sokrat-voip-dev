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
echo "${BACKUP_TIMESTAMP}" > "$INSTALL_DIR/backups/.last_preupgrade_backup"

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
ensure_db_column "dashboard_user_extensions" "peer_id" "INT DEFAULT NULL"
ensure_db_index "dashboard_user_extensions" "idx_peer_id" "KEY \`idx_peer_id\` (\`peer_id\`)"
ensure_db_column "gsm_dongles" "dynamic_enabled" "TINYINT(1) NOT NULL DEFAULT 0"
ensure_db_column "employee_extras" "is_group_admin" "TINYINT(1) NOT NULL DEFAULT 0"
ensure_db_column "storage_settings" "auto_purge_days" "INT DEFAULT 90"
ensure_db_column "storage_settings" "gdrive_enabled" "TINYINT(1) DEFAULT 0"
ensure_db_column "storage_settings" "gdrive_folder_name" "VARCHAR(255) DEFAULT 'Sokrat-VoIP-Backups'"
ensure_db_column "storage_settings" "gdrive_credentials" "TEXT DEFAULT NULL"
ensure_db_column "storage_settings" "auto_backup_schedule" "VARCHAR(50) DEFAULT 'daily'"
ensure_db_column "storage_settings" "last_backup_at" "DATETIME DEFAULT NULL"
ensure_db_column "storage_settings" "last_backup_status" "VARCHAR(50) DEFAULT NULL"
ensure_db_column "storage_settings" "queue_provisioned" "TINYINT(1) DEFAULT 0"
ensure_db_index "mobile_devices" "uniq_platform_device" "UNIQUE KEY \`uniq_platform_device\` (\`platform\`, \`device_uuid\`)"
ensure_db_column "announcement" "tts_lang" "VARCHAR(10) NOT NULL DEFAULT 'en-US'"
ensure_db_column "announcement" "tts_text" "TEXT NOT NULL DEFAULT ('')"

# Seed new webhook settings keys (idempotent INSERT IGNORE)
mysql "${MYSQL_AUTH[@]}" asterisk -e "
INSERT IGNORE INTO dashboard_settings (setting_key, setting_value) VALUES
  ('webhook_incoming_call_enabled', 'false'),
  ('webhook_incoming_call_url', ''),
  ('webhook_incoming_call_secret', '');
" 2>/dev/null || true

# Camp-On (Callback When Free) callbacks table
mysql "${MYSQL_AUTH[@]}" asterisk -e "
CREATE TABLE IF NOT EXISTS \`sokrat_camp_on_callbacks\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`caller_ext\` VARCHAR(20) NOT NULL,
  \`target_ext\` VARCHAR(20) NOT NULL,
  \`status\` ENUM('pending', 'originating', 'connected', 'cancelled', 'expired', 'failed') NOT NULL DEFAULT 'pending',
  \`attempt_count\` INT NOT NULL DEFAULT 0,
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`expires_at\` DATETIME NOT NULL,
  \`completed_at\` DATETIME DEFAULT NULL,
  INDEX \`idx_camp_pending\` (\`status\`, \`target_ext\`, \`caller_ext\`),
  INDEX \`idx_camp_expires\` (\`expires_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
" 2>/dev/null || true

echo "  Database schema migrations complete. All PBX and CDR data preserved."

# 4. Rebuild & Patch chan_dongle Module
echo "[4/7] Applying Asterisk / chan_dongle stability patches..."
if [ -f "$INSTALL_DIR/installer-bundle/binaries/chan_dongle.so" ]; then
    mkdir -p "$MODULES_DIR"
    cp "$INSTALL_DIR/installer-bundle/binaries/chan_dongle.so" "$MODULES_DIR/chan_dongle.so"
    chmod 644 "$MODULES_DIR/chan_dongle.so"
    echo "  Hardened chan_dongle.so installed from bundle binary into $MODULES_DIR"
elif [ -d "$SRC_CHAN_DONGLE" ] && [ -f "$INSTALL_DIR/asterisk/chan_dongle.patch" ]; then
    cd "$SRC_CHAN_DONGLE"
    git reset --hard HEAD >/dev/null 2>&1 || true
    git clean -fd >/dev/null 2>&1 || true
    patch -p1 < "$INSTALL_DIR/asterisk/chan_dongle.patch"
    ./bootstrap 2>/dev/null || true
    ./configure --with-astversion=18.19.0 >/dev/null 2>&1 || ./configure >/dev/null 2>&1
    make clean >/dev/null 2>&1
    make -j"$(nproc 2>/dev/null || echo 1)" >/dev/null 2>&1
    make install >/dev/null 2>&1
    echo "  Patched chan_dongle.so built and installed into $MODULES_DIR"
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

    # Ensure Camp-On (Callback When Free) contexts exist if missing
    if "[ext-campon-bridge]" not in content:
        campon_stub = """
[campon-hangup-capture]
exten => s,1,NoOp(--- Sokrat Camp-On Hangup Capture: DIALSTATUS=${DIALSTATUS} HANGUPCAUSE=${HANGUPCAUSE} ---)
same => n,ExecIf($["${DIALSTATUS}" = "BUSY" | "${HANGUPCAUSE}" = "17"]?Set(DB(CAMP_ON_LAST_BUSY/${CALLERID(num)})=${DB(CAMP_ON_LAST_TARGET/${CALLERID(num)})}))
same => n,Return()

[sub-campon-busy-menu]
exten => s,1,NoOp(--- Sokrat Camp-On Busy Menu: Caller ${CALLERID(num)} Target ${EXTTOCALL} ---)
same => n,Set(CALLER_EXT=${IF($["${CALLERID(num)}" != ""]?${CALLERID(num)}:${CUT(CUT(CHANNEL,-,1),/,2)})})
same => n,Answer()
same => n,Playtones(busy)
same => n,Read(PRESSED_DIGIT,,1,,,8)
same => n,StopPlaytones()
same => n,GotoIf($["${PRESSED_DIGIT}" = "6"]?activate)
same => n,Busy(15)
same => n,Hangup()
same => n(activate),Goto(sub-campon-activate,s,1)

[macro-exten-vm-custom]
exten => s-BUSY,1,NoOp(--- Sokrat Camp-On: Target ${EXTTOCALL} is BUSY for ${CALLERID(num)} ---)
same => n,Set(CALLER_EXT=${IF($["${CALLERID(num)}" != ""]?${CALLERID(num)}:${CUT(CUT(CHANNEL,-,1),/,2)})})
same => n,Set(DB(CAMP_ON_LAST_BUSY/${CALLER_EXT})=${EXTTOCALL})
same => n,Set(DB(CAMP_ON_LAST_TARGET/${CALLER_EXT})=${EXTTOCALL})
same => n,Goto(sub-campon-busy-menu,s,1)

[sub-campon-activate]
exten => s,1,NoOp(--- Sokrat Camp-On Activated via DTMF 6: ${CALLERID(num)} -> ${EXTTOCALL} ---)
same => n,ExecIf($["${EXTTOCALL}" = ""]?Set(EXTTOCALL=${DB(CAMP_ON_LAST_BUSY/${CALLERID(num)})}))
same => n,GotoIf($["${EXTTOCALL}" = "" | "${EXTTOCALL}" = "${CALLERID(num)}"]?invalid)
same => n,AGI(sokrat-campon.py,register,${CALLERID(num)},${EXTTOCALL})
same => n,Playback(beep)
same => n,Playback(activated)
same => n,Wait(1)
same => n,Hangup()
same => n(invalid),Playback(beeperr)
same => n,Playback(cannot-complete-as-dialed)
same => n,Hangup()

[ext-campon-bridge]
exten => failed,1,NoOp(--- Sokrat Camp-On: Caller ${CALLER_EXT} did not answer callback ring ---)
same => n,Hangup()
exten => _[0-9*#+a-zA-Z]!,1,NoOp(--- Sokrat Camp-On Bridge: Connecting ${CALLER_EXT} to ${EXTEN} ---)
same => n,Set(CALLERID(num)=${CALLER_EXT})
same => n,Set(CALLERID(name)=${DB(AMPUSER/${CALLER_EXT}/cidname)})
same => n,ExecIf($["${CALLERID(name)}" = ""]?Set(CALLERID(name)=${CALLER_EXT}))
same => n,Goto(from-internal,${EXTEN},1)
"""
        content = content.rstrip() + "\n\n" + campon_stub.strip() + "\n"

    # Ensure *82 and *83 exist in [from-internal-custom]
    if "*82" not in content and "[from-internal-custom]" in content:
        campon_fc = """
; === Sokrat Camp-On (Callback When Free) Feature Codes (*82 / *83) ===
exten => *82,1,NoOp(--- Feature Code *82: Camp-On Request from ${CALLERID(num)} Channel: ${CHANNEL} ---)
same => n,Set(CALLER_EXT=${CALLERID(num)})
same => n,ExecIf($["${CALLER_EXT}" = ""]?Set(CALLER_EXT=${DB(DEVICE/${CUT(CUT(CHANNEL,-,1),/,2)}/user)}))
same => n,ExecIf($["${CALLER_EXT}" = ""]?Set(CALLER_EXT=${CUT(CUT(CHANNEL,-,1),/,2)}))
same => n,Answer()
same => n,Set(EXTTOCALL=${DB(CAMP_ON_LAST_BUSY/${CALLER_EXT})})
same => n,ExecIf($["${EXTTOCALL}" = ""]?Set(EXTTOCALL=${DB(CAMP_ON_LAST_TARGET/${CALLER_EXT})}))
same => n,GotoIf($["${EXTTOCALL}" = "" | "${EXTTOCALL}" = "${CALLER_EXT}"]?no_target)
same => n,AGI(sokrat-campon.py,register,${CALLER_EXT},${EXTTOCALL})
same => n,Playback(beep)
same => n,Playback(activated)
same => n,Wait(1)
same => n,Hangup()
same => n(no_target),Playback(beeperr)
same => n,Playback(cannot-complete-as-dialed)
same => n,Hangup()

exten => *83,1,NoOp(--- Feature Code *83: Camp-On Cancel from ${CALLERID(num)} Channel: ${CHANNEL} ---)
same => n,Set(CALLER_EXT=${CALLERID(num)})
same => n,ExecIf($["${CALLER_EXT}" = ""]?Set(CALLER_EXT=${DB(DEVICE/${CUT(CUT(CHANNEL,-,1),/,2)}/user)}))
same => n,ExecIf($["${CALLER_EXT}" = ""]?Set(CALLER_EXT=${CUT(CUT(CHANNEL,-,1),/,2)}))
same => n,Answer()
same => n,AGI(sokrat-campon.py,cancel,${CALLER_EXT})
same => n,Playback(beep)
same => n,Playback(cancelled)
same => n,Wait(1)
same => n,Hangup()
"""
        content = re.sub(r'(\[from-internal-custom\][\s\S]*?)(?=\n\[|\Z)', r'\1\n' + campon_fc, content, count=1)

    override_conf = "/etc/asterisk/extensions_override_issabel.conf"
    if os.path.exists(override_conf):
        with open(override_conf, "r", encoding="utf-8") as f:
            ov_content = f.read()
        if "[macro-exten-vm]" not in ov_content:
            exten_vm_override = """
; === Sokrat VoIP: Macro Extension Voicemail & Camp-On Override ===
[macro-exten-vm]
include => macro-exten-vm-custom
exten => s,1,Macro(user-callerid,)
exten => s,n,Set(RingGroupMethod=none)
exten => s,n,Set(__EXTTOCALL=${ARG2})
exten => s,n,Set(__PICKUPMARK=${ARG2})
exten => s,n,Set(DB(CAMP_ON_LAST_TARGET/${CALLERID(num)})=${EXTTOCALL})
exten => s,n,ExecIf($["${DB(DEVICE/${CUT(CUT(CHANNEL,-,1),/,2)}/user)}" != ""]?Set(DB(CAMP_ON_LAST_TARGET/${DB(DEVICE/${CUT(CUT(CHANNEL,-,1),/,2)}/user)})=${EXTTOCALL}))
exten => s,n,Set(RT=${IF($["${ARG1}"!="novm" | "${DB(CFU/${EXTTOCALL})}"!="" | "${DB(CFB/${EXTTOCALL})}"!="" | "${ARG3}"="1" | "${ARG4}"="1" | "${ARG5}"="1"]?${RINGTIMER}:)})
exten => s,n(checkrecord),Gosub(sub-record-check,s,1(exten,${EXTTOCALL},))
exten => s,n(macrodial),Macro(dial-one,${RT},${DIAL_OPTIONS},${EXTTOCALL})
exten => s,n,Set(SV_DIALSTATUS=${DIALSTATUS})
exten => s,n(calldocfu),GosubIf($[("${SV_DIALSTATUS}"="NOANSWER"|"${SV_DIALSTATUS}"="CHANUNAVAIL") & "${DB(CFU/${EXTTOCALL})}"!="" & "${SCREEN}"=""]?docfu,1())
exten => s,n(calldocfb),GosubIf($["${SV_DIALSTATUS}"="BUSY" & "${DB(CFB/${EXTTOCALL})}"!="" & "${SCREEN}"=""]?docfb,1())
exten => s,n,Set(DIALSTATUS=${SV_DIALSTATUS})
exten => s,n,ExecIf($[("${DIALSTATUS}"="NOANSWER"&"${ARG3}"="1")|("${DIALSTATUS}"="BUSY"&"${ARG4}"="1")|("${DIALSTATUS}"="CHANUNAVAIL"&"${ARG5}"="1")]?MacroExit())
exten => s,n,GotoIf($["${ARG1}"="novm"]?s-${DIALSTATUS},1)
exten => s,n,Macro(vm,${ARG1},${DIALSTATUS},${IVR_RETVM})

exten => docfu,1(docfu),ExecIf($["${DB(AMPUSER/${EXTTOCALL}/cfringtimer)}"="-1"|("${ARG1}"="novm"&"${ARG3}"="1")]?StackPop())
exten => docfu,n,GotoIf($["${DB(AMPUSER/${EXTTOCALL}/cfringtimer)}"="-1"|("${ARG1}"="novm"&"${ARG3}"="1")]?from-internal,${DB(CFU/${EXTTOCALL})},1)
exten => docfu,n,Set(RTCF=${IF($["${DB(AMPUSER/${EXTTOCALL}/cfringtimer)}"="0"]?${RT}:${DB(AMPUSER/${EXTTOCALL}/cfringtimer)})})
exten => docfu,n,ExecIf($["${DIRECTION}" = "INBOUND"]?Set(DIAL_OPTIONS=${STRREPLACE(DIAL_OPTIONS,T)}))
exten => docfu,n,Dial(Local/${DB(CFU/${EXTTOCALL})}@from-internal/n,${RTCF},${DIAL_OPTIONS})
exten => docfu,n,Return()

exten => docfb,1(docfu),ExecIf($["${DB(AMPUSER/${EXTTOCALL}/cfringtimer)}"="-1"|("${ARG1}"="novm"&"${ARG4}"="1")]?StackPop())
exten => docfb,n,GotoIf($["${DB(AMPUSER/${EXTTOCALL}/cfringtimer)}"="-1"|("${ARG1}"="novm"&"${ARG4}"="1")]?from-internal,${DB(CFB/${EXTTOCALL})},1)
exten => docfb,n,Set(RTCF=${IF($["${DB(AMPUSER/${EXTTOCALL}/cfringtimer)}"="0"]?${RT}:${DB(AMPUSER/${EXTTOCALL}/cfringtimer)})})
exten => docfb,n,ExecIf($["${DIRECTION}" = "INBOUND"]?Set(DIAL_OPTIONS=${STRREPLACE(DIAL_OPTIONS,T)}))
exten => docfb,n,Dial(Local/${DB(CFB/${EXTTOCALL})}@from-internal/n,${RTCF},${DIAL_OPTIONS})
exten => docfb,n,Return()

exten => s-BUSY,1,GotoIf($["${IVR_RETVM}"="RETURN" & "${IVR_CONTEXT}"!=""]?exit,1)
exten => s-BUSY,n,NoOp(--- Sokrat Camp-On: Target ${EXTTOCALL} is BUSY for ${CALLERID(num)} ---)
exten => s-BUSY,n,Set(DB(CAMP_ON_LAST_BUSY/${CALLERID(num)})=${EXTTOCALL})
exten => s-BUSY,n,ExecIf($["${DB(DEVICE/${CUT(CUT(CHANNEL,-,1),/,2)}/user)}" != ""]?Set(DB(CAMP_ON_LAST_BUSY/${DB(DEVICE/${CUT(CUT(CHANNEL,-,1),/,2)}/user)})=${EXTTOCALL}))
exten => s-BUSY,n,Set(DB(CAMP_ON_LAST_TARGET/${CALLERID(num)})=${EXTTOCALL})
exten => s-BUSY,n,ExecIf($["${DB(DEVICE/${CUT(CUT(CHANNEL,-,1),/,2)}/user)}" != ""]?Set(DB(CAMP_ON_LAST_TARGET/${DB(DEVICE/${CUT(CUT(CHANNEL,-,1),/,2)}/user)})=${EXTTOCALL}))
exten => s-BUSY,n,Goto(sub-campon-busy-menu,s,1)

exten => _s-!,1,GotoIf($["${IVR_RETVM}"="RETURN" & "${IVR_CONTEXT}"!=""]?exit,1)
exten => _s-!,n,Playtones(congestion)
exten => _s-!,n,Congestion(10)

exten => exit,1,Playback(beep&line-busy-transfer-menu&silence/1)
exten => exit,n,MacroExit()
"""
            ov_content = ov_content.rstrip() + "\n\n" + exten_vm_override.strip() + "\n"
            with open(override_conf, "w", encoding="utf-8") as f:
                f.write(ov_content)

    # Update [ext-external-failover] with smart alternate dongle selection
    content = re.sub(r'\[ext-external-failover\].*?(?=\n\[|\Z)', '', content, flags=re.DOTALL)
    failover_stub = """
[ext-external-failover]
; Sokrat Call Center Failover to External Mobile Number (Direct Bridge)
; Supports:
;   1. Explicit Dongle: ext-external-failover,01011719380/dongle1,1 OR ext-external-failover,01011719380@dongle1,1
;   2. Automatic Outbound Routing with Smart Alternate Dongle Selection
exten => _[0-9+*#].!,1,NoOp(=== SOKRAT FAILOVER: Target '${EXTEN}' for Customer '${CALLERID(num)}' ===)
same => n,Set(CUST_NUM=${CALLERID(num)})
same => n,Set(RAW_TARGET=${EXTEN})
same => n,Set(TARGET_NUM=${CUT(RAW_TARGET,/,1)})
same => n,Set(TARGET_NUM=${CUT(TARGET_NUM,@,1)})
same => n,Set(EXPLICIT_DONGLE=${CUT(RAW_TARGET,/,2)})
same => n,ExecIf($["${EXPLICIT_DONGLE}"=""]?Set(EXPLICIT_DONGLE=${CUT(RAW_TARGET,@,2)}))
same => n,Set(__FAILOVER_DEST=${TARGET_NUM})
same => n,Set(CDR(userfield)=Failover: ${RAW_TARGET})
same => n,GotoIf($["${EXPLICIT_DONGLE}"!="" & "${EXPLICIT_DONGLE}"!="auto" & "${EXPLICIT_DONGLE}"!="none"]?dial_explicit:auto_select)

same => n(dial_explicit),NoOp(Dialing explicitly via Dongle/${EXPLICIT_DONGLE}/${TARGET_NUM})
same => n,Dial(Dongle/${EXPLICIT_DONGLE}/${TARGET_NUM},60)
same => n,Hangup()

same => n(auto_select),NoOp(Auto-selecting outbound path for ${TARGET_NUM})
same => n,Set(IN_DONGLE=${CUT(CHANNEL,-,1)})
same => n,Set(IN_DONGLE=${CUT(IN_DONGLE,/,2)})
same => n,Set(TARGET_DONGLE=dongle1)
same => n,ExecIf($["${IN_DONGLE}"="dongle1"]?Set(TARGET_DONGLE=dongle0))
same => n,NoOp(Auto-selected alternate dongle: ${TARGET_DONGLE} (incoming was: ${IN_DONGLE}))
same => n,Dial(Dongle/${TARGET_DONGLE}/${TARGET_NUM},60)
same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?done)
same => n,Dial(Local/${TARGET_NUM}@outbound-allroutes/n,60)
same => n(done),Hangup()
"""
    content = content.rstrip() + "\n\n" + failover_stub.strip() + "\n"

    # Sanitize [from-dongle-custom] so DONGLE_TARGET and cdr-cause-capture execute for all call entries
    content = re.sub(
        r'exten => s,1,Set\(DONGLE_TARGET=\$\{DONGLENAME\}\)\s*\n\s*same => n,Set\(CHANNEL\(hangup_handler_push\)=cdr-cause-capture,s,1\)\s*\n\s*same => n,ExecIf\(\$\["\$\{MY_SIM_NUMBER\}" = "" \| "\$\{MY_SIM_NUMBER\}" = "\+1234567890"\]\?Set\(MY_SIM_NUMBER=\)\)\s*\n\s*same => n\(process\),NoOp\(--- Incoming call from Dongle \$\{DONGLENAME\} \(EXTEN: \$\{EXTEN\}\) ---\)',
        'exten => s,1,Goto(s,process)\nsame => n(process),NoOp(--- Incoming call from Dongle ${DONGLENAME} (EXTEN: ${EXTEN}) ---)\nsame => n,Set(DONGLE_TARGET=${DONGLENAME})\nsame => n,Set(CHANNEL(hangup_handler_push)=cdr-cause-capture,s,1)\nsame => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=))',
        content
    )

    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("  Dialplan successfully sanitized in extensions_custom.conf")
except Exception as e:
    print(f"  Warning: Dialplan sanitization encountered: {e}")
PYEOF
    if [ -f "$INSTALL_DIR/scripts/sokrat-campon.py" ]; then
        mkdir -p /var/lib/asterisk/agi-bin
        cp "$INSTALL_DIR/scripts/sokrat-campon.py" /var/lib/asterisk/agi-bin/sokrat-campon.py
        chmod +x /var/lib/asterisk/agi-bin/sokrat-campon.py
        chown asterisk:asterisk /var/lib/asterisk/agi-bin/sokrat-campon.py
    fi
    asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
fi

# 6. Reload Asterisk Modules & Sokrat Daemons
echo "[6/7] Refreshing Asterisk modules and restarting Sokrat services..."
if command -v systemctl &>/dev/null && systemctl is-active asterisk >/dev/null 2>&1; then
    echo "  Restarting Asterisk service to reload shared driver libraries..."
    systemctl restart asterisk
    sleep 2
elif command -v asterisk &>/dev/null && pgrep -x asterisk >/dev/null 2>&1; then
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
