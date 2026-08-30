#!/bin/bash
# Issabel Dashboard — Automated installer for Issabel 5 / Asterisk 18
# Run as root on a fresh Issabel 5 installation.
# Usage: bash install.sh

set -euo pipefail

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

INSTALL_DIR=/opt/sokrat-voip
REPO_URL=https://github.com/Ahmed-Emad02/sokrat-voip-dev.git
REPO_BRANCH=main
SOFTPHONE_DIR=/opt/sokrat-softphone
SOFTPHONE_REPO_URL=https://github.com/Ahmed-Emad02/sokrat-voice.git
SOFTPHONE_REPO_BRANCH=main
NODE_SETUP_URL=https://rpm.nodesource.com/setup_22.x
MYSQL_ROOT_PWD=$(grep mysqlrootpwd /etc/issabel.conf 2>/dev/null | cut -d= -f2- | xargs || true)
echo "============================================"
echo " Sokrat VOIP Installer v1.0.4"
echo " Target: Asterisk 18"
echo "============================================"
# Collect required interactive input BEFORE any system checks or package installations.
# When the installer is piped to Bash, stdin contains the script, so read from the
# controlling terminal (or another terminal-backed descriptor) instead.
collect_dongle_count() {
    local input_fd
    local user_val=""
    local default_count=1

    if [[ -n "${NUM_DONGLES:-}" ]]; then
        if [[ "$NUM_DONGLES" =~ ^([1-9]|1[0-9]|2[0-5])$ ]]; then
            return 0
        fi
        echo "Error: NUM_DONGLES must be a number between 1 and 25." >&2
        return 1
    fi

    if [[ -t 0 ]]; then
        input_fd=0
    elif { exec 3<>/dev/tty; } 2>/dev/null; then
        input_fd=3
    elif [[ -t 1 ]] && { exec 3<>/proc/self/fd/1; } 2>/dev/null; then
        input_fd=3
    elif [[ -t 2 ]] && { exec 3<>/proc/self/fd/2; } 2>/dev/null; then
        input_fd=3
    else
        echo "Error: no interactive terminal is available for the dongle count prompt." >&2
        echo "Download install.sh and run 'bash install.sh', or set NUM_DONGLES to a value from 1 to 25." >&2
        return 1
    fi

    while true; do
        printf "Enter the number of GSM dongles to activate on this server (1-25) [default: %s]: " "$default_count"
        if ! IFS= read -r -u "$input_fd" user_val; then
            if [[ "$input_fd" -eq 3 ]]; then
                exec 3>&-
            fi
            echo >&2
            echo "Error: could not read the GSM dongle count; installation stopped." >&2
            return 1
        fi

        user_val="${user_val//[[:space:]]/}"
        if [[ -z "$user_val" ]]; then
            NUM_DONGLES=$default_count
            break
        fi
        if [[ "$user_val" =~ ^([1-9]|1[0-9]|2[0-5])$ ]]; then
            NUM_DONGLES=$user_val
            break
        fi

        echo "Invalid input '$user_val'. Please enter a number between 1 and 25."
    done

    if [[ "$input_fd" -eq 3 ]]; then
        exec 3>&-
    fi
}

collect_dongle_count
echo " GSM dongles selected: $NUM_DONGLES"
echo "============================================"
echo ""

# ──────────────────────────────────────────────
# Step 1 — System Packages + Disable Fail2Ban
# ──────────────────────────────────────────────
echo "[1/14] Installing system packages..."
# Install EPEL first so sox (which lives in EPEL) resolves
yum install -y epel-release
yum install -y nano net-tools sox sqlite picotts

# Announcements in Issabel use picotts.agi, which requires both sox and pico2wave.
PICO_AGI_SOURCE=/var/www/html/admin/modules/announcement/agi-bin/picotts.agi
PICO_AGI_TARGET=/var/lib/asterisk/agi-bin/picotts.agi
if ! command -v pico2wave &>/dev/null; then
    echo "  Error: picotts installed without the required pico2wave binary" >&2
    exit 1
fi
if [ ! -f "$PICO_AGI_SOURCE" ]; then
    echo "  Error: Issabel's Announcements module is missing $PICO_AGI_SOURCE" >&2
    exit 1
fi
install -d -o asterisk -g asterisk -m 0755 "$(dirname "$PICO_AGI_TARGET")"
install -o asterisk -g asterisk -m 0755 "$PICO_AGI_SOURCE" "$PICO_AGI_TARGET"
perl -c "$PICO_AGI_TARGET" >/dev/null 2>&1

PICO_TEST_WAV="/tmp/sokrat-pico-test-$$.wav"
if ! pico2wave -l en-US -w "$PICO_TEST_WAV" "Sokrat VoIP" || [ ! -s "$PICO_TEST_WAV" ]; then
    rm -f "$PICO_TEST_WAV"
    echo "  Error: Pico TTS synthesis check failed" >&2
    exit 1
fi
rm -f "$PICO_TEST_WAV"
echo "  Announcement TTS dependencies verified"
echo "  System packages installed"
# fail2ban is optional; disable if the unit exists
if systemctl is-enabled fail2ban &>/dev/null; then
    systemctl disable --now fail2ban
    echo "  fail2ban disabled"
else
    echo "  fail2ban not present, skipping"
fi

# ──────────────────────────────────────────────
# Step 2 — Install Node.js 22
# ──────────────────────────────────────────────
echo "[2/14] Installing Node.js 22..."
if ! command -v node &>/dev/null; then
    curl -fsSL -o /tmp/nodesetup.sh "$NODE_SETUP_URL"
    bash /tmp/nodesetup.sh
    yum install -y nodejs
    rm -f /tmp/nodesetup.sh
else
    echo "  Node.js already installed: $(node -v)"
fi

# ──────────────────────────────────────────────
# Step 3 — Clone the Repository
# ──────────────────────────────────────────────
echo "[3/14] Cloning repository..."
systemctl stop sokrat-voip 2>/dev/null || true
yum install -y git net-tools

# Optimize git HTTP settings to prevent SSL_ERROR_SYSCALL on slow/unstable networks
git config --global http.postBuffer 524288000 2>/dev/null || true
git config --global http.lowSpeedLimit 1000 2>/dev/null || true
git config --global http.lowSpeedTime 300 2>/dev/null || true

if [ -d "$INSTALL_DIR" ]; then
    echo "  Directory $INSTALL_DIR exists, maintaining local modifications..."
    cd "$INSTALL_DIR"
    git config http.postBuffer 524288000 2>/dev/null || true
    git remote set-url origin "$REPO_URL" 2>/dev/null || true
    git fetch --depth 1 origin "$REPO_BRANCH" 2>/dev/null || true
    if git diff-index --quiet HEAD -- 2>/dev/null; then
        git checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH" 2>/dev/null || true
    fi
else
    if ! git clone --depth 1 --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"; then
        echo "  Shallow clone failed, retrying git clone..."
        git clone --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
fi

# 3b — Clone / Update Sokrat VOICE (WebRTC Softphone)
echo "  [3b] Cloning Sokrat VOICE (WebRTC Softphone) repository..."
systemctl stop sokrat-softphone 2>/dev/null || true
if [ -d "$SOFTPHONE_DIR" ]; then
    echo "  Directory $SOFTPHONE_DIR exists, maintaining local modifications..."
    cd "$SOFTPHONE_DIR"
    git config http.postBuffer 524288000 2>/dev/null || true
    git remote set-url origin "$SOFTPHONE_REPO_URL" 2>/dev/null || true
    git fetch --depth 1 origin "$SOFTPHONE_REPO_BRANCH" 2>/dev/null || true
    if git diff-index --quiet HEAD -- 2>/dev/null; then
        git checkout -B "$SOFTPHONE_REPO_BRANCH" "origin/$SOFTPHONE_REPO_BRANCH" 2>/dev/null || true
    fi
    cd "$INSTALL_DIR"
else
    if ! git clone --depth 1 --branch "$SOFTPHONE_REPO_BRANCH" --single-branch "$SOFTPHONE_REPO_URL" "$SOFTPHONE_DIR"; then
        echo "  Shallow clone failed, retrying git clone..."
        git clone --branch "$SOFTPHONE_REPO_BRANCH" --single-branch "$SOFTPHONE_REPO_URL" "$SOFTPHONE_DIR"
    fi
    cd "$INSTALL_DIR"
fi


# ──────────────────────────────────────────────
# Step 4 — Install Dependencies
# ──────────────────────────────────────────────
echo "[4/14] Installing npm dependencies from package-lock.json..."
npm ci --omit=dev

echo "  [4a] Installing Sokrat VOICE softphone npm dependencies..."
if [ -d "$SOFTPHONE_DIR" ]; then
    cd "$SOFTPHONE_DIR"
    npm install --omit=dev 2>/dev/null || true
    cd "$INSTALL_DIR"
fi
echo "  [4b] Installing ffmpeg (static build, recording upload conversion)..."
if ! command -v ffmpeg &>/dev/null && [ ! -x /usr/local/bin/ffmpeg ]; then
    if yum install -y ffmpeg &>/dev/null; then
        echo "  ffmpeg installed via package manager"
    else
        echo "  Checking static ffmpeg mirrors (5s timeout)..."
        cd /tmp
        rm -rf ffmpeg-*-static ffmpeg-release-amd64-static.tar.xz
        if curl -fsSL --connect-timeout 5 --max-time 15 -o /usr/local/bin/ffmpeg "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64" 2>/dev/null; then
            chmod +x /usr/local/bin/ffmpeg 2>/dev/null || true
        elif curl -fsSL --connect-timeout 5 --max-time 20 -o ffmpeg-release-amd64-static.tar.xz "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" 2>/dev/null; then
            tar xJf ffmpeg-release-amd64-static.tar.xz 2>/dev/null || true
            cp ffmpeg-*-static/ffmpeg /usr/local/bin/ 2>/dev/null || true
            cp ffmpeg-*-static/ffprobe /usr/local/bin/ 2>/dev/null || true
            chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe 2>/dev/null || true
            rm -rf ffmpeg-*-static ffmpeg-release-amd64-static.tar.xz
        fi
        cd "$INSTALL_DIR"
    fi
fi

if command -v ffmpeg &>/dev/null || [ -x /usr/local/bin/ffmpeg ]; then
    echo "  ffmpeg verified: $(/usr/local/bin/ffmpeg -version 2>&1 | head -1 || ffmpeg -version 2>&1 | head -1)"
else
    echo "  Notice: ffmpeg binary skipped; audio conversion will use sox fallback"
fi
# ──────────────────────────────────────────────
# Step 5 — Create the Environment File
# ──────────────────────────────────────────────
echo "[5/14] Creating .env file..."
AMPMGR_USER=$(grep -i '^AMPMGRUSER=' /etc/amportal.conf 2>/dev/null | cut -d= -f2- | tr -d '"'\'' ' | xargs 2>/dev/null || echo "admin")
AMPMGR_PASS=$(grep -i '^AMPMGRPASS=' /etc/amportal.conf 2>/dev/null | cut -d= -f2- | tr -d '"'\'' ' | xargs 2>/dev/null || echo "admin")
if [ -z "$AMPMGR_USER" ]; then AMPMGR_USER="admin"; fi
if [ -z "$AMPMGR_PASS" ]; then AMPMGR_PASS="admin"; fi

if [ -f "$INSTALL_DIR/.env" ]; then
    echo "  .env already exists, updating AMI credentials..."
    sed -i "s/^AMI_USER=.*/AMI_USER=${AMPMGR_USER}/" "$INSTALL_DIR/.env"
    sed -i "s/^AMI_PASS=.*/AMI_PASS=${AMPMGR_PASS}/" "$INSTALL_DIR/.env"
    if ! grep -q '^ROOT_PASSWORD_HASH=' "$INSTALL_DIR/.env"; then
        GEN_ROOT_PASS="Admin@123"
        GEN_ROOT_HASH=$(node -e "console.log(require('bcrypt').hashSync('$GEN_ROOT_PASS', 10))")
        echo "ROOT_PASSWORD_HASH=${GEN_ROOT_HASH}" >> "$INSTALL_DIR/.env"
        echo "ROOT_USER=root" > /etc/sokrat-root-credential.txt
        echo "ROOT_PASSWORD=${GEN_ROOT_PASS}" >> /etc/sokrat-root-credential.txt
        chmod 600 /etc/sokrat-root-credential.txt
    fi
    echo "  .env AMI credentials updated ($AMPMGR_USER)"
else
    GEN_ROOT_PASS="Admin@123"
    GEN_ROOT_HASH=$(node -e "console.log(require('bcrypt').hashSync('$GEN_ROOT_PASS', 10))")
    cat > "$INSTALL_DIR/.env" << EOF
PORT=8080
DB_HOST=localhost
DB_USER=root
DB_PASS=${MYSQL_ROOT_PWD}
CDR_DB=asteriskcdrdb
ASTERISK_DB=asterisk
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USER=${AMPMGR_USER}
AMI_PASS=${AMPMGR_PASS}
RECORDING_ROOT=/var/spool/asterisk/monitor
SESSION_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
SMTP_HOST=localhost
SMTP_PORT=25
SMTP_FROM=noreply@sokrat-voip.local
ROOT_PASSWORD_HASH=${GEN_ROOT_HASH}
EOF
    echo "ROOT_USER=root" > /etc/sokrat-root-credential.txt
    echo "ROOT_PASSWORD=${GEN_ROOT_PASS}" >> /etc/sokrat-root-credential.txt
    chmod 600 /etc/sokrat-root-credential.txt
    echo "  .env created"
fi

# ──────────────────────────────────────────────
# Step 6 — Initialize Database Tables
# ──────────────────────────────────────────────
echo "[6/14] Initializing database tables..."
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk < "$INSTALL_DIR/backend/install_db.sql"

# Schema migration statements for re-installations on existing databases
ensure_db_column() {
    local tbl="$1"
    local col="$2"
    local col_def="$3"
    local exists
    exists=$(mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -Nse \
        "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '$tbl' AND COLUMN_NAME = '$col'")
    if [ "$exists" = "0" ]; then
        mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "ALTER TABLE \`$tbl\` ADD \`$col\` $col_def"
    fi
}

ensure_db_index() {
    local tbl="$1"
    local idx="$2"
    local idx_def="$3"
    local exists
    exists=$(mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -Nse \
        "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '$tbl' AND INDEX_NAME = '$idx'")
    if [ "$exists" = "0" ]; then
        mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "ALTER TABLE \`$tbl\` ADD $idx_def" 2>/dev/null || true
    fi
}

ensure_db_column "dashboard_users" "group_id" "INT DEFAULT NULL"
ensure_db_column "dashboard_users" "extension" "VARCHAR(20) DEFAULT NULL"
ensure_db_column "dashboard_users" "reset_token_expires" "DATETIME DEFAULT NULL"
ensure_db_index "dashboard_users" "idx_dash_users_extension" "KEY \`idx_dash_users_extension\` (\`extension\`)"
ensure_db_index "dashboard_users" "idx_unique_email" "UNIQUE KEY \`idx_unique_email\` (\`email\`)"

mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
CREATE TABLE IF NOT EXISTS \`dashboard_user_dongles\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`user_id\` INT NOT NULL,
  \`dongle_name\` VARCHAR(50) NOT NULL,
  UNIQUE KEY \`idx_user_dongle\` (\`user_id\`, \`dongle_name\`),
  KEY \`idx_dongle_name\` (\`dongle_name\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
" 2>/dev/null || true

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

mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "INSERT IGNORE INTO \`storage_settings\` (\`id\`) VALUES (1);" 2>/dev/null || true

# Older/partial Announcement module installs can lack the Pico TTS columns.
# Use information_schema checks rather than version-specific ADD IF NOT EXISTS syntax.
ANNOUNCEMENT_TABLE_EXISTS=$(mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -Nse \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcement'")
if [ "$ANNOUNCEMENT_TABLE_EXISTS" != "1" ]; then
    echo "  Error: Issabel's required asterisk.announcement table is missing" >&2
    exit 1
fi

ensure_db_column "announcement" "tts_lang" "VARCHAR(10) NOT NULL DEFAULT 'en-US'"
ensure_db_column "announcement" "tts_text" "TEXT NOT NULL DEFAULT ('')"
echo "  Announcement TTS schema ensured"
echo "  Database tables ensured"
echo "  Database migrations applied"

# Clear any stale retrieve_conf failure notification
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "DELETE FROM \`notifications\` WHERE \`id\` = 'RCONFFAIL';" 2>/dev/null || true

# ──────────────────────────────────────────────
# Step 7 — Configure Asterisk AMI
# ──────────────────────────────────────────────
echo "[7/14] Configuring Asterisk AMI..."
python3 -c "
import re, sys
path = '/etc/asterisk/manager.conf'
user = '$AMPMGR_USER'
pwd = '$AMPMGR_PASS'
try:
    with open(path) as f: text = f.read()
except Exception as e:
    sys.exit(0)

pattern = r'^\[\s*' + re.escape(user) + r'\s*\].*?(?=^\[|\Z)'
m = re.search(pattern, text, re.MULTILINE | re.DOTALL)
if m:
    sec = m.group()
    sec = re.sub(r'^\s*(deny|permit)\s*=.*$', '', sec, flags=re.MULTILINE)
    if re.search(r'^\s*secret\s*=', sec, re.MULTILINE):
        sec = re.sub(r'^\s*secret\s*=.*$', f'secret = {pwd}', sec, flags=re.MULTILINE)
    else:
        sec += f'secret = {pwd}\n'
    sec = sec.rstrip() + '\npermit = 127.0.0.1/255.255.255.0\n'
    text = text[:m.start()] + sec + text[m.end():]
else:
    text = text.rstrip() + f'\n\n[{user}]\nsecret = {pwd}\nread = system,call,agent,config,command,reporting,user,verbose\nwrite = system,call,agent,config,command,reporting,user,verbose\npermit = 127.0.0.1/255.255.255.0\n'

with open(path, 'w') as f: f.write(text)
"
echo "  AMI manager.conf configured for $AMPMGR_USER"
asterisk -rx "manager reload" 2>/dev/null || true
echo "  AMI reloaded"
# ──────────────────────────────────────────────
# Step 7b — Initialize SQLite Address Book Database
# ──────────────────────────────────────────────
echo "  [7b] Preparing SQLite Address Book Database..."
mkdir -p /var/www/db
sqlite3 /var/www/db/address_book.db << 'SQLITE'
CREATE TABLE IF NOT EXISTS contact (
    id integer PRIMARY KEY AUTOINCREMENT,
    name varchar(35),
    last_name varchar(35),
    telefono varchar(12),
    extension varchar(7),
    email varchar(30),
    iduser int,
    picture varchar(50),
    address varchar(100),
    company varchar(30),
    notes varchar(200),
    status varchar(30) default 'isPrivate',
    cell_phone varchar(50),
    home_phone varchar(50),
    fax1 varchar(50),
    fax2 varchar(50),
    province varchar(100),
    city varchar(100),
    company_contact varchar(100),
    contact_rol varchar(50),
    directory varchar(8) default 'external',
    department varchar(100),
    im varchar(100)
);
SQLITE
chown -R asterisk:asterisk /var/www/db
chmod -R 775 /var/www/db
chmod 664 /var/www/db/address_book.db
echo "  address_book.db initialized with schema and permissions set"

# ──────────────────────────────────────────────
# Step 8 — Configure WebRTC / PJSIP Infrastructure
# ──────────────────────────────────────────────
echo "[8/14] Configuring WebRTC / PJSIP infrastructure..."

# Generate DTLS certificate for WebRTC if missing
if [ ! -f /etc/asterisk/keys/asterisk.pem ]; then
    mkdir -p /etc/asterisk/keys
    openssl req -x509 -newkey rsa:4096 -keyout /etc/asterisk/keys/asterisk.pem \
        -out /etc/asterisk/keys/asterisk.pem -days 3650 -nodes \
        -subj "/C=EG/ST=Cairo/L=Cairo/O=sokrat-voip/CN=$(hostname -f 2>/dev/null || echo 'localhost')"
    chown -R asterisk:asterisk /etc/asterisk/keys
    chmod 640 /etc/asterisk/keys/asterisk.pem
    echo "  DTLS certificate generated at /etc/asterisk/keys/asterisk.pem"
else
    echo "  DTLS certificate already exists"
fi

# Ensure modules_custom.conf loads chan_sip
MODULES_CUSTOM=/etc/asterisk/modules_custom.conf
touch "$MODULES_CUSTOM"
if ! grep -q 'load => chan_sip.so' "$MODULES_CUSTOM"; then
    echo 'load => chan_sip.so' >> "$MODULES_CUSTOM"
    echo "  Added load => chan_sip.so to modules_custom.conf"
else
    echo "  chan_sip already configured in modules_custom.conf"
fi

# Disable chan_sip WebSocket to avoid conflict with PJSIP WebSocket
SIP_GENERAL_CUSTOM=/etc/asterisk/sip_general_custom.conf
touch "$SIP_GENERAL_CUSTOM"
if ! grep -q 'websocket_enabled=no' "$SIP_GENERAL_CUSTOM"; then
    echo '' >> "$SIP_GENERAL_CUSTOM"
    echo '; Disable chan_sip WebSocket — PJSIP handles WebRTC' >> "$SIP_GENERAL_CUSTOM"
    echo 'websocket_enabled=no' >> "$SIP_GENERAL_CUSTOM"
    echo "  Disabled chan_sip WebSocket in sip_general_custom.conf"
else
    echo "  chan_sip WebSocket already disabled"
fi

# Ensure WSS transport exists for PJSIP (needed by WebRTC)
WSS_TRANSPORT=/etc/asterisk/pjsip_transport_custom.conf
if [ ! -f "$WSS_TRANSPORT" ] || ! grep -q 'transport-wss' "$WSS_TRANSPORT" 2>/dev/null; then
    cat >> "$WSS_TRANSPORT" << 'TRPEOF'

[transport-wss]
type=transport
protocol=wss
allow_reload=true
bind=0.0.0.0:5066
TRPEOF
    echo "  WSS transport added to pjsip_transport_custom.conf"
else
    echo "  WSS transport already configured"
fi

# Patch IssabelPBX PJSIP generator to fix maxcontacts and inband_progress
FUNCTIONS_FILE=/var/www/html/admin/modules/core/functions.inc.php
if [ -f "$FUNCTIONS_FILE" ]; then
    if ! grep -q "case 'maxcontacts':" "$FUNCTIONS_FILE"; then
        sed -i "s/case 'max_contacts':/case 'maxcontacts':\n                        case 'max_contacts':/" "$FUNCTIONS_FILE"
    fi
    if ! grep -q "case 'inband_progress':" "$FUNCTIONS_FILE"; then
        sed -i "/case 'use_avpf':/i \                        case 'inband_progress':\n                        case 'inbandprogress':\n                            \$output1[]='inband_progress='.\$result2['data'];\n                            break;" "$FUNCTIONS_FILE"
    fi
    if ! grep -q "\$devopts\['inband_progress'\]" "$FUNCTIONS_FILE"; then
        sed -i "/\$devopts\['use_avpf'\]\['value'\]='yes';/a \                \$devopts\['inband_progress'\]\['value'\]='yes';" "$FUNCTIONS_FILE"
    fi
    echo "  IssabelPBX PJSIP generator patched for maxcontacts and inband_progress"
fi

# Ensure inband_progress=yes for WebRTC extensions in database
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
INSERT INTO sip (id, keyword, data, flags)
SELECT id, 'inband_progress', 'yes', 18 FROM sip WHERE keyword='webrtc' AND data='yes'
ON DUPLICATE KEY UPDATE data='yes';
" 2>/dev/null || true

# Ensure Asterisk socket permissions allow sokrat-softphone service access
if [ -f /etc/asterisk/asterisk.conf ]; then
    if ! grep -q '^astctlpermissions' /etc/asterisk/asterisk.conf; then
        echo "astctlpermissions = 0775" >> /etc/asterisk/asterisk.conf
    else
        sed -i 's/^astctlpermissions.*/astctlpermissions = 0775/' /etc/asterisk/asterisk.conf
    fi
    if ! grep -q '^astctlgroup' /etc/asterisk/asterisk.conf; then
        echo "astctlgroup = asterisk" >> /etc/asterisk/asterisk.conf
    else
        sed -i 's/^astctlgroup.*/astctlgroup = asterisk/' /etc/asterisk/asterisk.conf
    fi
fi

asterisk -rx "pjsip reload" 2>/dev/null || true
asterisk -rx "module load chan_sip.so" 2>/dev/null || true
echo "  PJSIP reloaded, chan_sip loaded"
# ──────────────────────────────────────────────
# Step 9 — Add Required Dialplan Contexts
# ──────────────────────────────────────────────
echo "[9/14] Adding dialplan contexts..."
DIALPLAN_FILE=/etc/asterisk/extensions_custom.conf

# Ensure file exists
touch "$DIALPLAN_FILE"

# Helper: append a block only if its context header is not already present
append_context() {
    local header="$1"
    local label="$2"
    if grep -qF "$header" "$DIALPLAN_FILE"; then
        echo "  $label already present, skipping"
    else
        cat >> "$DIALPLAN_FILE"
        echo "  $label appended"
    fi
}

# Strip old [from-internal-custom], [from-intercom-autoanswer], [intercom-predial-autoanswer], [from-intercom-conf] before appending
echo "  Stripping old dialplan custom contexts..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\[from-internal-custom\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[from-intercom-autoanswer\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[intercom-predial-autoanswer\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[from-intercom-conf\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append Intercom, ChanSpy & Hijack from-internal-custom
append_context '[from-internal-custom]' '[from-internal-custom]' << 'CHANSPY'

[from-internal-custom]
; === Solution A: Direct 1-to-1 Intercom Code (*80 + Extension, e.g. *80102) ===
exten => _*80X.,1,NoOp(--- Keypad Direct 1-to-1 Intercom to ${EXTEN:3} ---)
same => n,Set(INTERCOM_CALLER=${CALLERID(num)})
same => n,Goto(from-intercom-autoanswer,${EXTEN:3},1)

; === Solution B: All-Available Extensions Mass Intercom Code (*800 or 800) ===
exten => *800,1,NoOp(--- Keypad Mass Intercom to All Available Extensions ---)
same => n,Set(HOST_EXT=${CALLERID(num)})
same => n,Set(ROOM_ID=88${RAND(100000,999999)})
same => n,System(/usr/bin/node /opt/sokrat-voip/scripts/trigger-intercom-code.js ${HOST_EXT} ${ROOM_ID} &)
same => n,Answer()
same => n,ConfBridge(${ROOM_ID})
same => n,Hangup()

exten => 800,1,Goto(*800,1)

exten => _222X.,1,NoOp(Spying on extension ${EXTEN:3} in Listen-only mode)
exten => _222X.,n,Answer()
exten => _222X.,n,Set(spyee_dial=${DB(DEVICE/${EXTEN:3}/dial)})
exten => _222X.,n,GotoIf($["${spyee_dial}" = ""]?fallback)
exten => _222X.,n,ChanSpy(${spyee_dial},q)
exten => _222X.,n,Hangup()
exten => _222X.,n(fallback),ChanSpy(PJSIP/${EXTEN:3},q)
exten => _222X.,n,ChanSpy(SIP/${EXTEN:3},q)
exten => _222X.,n,Hangup()

exten => _223X.,1,NoOp(Spying on extension ${EXTEN:3} in Whisper mode)
exten => _223X.,n,Answer()
exten => _223X.,n,Set(spyee_dial=${DB(DEVICE/${EXTEN:3}/dial)})
exten => _223X.,n,GotoIf($["${spyee_dial}" = ""]?fallback)
exten => _223X.,n,ChanSpy(${spyee_dial},qw)
exten => _223X.,n,Hangup()
exten => _223X.,n(fallback),ChanSpy(PJSIP/${EXTEN:3},qw)
exten => _223X.,n,ChanSpy(SIP/${EXTEN:3},qw)
exten => _223X.,n,Hangup()

exten => _224X.,1,NoOp(Spying on extension ${EXTEN:3} in Barge mode)
exten => _224X.,n,Answer()
exten => _224X.,n,Set(spyee_dial=${DB(DEVICE/${EXTEN:3}/dial)})
exten => _224X.,n,GotoIf($["${spyee_dial}" = ""]?fallback)
exten => _224X.,n,ChanSpy(${spyee_dial},qB)
exten => _224X.,n,Hangup()
exten => _224X.,n(fallback),ChanSpy(PJSIP/${EXTEN:3},qB)
exten => _224X.,n,ChanSpy(SIP/${EXTEN:3},qB)
exten => _224X.,n,Hangup()

exten => _225X.,1,NoOp(--- Instant AGI Hijack Call for Extension ${EXTEN:3} ---)
same => n,Answer()
same => n,AGI(hijack_call.py,${EXTEN:3})
same => n,Hangup()

; === Solution C: Real-Time AI Noise Suppression Live Echo Tests ===
; *88 = RNNoise AI Neural Filter + VAD Gate (100% Dead Silence on Pauses)
exten => *88,1,NoOp(--- RNNoise AI Noise Suppression + VAD Gate Live Echo Test ---)
same => n,Answer()
same => n,Wait(0.5)
same => n,Set(RNNOISE(both,gate=on)=on)
same => n,Playback(beep)
same => n,Echo()
same => n,Hangup()

; *87 = RNNoise AI Neural Filter Continuous (Without VAD Hard Gate)
exten => *87,1,NoOp(--- RNNoise AI Noise Suppression Continuous Echo Test ---)
same => n,Answer()
same => n,Wait(0.5)
same => n,Set(RNNOISE(both,gate=off)=on)
same => n,Playback(beep)
same => n,Echo()
same => n,Hangup()

; *89 = Raw Unfiltered Baseline (Original Audio)
exten => *89,1,NoOp(--- Raw Audio Echo Test (Unfiltered A/B Comparison) ---)
same => n,Answer()
same => n,Wait(0.5)
same => n,Set(RNNOISE(both)=off)
same => n,Playback(beep)
same => n,Echo()
same => n,Hangup()

; === Solution D: Call Pickup Feature Codes (*, *<EXT/GROUP>, **<EXT>, *1 alias, *8 alias) ===
; Directed Call Pickup (**EXT, e.g. **102)
exten => _**X.,1,NoOp(--- Directed Call Pickup for Target ${EXTEN:2} by ${CALLERID(num)} ---)
same => n,PickupChan(PJSIP/${EXTEN:2}&SIP/${EXTEN:2}&Local/${EXTEN:2}@ext-local,p)
same => n,Pickup(${EXTEN:2}@ext-local&${EXTEN:2}@from-internal&${EXTEN:2}@from-did-direct)
same => n,Hangup()

; Directed Call Pickup or Ring Group Intercept (* + Number, e.g. *102 or *600)
exten => _*X.,1,NoOp(--- Directed / Ring Group Pickup for Target ${EXTEN:1} by ${CALLERID(num)} ---)
same => n,PickupChan(PJSIP/${EXTEN:1}&SIP/${EXTEN:1}&Local/${EXTEN:1}@ext-local,p)
same => n,Pickup(${EXTEN:1}@ext-local&${EXTEN:1}@from-internal&${EXTEN:1}@from-did-direct&${EXTEN:1}@ext-group)
same => n,Hangup()

; General Department Group Call Pickup (*)
exten => *,1,NoOp(--- Department Group Call Pickup by ${CALLERID(num)} ---)
same => n,Pickup()
same => n,Hangup()

; Backward Compatibility Aliases (*1, *8, *1X., *8X.)
exten => *1,1,Goto(*,1)
exten => *8,1,Goto(*,1)
exten => _*1X.,1,NoOp(--- Directed Pickup Alias to * ---)
same => n,PickupChan(PJSIP/${EXTEN:2}&SIP/${EXTEN:2}&Local/${EXTEN:2}@ext-local,p)
same => n,Pickup(${EXTEN:2}@ext-local&${EXTEN:2}@from-internal&${EXTEN:2}@from-did-direct&${EXTEN:2}@ext-group)
same => n,Hangup()
exten => _*8X.,1,NoOp(--- Directed Pickup Alias to * ---)
same => n,PickupChan(PJSIP/${EXTEN:2}&SIP/${EXTEN:2}&Local/${EXTEN:2}@ext-local,p)
same => n,Pickup(${EXTEN:2}@ext-local&${EXTEN:2}@from-internal&${EXTEN:2}@from-did-direct&${EXTEN:2}@ext-group)
same => n,Hangup()
CHANSPY

# Append Intercom dialplan contexts
append_context '[from-intercom-autoanswer]' '[from-intercom-autoanswer]' << 'INTERCOM_CTX'

[from-intercom-autoanswer]
exten => _X.,1,NoOp(--- Auto-Answer Intercom Call to ${EXTEN} ---)
same => n,ExecIf($["${INTERCOM_CALLER}" != ""]?Set(CALLERID(name)=Intercom ${INTERCOM_CALLER}):Set(CALLERID(name)=Intercom))
same => n,ExecIf($["${INTERCOM_CALLER}" != ""]?Set(CALLERID(num)=${INTERCOM_CALLER}):Set(CALLERID(num)=226))
same => n,Set(spyee_dial=${DB(DEVICE/${EXTEN}/dial)})
same => n,GotoIf($["${spyee_dial}" = ""]?fallback)
same => n,Dial(${spyee_dial},30,A(beep)b(intercom-predial-autoanswer^s^1))
same => n,Hangup()
same => n(fallback),Dial(PJSIP/${EXTEN},30,A(beep)b(intercom-predial-autoanswer^s^1))
same => n,Dial(SIP/${EXTEN},30,A(beep)b(intercom-predial-autoanswer^s^1))
same => n,Hangup()

[intercom-predial-autoanswer]
exten => s,1,NoOp(--- Predial Auto-Answer SIP Header Injection ---)
same => n,Set(PJSIP_HEADER(add,Call-Info)=<sip:127.0.0.1>\;answer-after=0)
same => n,Set(PJSIP_HEADER(add,Alert-Info)=info=alert-autoanswer)
same => n,SIPAddHeader(Call-Info: <sip:127.0.0.1>\;answer-after=0)
same => n,SIPAddHeader(Alert-Info: info=alert-autoanswer)
same => n,Return()

[from-intercom-conf]
exten => _X.,1,NoOp(--- Intercom Target Join ConfBridge ${EXTEN} ---)
same => n,Answer()
same => n,ConfBridge(${EXTEN})
same => n,Hangup()

INTERCOM_CTX

# Install AGI hijack script & trigger script permissions
echo "  Installing AGI hijack script & scripts..."
mkdir -p /var/lib/asterisk/agi-bin
cp "$INSTALL_DIR/agi-bin/hijack_call.py" /var/lib/asterisk/agi-bin/hijack_call.py
chmod +x /var/lib/asterisk/agi-bin/hijack_call.py
chown asterisk:asterisk /var/lib/asterisk/agi-bin/hijack_call.py
chmod +x "$INSTALL_DIR/scripts/trigger-intercom-code.js" 2>/dev/null || true
echo "  hijack_call.py and scripts initialized."
# Strip old [from-dongle-custom] and [ext-moh] before appending (ensures upgrades get the latest version)
echo "  Stripping old [from-dongle-custom] and [ext-moh]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\[from-dongle-custom\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[ext-moh\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append updated from-dongle-custom
cat << 'DONGLE' >> "$DIALPLAN_FILE"

[from-dongle-custom]
exten => sms,1,NoOp(--- Incoming SMS on ${DONGLENAME} ---)
same => n,Verbose(1, [SMS-RECEIVE] Dongle: ${DONGLENAME}, Sender: ${CALLERID(num)}, Content: ${SMS})
same => n,Hangup()

exten => ussd,1,NoOp(--- Incoming USSD on ${DONGLENAME} ---)
same => n,NoOp(USSD Session Type: ${USSD_TYPE})
same => n,NoOp(USSD Content: ${USSD})
same => n,Hangup()

exten => _+X.,1,NoOp(Checking if extension ${EXTEN} exists in from-trunk context)
same => n,ExecIf($["${EXTEN}" != "+1234567890" & ${DIALPLAN_EXISTS(from-trunk,${EXTEN},1)}]?Set(MY_SIM_NUMBER=${EXTEN}))
same => n,Goto(s,process)

exten => _X.,1,NoOp(Checking if extension ${EXTEN} exists in from-trunk context)
same => n,ExecIf($["${EXTEN}" != "+1234567890" & ${DIALPLAN_EXISTS(from-trunk,${EXTEN},1)}]?Set(MY_SIM_NUMBER=${EXTEN}))
same => n,Goto(s,process)

exten => s,1,Set(DONGLE_TARGET=${DONGLENAME})
same => n,Set(CHANNEL(hangup_handler_push)=cdr-cause-capture,s,1)
same => n,Set(CHANNEL(hangup_handler_push)=dongle-hangup-cleanup,s,1)
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=))
same => n(process),NoOp(--- Incoming call from Dongle ${DONGLENAME} (EXTEN: ${EXTEN}) ---)
same => n,ExecIf($["${DB(DONGLE_SETTINGS/${DONGLENAME})}" != "1"]?Goto(skip_dynamic))
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "s" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${DB(dongle_map/${DONGLENAME})}))
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "s" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${DB(DONGLE_NUMBERS/${DONGLEIMSI})}))
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "s" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${DB(sim_map/${DONGLEIMSI})}))
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "s" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${DB(DONGLE_NUMBERS/${DONGLEIMEI})}))
same => n(skip_dynamic),ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${EXTEN}))

same => n,Set(CALLER_NUMBER=${FILTER(0123456789+,${CALLERID(num)})})
same => n,Set(CLEAN_CALLER=${FILTER(0123456789,${CALLER_NUMBER})})
same => n,NoOp(Caller Number: ${CALLER_NUMBER})
same => n,ExecIf($["${DB(blacklist/${CALLER_NUMBER})}" != "" | "${DB(blacklist/${CLEAN_CALLER})}" != "" | "${DB(blacklist/+${CLEAN_CALLER})}" != "" | "${DB(blacklist/0${CLEAN_CALLER})}" != ""]?Goto(blacklisted))
same => n,Set(FOUND_NAME=${SHELL(sqlite3 /var/www/db/address_book.db "SELECT name || ' ' || last_name FROM contact WHERE (replace(replace(replace(replace(replace(telefono,'-',''),' ',''),'(',''),')',''),'.','') = '${CALLER_NUMBER}' OR '${CALLER_NUMBER}' LIKE '%' || replace(replace(replace(replace(replace(telefono,'-',''),' ',''),'(',''),')',''),'.','') OR replace(replace(replace(replace(replace(telefono,'-',''),' ',''),'(',''),')',''),'.','') LIKE '%${CALLER_NUMBER}') AND length(replace(replace(replace(replace(replace(telefono,'-',''),' ',''),'(',''),')',''),'.','')) >= 5 LIMIT 1" | tr -d '\n')})
same => n,GotoIf($["${FOUND_NAME}" = ""]?skip_cid)
same => n,NoOp(Found Contact Name: ${FOUND_NAME})
same => n,Set(CALLERID(name)=${FOUND_NAME})
same => n(skip_cid),GotoIf($["${MY_SIM_NUMBER}" != "" & "${MY_SIM_NUMBER}" != "s" & "${MY_SIM_NUMBER}" != "+1234567890" & ${DIALPLAN_EXISTS(from-trunk,${MY_SIM_NUMBER},1)}]?goto_did:no_route)
same => n(goto_did),Goto(from-trunk,${MY_SIM_NUMBER},1)
same => n(no_route),NoOp(DONGLE-ERROR: No matching inbound route in from-trunk for DID '${MY_SIM_NUMBER}' on dongle '${DONGLENAME}')
same => n,Playtones(congestion)
same => n,Congestion(10)
same => n,Hangup()
same => n(blacklisted),NoOp(--- INBOUND CALL REJECTED BY BLACKLIST RULE: ${CALLER_NUMBER} ---)
same => n,Answer()
same => n,Wait(1)
same => n,Zapateller()
same => n,Playback(ss-noservice)
same => n,Hangup()
[ext-moh]
exten => _!,1,NoOp(--- Class-Aware Music On Hold: ${EXTEN} ---)
same => n,Answer()
same => n,Set(CHANNEL(musicclass)=${EXTEN})
same => n,MusicOnHold(${EXTEN})
same => n,Hangup()
DONGLE

# Strip old [macro-dialout-trunk-predial-hook] before appending
echo "  Stripping old [macro-dialout-trunk-predial-hook]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\\[macro-dialout-trunk-predial-hook\\].*?(?=\\n\\[|\\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append macro-dialout-trunk-predial-hook
append_context '[macro-dialout-trunk-predial-hook]' '[macro-dialout-trunk-predial-hook]' << 'MACRO'

[macro-dialout-trunk-predial-hook]
exten => s,1,NoOp(--- Outbound call via Dongle (CID auto-set by trunk outcid & Extension RNNoise Filter) ---)
same => n,Set(CALLER_DENOISE=${DB(AMPUSER/${REALCALLERIDNUM}/ai_denoise)})
same => n,ExecIf($["${CALLER_DENOISE}" = ""]?Set(CALLER_DENOISE=${DB(AMPUSER/${CALLERID(num)}/ai_denoise)}))
same => n,ExecIf($["${CALLER_DENOISE}" = ""]?Set(CALLER_DENOISE=both))
same => n,Set(CALLER_VAD=${DB(AMPUSER/${REALCALLERIDNUM}/vad_gate)})
same => n,ExecIf($["${CALLER_VAD}" = ""]?Set(CALLER_VAD=${DB(AMPUSER/${CALLERID(num)}/vad_gate)}))
same => n,Set(U_THRESH=${DB(AUDIO_GLOBALS/vad_threshold)})
same => n,ExecIf($["${U_THRESH}" = ""]?Set(U_THRESH=0.20))
same => n,Set(U_HANG=${DB(AUDIO_GLOBALS/vad_hangover)})
same => n,ExecIf($["${U_HANG}" = ""]?Set(U_HANG=250))
same => n,ExecIf($["${CALLER_VAD}" = "0"]?Set(VAD_OPT=gate=off):Set(VAD_OPT=gate=on,threshold=${U_THRESH},hangover=${U_HANG}))
same => n,ExecIf($["${CALLER_DENOISE}" != "off"]?Set(RNNOISE(${CALLER_DENOISE},${VAD_OPT})=on))
same => n,Set(JITTERBUFFER(adaptive)=default)
same => n,Set(RAW_TARGET=${CUT(OUT_${DIAL_TRUNK},/,2)})
same => n,Set(DONGLE_TARGET=${DB(DONGLE_DEVICE_MAP/${RAW_TARGET})})
same => n,ExecIf($["${DONGLE_TARGET}"=""]?Set(DONGLE_TARGET=${RAW_TARGET}))
same => n,Set(CHANNEL(hangup_handler_push)=cdr-cause-capture,s,1)
same => n,Set(CHANNEL(hangup_handler_push)=dongle-hangup-cleanup,s,1)
same => n,MacroExit()

[dongle-hangup-cleanup]
exten => s,1,NoOp(--- Pure Dialplan Dongle Hangup Cleanup ---)
same => n,ExecIf($["${DONGLE_TARGET}"=""]?Set(DONGLE_TARGET=${CUT(CHANNEL,-,1)}))
same => n,ExecIf($["${DONGLE_TARGET:0:7}"="Dongle/"]?Set(DONGLE_TARGET=${DONGLE_TARGET:7}))
same => n,ExecIf($["${DB_EXISTS(DONGLE_DEVICE_MAP/${DONGLE_TARGET})}"="1"]?Set(DONGLE_TARGET=${DB(DONGLE_DEVICE_MAP/${DONGLE_TARGET})}))
same => n,GotoIf($["${DONGLE_TARGET}"="" | "${DONGLE_TARGET:0:6}"!="dongle"]?done)
same => n,Verbose(1, [DONGLE-DIALPLAN-CLEANUP] Resetting dongle ${DONGLE_TARGET} via dialplan System call (Cause: ${HANGUPCAUSE}, DialStatus: ${DIALSTATUS}))
same => n,NoOp([DONGLE-DIALPLAN-CLEANUP] Restart disabled for ${DONGLE_TARGET})
same => n(done),Return()
MACRO

# Append CDR hangup-cause capture subroutine
append_context '[cdr-cause-capture]' '[cdr-cause-capture]' << 'CAUSECAP'

[cdr-cause-capture]
; Persist the Q.850 hangup cause on monitored channels so Call History can
; distinguish busy / no-answer / congestion instead of relying on driver defaults.
exten => s,1,Set(CDR(userfield)=${HANGUPCAUSE})
same => n,Return()

CAUSECAP
# Strip old [macro-dialout-one-predial-hook] before appending
echo "  Stripping old [macro-dialout-one-predial-hook]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\\[macro-dialout-one-predial-hook\\].*?(?=\\n\\[|\\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append macro-dialout-one-predial-hook
append_context '[macro-dialout-one-predial-hook]' '[macro-dialout-one-predial-hook]' << 'ONEHOOK'

[macro-dialout-one-predial-hook]
exten => s,1,NoOp(--- Dynamic Adaptive Jitter Buffer & RNNoise Filter for Outbound Extension Leg ---)
same => n,Set(CALLER_DENOISE=${DB(AMPUSER/${CALLERID(num)}/ai_denoise)})
same => n,ExecIf($["${CALLER_DENOISE}" = ""]?Set(CALLER_DENOISE=both))
same => n,Set(CALLER_VAD=${DB(AMPUSER/${CALLERID(num)}/vad_gate)})
same => n,Set(U_THRESH=${DB(AUDIO_GLOBALS/vad_threshold)})
same => n,ExecIf($["${U_THRESH}" = ""]?Set(U_THRESH=0.20))
same => n,Set(U_HANG=${DB(AUDIO_GLOBALS/vad_hangover)})
same => n,ExecIf($["${U_HANG}" = ""]?Set(U_HANG=250))
same => n,ExecIf($["${CALLER_VAD}" = "0"]?Set(VAD_OPT=gate=off):Set(VAD_OPT=gate=on,threshold=${U_THRESH},hangover=${U_HANG}))
same => n,ExecIf($["${CALLER_DENOISE}" != "off"]?Set(RNNOISE(${CALLER_DENOISE},${VAD_OPT})=on))
same => n,Set(JITTERBUFFER(adaptive)=default)
same => n,Set(CHANNEL(hangup_handler_push)=cdr-cause-capture,s,1)
same => n,MacroExit()

ONEHOOK

# Strip old [func-apply-sipheaders-custom] before appending
echo "  Stripping old [func-apply-sipheaders-custom]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\[func-apply-sipheaders-custom\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append func-apply-sipheaders-custom
append_context '[func-apply-sipheaders-custom]' '[func-apply-sipheaders-custom]' << 'SIPHEADER'

[func-apply-sipheaders-custom]
exten => s,1,NoOp(--- SIP Client Incoming Leg & AI Denoise Hook ---)
same => n,Set(CALLEE_EXT=${DEXTEN})
same => n,ExecIf($["${CALLEE_EXT}" = ""]?Set(CALLEE_EXT=${EXTTOCALL}))
same => n,ExecIf($["${CALLEE_EXT}" = ""]?Set(CALLEE_EXT=${CUT(CUT(CHANNEL,-,1),/,2)}))
same => n,Set(CALLEE_DENOISE=${DB(AMPUSER/${CALLEE_EXT}/ai_denoise)})
same => n,ExecIf($["${CALLEE_DENOISE}" = ""]?Set(CALLEE_EXT=${DB(DEVICE/${CALLEE_EXT}/user)}))
same => n,ExecIf($["${CALLEE_DENOISE}" = ""]?Set(CALLEE_DENOISE=${DB(AMPUSER/${CALLEE_EXT}/ai_denoise)}))
same => n,ExecIf($["${CALLEE_DENOISE}" = ""]?Set(CALLEE_DENOISE=both))
same => n,Set(CALLEE_VAD=${DB(AMPUSER/${CALLEE_EXT}/vad_gate)})
same => n,Set(U_THRESH=${DB(AUDIO_GLOBALS/vad_threshold)})
same => n,ExecIf($["${U_THRESH}" = ""]?Set(U_THRESH=0.20))
same => n,Set(U_HANG=${DB(AUDIO_GLOBALS/vad_hangover)})
same => n,ExecIf($["${U_HANG}" = ""]?Set(U_HANG=250))
same => n,ExecIf($["${CALLEE_VAD}" = "0"]?Set(VAD_OPT=gate=off):Set(VAD_OPT=gate=on,threshold=${U_THRESH},hangover=${U_HANG}))
same => n,ExecIf($["${CALLEE_DENOISE}" != "off"]?Set(RNNOISE(${CALLEE_DENOISE},${VAD_OPT})=on))
; Rule 1: Do not mask internal extension-to-extension calls (e.g. 101 calling 102)
same => n,GotoIf($[${LEN(${CALLERID(num)})} <= 4]?done)
same => n,GotoIf($["${DB_EXISTS(AMPUSER/${CALLERID(num)}/cidname)}" = "1"]?done)

; Rule 2: Skip masking if caller ID is anonymous, unavailable, unknown, or restricted
same => n,GotoIf($["${CALLERID(num)}" = "" | "${CALLERID(num)}" = "anonymous" | "${CALLERID(num)}" = "unknown" | "${CALLERID(num)}" = "s" | "${CALLERID(num)}" = "unavailable" | "${CALLERID(num)}" = "restricted"]?done)

; Rule 3: Skip if caller ID is too short to mask (needs at least 6 digits)
same => n,Set(RAW_NUM=${CALLERID(num)})
same => n,Set(NUM_LEN=${LEN(${RAW_NUM})})
same => n,GotoIf($[${NUM_LEN} < 6]?done)

; Rule 4: Check if destination extension has unmask_cid enabled in AstDB
same => n,Set(TARGET_EXT=${DEXTEN})
same => n,ExecIf($["${TARGET_EXT}" = ""]?Set(TARGET_EXT=${EXTTOCALL}))
same => n,ExecIf($["${TARGET_EXT}" = ""]?Set(TARGET_EXT=${CUT(CUT(CHANNEL,-,1),/,2)}))
same => n,GotoIf($["${TARGET_EXT}" != "" & "${DB(AMPUSER/${TARGET_EXT}/unmask_cid)}" = "1"]?done)
; Rule 5: Extract prefix (first 3 chars) and suffix (last 2 chars)
same => n,Set(CID_PREFIX=${RAW_NUM:0:3})
same => n,Set(CID_SUFFIX=${RAW_NUM:-2})

; Rule 6: Build masked representation (e.g. 010*********23)
same => n,Set(MASKED_NUM=${CID_PREFIX}*********${CID_SUFFIX})

; Rule 7: Apply to CallerID number and name for SIP INVITE
same => n,NoOp(Masking CallerID for SIP Client Display: ${RAW_NUM} -> ${MASKED_NUM})
same => n,Set(CALLERID(num)=${MASKED_NUM})
same => n,ExecIf($["${CALLERID(name)}" != "" & "${CALLERID(name)}" != "${RAW_NUM}"]?Set(CALLERID(name)=${CALLERID(name)} [${MASKED_NUM}]):Set(CALLERID(name)=${MASKED_NUM}))

same => n(done),Return()
SIPHEADER

# Strip old [ext-external-failover] and [sub-failover-screen] before appending
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\[ext-external-failover\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[sub-failover-screen\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"

# Append ext-external-failover
append_context '[ext-external-failover]' '[ext-external-failover]' << 'FAILOVER_CTX'

[ext-external-failover]
; Sokrat Call Center Failover to External Mobile Number (Direct Bridge)
; Supports:
;   1. Explicit Dongle: ext-external-failover,01011719380/dongle1,1 OR ext-external-failover,01011719380@dongle1,1
;   2. Automatic Outbound Routes: ext-external-failover,01011719380,1
exten => _[0-9+*#].!,1,NoOp(=== SOKRAT FAILOVER: Target '${EXTEN}' for Customer '${CALLERID(num)}' ===)
same => n,Set(CUST_NUM=${CALLERID(num)})
same => n,Set(RAW_TARGET=${EXTEN})
same => n,Set(TARGET_NUM=${CUT(RAW_TARGET,/,1)})
same => n,Set(TARGET_NUM=${CUT(TARGET_NUM,@,1)})
same => n,Set(EXPLICIT_DONGLE=${CUT(RAW_TARGET,/,2)})
same => n,ExecIf($["${EXPLICIT_DONGLE}"=""]?Set(EXPLICIT_DONGLE=${CUT(RAW_TARGET,@,2)}))
same => n,Set(__FAILOVER_DEST=${TARGET_NUM})
same => n,Set(CDR(userfield)=Failover: ${RAW_TARGET})
same => n,GotoIf($["${EXPLICIT_DONGLE}"!=""]?dial_explicit:dial_routes)
same => n(dial_explicit),NoOp(Dialing explicitly via Dongle/${EXPLICIT_DONGLE}/${TARGET_NUM})
same => n,Dial(Dongle/${EXPLICIT_DONGLE}/${TARGET_NUM},60)
same => n,Hangup()
same => n(dial_routes),NoOp(Dialing via Outbound Routes for ${TARGET_NUM})
same => n,Dial(Local/${TARGET_NUM}@outbound-allroutes,60)
same => n,Hangup()
FAILOVER_CTX

asterisk -rx "dialplan reload" 2>/dev/null || true
echo "  Dialplan reloaded"

# 9b — Configure Asterisk Voicemail Storage Limits (maxmsg=1000, maxsecs=300)
echo "  Configuring Asterisk voicemail storage limits (maxmsg=1000, maxsecs=300)..."
if [ -f /etc/asterisk/vm_general.inc ]; then
    sed -i '/^maxmsg=/d' /etc/asterisk/vm_general.inc
    sed -i '/^maxsecs=/d' /etc/asterisk/vm_general.inc
    sed -i '/^minsecs=/d' /etc/asterisk/vm_general.inc
    echo "maxmsg=1000" >> /etc/asterisk/vm_general.inc
    echo "maxsecs=300" >> /etc/asterisk/vm_general.inc
    echo "minsecs=3" >> /etc/asterisk/vm_general.inc
fi
if [ -f /etc/asterisk/voicemail.conf ]; then
    sed -i '/^maxmsg=/d' /etc/asterisk/voicemail.conf
    sed -i '/^maxsecs=/d' /etc/asterisk/voicemail.conf
    sed -i '/^minsecs=/d' /etc/asterisk/voicemail.conf
    if grep -q '^\[general\]' /etc/asterisk/voicemail.conf; then
        sed -i '/^\[general\]/a maxmsg=1000\nmaxsecs=300\nminsecs=3' /etc/asterisk/voicemail.conf
    fi
fi
asterisk -rx "voicemail reload" 2>/dev/null || true
echo "  Voicemail storage limit set to 1000 messages per mailbox"

# ──────────────────────────────────────────────
# Step 10 — GSM Dongle Setup
# ──────────────────────────────────────────────
echo ""
echo "[10/14] Setting up GSM dongles & chan_dongle..."

# 10a — Install Build Dependencies
echo "  [10a] Installing build dependencies..."
yum -y install gcc gcc-c++ make automake autoconf libtool sqlite-devel usbutils usb_modeswitch minicom wget curl tar
yum -y install asterisk18-devel

# 10b — Compile and Install librnnoise & func_rnnoise.so
echo "  [10b] Compiling librnnoise and func_rnnoise.so..."
if [ ! -f /usr/lib64/librnnoise.so ] || [ ! -f /usr/include/rnnoise.h ]; then
    cd /tmp
    rm -rf rnnoise_build
    mkdir -p rnnoise_build && cd rnnoise_build
    git clone https://github.com/xiph/rnnoise.git
    cd rnnoise
    chmod +x autogen.sh download_model.sh 2>/dev/null || true
    if [ -f "./autogen.sh" ]; then
        ./autogen.sh || (./download_model.sh && libtoolize --copy --force && autoreconf -fi)
    else
        [ -f "./download_model.sh" ] && ./download_model.sh
        libtoolize --copy --force && autoreconf -fi
    fi
    if [ ! -f src/rnnoise_data.c ] || [ ! -f src/rnnoise_data.h ]; then
        echo "  Downloading neural network model data..."
        [ -f "./download_model.sh" ] && ./download_model.sh
    fi
    ./configure --prefix=/usr --libdir=/usr/lib64 CFLAGS="-O3 -mavx2 -mfma"
    make -j$(nproc)
    make install
    ldconfig
    echo "  librnnoise compiled and installed"
else
    echo "  librnnoise already installed"
fi

if [ -f "$INSTALL_DIR/asterisk/func_rnnoise.c" ]; then
    gcc -shared -fPIC -O3 -mavx2 -mfma -I/usr/include -o /usr/lib64/asterisk/modules/func_rnnoise.so \
        "$INSTALL_DIR/asterisk/func_rnnoise.c" -lrnnoise -lm -lpthread
    chmod 755 /usr/lib64/asterisk/modules/func_rnnoise.so
    asterisk -rx "module load func_rnnoise.so" 2>/dev/null || asterisk -rx "module reload func_rnnoise.so" 2>/dev/null || true
    echo "  func_rnnoise.so compiled and loaded into Asterisk"
fi

# 10c — Compile and Install chan_dongle
echo "  [10c] Compiling chan_dongle..."
if [ ! -f /usr/lib64/asterisk/modules/chan_dongle.so ] && [ ! -f /usr/lib/asterisk/modules/chan_dongle.so ]; then
    cd /usr/src
    if [ ! -d asterisk-chan-dongle ]; then
        git clone https://github.com/wdoekes/asterisk-chan-dongle.git
    fi
    cd asterisk-chan-dongle
    git pull origin master 2>/dev/null || true
    ./bootstrap
    ./configure --with-astversion=18.19.0
    make
    make install
    echo "  chan_dongle compiled and installed"
else
    echo "  chan_dongle already installed"
fi

# 10d — Configure and apply dongle.conf
echo "  [10d] Configuring and applying dongle.conf..."

echo "  Configuring $NUM_DONGLES dongle(s)..."

TEMP_CONF="/tmp/dongle.conf.tmp"
rm -f "$TEMP_CONF"

# Extract everything up to [dongle0] from repository template
sed -n '1,/^\[dongle0\]/ { /^\[dongle0\]/! p }' "$INSTALL_DIR/dongle.conf" > "$TEMP_CONF"

# Append device sections dynamically based on the input
for ((i=0; i<NUM_DONGLES; i++)); do
    audio_port=$((i * 3 + 1))
    data_port=$((i * 3 + 2))
    cat >> "$TEMP_CONF" << EOF

[dongle$i]
txgain=3
rxgain=3
audio=/dev/ttyUSB$audio_port
data=/dev/ttyUSB$data_port
imei=
imsi=
EOF
done

# Copy to Asterisk configuration folder
cp "$TEMP_CONF" /etc/asterisk/dongle.conf
rm -f "$TEMP_CONF"
echo "  dongle.conf successfully generated with $NUM_DONGLES dongle(s) at /etc/asterisk/dongle.conf"

# 10d2 — Ensure /var/log/asterisk/full captures VERBOSE messages (required for SMS/USSD parsing)
echo "  [10d2] Enabling verbose logging in Asterisk logger.conf..."
if grep -q '^full\s*=>' /etc/asterisk/logger.conf; then
    if ! grep -q 'verbose' /etc/asterisk/logger.conf; then
        sed -i 's/^\(full\s*=>.*\)/\1,verbose/' /etc/asterisk/logger.conf
        echo "  verbose added to full log channel"
    else
        echo "  verbose already in full log channel"
    fi
fi

# 10e — Permissions, udev & USB Autosuspend Disable
echo "  [10e] Configuring permissions, udev, and disabling USB autosuspend..."
usermod -a -G lock,dialout asterisk
chgrp asterisk /run/lock 2>/dev/null || true
chmod 775 /run/lock 2>/dev/null || true

cat > /etc/tmpfiles.d/legacy.conf << 'TMPFILES'
d /run/lock 0775 root asterisk -
L /var/lock - - - - ../run/lock
d /run/lock/subsys 0755 root root -
r! /forcefsck
r! /fastboot
r! /forcequotacheck
TMPFILES
echo "  tmpfiles.d configured"

# Install udev rules from repo (permissions for all ttyUSB*)
cp "$INSTALL_DIR/rules/99-huawei-dongle.rules" /etc/udev/rules.d/99-huawei-dongle.rules
chmod 644 /etc/udev/rules.d/99-huawei-dongle.rules
echo "  99-huawei-dongle.rules installed"

cp "$INSTALL_DIR/rules/99-dongle-auto-restart.rules" /etc/udev/rules.d/99-dongle-auto-restart.rules
chmod 644 /etc/udev/rules.d/99-dongle-auto-restart.rules
echo "  99-dongle-auto-restart.rules installed"
# Disable USB autosuspend in GRUB kernel command line
if [ -f /etc/default/grub ]; then
    if ! grep -q 'usbcore.autosuspend=-1' /etc/default/grub; then
        echo "  Configuring GRUB to disable USB autosuspend..."
        sed -i 's/GRUB_CMDLINE_LINUX="\(.*\)"/GRUB_CMDLINE_LINUX="\1 usbcore.autosuspend=-1"/' /etc/default/grub
        if [ -f /boot/grub2/grub.cfg ]; then
            grub2-mkconfig -o /boot/grub2/grub.cfg 2>/dev/null || true
        fi
        if [ -f /boot/efi/EFI/centos/grub.cfg ]; then
            grub2-mkconfig -o /boot/efi/EFI/centos/grub.cfg 2>/dev/null || true
        fi
        if [ -f /boot/efi/EFI/redhat/grub.cfg ]; then
            grub2-mkconfig -o /boot/efi/EFI/redhat/grub.cfg 2>/dev/null || true
        fi
        echo "  GRUB updated with usbcore.autosuspend=-1"
    else
        echo "  GRUB already configured with usbcore.autosuspend=-1"
    fi
fi

# Disable USB autosuspend via modprobe & udev rules
echo "options usbcore autosuspend=-1" > /etc/modprobe.d/usbcore.conf
echo 'ACTION=="add", SUBSYSTEM=="usb", ATTR{power/control}="on"' > /etc/udev/rules.d/99-disable-usb-autosuspend.rules

# Live apply USB autosuspend disable immediately
echo -1 > /sys/module/usbcore/parameters/autosuspend 2>/dev/null || true
for dev in /sys/bus/usb/devices/*/power/control; do
    echo "on" > "$dev" 2>/dev/null || true
done
# Remove old dongle-auto-reload.service if it exists
systemctl stop dongle-auto-reload.service 2>/dev/null || true
systemctl disable dongle-auto-reload.service 2>/dev/null || true
rm -f /etc/systemd/system/dongle-auto-reload.service
echo "  Old dongle-auto-reload.service removed"

# 10f — Reload and restart
echo "  [10f] Reloading rules and restarting Asterisk..."
systemctl daemon-reload
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true
systemctl restart asterisk
echo "  Asterisk restarted"

# 10g — Initialize sim_mappings.json
echo "  [10g] Initializing sim_mappings.json..."
if [ ! -f "$INSTALL_DIR/sim_mappings.json" ]; then
    echo '{}' > "$INSTALL_DIR/sim_mappings.json"
    chmod 644 "$INSTALL_DIR/sim_mappings.json"
    echo "  sim_mappings.json created"
else
    echo "  sim_mappings.json already exists"
fi

# 10h — Initialize AstDB Noise & Audio Defaults
echo "  [10h] Initializing AstDB Noise and Audio defaults..."
asterisk -rx "database put AUDIO_GLOBALS vad_threshold 0.20" 2>/dev/null || true
asterisk -rx "database put AUDIO_GLOBALS vad_hangover 250" 2>/dev/null || true
for ext in $(asterisk -rx "database show AMPUSER" 2>/dev/null | grep "/cidname" | awk -F'/' '{print $2}' | sort -u); do
    curr_denoise=$(asterisk -rx "database get AMPUSER $ext/ai_denoise" 2>/dev/null | grep "Value:" | awk '{print $2}')
    if [ -z "$curr_denoise" ]; then
        asterisk -rx "database put AMPUSER $ext/ai_denoise both" 2>/dev/null || true
    fi
    curr_vad=$(asterisk -rx "database get AMPUSER $ext/vad_gate" 2>/dev/null | grep "Value:" | awk '{print $2}')
    if [ -z "$curr_vad" ]; then
        asterisk -rx "database put AMPUSER $ext/vad_gate 1" 2>/dev/null || true
    fi
done
echo "  AstDB Noise and Audio defaults initialized"

# ──────────────────────────────────────────────
# Step 11 — Configure Apache Reverse Proxy
# ──────────────────────────────────────────────
echo "[11/14] Configuring Apache reverse proxy..."
yum install -y mod_ssl 2>/dev/null || true

# Restore Listen 80 in httpd.conf if it was replaced, and ensure Listen 3000 is present
if ! grep -q '^Listen 80' /etc/httpd/conf/httpd.conf; then
    if grep -q '^Listen 3000' /etc/httpd/conf/httpd.conf; then
        sed -i 's/^Listen 3000/Listen 80/' /etc/httpd/conf/httpd.conf
        echo "  Restored Listen 80 in httpd.conf"
    else
        echo "Listen 80" >> /etc/httpd/conf/httpd.conf
        echo "  Added Listen 80 to httpd.conf"
    fi
fi

# Ensure Listen 3000 is present (so Issabel GUI can run on port 3000)
if ! grep -q '^Listen 3000' /etc/httpd/conf/httpd.conf; then
    sed -i '/^Listen 80/a Listen 3000' /etc/httpd/conf/httpd.conf
    echo "  Listen 3000 added to httpd.conf"
fi

# Remove HTTPS redirect from Issabel vhost (would break proxy)
sed -i '/RewriteEngine On/,/RewriteRule/d' /etc/httpd/conf.d/issabel.conf 2>/dev/null || true
echo "  Issabel HTTPS redirect removed"

# Create dashboard reverse proxy vhost for port 80 with WebSocket support
cat > /etc/httpd/conf.d/dashboard.conf << 'DASHBOARD'
<VirtualHost *:80>
    ProxyPreserveHost On

    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteCond %{REQUEST_URI} ^/socket.io [NC]
    RewriteRule /(.*) ws://127.0.0.1:8080/$1 [P,L]

    ProxyPass /socket.io http://127.0.0.1:8080/socket.io
    ProxyPassReverse /socket.io http://127.0.0.1:8080/socket.io

    ProxyPass / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/
</VirtualHost>
DASHBOARD
echo "  dashboard.conf created (port 80 -> :8080 with WebSocket support)"

# Add ProxyPass & WebSocket rewrite to SSL vhost (port 443 -> :8080)
if ! grep -q 'ProxyPass.*8080' /etc/httpd/conf.d/ssl.conf; then
    sed -i '/ProxyPreserveHost On/d; /RewriteEngine On/d; /RewriteCond %{HTTP:Upgrade}/d; /RewriteCond %{REQUEST_URI}/d; /RewriteRule.*ws:\/\/127\.0\.0\.1:8080/d; /ProxyPass.*8080/d; /ProxyPassReverse.*8080/d' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
    sed -i '/^SSLEngine on$/a\    ProxyPreserveHost On\n    RewriteEngine On\n    RewriteCond %{HTTP:Upgrade} =websocket [NC]\n    RewriteCond %{REQUEST_URI} ^/socket.io [NC]\n    RewriteRule /(.*) ws://127.0.0.1:8080/\$1 [P,L]\n    ProxyPass /socket.io http://127.0.0.1:8080/socket.io\n    ProxyPassReverse /socket.io http://127.0.0.1:8080/socket.io\n    ProxyPass / http://127.0.0.1:8080/\n    ProxyPassReverse / http://127.0.0.1:8080/' /etc/httpd/conf.d/ssl.conf
    echo "  SSL vhost proxied (port 443 -> :8080 with WebSocket support)"
else
    echo "  SSL vhost already proxied"
fi
# Restart Apache
httpd -t 2>&1 | grep -v 'Could not reliably' | grep -v 'AH00558' || true
systemctl restart httpd
echo "  Apache restarted"

# Configure Standalone WebRTC Softphone Apache VirtualHost (port 8443 -> :8090)
cat > /var/www/html/ssl-redirect.html << 'HTML'
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Redirecting to HTTPS...</title>
    <script>
        (function() {
            var host = window.location.host;
            var path = window.location.pathname || '/';
            var search = window.location.search || '';
            window.location.replace('https://' + host + path + search);
        })();
    </script>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding-top: 60px; background: #07070a; color: #ffffff;">
    <h3 style="margin-bottom: 12px;">Redirecting to Secure HTTPS Connection...</h3>
    <p style="color: #9e9eb0; font-size: 13px;">If you are not redirected automatically, <a id="httpsLink" href="#" style="color: #a855f7; font-weight: bold;">click here to continue</a>.</p>
    <script>
        document.getElementById('httpsLink').href = 'https://' + window.location.host + window.location.pathname + window.location.search;
    </script>
</body>
</html>
HTML

cat > /etc/httpd/conf.d/softphone.conf << 'APACHE'
Listen 8443 https

<VirtualHost *:8443>
    SSLEngine on
    SSLCertificateFile /etc/asterisk/keys/asterisk.pem
    SSLCertificateKeyFile /etc/asterisk/keys/asterisk.pem

    ErrorDocument 400 /ssl-redirect.html
    Alias /ssl-redirect.html /var/www/html/ssl-redirect.html

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "8443"

    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:8090/$1 [P,L]

    ProxyPass /ssl-redirect.html !
    ProxyPass / http://127.0.0.1:8090/
    ProxyPassReverse / http://127.0.0.1:8090/
</VirtualHost>
APACHE
echo "  softphone.conf created (port 8443 -> :8090 with auto-HTTPS redirect & WebSocket support)"

# ──────────────────────────────────────────────
# Step 12 — Create systemd Service
# ──────────────────────────────────────────────
echo "[12/14] Creating systemd services..."
cat > /etc/systemd/system/sokrat-voip.service << 'UNIT'
[Unit]
Description=Issabel Dashboard
After=network.target mysqld.service asterisk.service

[Service]
Type=simple
WorkingDirectory=/opt/sokrat-voip
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=root
Environment=NODE_ENV=production
Environment=LANG=en_US.UTF-8
Environment=LC_ALL=en_US.UTF-8

[Install]
WantedBy=multi-user.target
UNIT

# Configure amportal-reload.service with Asterisk readiness pre-check to prevent boot-time AMI race condition
for AMPORTAL_SERVICE in /usr/lib/systemd/system/amportal-reload.service /etc/systemd/system/amportal-reload.service; do
    if [ -f "$AMPORTAL_SERVICE" ]; then
        echo "  Configuring amportal-reload.service with Asterisk readiness pre-check..."
        if ! grep -q "ExecStartPre=" "$AMPORTAL_SERVICE"; then
            sed -i '/\[Service\]/a ExecStartPre=/bin/bash -c '\''for i in $(seq 1 30); do if /usr/sbin/asterisk -rx "core show version" >/dev/null 2>&1; then exit 0; fi; sleep 1; done; exit 0'\''' "$AMPORTAL_SERVICE"
        else
            sed -i 's|^ExecStartPre=.*|ExecStartPre=/bin/bash -c '\''for i in $(seq 1 30); do if /usr/sbin/asterisk -rx "core show version" >/dev/null 2>&1; then exit 0; fi; sleep 1; done; exit 0'\''|' "$AMPORTAL_SERVICE"
        fi
    fi
done

systemctl daemon-reload
systemctl enable --now sokrat-voip
echo "  Service enabled and started"

# Provision Sokrat Standalone WebRTC Softphone Daemon
id -u sokrat-softphone &>/dev/null || useradd -r -s /sbin/nologin -d /opt/sokrat-softphone -c "Sokrat Softphone Daemon" sokrat-softphone
usermod -aG asterisk sokrat-softphone 2>/dev/null || true
chown -R sokrat-softphone:sokrat-softphone /opt/sokrat-softphone 2>/dev/null || true
cat > /etc/systemd/system/sokrat-softphone.service << 'UNIT'
[Unit]
Description=Sokrat Standalone WebRTC Softphone Daemon
After=network.target asterisk.service
Wants=asterisk.service

[Service]
Type=simple
User=sokrat-softphone
Group=sokrat-softphone
WorkingDirectory=/opt/sokrat-softphone
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
# Kernel Hardening & Sandbox
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Environment
Environment=NODE_ENV=production
Environment=PORT=8090
Environment=HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now sokrat-softphone
echo "  Sokrat softphone daemon enabled and started"

# ──────────────────────────────────────────────
# Step 13 — Set timezone to Africa/Cairo
# ──────────────────────────────────────────────
echo ""
echo "[13/14] Setting timezone to Africa/Cairo..."
timedatectl set-timezone Africa/Cairo 2>/dev/null && echo "  Timezone set to Africa/Cairo" || echo "  Warning: Could not set timezone (timedatectl may not be available)"
if [ -f /etc/php.ini ]; then
    sed -i 's@^;\?date\.timezone =.*@date.timezone = "Africa/Cairo"@' /etc/php.ini
    systemctl restart httpd 2>/dev/null || true
    systemctl restart php-fpm 2>/dev/null || true
    echo "  PHP timezone set to Africa/Cairo in /etc/php.ini"
fi
echo "  Current timezone: $(timedatectl 2>/dev/null | grep 'Time zone' || echo 'N/A')"
# ──────────────────────────────────────────────
# Step 14 — Verify
# ──────────────────────────────────────────────
echo ""
echo "[14/14] Verifying installation..."
sleep 2
echo "--- Sokrat VoIP Service ---"
systemctl status sokrat-voip --no-pager -l | head -12
echo ""
echo "--- Sokrat VOICE Softphone Service ---"
systemctl status sokrat-softphone --no-pager -l | head -12
echo ""
echo "============================================"
echo " Installation complete!"
echo " Access Sokrat VOIP Dashboard on: http://<machine_ip>/"
echo " Access Sokrat VOICE Softphone on: https://<machine_ip>/phone/ or https://<machine_ip>:8443/"
echo "============================================"
