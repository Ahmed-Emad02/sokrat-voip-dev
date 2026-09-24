<div align="center">

# ⚡ SOKRAT VOIP
### Next-Generation Enterprise PBX Analytics, WebRTC Softphone & Campaign Switchboard
**Engineered for Issabel 5 & Asterisk 18 on Rocky Linux 8**

[![Node.js Version](https://img.shields.io/badge/node.js-v22.x-68a063?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![Asterisk](https://img.shields.io/badge/Asterisk-18.19.0-f38b00?style=for-the-badge&logo=asterisk)](https://www.asterisk.org/)
[![Issabel](https://img.shields.io/badge/Issabel-5.0.0-cb2026?style=for-the-badge)](https://www.issabel.org/)
[![Rocky Linux](https://img.shields.io/badge/Rocky%20Linux-8.8%20%7C%208.10-10b981?style=for-the-badge&logo=rockylinux)](https://rockylinux.org/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

[Quick Start](#-installation) • [Key Features](#-core-capabilities) • [System Ports](#-network--service-ports) • [Architecture](#-architecture) • [Default Credentials](#-default-access-credentials) • [Testing](#-testing--validation)

</div>

---

## 🌟 Overview

**SOKRAT VOIP** is a full-stack, enterprise-grade telecommunications and analytics suite built to transform Asterisk and Issabel PBX installations into a modern, real-time command center. Featuring high-throughput AMI event streaming, WebSockets, multi-dongle hardware GSM monitoring, built-in WebRTC softphones, mobile push-to-wake notifications, an outbound campaign dialer, and high-performance native Excel (`.xlsx`) reporting.

---

## 🚀 Installation

### Option A: Complete 1-Step Setup (Fresh Rocky Linux 8 Server)
> **Recommended**: Clones once and automatically installs Asterisk 18, Issabel 5 (100% offline bundle), and Sokrat VOIP with zero external mirror dependencies.

```bash
git clone https://github.com/Ahmed-Emad02/sokrat-voip-dev.git /tmp/sokrat-repo && \
cd /tmp/sokrat-repo/installer-bundle && \
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
git clone https://github.com/Ahmed-Emad02/sokrat-voip-dev.git /tmp/sokrat-repo && \
cd /tmp/sokrat-repo/installer-bundle && \
bash setup-issabel-asterisk.sh
```

**Step 2 — Install Sokrat VOIP (Without downloading again):**
```bash
cd /tmp/sokrat-repo/installer-bundle && \
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

## 📜 Updating & Maintenance

To update Sokrat VOIP to the latest version while preserving your local database and SIM configurations:

```bash
cd /opt/sokrat-voip
git pull origin main
systemctl restart sokrat-voip sokrat-softphone
```

---

<div align="center">
  <sub>Engineered with ❤️ for high-performance enterprise telecommunications.</sub>
</div>
