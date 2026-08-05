#!/bin/bash
# Issabel Dashboard — Automated installer for Issabel 5 / Asterisk 18
# Run as root on a fresh Issabel 5 installation.
# Usage: bash install.sh

set -euo pipefail

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

INSTALL_DIR=/opt/sokrat-voip
REPO_URL=https://github.com/Ahmed-Emad02/sokrat-voip-dev.git
REPO_BRANCH=main
NODE_SETUP_URL=https://rpm.nodesource.com/setup_22.x
MYSQL_ROOT_PWD=$(grep mysqlrootpwd /etc/issabel.conf 2>/dev/null | cut -d= -f2- | xargs || true)

echo "============================================"
echo " Issabel Dashboard Installer v1.7.0"
echo " Target: Issabel 5 / Asterisk 18"
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
    echo "  Directory $INSTALL_DIR exists, pulling latest..."
    cd "$INSTALL_DIR"
    git config http.postBuffer 524288000 2>/dev/null || true
    git remote set-url origin "$REPO_URL"
    git fetch --depth 1 origin "$REPO_BRANCH" || git fetch origin "$REPO_BRANCH"
    git checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH"
else
    if ! git clone --depth 1 --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"; then
        echo "  Shallow clone failed, retrying git clone..."
        git clone --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
fi

mkdir -p "$INSTALL_DIR/public/js"
if [ ! -f "$INSTALL_DIR/public/js/jssip.min.js" ]; then
    echo "  Warning: jssip.min.js missing from repo, fetching static asset..."
    curl -fsSL -o "$INSTALL_DIR/public/js/jssip.min.js" https://cdn.jsdelivr.net/npm/jssip@3.10.1/dist/jssip.min.js
fi
if [ ! -f "$INSTALL_DIR/public/js/jssip.min.js" ]; then
    echo "  Error: Failed to locate or download public/js/jssip.min.js" >&2
    exit 1
else
    echo "  WebRTC static assets verified (jssip.min.js)"
fi

# ──────────────────────────────────────────────
# Step 4 — Install Dependencies
# ──────────────────────────────────────────────
echo "[4/14] Installing npm dependencies from package-lock.json..."
npm ci --omit=dev

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
    echo "  Notice: ffmpeg binary skipped; audio conversion will use sox/issabel fallback"
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
    echo "  .env AMI credentials updated ($AMPMGR_USER)"
else
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
EOF
    echo "  .env created"
fi

# ──────────────────────────────────────────────
# Step 6 — Initialize Database Tables
# ──────────────────────────────────────────────
echo "[6/14] Initializing database tables..."
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk < "$INSTALL_DIR/backend/install_db.sql"

# Older/partial Announcement module installs can lack the Pico TTS columns.
# Use information_schema checks rather than version-specific ADD IF NOT EXISTS syntax.
ANNOUNCEMENT_TABLE_EXISTS=$(mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -Nse \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcement'")
if [ "$ANNOUNCEMENT_TABLE_EXISTS" != "1" ]; then
    echo "  Error: Issabel's required asterisk.announcement table is missing" >&2
    exit 1
fi

ANNOUNCEMENT_TTS_LANG_EXISTS=$(mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -Nse \
    "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcement' AND COLUMN_NAME = 'tts_lang'")
if [ "$ANNOUNCEMENT_TTS_LANG_EXISTS" = "0" ]; then
    mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e \
        "ALTER TABLE \`announcement\` ADD \`tts_lang\` VARCHAR(10) NOT NULL DEFAULT 'en-US'"
fi

ANNOUNCEMENT_TTS_TEXT_EXISTS=$(mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -Nse \
    "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcement' AND COLUMN_NAME = 'tts_text'")
if [ "$ANNOUNCEMENT_TTS_TEXT_EXISTS" = "0" ]; then
    mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e \
        "ALTER TABLE \`announcement\` ADD \`tts_text\` TEXT NOT NULL DEFAULT ('')"
fi
echo "  Announcement TTS schema ensured"
echo "  Database tables ensured"

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

# Strip old [from-internal-custom] before appending (ensures upgrades get the latest version)
echo "  Stripping old [from-internal-custom]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\\[from-internal-custom\\].*?(?=\\n\\[|\\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append ChanSpy & Hijack from-internal-custom
append_context '[from-internal-custom]' '[from-internal-custom]' << 'CHANSPY'

[from-internal-custom]
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

CHANSPY

# Install AGI hijack script
echo "  Installing AGI hijack script..."
mkdir -p /var/lib/asterisk/agi-bin
cp "$INSTALL_DIR/agi-bin/hijack_call.py" /var/lib/asterisk/agi-bin/hijack_call.py
chmod +x /var/lib/asterisk/agi-bin/hijack_call.py
chown asterisk:asterisk /var/lib/asterisk/agi-bin/hijack_call.py
echo "  hijack_call.py installed."

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
same => n,NoOp(Caller Number: ${CALLER_NUMBER})
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
exten => s,1,NoOp(--- Outbound call via Dongle (CID auto-set by trunk outcid) ---)
same => n,Set(JITTERBUFFER(adaptive)=default)
same => n,Set(RAW_TARGET=${CUT(OUT_${DIAL_TRUNK},/,2)})
same => n,Set(DONGLE_TARGET=${DB(DONGLE_DEVICE_MAP/${RAW_TARGET})})
same => n,ExecIf($["${DONGLE_TARGET}"=""]?Set(DONGLE_TARGET=${RAW_TARGET}))
same => n,Set(CHANNEL(hangup_handler_push)=dongle-hangup-cleanup,s,1)
same => n,MacroExit()

[dongle-hangup-cleanup]
exten => s,1,NoOp(--- Pure Dialplan Dongle Hangup Cleanup ---)
same => n,ExecIf($["${DONGLE_TARGET}"=""]?Set(DONGLE_TARGET=${CUT(CHANNEL,-,1)}))
same => n,ExecIf($["${DONGLE_TARGET:0:7}"="Dongle/"]?Set(DONGLE_TARGET=${DONGLE_TARGET:7}))
same => n,ExecIf($["${DB_EXISTS(DONGLE_DEVICE_MAP/${DONGLE_TARGET})}"="1"]?Set(DONGLE_TARGET=${DB(DONGLE_DEVICE_MAP/${DONGLE_TARGET})}))
same => n,GotoIf($["${DONGLE_TARGET}"="" | "${DONGLE_TARGET:0:6}"!="dongle"]?done)
same => n,Verbose(1, [DONGLE-DIALPLAN-CLEANUP] Resetting dongle ${DONGLE_TARGET} via dialplan System call (Cause: ${HANGUPCAUSE}, DialStatus: ${DIALSTATUS}))
same => n,System(/usr/sbin/asterisk -rx "dongle restart now ${DONGLE_TARGET}" &)
same => n(done),Return()
MACRO
# Strip old [macro-dialout-one-predial-hook] before appending
echo "  Stripping old [macro-dialout-one-predial-hook]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\\[macro-dialout-one-predial-hook\\].*?(?=\\n\\[|\\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append macro-dialout-one-predial-hook
append_context '[macro-dialout-one-predial-hook]' '[macro-dialout-one-predial-hook]' << 'ONEHOOK'

[macro-dialout-one-predial-hook]
exten => s,1,NoOp(--- Dynamic Adaptive Jitter Buffer for Internal/Extension Call ---)
same => n,Set(JITTERBUFFER(adaptive)=default)
same => n,MacroExit()

ONEHOOK

asterisk -rx "dialplan reload" 2>/dev/null || true
echo "  Dialplan reloaded"

# ──────────────────────────────────────────────
# Step 10 — GSM Dongle Setup
# ──────────────────────────────────────────────
echo ""
echo "[10/14] Setting up GSM dongles & chan_dongle..."

# 10a — Install Build Dependencies
echo "  [10a] Installing build dependencies..."
yum -y install gcc gcc-c++ make automake autoconf libtool sqlite-devel usbutils usb_modeswitch minicom
yum -y install asterisk18-devel

# 10b — Compile and Install chan_dongle
echo "  [10b] Compiling chan_dongle..."
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

# 10c — Configure and apply dongle.conf
echo "  [10c] Configuring and applying dongle.conf..."

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

# 10c2 — Ensure /var/log/asterisk/full captures VERBOSE messages (required for SMS/USSD parsing)
echo "  [10c2] Enabling verbose logging in Asterisk logger.conf..."
if grep -q '^full\s*=>' /etc/asterisk/logger.conf; then
    if ! grep -q 'verbose' /etc/asterisk/logger.conf; then
        sed -i 's/^\(full\s*=>.*\)/\1,verbose/' /etc/asterisk/logger.conf
        echo "  verbose added to full log channel"
    else
        echo "  verbose already in full log channel"
    fi
fi

# 10d — Permissions & udev
echo "  [10d] Configuring permissions and udev..."
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

# Remove old dongle-auto-reload.service if it exists
systemctl stop dongle-auto-reload.service 2>/dev/null || true
systemctl disable dongle-auto-reload.service 2>/dev/null || true
rm -f /etc/systemd/system/dongle-auto-reload.service
echo "  Old dongle-auto-reload.service removed"

# 10e — Reload and restart
echo "  [10e] Reloading rules and restarting Asterisk..."
systemctl daemon-reload
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true
systemctl restart asterisk
echo "  Asterisk restarted"

# 10f — Initialize sim_mappings.json
echo "  [10f] Initializing sim_mappings.json..."
if [ ! -f "$INSTALL_DIR/sim_mappings.json" ]; then
    echo '{}' > "$INSTALL_DIR/sim_mappings.json"
    chmod 644 "$INSTALL_DIR/sim_mappings.json"
    echo "  sim_mappings.json created"
else
    echo "  sim_mappings.json already exists"
fi

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
    sed -i '/^SSLEngine on$/a\    ProxyPreserveHost On\n    RewriteEngine On\n    RewriteCond %{HTTP:Upgrade} =websocket [NC]\n    RewriteCond %{REQUEST_URI} ^/socket.io [NC]\n    RewriteRule /(.*) ws://127.0.0.1:8080/\$1 [P,L]\n    ProxyPass /socket.io http://127.0.0.1:8080/socket.io\n    ProxyPassReverse /socket.io http://127.0.0.1:8080/socket.io\n    ProxyPass / http://127.0.0.1:8080/\n    ProxyPassReverse / http://127.0.0.1:8080/' /etc/httpd/conf.d/ssl.conf
    echo "  SSL vhost proxied (port 443 -> :8080 with WebSocket support)"
else
    echo "  SSL vhost already proxied"
fi
# Restart Apache
httpd -t 2>&1 | grep -v 'Could not reliably' | grep -v 'AH00558' || true
systemctl restart httpd
echo "  Apache restarted"

# ──────────────────────────────────────────────
# Step 12 — Create systemd Service
# ──────────────────────────────────────────────
echo "[12/14] Creating systemd service..."
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

systemctl daemon-reload
systemctl enable --now sokrat-voip
echo "  Service enabled and started"

# ──────────────────────────────────────────────
# Step 13 — Set timezone to Africa/Cairo
# ──────────────────────────────────────────────
echo ""
echo "[13/14] Setting timezone to Africa/Cairo..."
timedatectl set-timezone Africa/Cairo 2>/dev/null && echo "  Timezone set to Africa/Cairo" || echo "  Warning: Could not set timezone (timedatectl may not be available)"
echo "  Current timezone: $(timedatectl 2>/dev/null | grep 'Time zone' || echo 'N/A')"

# ──────────────────────────────────────────────
# Step 14 — Verify
# ──────────────────────────────────────────────
echo ""
echo "[14/14] Verifying installation..."
sleep 2
systemctl status sokrat-voip --no-pager -l | head -12
echo ""
echo "--- Last 10 log lines ---"
journalctl -u sokrat-voip -n 10 --no-pager -l
echo ""
echo "============================================"
echo " Installation complete!"
echo ""
echo "  http://<your-issabel-ip>     -> Custom Dashboard"
echo "  https://<your-issabel-ip>    -> Custom Dashboard (SSL)"
echo "  http://<your-issabel-ip>:3000 -> Issabel Web Interface"
echo "============================================"
