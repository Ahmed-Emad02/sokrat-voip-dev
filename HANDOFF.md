# Sokrat VOIP & Telephony Suite — Engineering Handoff Document
**Date:** October 20, 2026
**Primary Repository:** `sokrat-voip` (Remote: `https://github.com/Ahmed-Emad02/sokrat-voip-dev.git`)
**Target Servers:**
- **Test Server:** `100.98.185.86` (`sokrat-demo`, branch `feature/auto-interface-discovery`, commit `da1c0ad`)
- **Production Server:** `100.92.104.104` (`sokrat-sales`, branch `main`, commit `a0bec4b`)
**Core Telephony Engine:** Asterisk 18.19.0 (Rocky Linux 8.10), FreePBX / Issabel Core, chan_dongle, PJSIP, WebRTC WSS

---

## 1. Executive Summary

This handoff documents the engineering deliverables, architectural enhancements, cellular DSP implementations, UI refinements, WebRTC infrastructure hardening, and bug fixes across the Sokrat VOIP platform as of October 20, 2026.

Key milestones achieved:
1. **Auto-Dial Campaign Card Display & Toolbar Layout**: Resolved an issue where newly created auto-dial campaigns were stored in the database but failed to render in the user interface. Streamlined the campaign card layout into a minimal, space-efficient horizontal presentation without sacrificing operational controls or live metrics. Unified all toolbar action buttons and 3-dot dropdown items to a consistent aesthetic.
2. **Cellular Audio Processing (DSP) Suite**: Implemented real-time server-side digital signal processing in Asterisk using native channel filters (`DENOISE`, `RNNOISE`, `AGC`) without external audio proxies. Created tiered dialplan routing (Universal Defaults -> Per-Dongle Overrides -> Per-Extension Overrides), REST management APIs, and an Audio Processing studio in the PBX configuration tab.
3. **40-Dongle Scaling Architecture & RF Analysis**: Evaluated physical and electrical scalability for connecting 40 GSM dongles to a single host. Documented mitigation strategies for 217 Hz TDMA cellular burst radiation, USB xHCI host controller endpoint exhaustion, and bus isolation via discrete PCIe expansion cards.
4. **Jitter Buffer Default State**: Disabled Asterisk jitter buffers by default across clean installers (`install.sh`, `installer-bundle/install-sokrat.sh`) and upgrade routines (`scripts/safe-upgrade.sh`), setting default `cellular_jitterbuffer` to `off`.
5. **Production Server Sync & WebRTC Hardening (`100.92.104.104`)**: Synchronized production dialplan hooks with safety backups, resolved WebRTC certificate validation issues via automatic combined PEM healing, configured PJSIP AOR multi-registration (`max_contacts=10`, `remove_existing=no`), and verified live WebRTC call origination on Extension 161.
6. **GSM Dongles Minimal View**: Restructured the minimal view on `/gsm-dongles` so that each modem occupies its own dedicated, full-width row with responsive 6-column alignment.
7. **Theme Switch Optimization**: Replaced a laggy full-viewport blur backdrop-filter ripple with a 120fps hardware-composited toggle switch featuring dual Sun and Moon track icons, an inset optical pill, and a solid black dynamic center glyph on the sliding thumb.
8. **CDR Records System & Audio Player Polish**: Resolved a SQL error (`Unknown column 'c.call_scope' in 'where clause'`) when filtering internal calls. Modernized the CDR media player by removing backgrounds, borders, and pseudo-element shutter covers from all action buttons, scaling icons by 150%, replacing solid play/pause buttons with hollow soft-edged SVG paths, shortening the seek slider by 15% anchored from the left, and eliminating duration timestamp clipping for calls exceeding one hour (`H:MM:SS`) in both LTR and RTL layouts.

---

## 2. Detailed Technical Breakdown

### A. Auto-Dial Campaign Center (`views/dialer.ejs`)
- **Root Cause Analysis**:
  - In `loadCampaigns()`, client-side JavaScript attempted to reference translation object `t` and boolean `isRtl`.
  - These variables were defined only in server-side EJS execution context, throwing an unhandled `ReferenceError: t is not defined` inside a silent `catch (_) {}` block.
  - The API call to `/api/dialer/campaigns` returned HTTP 200 with complete campaign data, but DOM rendering aborted before cards were constructed.
- **Client Script Correction**:
  - Injected `const t = <%- JSON.stringify(t) %>;` and `const isRtl = Boolean(<%- JSON.stringify(isRtl) %>);` directly at the head of the browser script in `views/dialer.ejs`.
- **Minimal Card Architecture**:
  - Reduced outer card padding and consolidated loose status badges into an inline metadata strip (`Dongles • Agents`).
  - Flattened metrics into a 4-column counter (`Total`, `Pending`, `Connected`, `Failed`).
  - Unified toolbar action buttons and contextual dropdown items to a clean neutral aesthetic with subtle hover states.
- **Git Commits Merged to Remote Main**: `b83fbfe`, `911c910`, `09d1e88`, `dcabf93`.

### B. Cellular Audio Processing (DSP) Suite & 40-Dongle Scaling
- **Acoustic & Bandpass Analysis**:
  - Cellular 2G/3G voice operates over AMR-NB (Adaptive Multi-Rate Narrowband) sampled at 8 kHz with a strict 300 Hz - 3400 Hz acoustic passband.
  - Broadcast De-Essers (targeting 4 kHz - 8 kHz) have no audible effect because high frequencies are eliminated prior to modem ingestion.
  - Vocal presence boost frequencies were shifted from 3.5 kHz down to 2.2 kHz - 2.8 kHz to remain within the AMR-NB band.
- **Asterisk Channel Filters**:
  - `DENOISE(rx/tx)=on`: Speex pre-filter cutting low-frequency rumble below 100 Hz, electrical hum, and 217 Hz TDMA cellular carrier noise.
  - `RNNOISE(..., gate=on, threshold=..., mindb=...)`: Recurrent neural network noise reduction and downward expander noise gate suppressing ambient room noise, fan hum, and breathing.
  - `AGC(rx/tx)=8000`: Real-time RMS/peak level leveling and soft limiter preventing digital clipping on modem ADC inputs.
- **Tiered Dialplan Routing (`/etc/asterisk/extensions_custom.conf`)**:
  - **Inbound (`[from-dongle-custom]`)**: Checks Asterisk DB for dongle-specific audio profile (`/DONGLE_AUDIO/${DONGLENAME}/...`), falling back to system defaults (`/AUDIO_GLOBALS/...`).
  - **Outbound Trunks (`[macro-dialout-trunk-predial-hook]`)**: Checks target trunk override (`/DONGLE_AUDIO/${DONGLE_TARGET}/...`), falling back to global settings.
  - **Internal Extensions (`[macro-dialout-one-predial-hook]` & `[func-apply-sipheaders-custom]`)**: Checks extension profile (`/AMPUSER/${EXT}/...`), falling back to globals.
- **Backend APIs (`server.js`)**:
  - `GET /api/config/audio-globals` & `PUT /api/config/audio-globals`
  - `GET /api/config/audio/dongles` & `PUT /api/config/audio/dongles/:id`
  - `GET /api/config/audio/extensions` & `PUT /api/config/audio/extensions/:ext`
- **UI Studio (`views/config.ejs`)**:
  - Added dedicated subtab `#section-audioprocessing` with universal defaults, a live table of physical dongle profiles, and a searchable extension roster.
  - Fixed `loadDonglesAudioState` ReferenceError and 400 Bad Request parameter validation.
- **Jitter Buffer Defaults**:
  - Disabled hardcoded `Set(JITTERBUFFER(adaptive)=default)` calls in `install.sh` and `installer-bundle/install-sokrat.sh`.
  - Added automated sanitization in `scripts/safe-upgrade.sh` to clean legacy jitter buffer lines.
  - Set fallback default for `cellular_jitterbuffer` to `'off'`.
- **40-Dongle Scaling & RF Guidelines**:
  - **RF Mitigation**: 40 modems transmit pulsed 217 Hz TDMA radiation. Recommendations include external directional antenna extensions, physical separation of modem clusters, and chassis shielding.
  - **USB Bus Architecture**: Each modem consumes 3-4 USB endpoints (control, data, audio). Standard xHCI controllers support 32-64 endpoints. Deploying 40 modems requires discrete PCIe USB expansion cards (e.g. VIA VL805 or Renesas uPD720101) allocating no more than 6-8 modems per host controller, accompanied by industrial externally powered hubs supplying 2A per port.

### C. WebRTC Infrastructure & Production Server Sync (`100.92.104.104`)
- **Safety Pre-Checks**:
  - Generated pre-upgrade dialplan backup: `/etc/asterisk/extensions_custom.conf.bak.20261019180245`.
- **Certificate Auto-Healing**:
  - Asterisk HTTP WSS TLS requires both private key and certificate in a single PEM file (`/etc/asterisk/keys/asterisk.pem`).
  - Patched `scripts/safe-upgrade.sh` and `server.js` to automatically concatenate `/etc/asterisk/keys/asterisk.key` and `/etc/asterisk/keys/asterisk.crt` into `asterisk.pem` on launch or upgrade.
- **PJSIP Multi-Registration Configuration**:
  - Set `max_contacts=10` and `remove_existing=no` across WebRTC endpoints in `pjsip_custom.conf`.
  - Enables simultaneous registration for Desktop CRM WebRTC softphone, Mobile App, and MicroSIP desktop clients without registration flapping or call collisions.
- **Extension 161 Verification**:
  - Verified Extension 161 registered via WSS (`100.120.23.53:57174`) and tested live call origination into ringing state.
  - Production server synchronized up to commit `a0bec4b`.

### D. GSM Dongles Minimal View (`views/gsm-dongles.ejs`)
- **Row-Based Architecture**:
  - Transformed `#dongles-grid.dongles-view-minimal` from boxed cards into full-width responsive flex rows (`.dongle-minimal-row`).
- **Layout & Column Alignment**:
  - Configured 6-column CSS grid: Identity (Icon + Name), Phone Number, IMEI, Status Pill, Signal Bars, and Action Controls.
  - Included mobile wrap fallback for responsive tablet and smartphone viewports.

### E. Theme Switch Optimization (`views/sidebar.ejs`)
- **Frame Rate & Stutter Fix**:
  - Removed Anime.js full-screen backdrop-filter blur ripple that caused noticeable frame drops during theme transitions.
- **Visual Design & Physics**:
  - Replaced switch with a 52x28px inset pill containing amber Sun and cyan Moon track icons.
  - Promoted sliding thumb to GPU-composited `translate3d()` layer with high-frequency spring curve (`cubic-bezier(0.34, 1.56, 0.64, 1)`).
  - Rendered active thumb center glyph in solid black (`#000000`).
- **Typography Metric Audit**:
  - Verified identical typography sizing across dark and light themes, ensuring layout geometry remains static during toggles.

### F. CDR Records System & Audio Player Redesign (`views/cdr.ejs`, `views/voicemails.ejs`)
- **MySQL Query Correction**:
  - Fixed error `Unknown column 'c.call_scope' in 'where clause'` when selecting "Internal Only" trunk filter.
  - Embedded dynamic `${CDR_CALL_SCOPE_CASE}` calculation directly into `buildTrunkFilterSql()` in `server.js`.
- **Audio Player Borderless Controls**:
  - Stripped backgrounds, borders, and pseudo-element shutter covers (`button::before`) from Mute, Download, Transcribe, and Delete buttons.
- **Icon Sizing**:
  - Scaled media player SVG icons by 150% (from 14px to 20px, and delete icon to 24px).
- **Hollow Soft Playback Icon**:
  - Replaced solid filled geometric shapes with outlined stroke paths featuring rounded apex and soft organic corners (`da1c0ad`, `9e9e458`).
- **Seek Slider Length**:
  - Shortened seek slider track by 15% (width: 85%) anchored from the left (`63a8792`).
- **Duration Timestamp Clipping**:
  - Replaced fixed width container with `min-w-[32px] w-auto whitespace-nowrap`.
  - Updated `fmtTime()` in client JavaScript to format call durations exceeding one hour as `H:MM:SS`, preventing overlap with adjacent volume controls in English (LTR) and Arabic (RTL) layouts (`308ed86`).

---

## 3. Server Topology & Service Matrix

| System / Host | IP / Network | Role | Active Services & Ports | Fleet / Capacity |
| :--- | :--- | :--- | :--- | :--- |
| **Test PBX** | `100.98.185.86` (`sokrat-demo`) | Primary dev & QA bench | `sokrat-voip.service` (:8080)<br>`asterisk.service` (:5038, :8089)<br>`sokrat-softphone.service` (:8090)<br>`sokrat-push-gateway.service` (:8095)<br>Whisper STT (:8000) | 2 modems (`dongle0` Etisalat, `dongle1` offline)<br>Endpoints 101, 103 active via WSS |
| **Production PBX** | `100.92.104.104` (`sokrat-sales`) | Live production PBX | `sokrat-voip.service` (:8080)<br>`asterisk.service` (:5038, :8089)<br>`sokrat-softphone.service` (:8090) | 6 modems (`dongle0` WE, `dongle1` Orange, `dongle2` Etisalat, `dongle3`, `dongle4` Orange, `dongle9` Orange)<br>31 extensions |
| **CRM Web Server** | `localhost:8081` (host) -> `:80` | Sales CRM & Lead Hub | Apache, PHP 8.3 / Laravel 11, MySQL 8 | Enterprise CRM with native WebRTC & MicroSIP drivers |

---

## 4. Git Commit History & Branch State

### Test Server (`/opt/sokrat-voip` on `100.98.185.86`)
Active branch: `feature/auto-interface-discovery`
- `da1c0ad` style(player): round apex and corners on hollow play and pause SVG icons for soft organic edges
- `9e9e458` style(player): switch solid play/pause icons to hollow outlined stroke polygons
- `308ed86` fix(cdr): prevent duration timestamp clipping when call exceeds one hour (H:MM:SS) in both LTR and RTL
- `0d8ad34` feat(crm): expose auto-detected network interfaces in /health endpoint
- `63a8792` style(cdr): reduce media player seek slider length by 15 percent anchored from left
- `45f2647` style(ui): universally exempt media player buttons and delete actions from shutter cover and force transparent background
- `a087535` style(cdr): scale audio player buttons 150 percent and convert play button to minimal transparent svg playback icon
- `a4d54d1` style(cdr): remove border, background, and pseudo-shutter cover from CDR delete action button
- `1871e06` style(player): enforce strict transparent background, borderless, and disabled pseudo-shutter cover on audio player controls
- `8738d0c` feat(crm): auto-discover host network interfaces and return candidate socket URLs for multi-path WebRTC
- `a55f64b` style(player): make audio player mute, download, and transcribe buttons borderless and transparent
- `9ea1336` fix(cdr): resolve unknown column call_scope in internal trunk filter SQL and make toggle thumb glyph solid black
- `acbf40b` feat(ui): merge minimal dongle row view and revamped 120fps hardware-accelerated theme toggle

### Production Server (`/opt/sokrat-voip` on `100.92.104.104`)
Active branch: `main` (synchronized up to `a0bec4b`)
- `a0bec4b` fix(upgrade): ensure WebRTC combined certificate auto-heals during safe-upgrade
- `5f52ab1` feat(dsp): merge tiered audio processing studio and installer jitter buffer disabling
- `69fdb8d` feat(installer): disable jitter buffer by default on install and upgrade
- `10b80bc` feat(dsp): implement tiered per-dongle and per-extension DSP audio processing controls and UI tables
- `1eb8d2a` fix(config): disambiguate DSP form control IDs and provide robust fallback defaults

---

## 5. Verification & Test Evidence

| Component / Subsystem | Verification Method | Result | Notes |
| :--- | :--- | :---: | :--- |
| **Auto-Dial Campaigns** | Campaign creation & UI reload | **PASS** | Cards render immediately; action buttons unified. |
| **Audio Processing Studio** | API fetch & Asterisk DB inspect | **PASS** | Globals and per-dongle overrides persist correctly. |
| **Jitter Buffer Defaults** | Clean installer inspection | **PASS** | Jitter buffer commented out; defaults to off. |
| **WebRTC Multi-Registration** | Registration query (`pjsip show endpoints`) | **PASS** | `max_contacts=10`, `remove_existing=no`. |
| **Extension 161 (Prod)** | Live WSS handshake & call test | **PASS** | Endpoint online; call origination confirmed. |
| **Theme Toggle** | GPU frame profiling & DOM audit | **PASS** | 0ms frame drops; solid black thumb glyph; static typography. |
| **CDR Internal Filter** | Database query with internal only | **PASS** | 0 SQL errors; correct scope calculation. |
| **CDR Player Styling** | Visual inspection & call duration test | **PASS** | Borderless/transparent buttons, 150% icons, soft hollow play/pause, 85% slider, H:MM:SS format without clipping. |

---

## 6. Standard Operating Procedures (SOP) & Runbook

### Deploying Updates to Production (`100.92.104.104`)
```bash
# 1. Connect to production server via Tailscale
ssh root@100.92.104.104

# 2. Run safe upgrader (creates backup, pulls main, auto-heals certs, restarts service)
cd /opt/sokrat-voip
./scripts/safe-upgrade.sh

# 3. Verify service status and Asterisk health
systemctl status sokrat-voip.service
asterisk -rx "dongle show devices"
asterisk -rx "pjsip show endpoints"
```

### Merging Feature Branch to Main on Test Server (`100.98.185.86`)
```bash
# 1. Connect to test bench
ssh sokrat-demo

# 2. Switch to main and merge feature branch
cd /opt/sokrat-voip
git checkout main
git merge feature/auto-interface-discovery

# 3. Push to remote repository
git push origin main

# 4. Restart services
systemctl restart sokrat-voip.service
```

### Checking Audio Processing Filters in Asterisk CLI
```bash
# Check database tree for audio settings
asterisk -rx "database show AUDIO_GLOBALS"
asterisk -rx "database show DONGLE_AUDIO"
asterisk -rx "database show AMPUSER"

# Monitor active channel audio hooks during live call
asterisk -rx "core show channel <active-channel-id>"
```
