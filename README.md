<div align="center">

# ⚡ SOKRAT VOIP
### Next-Generation Enterprise PBX Analytics, WebRTC Softphone & Campaign Switchboard
**Engineered for Issabel 5 & Asterisk 18 on Rocky Linux 8**

[![Node.js Version](https://img.shields.io/badge/node.js-v22.x-68a063?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![Asterisk](https://img.shields.io/badge/Asterisk-18.19.0-f38b00?style=for-the-badge&logo=asterisk)](https://www.asterisk.org/)
[![Issabel](https://img.shields.io/badge/Issabel-5.0.0-cb2026?style=for-the-badge)](https://www.issabel.org/)
[![Rocky Linux](https://img.shields.io/badge/Rocky%20Linux-8.8%20%7C%208.10-10b981?style=for-the-badge&logo=rockylinux)](https://rockylinux.org/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![API Documentation](https://img.shields.io/badge/API-Documentation%20(259%20Endpoints)-8a2be2?style=for-the-badge&logo=openapi-initiative)](API_DOCUMENTATION.md)

[Quick Start](#-installation) • [Key Features](#-core-capabilities) • [API Reference](API_DOCUMENTATION.md) • [System Ports](#-network--service-ports) • [Architecture](#-architecture) • [Default Credentials](#-default-access-credentials) • [Safe Upgrade](#-safe-in-place-upgrade) • [Backups](#-backup-retrieval--export) • [Testing](#-testing--validation)

</div>

---

## 🌟 Overview

**SOKRAT VOIP** is a full-stack, enterprise-grade telecommunications and analytics suite built to transform Asterisk and Issabel PBX installations into a modern, real-time command center. Featuring high-throughput AMI event streaming, WebSockets, multi-dongle hardware GSM monitoring, built-in WebRTC softphones, mobile push-to-wake notifications, an outbound campaign dialer, and high-performance native Excel (`.xlsx`) reporting.

---

## 🚀 Installation

### Option A: Complete 1-Step Setup (Fresh Rocky Linux 8 Server)
> **Recommended**: Clones once and automatically installs Asterisk 18, Issabel 5 (100% offline bundle), and Sokrat VOIP with zero external mirror dependencies.

```bash
yum install -y git && \
git clone https://github.com/Ahmed-Emad02/sokrat-voip-dev.git /opt/sokrat-voip && \
cd /opt/sokrat-voip/installer-bundle && \
bash setup-issabel-asterisk.sh && \
bash install-sokrat.sh
```

### Option B: Quick Online Install (Existing Issabel 5 Server)
```bash
curl -fsSL https://raw.githubusercontent.com/Ahmed-Emad02/sokrat-voip-dev/main/install.sh | bash
```

### Option C: Step-by-Step Offline Setup

**Step 1 — Install Issabel 5 & Asterisk 18 (100% Offline Bundle):**
```bash
yum install -y git && \
git clone https://github.com/Ahmed-Emad02/sokrat-voip-dev.git /opt/sokrat-voip && \
cd /opt/sokrat-voip/installer-bundle && \
bash setup-issabel-asterisk.sh
```

**Step 2 — Install Sokrat VOIP (Without downloading again):**
```bash
cd /opt/sokrat-voip/installer-bundle && \
bash install-sokrat.sh
```

### Quick Uninstall (Restore Default Issabel Web GUI)
```bash
curl -fsSL https://raw.githubusercontent.com/Ahmed-Emad02/sokrat-voip-dev/main/uninstall.sh | bash
```

---

## ⚡ Core Capabilities

| Capability | Highlights |
| :--- | :--- |
| 📊 **Executive Dashboard** | Real-time call volume KPI cards rendered in tabular JetBrains Mono font, hourly distribution trends, inbound vs outbound distribution, airtime gauges, and live agent rosters. |
| 📞 **CDR Analytics & Audio Player** | Advanced search & filtering by DID, extension, disposition, duration, or date. In-browser audio player with seekable slider, playback speed control (0.5×–2×), and **Export to native Excel (.xlsx)**. |
| 🎧 **Sokrat VOICE WebRTC Phone** | Dedicated standalone softphone (Port 8443) running SIP over WSS. Auto-answers intercoms, supports multi-tab session management, transfer, DTMF keypad, and hold. |
| 📱 **Mobile Push Gateway** | Dedicated microservice waking up iOS and Android mobile softphones via Apple Push Notification Service (APNS) and Firebase Cloud Messaging (FCM). |
| 🕵️ **Live Operator Switchboard** | Real-time extension matrix showing idle, ringing, and in-call channels with live duration timers. One-click **Listen**, **Whisper**, and **Barge** via Asterisk ChanSpy. |
| 📶 **GSM Dongle Engine** | Direct multi-modem monitoring (up to 25 dongles). Live RSSI signal gauges, SMS inbox/composer with reply threads, USSD execution console, and hardware disconnect popups. |
| 📢 **Smart Audio Studio** | Built-in sound studio: upload MP3, WAV, OGG, AAC, or FLAC up to 50 MB; auto-converts via static `ffmpeg` to Asterisk-compatible 8000 Hz / 16-bit mono PCM WAV and registers directly in Issabel IVR. |
| 🤖 **AI Speech-to-Text** | Background transcription daemon transcribing recorded calls and indexing transcripts for instant full-text search across the CDR database. |
| 🎯 **Outbound Campaign Dialer** | Create progressive/predictive calling campaigns, import contact lists from Excel/CSV, track lead attempts, agent allocations, and export call disposition reports. |
| 🌗 **Dark / Light & Arabic RTL** | Full bilingual support with automated RTL layout for Arabic (`Cairo` typography) and dark/light OLED theme switching saved in local storage. |

---

## 🌐 Network & Service Ports

| Port | Protocol | Purpose | Authentication |
| :---: | :---: | :--- | :--- |
| **80** | HTTP | Sokrat VOIP Dashboard (redirects to 443) | Session-based |
| **443** | HTTPS | Sokrat VOIP Secure Web Dashboard | `admin` / `admin` (or `root`) |
| **8443** | HTTPS | Sokrat VOICE WebRTC Standalone Softphone | Extension SIP secret |
| **3000** | HTTP | Issabel 5 PBX Admin Web Interface | `admin` / `admin` |
| **3001** | HTTPS | Webmin Linux System Control Panel | System root credentials |
| **8095** | HTTP | Sokrat Push-to-Wake Gateway API | Internal / JWT |
| **5060** | UDP/TCP | SIP Signaling Port (`chan_sip`) | SIP Credentials |
| **5038** | TCP | Asterisk Manager Interface (AMI) | `admin` / `admin` |
| **10000–20000**| UDP | Asterisk RTP Media Streams (Audio) | Media Exchange |

---

## 📂 Architecture & Directory Structure

```text
/opt/sokrat-voip/
├── server.js               # Main Express + Socket.IO server (REST API, AMI & Live Engine)
├── routes/                 # Modular API routes (CRM, Dialer, Recordings, Dongles)
├── lib/                    # Core libraries (CDR aggregation, Phone normalization, Auth)
├── views/                  # EJS Frontend Templates (Tailwind v4, ECharts 5, JetBrains Mono)
├── public/                 # Static assets, WebRTC softphone UI core, custom audio players
├── installer-bundle/       # 100% Offline Rocky Linux 8 Appliance & Dependencies
│   ├── setup-issabel-asterisk.sh   # Master offline PBX appliance installer
│   ├── install-sokrat.sh           # Standalone application installer
│   ├── sokrat-prereqs.tar.gz.*     # 670+ offline RPM packages (multi-part chunks)
│   └── sokrat-npm-modules.tar.gz   # Pre-bundled npm dependencies (zero network required)
└── test/                   # Comprehensive automated test suite (56+ test specs)
```

---

## 🛡️ Default Access Credentials

| Service | URL | Username | Password |
| :--- | :--- | :--- | :--- |
| **Sokrat Dashboard** | `https://<server-ip>/` | `admin` | `admin` |
| **Hardcoded Root** | `https://<server-ip>/` | `root` | `Admin@123` |
| **Issabel PBX GUI** | `http://<server-ip>:3000/` | `admin` | `admin` |
| **MySQL / MariaDB** | `localhost` | `root` | `admin` |
| **Asterisk AMI** | `127.0.0.1:5038` | `admin` | `admin` |
| **Webmin Panel** | `https://<server-ip>:3001/` | `root` | System root password |

---

## 🔄 Safe In-Place Upgrade

Upgrade an existing Sokrat VOIP installation safely with a single command. This applies new stability patches for Asterisk / `chan_dongle`, provisions any new database tables and columns (`CREATE TABLE IF NOT EXISTS`), and sanitizes dialplans to prevent call transfer disconnects—**all while strictly preserving PBX extensions, routes, trunks, IVRs, and call history (CDR)**:

```bash
curl -fsSL https://raw.githubusercontent.com/Ahmed-Emad02/sokrat-voip-dev/main/scripts/safe-upgrade.sh | bash
```

*Or directly from an existing installation:*
```bash
bash /opt/sokrat-voip/scripts/safe-upgrade.sh
```

### 🛡️ What the Safe Upgrade Performs:
1. **Pre-flight Backups:** Automatically creates timestamped backups of `/etc/asterisk/extensions_custom.conf`, `/etc/asterisk/dongle.conf`, and MySQL PBX database schemas in `/opt/sokrat-voip/backups/`.
2. **Codebase Synchronization:** Fetches and fast-forwards the latest Sokrat VoIP features and bug fixes without overwriting local custom settings.
3. **Database Schema Migrations:** Idempotently executes `CREATE TABLE IF NOT EXISTS` and adds missing columns/indexes. Existing tables, PBX configurations, and CDR records are never dropped or altered destructively.
4. **Asterisk & `chan_dongle` Hardening:** Rebuilds `chan_dongle.so` with Condition 32 mutex crash protection, Use-After-Free (UAF) prevention, and audio jitter buffer alignment.
5. **Dialplan Sanitization (Call Transfer Safety):** Removes rogue automated restart commands and deduplicates `[dongle-hangup-cleanup]` contexts so transferring calls between extensions never drops live conversations.
6. **Zero-Downtime Reload:** Replaces driver modules and dialplans in RAM (`dialplan reload`) without requiring an Asterisk daemon restart.

---

## 💾 Backup Retrieval & Export

Every safe upgrade automatically creates a timestamped backup snapshot in `/opt/sokrat-voip/backups/`. You can bundle, inspect, or stream backups directly to your local computer with a single command.

### 🚀 Remote 1-Liner (Stream Backup to Your Local Machine)
Download the latest PBX and database backup snapshot directly to your workstation over SSH (no temporary bundle files created on the server):

```bash
ssh root@<server-ip> "bash /opt/sokrat-voip/scripts/retrieve-backups.sh --stream" > sokrat_backup_$(date +%Y%m%d).tar.gz
```

*Or via curl one-liner directly over SSH:*
```bash
ssh root@<server-ip> "curl -fsSL https://raw.githubusercontent.com/Ahmed-Emad02/sokrat-voip-dev/main/scripts/retrieve-backups.sh | bash -s -- --stream" > sokrat_backup_$(date +%Y%m%d).tar.gz
```

### 📦 Local Server Commands

* **Package latest backup locally on the server:**
  ```bash
  bash /opt/sokrat-voip/scripts/retrieve-backups.sh
  ```
  *(Packages into `/opt/sokrat-voip/backups/sokrat_backup_latest.tar.gz` with SHA256 checksums)*

* **List all available snapshots:**
  ```bash
  bash /opt/sokrat-voip/scripts/retrieve-backups.sh --list
  ```

* **Create a fresh live snapshot right now and bundle it:**
  ```bash
  bash /opt/sokrat-voip/scripts/retrieve-backups.sh --create
  ```

### 📋 Files Included in Each Snapshot
* `asterisk_pbx.bak_<timestamp>.sql`: Full dump of the FreePBX/Asterisk MySQL database (extensions, queues, IVRs, trunks, routes, settings).
* `asterisk_cdr.bak_<timestamp>.sql`: Full dump of the Call Detail Records (`asteriskcdrdb.cdr`) history.
* `extensions_custom.conf.bak_<timestamp>`: Custom Asterisk dialplans and contexts.
* `dongle.conf.bak_<timestamp>`: GSM dongle hardware modem configurations.

---

## 📖 API Documentation & Integration

Sokrat VoIP features an enterprise-grade REST and Telephony API with **259 documented endpoints** spanning 30 functional domains:

* 🔐 **Authentication & Sessions**: Login, multi-session management, password reset tokens, user preferences.
* 🔑 **Static API Key Manager (Root-Only)**: Secure GUI and REST engine for managing AES-256-GCM encrypted API keys (`sokrat_live_...`) with IP whitelisting, scope enforcement, and support for `X-API-Key`, `Authorization: Bearer`, and `?api_key=` audio streams.
* 👥 **User Administration & RBAC**: Accounts, groups, permissions, extension scoping.
* 📊 **CDR & Telephony Reporting**: Fast filtered CDR search, single-record retrieval by Unique ID, phone-based call history matching, byte-range audio streaming, native streaming `.xlsx` exports.
* 🎙️ **Media & Voicemail**: Partial-content HTTP 206 byte-range audio streaming, custom mailbox greetings.
* 🎛️ **PBX Administration**: Extensions (with AGC audio tuning), Trunks, Routes, Queues, Ring Groups, IVRs, Announcements, Time Conditions, MOH, DSP.
* 📱 **GSM Cellular Gateways**: Multi-dongle USB monitoring, USSD query engine, SMS messaging threads, port remapping.
* 📞 **Progressive Outbound Dialer**: High-concurrency automated campaigns, lead management, DNC lists, dispositions.
* 🤝 **CRM Integration REST v1**: Bearer token authentication, customer call history matching, iframe softphone embed tickets.
* 🌐 **Multi-Site Federation**: Inter-branch clustering, IAX2 trunking, distributed GSM pooling.
* 🤖 **AI Speech-to-Text (STT)**: Call & voicemail automated transcription (Whisper, Vosk, Google).

👉 **[Read the Complete API Documentation (API_DOCUMENTATION.md)](API_DOCUMENTATION.md)**

---

## 🧪 Testing & Validation

Run the internal test suite to verify endpoints, schema migrations, and real-time state machines:

```bash
cd /opt/sokrat-voip
npm test
```

To run the full-surface endpoint error scanner across all server routes:
```bash
node --test test/server-endpoints-scan.test.js
```



---

<div align="center">
  <sub>Engineered with ❤️ for high-performance enterprise telecommunications.</sub>
</div>
