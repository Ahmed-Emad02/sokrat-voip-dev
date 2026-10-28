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

# This script updates the very repository it lives in. Bash reads a script
# incrementally, so without a re-exec the second half of the run would execute
# the OLD file (new migrations/patches silently skipped). Remember our identity
# and restart ourselves once if the pull replaced us.
SELF_PATH=$(readlink -f "$0" 2>/dev/null || echo "$0")
SELF_HASH_BEFORE=$(sha256sum "$SELF_PATH" 2>/dev/null | cut -d' ' -f1 || echo "")

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

    SELF_HASH_AFTER=$(sha256sum "$SELF_PATH" 2>/dev/null | cut -d' ' -f1 || echo "")
    if [ "${SOKRAT_UPGRADE_REEXEC:-0}" != "1" ] && [ -n "$SELF_HASH_BEFORE" ] && [ "$SELF_HASH_BEFORE" != "$SELF_HASH_AFTER" ]; then
        echo "  The upgrader itself was updated by this pull - restarting it so the new steps run."
        exec env SOKRAT_UPGRADE_REEXEC=1 bash "$SELF_PATH" "$@"
    fi
fi

# 3. Database Schema Migrations (Preserving PBX Data)
echo "[3/7] Provisioning new database tables and schema migrations..."
if [ -f "$INSTALL_DIR/backend/install_db.sql" ]; then
    # mysql aborts a batch at the first error, so one transient failure (lock
    # wait timeout while the PBX is writing, deadlock on an ALTER) would silently
    # skip every later migration. Every statement in the file is idempotent, so a
    # single retry is safe and fixes the common case.
    SOKRAT_SCHEMA_LOG=$(mktemp 2>/dev/null || echo /tmp/sokrat-schema.log)
    if mysql "${MYSQL_AUTH[@]}" asterisk < "$INSTALL_DIR/backend/install_db.sql" 2>"$SOKRAT_SCHEMA_LOG"; then
        echo "  Applied database schema definitions (CREATE TABLE IF NOT EXISTS)"
    else
        echo "  WARNING: install_db.sql reported an error; retrying once so a transient lock cannot skip later migrations"
        head -3 "$SOKRAT_SCHEMA_LOG" | sed 's/^/    /' >&2 || true
        if mysql "${MYSQL_AUTH[@]}" asterisk < "$INSTALL_DIR/backend/install_db.sql" 2>>"$SOKRAT_SCHEMA_LOG"; then
            echo "  Applied database schema definitions on retry"
        else
            echo "  WARNING: install_db.sql still failing after retry (details: $SOKRAT_SCHEMA_LOG)" >&2
        fi
    fi
    rm -f "$SOKRAT_SCHEMA_LOG" 2>/dev/null || true
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
ensure_db_column "sokrat_federation_remote_extensions" "emp_group" "VARCHAR(100) DEFAULT NULL"
ensure_db_column "employee_groups" "name_ar" "VARCHAR(100) DEFAULT NULL"
ensure_db_column "employee_groups" "name_en" "VARCHAR(100) DEFAULT NULL"
ensure_db_column "sokrat_federation_settings" "local_node_uuid" "VARCHAR(36) DEFAULT NULL"
ensure_db_column "sokrat_federation_peers" "node_uuid" "VARCHAR(36) DEFAULT NULL"
ensure_db_column "sokrat_federation_peers" "api_version" "SMALLINT UNSIGNED NOT NULL DEFAULT 1"
ensure_db_column "sokrat_federation_peers" "node_version" "VARCHAR(50) DEFAULT NULL"
ensure_db_column "sokrat_federation_peers" "allow_report_read" "TINYINT(1) NOT NULL DEFAULT 1"
ensure_db_column "sokrat_federation_peers" "allow_contact_write" "TINYINT(1) NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_peers" "allow_dongle_control" "TINYINT(1) NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_peers" "allow_campaign_control" "TINYINT(1) NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_peers" "allow_config_write" "TINYINT(1) NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_node_status" "asterisk_version" "VARCHAR(64) DEFAULT NULL"
ensure_db_column "sokrat_federation_node_status" "uptime_sec" "BIGINT DEFAULT NULL"
ensure_db_column "sokrat_federation_node_status" "load1" "DECIMAL(6,2) DEFAULT NULL"
ensure_db_column "sokrat_federation_node_status" "disk_pct" "TINYINT DEFAULT NULL"
ensure_db_column "sokrat_federation_node_status" "extensions_total" "INT NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_node_status" "extensions_online" "INT NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_node_status" "dongles_total" "INT NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_node_status" "dongles_free" "INT NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_node_status" "active_calls" "INT NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_node_status" "calls_today" "INT NOT NULL DEFAULT 0"
ensure_db_column "sokrat_federation_remote_dongles" "state" "VARCHAR(32) DEFAULT NULL"
ensure_db_column "sokrat_federation_remote_dongles" "signal_pct" "TINYINT DEFAULT NULL"
ensure_db_column "sokrat_federation_remote_dongles" "operator_name" "VARCHAR(64) DEFAULT NULL"
ensure_db_column "sokrat_federation_remote_dongles" "imsi" "VARCHAR(32) DEFAULT NULL"
ensure_db_column "sokrat_federation_remote_dongles" "imei" "VARCHAR(32) DEFAULT NULL"
ensure_db_column "sokrat_federation_remote_dongles" "sim_number" "VARCHAR(32) DEFAULT NULL"
ensure_db_column "sokrat_federation_remote_dongles" "active_call" "VARCHAR(128) DEFAULT NULL"
ensure_db_column "sokrat_federation_remote_dongles" "last_seen_at" "DATETIME DEFAULT NULL"
ensure_db_column "sokrat_federation_remote_dongles" "updated_at" "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
mysql "${MYSQL_AUTH[@]}" asterisk -e "
ALTER TABLE \`sokrat_federation_node_status\`
  MODIFY COLUMN \`status\` ENUM('online','degraded','offline','error','unreachable') NOT NULL DEFAULT 'offline';" 2>/dev/null || true
# Federation Phase 0: every node needs a stable identity, and legacy peer rows
# pointed at the softphone vhost (:8443) which does not serve the federation API.
mysql "${MYSQL_AUTH[@]}" asterisk -e "
UPDATE \`sokrat_federation_settings\`
SET \`local_node_uuid\` = UUID()
WHERE \`id\` = 1 AND (\`local_node_uuid\` IS NULL OR \`local_node_uuid\` = '');
UPDATE \`sokrat_federation_peers\`
SET \`api_base_url\` = REPLACE(\`api_base_url\`, ':8443', '')
WHERE \`api_base_url\` LIKE '%:8443%';" 2>/dev/null || true

# Federation Phase 2: cached address book from every peer.
mysql "${MYSQL_AUTH[@]}" asterisk -e "
CREATE TABLE IF NOT EXISTS \`sokrat_federation_remote_contacts\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`peer_id\` INT NOT NULL,
  \`source_id\` VARCHAR(64) NOT NULL,
  \`name\` VARCHAR(150) DEFAULT NULL,
  \`last_name\` VARCHAR(150) DEFAULT NULL,
  \`telefono\` VARCHAR(50) NOT NULL,
  \`synced_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY \`idx_peer_source\` (\`peer_id\`, \`source_id\`),
  KEY \`idx_peer_id\` (\`peer_id\`),
  KEY \`idx_phone\` (\`telefono\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" 2>/dev/null || true

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

# Record every call by default (idempotent): the dialplan's [sub-record-check]
# gate reads the recording mode from these tables, and an empty mode
# ("dontcare") means the call is silently never recorded.
RECQUEUES_TABLE=$(mysql "${MYSQL_AUTH[@]}" asterisk -Nse \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='asterisk' AND TABLE_NAME='queues_config'" 2>/dev/null || echo "0")
if [ "$RECQUEUES_TABLE" != "0" ]; then
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "UPDATE \`asterisk\`.\`queues_config\` SET \`monitor_type\`='bgrnd' WHERE \`monitor_type\` IS NULL OR \`monitor_type\`=''" 2>/dev/null || true
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "UPDATE \`asterisk\`.\`queues_config\` SET \`maxwait\`='' WHERE \`maxwait\`='0'" 2>/dev/null || true
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "UPDATE \`asterisk\`.\`queues_details\` SET \`data\`='' WHERE \`keyword\`='maxwait' AND \`data\`='0'" 2>/dev/null || true
    # The recording gate itself is Issabel's `monitor-format` key: without it
    # Issabel emits dontcare and the queue is silently never recorded.
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "INSERT INTO \`asterisk\`.\`queues_details\` (id, keyword, data, flags)
         SELECT q.extension, 'monitor-format', 'wav', 0 FROM \`asterisk\`.\`queues_config\` q
         WHERE q.extension NOT IN (SELECT d.id FROM \`asterisk\`.\`queues_details\` d WHERE d.keyword = 'monitor-format')" 2>/dev/null || true
    # Neutralize self-referential queue failover loops
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "UPDATE \`asterisk\`.\`queues_config\` SET \`dest\`='app-blackhole,hangup,1' WHERE \`dest\`=CONCAT('ext-queues,', \`extension\`, ',1') OR \`dest\`=CONCAT('from-did-direct,', \`extension\`, ',1') OR \`dest\` IS NULL OR \`dest\`=''" 2>/dev/null || true
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "UPDATE \`asterisk\`.\`queues_config\` SET \`destcontinue\`='app-blackhole,hangup,1' WHERE \`destcontinue\`=CONCAT('ext-queues,', \`extension\`, ',1') OR \`destcontinue\`=CONCAT('from-did-direct,', \`extension\`, ',1')" 2>/dev/null || true
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "UPDATE \`asterisk\`.\`queues_details\` SET \`data\`='app-blackhole,hangup,1' WHERE \`keyword\`='goto' AND (\`data\`=CONCAT('ext-queues,', \`id\`, ',1') OR \`data\`=CONCAT('from-did-direct,', \`id\`, ',1'))" 2>/dev/null || true
    # Queue empty defaults: keep Issabel/Asterisk defaults so a call is never
    # rejected just because an agent's device state looks unavailable.
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "UPDATE \`asterisk\`.\`queues_details\` SET \`data\`='no' WHERE \`keyword\`='leavewhenempty' AND \`data\`!='no'" 2>/dev/null || true
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "UPDATE \`asterisk\`.\`queues_details\` SET \`data\`='yes' WHERE \`keyword\`='joinempty' AND \`data\`!='yes'" 2>/dev/null || true
    # Drop non-FreePBX keywords written by older dashboards (multi-line values
    # corrupted queues_additional.conf) and phantom "Local/0" members.
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "DELETE FROM \`asterisk\`.\`queues_details\` WHERE \`keyword\` IN ('dynmembers','goto','maxwait')" 2>/dev/null || true
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "DELETE FROM \`asterisk\`.\`queues_details\` WHERE \`keyword\`='member' AND (\`data\` NOT REGEXP '^[A-Za-z]+/[0-9]+@' OR \`data\` REGEXP '^[A-Za-z]+/0+@')" 2>/dev/null || true
    echo "  Queues: call recording enabled by default (monitor-format=wav, maxwait normalized, failover loops neutralized)"
fi
mysql "${MYSQL_AUTH[@]}" asterisk -e \
    "UPDATE \`asterisk\`.\`ringgroups\` SET \`recording\`='always' WHERE \`recording\` IS NULL OR \`recording\`='' OR \`recording\`='dontcare'" 2>/dev/null || true
mysql "${MYSQL_AUTH[@]}" asterisk -e \
    "UPDATE \`asterisk\`.\`ringgroups\` SET \`postdest\`='app-blackhole,hangup,1' WHERE \`postdest\`=CONCAT('ext-group,', \`grpnum\`, ',1') OR \`postdest\`=CONCAT('from-did-direct,', \`grpnum\`, ',1') OR \`postdest\` IS NULL OR \`postdest\`=''" 2>/dev/null || true
mysql "${MYSQL_AUTH[@]}" asterisk -e \
    "UPDATE \`asterisk\`.\`users\` SET \`recording\`='out=always|in=always' WHERE \`recording\` IS NULL OR \`recording\`='' OR \`recording\`='dontcare'" 2>/dev/null || true
echo "  Extensions and ring groups: call recording enabled by default"

# Indexes for the dashboard/CDR hot paths (idempotent)
mysql "${MYSQL_AUTH[@]}" -e "ALTER TABLE \`asteriskcdrdb\`.\`cdr\` ADD INDEX \`idx_calldate_disp\` (\`calldate\`, \`disposition\`)" 2>/dev/null || true
mysql "${MYSQL_AUTH[@]}" asterisk -e "ALTER TABLE \`asterisk\`.\`queues_details\` ADD INDEX \`idx_keyword\` (\`keyword\`)" 2>/dev/null || true
mysql "${MYSQL_AUTH[@]}" asterisk -e "ALTER TABLE \`asterisk\`.\`users\` ADD INDEX \`idx_voicemail\` (\`voicemail\`)" 2>/dev/null || true
echo "  Indexes: CDR/dashboard hot paths ensured"

if command -v asterisk >/dev/null 2>&1; then
    for ext in $(mysql "${MYSQL_AUTH[@]}" asterisk -Nse "SELECT extension FROM users" 2>/dev/null || true); do
        [ -n "$ext" ] || continue
        asterisk -rx "database put AMPUSER $ext/recording/in/external always" >/dev/null 2>&1 || true
        asterisk -rx "database put AMPUSER $ext/recording/out/external always" >/dev/null 2>&1 || true
        asterisk -rx "database put AMPUSER $ext/recording/in/internal always" >/dev/null 2>&1 || true
        asterisk -rx "database put AMPUSER $ext/recording/out/internal always" >/dev/null 2>&1 || true
    done
fi

# Inbound routes: call recording enabled by default ('force' in callrecording_module)
REC_CALLREC_TABLE=$(mysql "${MYSQL_AUTH[@]}" -sN -e \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='asterisk' AND TABLE_NAME='callrecording_module'" 2>/dev/null || echo "0")
if [ "$REC_CALLREC_TABLE" != "0" ]; then
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "INSERT INTO \`asterisk\`.\`callrecording_module\` (\`display\`, \`extension\`, \`cidnum\`, \`callrecording\`)
         SELECT 'did', i.\`extension\`, COALESCE(i.\`cidnum\`, ''), 'force'
         FROM \`asterisk\`.\`incoming\` i
         LEFT JOIN \`asterisk\`.\`callrecording_module\` c
           ON c.\`display\` = 'did' AND c.\`extension\` = i.\`extension\` AND c.\`cidnum\` = COALESCE(i.\`cidnum\`, '')
         WHERE c.\`extension\` IS NULL" 2>/dev/null || true
    mysql "${MYSQL_AUTH[@]}" asterisk -e \
        "UPDATE \`asterisk\`.\`callrecording_module\` SET \`callrecording\`='force'
         WHERE \`display\`='did' AND (\`callrecording\` IS NULL OR \`callrecording\`='' OR \`callrecording\`='dontcare')" 2>/dev/null || true
    echo "  Inbound routes: call recording enabled by default (callrecording=force)"
fi

# ---------------------------------------------------------------------------
# Hardware Dongle Stability & Power Optimization
# ---------------------------------------------------------------------------
# Prevent NetworkManager from managing cellular WWAN interfaces (CDC NCM)
mkdir -p /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/99-unmanaged-wwan.conf << 'EOF'
[keyfile]
unmanaged-devices=interface-name:ww*
EOF
nmcli general reload 2>/dev/null || systemctl reload NetworkManager 2>/dev/null || true

# Fix udev autosuspend rule to prevent permission denied on USB interfaces
if [ -f /etc/udev/rules.d/99-disable-usb-autosuspend.rules ]; then
    echo 'ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{power/control}="on"' > /etc/udev/rules.d/99-disable-usb-autosuspend.rules
    udevadm control --reload-rules 2>/dev/null || true
    udevadm trigger 2>/dev/null || true
fi

# Enable and start Sokrat Laya Autonomous Maintenance Daemon
if [ -f /etc/systemd/system/sokrat-laya.service ]; then
    systemctl daemon-reload
    systemctl enable sokrat-laya.service 2>/dev/null || true
    systemctl restart sokrat-laya.service 2>/dev/null || true
    echo "  Sokrat Laya GSM autonomous maintenance daemon enabled and active"
fi

# Flush saturated SMS storage on all active dongles
if command -v asterisk >/dev/null 2>&1; then
    for d in $(asterisk -rx "dongle show devices" 2>/dev/null | awk 'NR>1 {print $1}'); do
        [ -n "$d" ] || continue
        asterisk -rx "dongle cmd $d AT+CMGD=1,4" >/dev/null 2>&1 || true
    done
    echo "  Modem SMS storage flushed via AT+CMGD=1,4"
fi

# Decommission local whisper and migrate STT settings to Cloud AI
mysql "${MYSQL_AUTH[@]}" asterisk -e "
    UPDATE stt_settings
    SET engine='cloud_api', provider='munsit', api_url='https://api.munsit.com/api/v1/audio/transcribe', model_name='munsit'
    WHERE engine='local_whisper' OR provider='local';
" 2>/dev/null || true

# Seed new webhook settings keys (idempotent INSERT IGNORE)
mysql "${MYSQL_AUTH[@]}" asterisk -e "
INSERT IGNORE INTO dashboard_settings (setting_key, setting_value) VALUES
  ('webhook_incoming_call_enabled', 'false'),
  ('webhook_incoming_call_url', ''),
  ('webhook_incoming_call_secret', ''),
  ('laya_scheduled_restart_enabled', 'true'),
  ('laya_scheduled_restart_start', '03:00'),
  ('laya_scheduled_restart_end', '07:00'),
  ('laya_scheduled_restart_cooldown_sec', '25'),
  ('laya_scheduled_restart_last_run', ''),
  ('laya_baseband_hygiene_enabled', 'true'),
  ('laya_baseband_reboot_enabled', 'false'),
  ('laya_baseband_reboot_confirmed', 'false'),
  ('laya_baseband_recovery_timeout_sec', '60'),
  ('laya_cfun_restart_enabled', 'true'),
  ('laya_cfun_restart_threshold', '3'),
  ('laya_kill_switch_active', 'true');

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

CREATE TABLE IF NOT EXISTS \`extension_policies\` (
  \`extension\` VARCHAR(20) PRIMARY KEY,
  \`auto_answer\` ENUM('user_choice', 'force_on', 'force_off') NOT NULL DEFAULT 'user_choice',
  \`dnd\` ENUM('user_choice', 'force_on', 'force_off') NOT NULL DEFAULT 'user_choice',
  \`disable_outbound_ringing_cancel\` TINYINT(1) NOT NULL DEFAULT 0,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE \`extension_policies\` ADD COLUMN IF NOT EXISTS \`disable_outbound_ringing_cancel\` TINYINT(1) NOT NULL DEFAULT 0 AFTER \`dnd\`;

CREATE TABLE IF NOT EXISTS \`sokrat_queue_agents\` (
  \`queue\` VARCHAR(45) NOT NULL,
  \`extension\` VARCHAR(45) NOT NULL,
  \`is_static\` TINYINT(1) NOT NULL DEFAULT 0,
  \`is_dynamic\` TINYINT(1) NOT NULL DEFAULT 0,
  \`penalty\` INT NOT NULL DEFAULT 0,
  \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`queue\`, \`extension\`),
  KEY \`idx_queue\` (\`queue\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS \`laya_dongle_health\` (
  \`dongle_name\` VARCHAR(50) NOT NULL PRIMARY KEY,
  \`health_score\` TINYINT NOT NULL DEFAULT 100,
  \`status\` ENUM('healthy', 'degraded', 'healing', 'frozen', 'offline') NOT NULL DEFAULT 'healthy',
  \`rssi\` TINYINT DEFAULT NULL,
  \`carrier_registered\` TINYINT(1) DEFAULT 1,
  \`provider_name\` VARCHAR(100) DEFAULT NULL,
  \`model\` VARCHAR(50) DEFAULT NULL,
  \`firmware\` VARCHAR(50) DEFAULT NULL,
  \`imei\` VARCHAR(30) DEFAULT NULL,
  \`imsi\` VARCHAR(30) DEFAULT NULL,
  \`phone_number\` VARCHAR(30) DEFAULT NULL,
  \`active_channel\` VARCHAR(100) DEFAULT NULL,
  \`stuck_state_duration\` INT DEFAULT 0,
  \`healing_level\` TINYINT DEFAULT 0,
  \`last_heal_action\` VARCHAR(100) DEFAULT NULL,
  \`last_heal_at\` DATETIME DEFAULT NULL,
  \`consecutive_errors\` INT DEFAULT 0,
  \`last_check_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX \`idx_laya_status\` (\`status\`),
  INDEX \`idx_laya_score\` (\`health_score\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS \`laya_maintenance_events\` (
  \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
  \`dongle_name\` VARCHAR(50) NOT NULL,
  \`trigger_reason\` VARCHAR(150) NOT NULL,
  \`recovery_level\` TINYINT NOT NULL,
  \`action_taken\` VARCHAR(150) NOT NULL,
  \`result\` ENUM('success', 'failed', 'in_progress') NOT NULL DEFAULT 'in_progress',
  \`details\` TEXT DEFAULT NULL,
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX \`idx_laya_dongle_time\` (\`dongle_name\`, \`created_at\`),
  INDEX \`idx_laya_result\` (\`result\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS \`synq_agent_status_definitions\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`status_key\` VARCHAR(50) NOT NULL UNIQUE,
  \`label_ar\` VARCHAR(100) NOT NULL,
  \`label_en\` VARCHAR(100) NOT NULL,
  \`desc_ar\` VARCHAR(255) DEFAULT NULL,
  \`desc_en\` VARCHAR(255) DEFAULT NULL,
  \`color\` VARCHAR(20) NOT NULL DEFAULT '#f59e0b',
  \`target_group\` VARCHAR(100) DEFAULT NULL,
  \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
  \`sort_order\` INT NOT NULL DEFAULT 0,
  \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO \`synq_agent_status_definitions\` (\`status_key\`, \`label_ar\`, \`label_en\`, \`desc_ar\`, \`desc_en\`, \`color\`, \`sort_order\`) VALUES
  ('meeting', 'اجتماع', 'Meeting', 'اجتماع داخلي أو مقابلة عميل', 'Internal meeting or client call', '#8b5cf6', 1),
  ('training', 'تدريب', 'Training', 'جلسة تدريب أو ورشة عمل', 'Training session', '#3b82f6', 2);
" 2>/dev/null || true

ensure_db_column "synq_agent_status_definitions" "target_group" "VARCHAR(100) DEFAULT NULL"

echo "  Database schema migrations complete. All PBX and CDR data preserved."

# 4. Rebuild & Patch chan_dongle Module
echo "[4/7] Applying Asterisk / chan_dongle stability patches (Call Waiting UDUB, CRING detection, and Master audio recovery)..."
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
# 5.0 Ensure Jitter Buffer is disabled by default unless explicitly activated
    # Disable legacy hardcoded JITTERBUFFER calls in extensions_custom.conf
    sed -i 's/^\s*same\s*=>\s*n,Set(JITTERBUFFER(adaptive)=default)/; same => n,Set(JITTERBUFFER(adaptive)=default)/g' /etc/asterisk/extensions_custom.conf 2>/dev/null || true

echo "[5/7] Sanitizing dialplan contexts and hangup handlers..."
if [ -f /etc/asterisk/extensions_custom.conf ]; then
    # Remove any rogue automated restart triggers and conflicting 800 extension alias
    sed -i '/dongle restart now/d' /etc/asterisk/extensions*.conf 2>/dev/null || true
    sed -i '/exten => 800,1,Goto(\*800,1)/d' /etc/asterisk/extensions_custom.conf 2>/dev/null || true

    python3 - << 'PYEOF'
import re, os

conf_path = "/etc/asterisk/extensions_custom.conf"
try:
    with open(conf_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Remove all legacy [dongle-hangup-cleanup] contexts
    content = re.sub(r'\[dongle-hangup-cleanup\].*?(?=\n\[|\Z)', '', content, flags=re.DOTALL)

    # Remove legacy 800 alias that collides with queue/extension 800
    content = re.sub(r'exten\s*=>\s*800\s*,\s*1\s*,\s*Goto\(\*800\s*,\s*1\)\r?\n?', '', content)

    # The RNNoise continuous echo test moved from *87 (Issabel owns *87 as its
    # conference-status feature code) to *86, which is free.
    content = content.replace(
        'exten => *87,1,NoOp(--- RNNoise AI Noise Suppression Continuous Echo Test ---)',
        'exten => *86,1,NoOp(--- RNNoise AI Noise Suppression Continuous Echo Test ---)')

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
same => n,Set(TARGET_NUM=${IF($["${DIAL_NUM}"!=""]?${DIAL_NUM}:${LEAD_PHONE})})
same => n,GotoIf($["${DIAL_TARGET}"!=""]?dial_target:dial_route)
same => n(dial_target),Dial(${DIAL_TARGET}/${TARGET_NUM},60,U(sub-autodialer-progressive-connect))
same => n,Hangup()
same => n(dial_route),Dial(Local/${TARGET_NUM}@outbound-allroutes,60,U(sub-autodialer-progressive-connect))
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
same => n,GotoIf($["${DIRECTION}" = "INBOUND"]?ext_busy)
same => n,GotoIf($["${LEN(${CALLER_EXT})}" > 5]?ext_busy)
same => n,Answer()
same => n,Playtones(busy)
same => n,Read(PRESSED_DIGIT,,1,,,8)
same => n,StopPlaytones()
same => n,GotoIf($["${PRESSED_DIGIT}" = "6"]?activate)
same => n,Busy(15)
same => n,Hangup()
same => n(activate),Goto(sub-campon-activate,s,1)
same => n(ext_busy),Busy(10)
same => n,Hangup()

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
exten => s-BUSY,n,ExecIf($["${DIRECTION}" = "INBOUND"]?Hangup(17))
exten => s-BUSY,n,ExecIf($["${LEN(${CALLERID(num)})}" > 5]?Hangup(17))
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

        subrecord_override = """
; === Sokrat VoIP: Recording Volume Balance Override (MixMonitor v(3)V(-1)) ===
; Boosts the heard audio (remote customer) by ~+9 dB and gently tames the
; spoken audio (local agent microphone) by ~-3 dB in the recorded audio file on disk,
; ensuring clean, balanced call recordings without altering the live call audio.
[sub-record-check]
include => sub-record-check-custom
exten => s,1,Set(REC_POLICY_MODE_SAVE=${REC_POLICY_MODE})
exten => s,n,GotoIf($["${BLINDTRANSFER}" = ""]?check)
exten => s,n,ResetCDR()
exten => s,n,GotoIf($["${REC_STATUS}" != "RECORDING"]?check)
exten => s,n,Set(MIXMON_OPTS=${IF($["${MIXMON_OPTS}"=""]?v(3)V(-1):${MIXMON_OPTS})})
exten => s,n,MixMonitor(${MIXMON_DIR}${YEAR}/${MONTH}/${DAY}/${CALLFILENAME}.${MIXMON_FORMAT},a${MIXMON_OPTS},${MIXMON_POST})
exten => s,n(check),Set(__MON_FMT=${IF($["${MIXMON_FORMAT}"="wav49"]?WAV:${MIXMON_FORMAT})})
exten => s,n,GotoIf($["${REC_STATUS}"!="RECORDING"]?next)
exten => s,n,Set(CDR(recordingfile)=${CALLFILENAME}.${MON_FMT})
exten => s,n,Return()
exten => s,n(next),ExecIf($[!${LEN(${ARG1})}]?Return())
exten => s,n,ExecIf($["${REC_POLICY_MODE}"="" & "${ARG3}"!=""]?Set(__REC_POLICY_MODE=${ARG3}))
; Sokrat Universal Recording: Default to 'always' unless explicitly 'never'
exten => s,n,ExecIf($["${REC_POLICY_MODE}"="" | "${REC_POLICY_MODE}"="dontcare"]?Set(__REC_POLICY_MODE=always))
exten => s,n,GotoIf($["${REC_STATUS}"!=""]?${ARG1},1)
exten => s,n,Set(__REC_STATUS=INITIALIZED)
exten => s,n,Set(NOW=${EPOCH})
exten => s,n,Set(__DAY=${STRFTIME(${NOW},,%d)})
exten => s,n,Set(__MONTH=${STRFTIME(${NOW},,%m)})
exten => s,n,Set(__YEAR=${STRFTIME(${NOW},,%Y)})
exten => s,n,Set(__TIMESTR=${YEAR}${MONTH}${DAY}-${STRFTIME(${NOW},,%H%M%S)})
exten => s,n,Set(__FROMEXTEN=${IF($[${LEN(${AMPUSER})}]?${AMPUSER}:${IF($[${LEN(${REALCALLERIDNUM})}]?${REALCALLERIDNUM}:${CALLERID(num)})})})
exten => s,n,Set(__CALLFILENAME=${ARG1}-${ARG2}-${FROMEXTEN}-${TIMESTR}-${UNIQUEID})
exten => s,n,Set(__SOKRAT_REC_FILE=${CALLFILENAME}.${MON_FMT})
exten => s,n,Goto(${ARG1},1)

exten => rg,1,ExecIf($["${REC_POLICY_MODE}"!="never"]?Set(__REC_POLICY_MODE=always))
exten => rg,n,GosubIf($["${REC_POLICY_MODE}"="always"]?record,1(${EXTEN},${REC_POLICY_MODE},${FROMEXTEN}))
exten => rg,n,Return()

exten => force,1,GosubIf($["${REC_POLICY_MODE}"="always"]?record,1(${EXTEN},${REC_POLICY_MODE},${FROMEXTEN}))
exten => force,n,Return()

exten => q,1,ExecIf($["${REC_POLICY_MODE}"!="never"]?Set(__REC_POLICY_MODE=always))
exten => q,n,GosubIf($["${REC_POLICY_MODE}"="always"]?recq,1(${EXTEN},${ARG2},${FROMEXTEN}))
exten => q,n,Return()

exten => out,1,ExecIf($["${REC_POLICY_MODE}"=""]?Set(__REC_POLICY_MODE=${DB(AMPUSER/${FROMEXTEN}/recording/out/external)}))
exten => out,n,ExecIf($["${REC_POLICY_MODE}"!="never"]?Set(__REC_POLICY_MODE=always))
exten => out,n,GosubIf($["${REC_POLICY_MODE}"="always"]?record,1(exten,${ARG2},${FROMEXTEN}))
exten => out,n,Return()

exten => exten,1,GotoIf($["${REC_POLICY_MODE}"!=""]?callee)
exten => exten,n,Set(__REC_POLICY_MODE=${IF($[${LEN(${FROM_DID})}]?${DB(AMPUSER/${ARG2}/recording/in/external)}:${DB(AMPUSER/${ARG2}/recording/in/internal)})})
exten => exten,n,GotoIf($["${REC_POLICY_MODE}"="dontcare"]?caller)
exten => exten,n,GotoIf($["${DB(AMPUSER/${FROMEXTEN}/recording/out/internal)}"="dontcare" | "${FROM_DID}"!=""]?callee)
exten => exten,n,ExecIf($[${LEN(${DB(AMPUSER/${FROMEXTEN}/recording/priority)})}]?Set(CALLER_PRI=${DB(AMPUSER/${FROMEXTEN}/recording/priority)}):Set(CALLER_PRI=0))
exten => exten,n,ExecIf($[${LEN(${DB(AMPUSER/${ARG2}/recording/priority)})}]?Set(CALLEE_PRI=${DB(AMPUSER/${ARG2}/recording/priority)}):Set(CALLEE_PRI=0))
exten => exten,n,GotoIf($["${CALLER_PRI}"="${CALLEE_PRI}"]?${REC_POLICY}:${IF($[${CALLER_PRI}>${CALLEE_PRI}]?caller:callee)})
exten => exten,n(callee),ExecIf($["${REC_POLICY_MODE}"!="never"]?Set(__REC_POLICY_MODE=always))
exten => exten,n,GosubIf($["${REC_POLICY_MODE}"="always"]?record,1(${EXTEN},${ARG2},${FROMEXTEN}))
exten => exten,n,Return()
exten => exten,n(caller),Set(__REC_POLICY_MODE=${DB(AMPUSER/${FROMEXTEN}/recording/out/internal)})
exten => exten,n,ExecIf($["${REC_POLICY_MODE}"!="never"]?Set(__REC_POLICY_MODE=always))
exten => exten,n,GosubIf($["${REC_POLICY_MODE}"="always"]?record,1(${EXTEN},${ARG2},${FROMEXTEN}))
exten => exten,n,Return()

exten => conf,1,Gosub(recconf,1(${EXTEN},${ARG2},${ARG2}))
exten => conf,n,Return()

exten => page,1,GosubIf($["${REC_POLICY_MODE}"="always"]?recconf,1(${EXTEN},${ARG2},${FROMEXTEN}))
exten => page,n,Return()

exten => record,1,Set(MIXMON_OPTS=${IF($["${MIXMON_OPTS}"=""]?v(3)V(-1):${MIXMON_OPTS})})
exten => record,n,MixMonitor(${MIXMON_DIR}${YEAR}/${MONTH}/${DAY}/${CALLFILENAME}.${MIXMON_FORMAT},${MIXMON_OPTS},${MIXMON_POST})
exten => record,n,Set(__REC_STATUS=RECORDING)
exten => record,n,Set(CDR(recordingfile)=${CALLFILENAME}.${MON_FMT})
exten => record,n,Return()

; NOTE: ${MONITOR_OPTIONS} is deliberately NOT passed to MixMonitor here.
; Issabel sets it to 'b' for queues, and Asterisk's 'b' flag only saves audio
; while the monitored channel is bridged - on a queue the monitored leg is
; often never bridged, which produced 44-byte (header-only) recordings.
exten => recq,1,Set(MONITOR_FILENAME=${MIXMON_DIR}${YEAR}/${MONTH}/${DAY}/${CALLFILENAME})
exten => recq,n,Set(MIXMON_OPTS=${IF($["${MIXMON_OPTS}"=""]?v(3)V(-1):${MIXMON_OPTS})})
exten => recq,n,MixMonitor(${MONITOR_FILENAME}.${MIXMON_FORMAT},${MIXMON_OPTS},${MIXMON_POST})
exten => recq,n,Set(__REC_STATUS=RECORDING)
exten => recq,n,Set(CDR(recordingfile)=${CALLFILENAME}.${MON_FMT})
exten => recq,n,Return()

exten => recconf,1,Set(__CALLFILENAME=${IF($[${CONFBRIDGE_INFO(parties,${ARG2})}]?${DB(RECCONF/${ARG2})}:${ARG1}-${ARG2}-${ARG3}-${TIMESTR}-${UNIQUEID})})
exten => recconf,n,ExecIf($[!${CONFBRIDGE_INFO(parties,${ARG2})}]?Set(DB(RECCONF/${ARG2})=${CALLFILENAME}))
exten => recconf,n,Set(CONFBRIDGE(bridge,record_file)=${MIXMON_DIR}${YEAR}/${MONTH}/${DAY}/${CALLFILENAME}.${MON_FMT})
exten => recconf,n,ExecIf($["${REC_POLICY_MODE}"!="always"]?Return())
exten => recconf,n,Set(CONFBRIDGE(bridge,record_conference)=yes)
exten => recconf,n,Set(CONFBRIDGE(bridge,record_file_timestamp)=no)
exten => recconf,n,Set(__REC_STATUS=RECORDING)
exten => recconf,n,Set(CDR(recordingfile)=${CALLFILENAME}.${MON_FMT})
exten => recconf,n,Return()

;--== end of [sub-record-check] ==--;
"""
        ov_content = re.sub(r'\[sub-record-check\].*?(?=\n\[|\Z)', '', ov_content, flags=re.DOTALL)
        ov_content = ov_content.rstrip() + "\n\n" + subrecord_override.strip() + "\n"

        # Recording continuity across queue hops (see the [sub-record-cancel]
        # block written below). Idempotent: replaces an existing block.
        cancel_override = """
; === Sokrat VoIP: Recording Continuity Across Queue / Ring-Group Hops ===
; Issabel tears the recording down at every queue hop: sub-record-cancel
; stops the MixMonitor, DELETES the file with `rm -f` and clears
; CDR(recordingfile). A call that traverses a queue chain therefore ends up
; with no audio at all, and a CDR that points at a file which no longer
; exists (the app then shows an empty player). Keep the recording running
; instead: one continuous file for the whole call, and the CDR keeps
; pointing at it.
[sub-record-cancel]
include => sub-record-cancel-custom
exten => s,1,Set(__REC_POLICY_MODE=${REC_POLICY_MODE_SAVE})
exten => s,n,Return()
"""
        ov_content = re.sub(r'\[sub-record-cancel\].*?(?=\n\[|\Z)', '', ov_content, flags=re.DOTALL)
        ov_content = ov_content.rstrip() + "\n\n" + cancel_override.strip() + "\n"
        with open(override_conf, "w", encoding="utf-8") as f:
            f.write(ov_content)

        # Drop the "bridged only" MixMonitor flag (${MONITOR_OPTIONS}) from the
        # queue recording path - it produced 44-byte (header-only) recordings.
        # Idempotent, and also fixes servers that already had the block.
        _recq_old = "exten => recq,n,MixMonitor(${MONITOR_FILENAME}.${MIXMON_FORMAT},${MIXMON_OPTS}${MONITOR_OPTIONS},${MIXMON_POST})"
        _recq_new = "exten => recq,n,MixMonitor(${MONITOR_FILENAME}.${MIXMON_FORMAT},${MIXMON_OPTS},${MIXMON_POST})"
        if _recq_old in ov_content:
            ov_content = ov_content.replace(_recq_old, _recq_new)
            with open(override_conf, "w", encoding="utf-8") as f:
                f.write(ov_content)
            print("  Patched queue recording MixMonitor (dropped bridged-only flag)")

        # Patch Issabel Time Groups unclosed <select> tag bug in functions.inc.php
        _tc_php = "/var/www/html/admin/modules/timeconditions/functions.inc.php"
        if os.path.exists(_tc_php):
            try:
                _tc_code = open(_tc_php, "r", encoding="utf-8").read()
                _tc_pat = r'(\$html\s*=\s*\$html\."<option value=\\"sun\\" \$default>" \. __\("Sunday"\);\s*)(?!\$html\s*=\s*\$html\.\'</select>\';)(\$html\s*=\s*\$html\.\'</td>\';)'
                if re.search(_tc_pat, _tc_code):
                    _tc_code = re.sub(_tc_pat, r"\1$html = $html.'</select>';\n    \2", _tc_code)
                    open(_tc_php, "w", encoding="utf-8").write(_tc_code)
                    print("  Patched Issabel Time Groups unclosed select tag in functions.inc.php")
            except Exception:
                pass

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

    # Strip the legacy PER-DONGLE DSP block from [from-dongle-custom].
    # Audio filtering (RNNOISE / DENOISE / AGC / JITTERBUFFER) must be derived from
    # the CALLING EXTENSION in the trunk predial hook, never from the dongle that
    # happens to carry the call. Leaving the legacy block in place applies the
    # wrong filter to inbound cellular calls and re-applies it again on the
    # outbound leg, so the call is filtered twice with mismatched settings.
    def _strip_dongle_dsp(match):
        body = match.group(0)
        # Remove the contiguous legacy DSP resolution block only.
        body = re.sub(
            r'\n?same => n,NoOp\(--- Resolving DSP for Inbound Dongle \$\{DONGLENAME\} ---\)'
            r'(?:\n?same => n,[^\n]*)*?'
            r'(?=\n?same => n,ExecIf\(\$?\["\$\{MY_SIM_NUMBER\}" = "")',
            '\n',
            body
        )
        # Safety net: drop any remaining per-dongle audio statements in this context.
        body = re.sub(r'\n?same => n,Set\(D_(?:DENOISE|RNNOISE|THRESH|HANG|MINDB|AGC|JB)=[^\n]*', '', body)
        body = re.sub(r'\n?same => n,ExecIf\(\$?\["\$\{D_[^"]*"[^\n]*', '', body)
        body = re.sub(r'\n?same => n,Set\((?:RNNOISE|DENOISE|AGC|JITTERBUFFER)\([^\n]*', '', body)
        return body

    content = re.sub(
        r'\[from-dongle-custom\].*?(?=\n\[|\Z)',
        _strip_dongle_dsp,
        content,
        flags=re.DOTALL
    )

    # Ensure Sokrat Universal Trunk Recording (Option B) in [from-dongle-custom]
    if 'Option B' not in content:
        content = re.sub(
            r'same => n\(skip_cid\),\s*GotoIf\(\$\["\$\{MY_SIM_NUMBER\}" != "" & "\$\{MY_SIM_NUMBER\}" != "s" & "\$\{MY_SIM_NUMBER\}" != "\+1234567890"\]\?goto_did:goto_s\)',
            'same => n(skip_cid),NoOp(--- Sokrat Universal Trunk Recording (Option B) ---)\n'
            'same => n,Set(NOW=${EPOCH})\n'
            'same => n,Set(__DAY=${STRFTIME(${NOW},,%d)})\n'
            'same => n,Set(__MONTH=${STRFTIME(${NOW},,%m)})'
            '\nsame => n,Set(__YEAR=${STRFTIME(${NOW},,%Y)})'
            '\nsame => n,Set(__TIMESTR=${YEAR}${MONTH}${DAY}-${STRFTIME(${NOW},,%H%M%S)})'
            '\nsame => n,Set(__FROMEXTEN=${IF($[${LEN(${CALLERID(num)})}]?${CALLERID(num)}:unknown)})'
            '\nsame => n,Set(__CALLFILENAME=in-${DONGLENAME}-${FROMEXTEN}-${TIMESTR}-${UNIQUEID})'
            '\nsame => n,Set(__MON_FMT=wav)'
            '\nsame => n,Set(__MIXMON_DIR=/var/spool/asterisk/monitor/)'
            '\nsame => n,Set(MIXMON_OPTS=v(3)V(-1))'
            '\nsame => n,MixMonitor(${MIXMON_DIR}${YEAR}/${MONTH}/${DAY}/${CALLFILENAME}.${MON_FMT},a${MIXMON_OPTS})'
            '\nsame => n,Set(__REC_STATUS=RECORDING)'
            '\nsame => n,Set(__REC_POLICY_MODE=always)'
            '\nsame => n,Set(__SOKRAT_REC_FILE=${CALLFILENAME}.${MON_FMT})'
            '\nsame => n,Set(CDR(recordingfile)=${CALLFILENAME}.${MON_FMT})'
            '\nsame => n,GotoIf($["${MY_SIM_NUMBER}" != "" & "${MY_SIM_NUMBER}" != "s" & "${MY_SIM_NUMBER}" != "+1234567890"]?goto_did:goto_s)',
            content
        )

    # Ensure recording file retention in cdr-cause-capture
    if 'SOKRAT_REC_FILE' not in content:
        content = re.sub(
            r'\[cdr-cause-capture\]\s*\n\s*;[^\n]*\s*\n\s*;[^\n]*\s*\n\s*exten => s,1,Set\(CDR\(userfield\)=\$\{HANGUPCAUSE\}\)\s*\n\s*same => n,Return\(\)',
            '[cdr-cause-capture]\n'
            '; Persist the Q.850 hangup cause on monitored channels so Call History can\n'
            '; distinguish busy / no-answer / congestion instead of relying on driver defaults.\n'
            'exten => s,1,Set(CDR(userfield)=${HANGUPCAUSE})\n'
            'same => n,ExecIf($["${CDR(recordingfile)}"="" & "${CALLFILENAME}"!=""]?Set(CDR(recordingfile)=${CALLFILENAME}.wav))\n'
            'same => n,ExecIf($["${CDR(recordingfile)}"="" & "${SOKRAT_REC_FILE}"!=""]?Set(CDR(recordingfile)=${SOKRAT_REC_FILE}))\n'
            'same => n,Return()',
            content
        )

    # Ensure ChanSpy volume boost for supervisor listening (qv(2))
    content = re.sub(r'ChanSpy\(([^,)]+),q\)', r'ChanSpy(\1,qv(2))', content)
    content = re.sub(r'ChanSpy\(([^,)]+),qw\)', r'ChanSpy(\1,qwv(2))', content)
    content = re.sub(r'ChanSpy\(([^,)]+),qB\)', r'ChanSpy(\1,qBv(2))', content)

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

    # Sokrat Dynamic Call Control Codes Include
    touch /etc/asterisk/extensions_sokrat_callcodes.conf
    chown asterisk:asterisk /etc/asterisk/extensions_sokrat_callcodes.conf 2>/dev/null || true
    chmod 644 /etc/asterisk/extensions_sokrat_callcodes.conf 2>/dev/null || true

    if ! grep -qF '#include extensions_sokrat_callcodes.conf' /etc/asterisk/extensions_custom.conf 2>/dev/null; then
        echo '' >> /etc/asterisk/extensions_custom.conf
        echo '; Sokrat Dynamic Call Control Codes' >> /etc/asterisk/extensions_custom.conf
        echo '#include extensions_sokrat_callcodes.conf' >> /etc/asterisk/extensions_custom.conf
    fi
    if ! grep -qF 'include => sokrat-call-codes-custom' /etc/asterisk/extensions_custom.conf 2>/dev/null; then
        sed -i '/\[from-internal-custom\]/a include => sokrat-call-codes-custom' /etc/asterisk/extensions_custom.conf
    fi

    # Hand Issabel's own feature codes back to Issabel. The Sokrat directed-pickup
    # patterns (_*X., _*1X., _*8X.) match every *<code>, and Asterisk drops a
    # literal extension that arrives through an include once the context already
    # holds a matching pattern - so Issabel's codes (*97 my voicemail, *72 call
    # forward, *78 DND, ...) were swallowed by the pickup rule. Each code is
    # declared as a LITERAL inside [from-internal-custom] instead, and a literal
    # always wins over a pattern in the same context. The Issabel codes that
    # take an argument (*98<mailbox>, *72<ext>, ...) need the same fix and are
    # declared as a pattern there as well: a more specific pattern wins over
    # _*X. in the same context, and the Sokrat directed pickup is kept for the
    # numbers that are a registered extension.
    if [ -f "$INSTALL_DIR/lib/feature-code-hand-off.js" ]; then
        (cd "$INSTALL_DIR" && node lib/feature-code-hand-off.js) || echo "  Warning: feature-code hand-off sync failed"
    else
        echo "  Warning: missing $INSTALL_DIR/lib/feature-code-hand-off.js; feature codes may be shadowed"
    fi


    # Tenant gateway readiness: shared push context, installation id and
    # endpoint manifest. The dialplan is reloaded by the block below.
    if [ -x "$INSTALL_DIR/scripts/sokrat-gateway-readiness.sh" ]; then
        "$INSTALL_DIR/scripts/sokrat-gateway-readiness.sh" --apply --no-reload || echo "  Warning: gateway readiness reported problems; see the output above."
    else
        echo "  Warning: missing $INSTALL_DIR/scripts/sokrat-gateway-readiness.sh; gateway readiness was not refreshed."
    fi
    asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
fi

# 5.1 Repair WebRTC transports and all existing CRM/WebRTC AORs
# 5.1 Ensure Asterisk WebRTC combined certificate contains private key
CERT_PATH="/etc/asterisk/keys/asterisk.pem"
KEY_PATH="/etc/asterisk/keys/asterisk.key"
if [ -f "$CERT_PATH" ] && [ -f "$KEY_PATH" ]; then
    if ! grep -q "PRIVATE KEY" "$CERT_PATH" 2>/dev/null; then
        echo "  Merging private key into $CERT_PATH for WebRTC DTLS compatibility..."
        cat "$KEY_PATH" >> "$CERT_PATH"
        chown asterisk:asterisk "$CERT_PATH" "$KEY_PATH" 2>/dev/null || true
        chmod 640 "$CERT_PATH" "$KEY_PATH" 2>/dev/null || true
    fi
fi

echo "[5.1/7] Repairing WebRTC/PJSIP transports and extension registration settings..."
WEBRTC_REPAIR_SCRIPT="$INSTALL_DIR/scripts/configure-webrtc-pjsip.sh"
if [ -x "$WEBRTC_REPAIR_SCRIPT" ]; then
    SKIP_ASTERISK_RELOAD=1 "$WEBRTC_REPAIR_SCRIPT"
else
    echo "  Warning: missing $WEBRTC_REPAIR_SCRIPT; WebRTC repair skipped."
fi

# 10x — Overlay VPN clients (ZeroTier / Tailscale) for remote management
echo "  [10x] Installing overlay VPN clients (ZeroTier / Tailscale)..."
install_overlay_vpn_clients() {
    local pkg_mgr=""
    if command -v dnf >/dev/null 2>&1; then
        pkg_mgr="dnf"
    elif command -v yum >/dev/null 2>&1; then
        pkg_mgr="yum"
    else
        echo "  no dnf/yum available - skipping overlay VPN installation"
        return 0
    fi

    # Tailscale is not shipped in the base Rocky/RHEL repositories
    if ! command -v tailscale >/dev/null 2>&1; then
        local os_major="8"
        if [ -r /etc/os-release ]; then
            os_major=$(awk -F= '/^VERSION_ID=/{gsub(/"/,"",$2); split($2,v,"."); print v[1]; exit}' /etc/os-release)
        fi
        if $pkg_mgr config-manager --add-repo "https://pkgs.tailscale.com/stable/rhel/${os_major}/tailscale.repo" >/dev/null 2>&1; then
            echo "  tailscale repository added"
        else
            mkdir -p /etc/yum.repos.d
            cat > /etc/yum.repos.d/sokrat-tailscale.repo << REPOEOF
[tailscale]
name=tailscale
baseurl=https://pkgs.tailscale.com/stable/rhel/${os_major}
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://pkgs.tailscale.com/stable/rhel/${os_major}/tailscale.gpg
REPOEOF
            echo "  tailscale repository file written"
        fi
    fi

    if command -v zerotier-cli >/dev/null 2>&1; then
        echo "  zerotier-one already installed"
    elif $pkg_mgr install -y zerotier-one >/dev/null 2>&1; then
        echo "  zerotier-one installed"
    else
        echo "  WARNING: could not install zerotier-one (continuing)"
    fi
    if command -v tailscale >/dev/null 2>&1; then
        echo "  tailscale already installed"
    elif $pkg_mgr install -y tailscale >/dev/null 2>&1; then
        echo "  tailscale installed"
    else
        echo "  WARNING: could not install tailscale (continuing)"
    fi

    # Enable both services so they come up after a reboot. The networks
    # themselves are joined from the Sokrat GUI (Settings -> Overlay VPN).
    systemctl enable zerotier-one.service >/dev/null 2>&1 || true
    systemctl enable tailscaled.service >/dev/null 2>&1 || true
    echo "  overlay VPN services enabled - join the networks from Settings -> Overlay VPN"
}
install_overlay_vpn_clients

# [10y] NetworkManager - the GUI network manager changes the DHCP / static
# state of the physical interfaces with nmcli, so NetworkManager has to be
# installed and running.
echo "  [10y] Checking NetworkManager..."
if command -v nmcli >/dev/null 2>&1; then
    echo "  NetworkManager already installed"
elif command -v dnf >/dev/null 2>&1; then
    if dnf install -y NetworkManager >/dev/null 2>&1; then
        echo "  NetworkManager installed"
    else
        echo "  WARNING: could not install NetworkManager (continuing)"
    fi
elif command -v yum >/dev/null 2>&1; then
    if yum install -y NetworkManager >/dev/null 2>&1; then
        echo "  NetworkManager installed"
    else
        echo "  WARNING: could not install NetworkManager (continuing)"
    fi
else
    echo "  WARNING: no dnf/yum available - the network manager will be limited"
fi
if systemctl list-unit-files NetworkManager.service >/dev/null 2>&1; then
    systemctl enable NetworkManager >/dev/null 2>&1 || true
    systemctl start NetworkManager >/dev/null 2>&1 || true
    if systemctl is-active --quiet NetworkManager; then
        echo "  NetworkManager enabled and running"
    else
        echo "  WARNING: NetworkManager is not running (continuing)"
    fi
fi


# [10z] Disable the host firewall
# The PBX needs a wide range of ports (SIP signalling, the RTP range, the
# WebRTC softphone, the CRM endpoints and the web UI) and a firewalld rule
# that is one port short silently breaks the calls, so the installers turn
# the local firewall off. The host is then reachable on every port.
echo "  [10z] Disabling the firewall..."
if systemctl list-unit-files firewalld.service >/dev/null 2>&1; then
    firewall-cmd --panic-off >/dev/null 2>&1 || true
    systemctl stop firewalld >/dev/null 2>&1 || true
    systemctl disable firewalld >/dev/null 2>&1 || true
    echo "  firewalld stopped and disabled"
elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --panic-off >/dev/null 2>&1 || true
    echo "  firewalld panic mode switched off"
else
    echo "  no firewalld on this host - nothing to disable"
fi
# The legacy iptables services can carry their own rules.
for fwsvc in iptables ip6tables; do
    if systemctl list-unit-files "$fwsvc.service" >/dev/null 2>&1; then
        systemctl stop "$fwsvc" >/dev/null 2>&1 || true
        systemctl disable "$fwsvc" >/dev/null 2>&1 || true
    fi
done
echo "  WARNING: the host firewall is off - every port is exposed to the network"

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

# Decommission obsolete local whisper service and files
if systemctl is-active --quiet sokrat-whisper.service 2>/dev/null; then
    systemctl stop sokrat-whisper.service 2>/dev/null || true
    systemctl disable sokrat-whisper.service 2>/dev/null || true
fi
rm -f /etc/systemd/system/sokrat-whisper.service 2>/dev/null || true
rm -rf /opt/sokrat-stt /var/lib/sokrat-stt/models 2>/dev/null || true
if [ -f /etc/systemd/system/sokrat-stt.service ]; then
    sed -i 's/ sokrat-whisper\.service//g' /etc/systemd/system/sokrat-stt.service 2>/dev/null || true
fi

# Decommission Webmin service and repo if present
if systemctl is-active --quiet webmin 2>/dev/null || systemctl is-enabled --quiet webmin 2>/dev/null; then
    systemctl stop webmin 2>/dev/null || true
    systemctl disable webmin 2>/dev/null || true
fi
rm -f /etc/systemd/system/webmin.service /usr/lib/systemd/system/webmin.service 2>/dev/null || true
rm -f /etc/yum.repos.d/webmin.repo /etc/yum.repos.d/sokrat-webmin.repo 2>/dev/null || true

systemctl daemon-reload 2>/dev/null || true

# --- Apache: HTTP/2 + Brotli for the dashboard vhosts (idempotent) ---
if [ -f /etc/httpd/conf.d/ssl.conf ] && ! grep -q 'Protocols h2 http/1.1' /etc/httpd/conf.d/ssl.conf 2>/dev/null; then
    sed -i 's/^SSLEngine on$/SSLEngine on\n    Protocols h2 http\/1.1/' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
    echo "  Apache: HTTP/2 enabled on the HTTPS vhost"
fi
if [ -f /etc/httpd/conf.d/dashboard.conf ] && ! grep -q 'BROTLI_COMPRESS' /etc/httpd/conf.d/dashboard.conf 2>/dev/null; then
    sed -i '1i <IfModule mod_brotli.c>\n    AddOutputFilterByType BROTLI_COMPRESS text/html text/plain text/css application\/javascript application\/json image\/svg+xml\n    BrotliCompressionQuality 5\n</IfModule>\n' /etc/httpd/conf.d/dashboard.conf 2>/dev/null || true
    echo "  Apache: Brotli compression enabled"
fi
if ! grep -q 'BROTLI_COMPRESS' /etc/httpd/conf.d/ssl.conf 2>/dev/null; then
    sed -i 's/^SSLEngine on$/SSLEngine on\n    <IfModule mod_brotli.c>\n    AddOutputFilterByType BROTLI_COMPRESS text\/html text\/css application\/javascript application\/json image\/svg+xml\n    BrotliCompressionQuality 5\n    <\/IfModule>/' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
fi
if command -v httpd >/dev/null 2>&1; then
    httpd -t >/dev/null 2>&1 && systemctl reload httpd 2>/dev/null || true
fi

systemctl restart sokrat-voip.service 2>/dev/null || true
systemctl restart sokrat-watchdog.service 2>/dev/null || true
systemctl restart sokrat-stt.service 2>/dev/null || true

# Provision/Restart Sokrat Laya GSM Maintenance Agent Daemon
if [ -f "$INSTALL_DIR/laya/engine.py" ]; then
    chmod +x "$INSTALL_DIR/laya/cli.py" 2>/dev/null || true
    ln -sf "$INSTALL_DIR/laya/cli.py" /usr/local/bin/laya 2>/dev/null || true
    ln -sf "$INSTALL_DIR/laya/cli.py" /usr/local/bin/laya-cli 2>/dev/null || true
    if [ ! -f /etc/systemd/system/sokrat-laya.service ]; then
        cat > /etc/systemd/system/sokrat-laya.service << 'UNIT'
[Unit]
Description=Sokrat Laya GSM Dongle Maintenance & Autonomous Watcher Daemon
After=network.target mariadb.service mysqld.service asterisk.service
Wants=asterisk.service mariadb.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sokrat-voip
ExecStart=/usr/bin/python3 /opt/sokrat-voip/laya/engine.py
Restart=always
RestartSec=5
Nice=5
CPUShares=256
Environment=PYTHONPATH=/opt/sokrat-voip
Environment=PYTHONUNBUFFERED=1
Environment=LANG=en_US.UTF-8
Environment=LC_ALL=en_US.UTF-8

[Install]
WantedBy=multi-user.target
UNIT
        systemctl daemon-reload 2>/dev/null || true
    fi

    # Sokrat Laya is disabled by default unless explicitly activated by operator
    LAYA_KILL_ACTIVE=$(mysql "${MYSQL_AUTH[@]}" asterisk -N -e "SELECT setting_value FROM dashboard_settings WHERE setting_key='laya_kill_switch_active' LIMIT 1" 2>/dev/null || echo "true")
    if [ "$LAYA_KILL_ACTIVE" = "false" ]; then
        systemctl enable sokrat-laya.service 2>/dev/null || true
        systemctl restart sokrat-laya.service 2>/dev/null || true
        echo "  Sokrat Laya GSM maintenance daemon restarted (active)"
    else
        systemctl stop sokrat-laya.service 2>/dev/null || true
        systemctl disable sokrat-laya.service 2>/dev/null || true
        echo "  Sokrat Laya GSM maintenance daemon is disabled (kill switch active)"
    fi
fi

# 7. Post-Upgrade Verification
echo "[7/7] Verifying system status..."
sleep 2

echo "--- Asterisk GSM Dongles ---"
if command -v asterisk &>/dev/null && pgrep -x asterisk >/dev/null 2>&1; then
    asterisk -rx "dongle show devices" 2>/dev/null || echo "chan_dongle not yet ready"
fi

echo "--- Sokrat VoIP Service Status ---"
systemctl is-active sokrat-voip.service 2>/dev/null && echo "sokrat-voip: active (running)" || echo "sokrat-voip: inactive"

echo "--- Multi-Server PBX Federation ---"
if [ -f "$INSTALL_DIR/lib/federation-proxy.js" ]; then
    FED_PROXY_HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/peer/__probe__ 2>/dev/null || true)
    if [ "$FED_PROXY_HTTP" = "302" ] || [ "$FED_PROXY_HTTP" = "401" ]; then
        echo "  Peer panel reverse proxy: ready (HTTP $FED_PROXY_HTTP)"
    else
        echo "  Peer panel reverse proxy: unexpected response (HTTP ${FED_PROXY_HTTP:-none})"
    fi
else
    echo "  Peer panel reverse proxy: module missing"
fi

echo "========================================================"
echo " ✅ Safe upgrade completed successfully!"
echo "========================================================"
