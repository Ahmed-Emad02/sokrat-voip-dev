# SPT-ANALYTICS

Real-time PBX analytics dashboard for **Issabel 5 / Asterisk 18** with CDR logs, extension performance metrics, a live operator switchboard, and call recording playback.

## Features

- **Executive Dashboard** — KPI cards, inbound/outbound pie chart, date-range filtering
- **CDR Analytics** — Search call detail records by date, extension, status, source, destination. Custom audio player with seekable slider, playback speed control, and download
- **Extension Statistics** — Per-extension breakdown with disposition pie charts and daily call volume bar graphs. Console overview with sortable metrics for all extensions
- **Live Operator Board** — Real-time extension grid showing idle/ringing/in-call states, call timers, connected partner numbers, and SIP registration. Listen, Whisper, and Barge actions via ChanSpy
- **Light / Dark Mode** — Toggle between themes. Persists across sessions via localStorage
- **RTL / Arabic** — Full English and Arabic interface with automatic RTL layout
- **Custom Audio Player** — Themed play/pause, seekable progress bar, current time / duration display, 0.5×–2× speed selector, download button — replaces native browser audio controls

---

## Fresh Issabel 5 Installation (Copy-Paste)

> Run all commands as **root** on your Issabel 5 server.

### Step 1 — Install Node.js 22

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
yum install -y nodejs
node -v
```

### Step 2 — Clone the Repository

```bash
cd /opt
git clone https://github.com/Ahmed-Emad02/issabel-analytics.git issabel-dashboard
cd /opt/issabel-dashboard
```

### Step 3 — Install Dependencies

```bash
npm install
```

### Step 4 — Create the Environment File

This command automatically reads your MySQL root password from Issabel's config and creates the `.env` file — no manual editing needed:

```bash
MYSQL_PWD=$(grep mysqlrootpwd /etc/issabel.conf | cut -d= -f2- | xargs)
cat > /opt/issabel-dashboard/.env << EOF
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASS=${MYSQL_PWD}
CDR_DB=asteriskcdrdb
ASTERISK_DB=asterisk
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USER=admin
AMI_PASS=admin
RECORDING_ROOT=/var/spool/asterisk/monitor
EOF
```

### Step 5 — Configure Asterisk AMI

Check if an AMI user already exists:

```bash
cat /etc/asterisk/manager.conf
```

If you need to add one, append this block:

```bash
cat >> /etc/asterisk/manager.conf << 'EOF'

[admin]
secret = admin
read = system,call,agent,originate
write = system,call,agent,originate
permit = 127.0.0.1/255.255.255.0

EOF
```

Reload the AMI configuration:

```bash
asterisk -rx "manager reload"
```

### Step 6 — Add ChanSpy Dialplan (Listen / Whisper / Barge)

This enables the operator panel's call monitoring actions (codes `222`, `223`, `224`):

```bash
cat >> /etc/asterisk/extensions_custom.conf << 'DIALPLAN'

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

DIALPLAN
```

> **Important:** If `[from-internal-custom]` already exists in the file, do NOT add a duplicate header. Paste only the `exten =>` lines inside the existing context block.

Reload the dialplan:

```bash
asterisk -rx "dialplan reload"
```

Verify it loaded:

```bash
asterisk -rx "dialplan show from-internal-custom" | head -20
```

### Step 7 — Create systemd Service

```bash
cat > /etc/systemd/system/issabel-dashboard.service << 'EOF'
[Unit]
Description=SPT-ANALYTICS Dashboard
After=network.target mysqld.service asterisk.service

[Service]
Type=simple
WorkingDirectory=/opt/issabel-dashboard
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now issabel-dashboard
```

### Step 8 — Verify

Check the service is running:

```bash
systemctl status issabel-dashboard
```

Open in your browser:

```
http://<your-issabel-ip>:3000
```

---

## GSM Dongles & chan_dongle Setup (Optional)

To enable support for Huawei GSM modems (monitoring & sending USSD commands directly from the dashboard):

### Step 1 — Install Build Dependencies & Asterisk 18 Headers
```bash
yum -y install git gcc gcc-c++ make automake autoconf libtool sqlite-devel usbutils usb_modeswitch minicom
yum -y install asterisk18-devel
```

### Step 2 — Compile and Install chan_dongle
```bash
cd /usr/src
git clone https://github.com/wdoekes/asterisk-chan-dongle.git
cd asterisk-chan-dongle
./bootstrap
./configure --with-astversion=18.19.0
make
make install
```

### Step 3 — Apply Reference dongle.conf Configuration
Copy the pre-configured 10-slot layout (included in this repository) to Asterisk:
```bash
cp /opt/issabel-dashboard/dongle.conf /etc/asterisk/dongle.conf
```

### Step 4 — Configure Permissions & systemd udev Auto-Reload
Grant Asterisk access to write lock files and read serial ports:
```bash
usermod -a -G lock,dialout asterisk
chgrp asterisk /run/lock
chmod 775 /run/lock
```

Add systemd tmpfiles override to persist `/run/lock` permissions across reboots:
```bash
cat > /etc/tmpfiles.d/legacy.conf << 'EOF'
d /run/lock 0775 root asterisk -
L /var/lock - - - - ../run/lock
d /run/lock/subsys 0755 root root -
r! /forcefsck
r! /fastboot
r! /forcequotacheck
EOF
```

Create udev rules for automatic reload upon USB replug:
```bash
cat > /etc/udev/rules.d/99-huawei-dongle.rules << 'EOF'
ACTION=="add", SUBSYSTEM=="tty", ATTRS{idVendor}=="12d1", MODE="0666", GROUP="dialout", TAG+="systemd", ENV{SYSTEMD_WANTS}="dongle-auto-reload.service"
EOF
```

Create the auto-reload systemd service:
```bash
cat > /etc/systemd/system/dongle-auto-reload.service << 'EOF'
[Unit]
Description=Auto reload chan_dongle after Huawei USB dongle plug
After=asterisk.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'sleep 15; chmod 666 /dev/ttyUSB* 2>/dev/null; /usr/sbin/asterisk -rx "dongle reload" 2>/dev/null; /usr/sbin/asterisk -rx "module reload chan_dongle.so" 2>/dev/null'
EOF
```

### Step 5 — Reload Rules and Restart Asterisk
```bash
systemctl daemon-reload
udevadm control --reload-rules
udevadm trigger
systemctl restart asterisk
```

---

## Configuration Reference

All settings live in `/opt/issabel-dashboard/.env`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port for the dashboard |
| `DB_HOST` | `localhost` | MySQL host |
| `DB_USER` | `root` | MySQL username |
| `DB_PASS` | — | MySQL password (auto-read from `/etc/issabel.conf`) |
| `CDR_DB` | `asteriskcdrdb` | CDR database name |
| `ASTERISK_DB` | `asterisk` | Asterisk config database name |
| `AMI_HOST` | `127.0.0.1` | Asterisk Manager Interface host |
| `AMI_PORT` | `5038` | AMI port |
| `AMI_USER` | `admin` | AMI username |
| `AMI_PASS` | `admin` | AMI secret |
| `RECORDING_ROOT` | `/var/spool/asterisk/monitor` | Path to call recordings |

---

## Routes

| Route | Description |
|---|---|
| `/` | Executive dashboard with KPI cards and call direction chart |
| `/cdr` | CDR logs with filters and custom audio player |
| `/ext-stats` | Extension statistics with overview grid and per-extension charts |
| `/operator` | Live operator switchboard with Listen/Whisper/Barge actions |

Append `?lang=ar` or `?lang=en` to any route for language switching.

---

## Project Structure

```
issabel-dashboard/
├── server.js              # Express app, MySQL queries, AMI handler, Socket.io, all routes
├── views/
│   ├── sidebar.ejs        # Shared top navigation bar, theme toggle, clock
│   ├── dashboard.ejs      # Executive KPI dashboard
│   ├── cdr.ejs            # CDR logs with custom audio player
│   ├── ext-stats.ejs      # Extension statistics with charts
│   └── operator.ejs       # Live operator switchboard
├── public/
│   ├── logo.png           # Light mode logo
│   ├── logo_dark.png      # Dark mode logo
│   └── favicon.png        # Browser tab icon
├── .env                   # Credentials (gitignored)
├── .gitignore
├── package.json
└── README.md
```

## Tech Stack

- **Backend:** Node.js 22, Express 4, Socket.io 4, mysql2
- **Frontend:** EJS, Tailwind CSS v4 (CDN), ECharts 5, Cairo font
- **Real-time:** Asterisk AMI (raw TCP), Socket.io WebSocket
- **Database:** MySQL (Issabel CDR — `asteriskcdrdb`)

---

## Troubleshooting

### "The number you have dialed is not in service"

The ChanSpy dialplan was not loaded. Run:

```bash
# Check for Windows line endings (common if edited on Windows)
sed -i 's/\r//' /etc/asterisk/extensions_custom.conf
asterisk -rx "dialplan reload"
```

### No audio on Listen/Whisper/Barge

Ensure the `[from-internal-custom]` context uses the correct channel technology lookup. The dialplan above tries `DB(DEVICE/ext/dial)` first, then falls back to `PJSIP/ext` and `SIP/ext`.

### Dashboard shows 0 calls / empty roster

Check your MySQL credentials in `.env` match the Issabel root password:

```bash
mysql -u root -p -e "SELECT COUNT(*) FROM asteriskcdrdb.cdr;"
```

### All extensions show offline

AMI needs the correct permissions. Verify:

```bash
asterisk -rx "manager show user admin"
```

Ensure `read` includes `system,call`.

---

## Updating

```bash
cd /opt/issabel-dashboard
git pull origin main
systemctl restart issabel-dashboard
```
