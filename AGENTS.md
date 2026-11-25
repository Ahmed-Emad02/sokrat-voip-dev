# AGENTS.md

Guidance and operational gotchas for AI agents working in `/opt/sokrat-voip`.

---

## 1. System & Architecture Overview

* **Stack:** Node.js v22 (Express + Socket.IO), Asterisk 18.19.0, Issabel 5 (FreePBX fork), MariaDB, Apache reverse proxy.
* **App Service:** `sokrat-voip.service` (Node server running on port 8080, reverse-proxied via Apache on ports 80 and 443).
* **Database:** `asterisk` (PBX configurations & users) and `asteriskcdrdb` (Call Detail Records). Credentials in `.env` and `/etc/issabel.conf`.
* **Hardware Drivers:** Multi-modem Huawei 3G GSM dongles (`chan_dongle.so`) and neural noise cancellation (`func_rnnoise.so`).

---

## 2. Testing & Verification

* **Run a single test:**
  ```bash
  node --test test/<test-name>.test.js
  ```
* **Verify schema and installers:**
  ```bash
  node --test test/installer-and-schema.test.js
  ```
* **Verify in-place upgrade and restore:**
  ```bash
  node --test test/system-upgrade-and-restore.test.js
  ```

* **Test live cellular dongles (real voice, SMS, USSD; explicit opt-in):**
  ```bash
  SOKRAT_LIVE_TESTS=1 ./scripts/test-cross-dongle-scenarios.sh
  ```
  This consumes cellular service and may incur charges. Ordinary tests must
  not initiate calls, SMS, USSD, resets, or service restarts.
* **Syntax check shell scripts:**
  ```bash
  bash -n scripts/<script-name>.sh
  ```

---

## 3. Critical Driver & Asterisk Gotchas

* **Activating a new `chan_dongle.so` requires a daemon restart:**
  * `module reload chan_dongle.so` only reads configuration; it does not replace executable code.
  * Replace the module atomically, never overwrite a mapped ELF in place.
  * Use `dongle_module_restart_verified` from `scripts/dongle-module.sh`.
    It checks call/AT queues, requests a graceful daemon restart, and verifies
    the new daemon generation and mapped inode. Asterisk may re-exec without changing PID.
* **Incoming-call tracking:**
  * Do not add broad CLCC release sweeps. Newly created incoming channels need
    their own tracked state; absence from one poll is not proof of release.
* **DTMF State Constraint:**
  * `AT^DTMF` cannot be processed by Huawei modems during dialing or ringing states. Sending it before answer causes a modem timeout and drops the USB connection.
  * The driver must drop or ignore DTMF until `cpvt->state == CALL_STATE_ACTIVE`.
* **Canceled Outgoing Calls Must Retain Modem Tracking Until Teardown Response:**
  * `channel_hangup()` already queues `AT+CHUP`/`AT+CHLD=1x` when `CALL_FLAG_NEED_HANGUP` is set, clearing the flag on successful enqueue before `disactivate_call()`. Do not enqueue a duplicate hangup or force outgoing `INIT`/`DIALING`/`ALERTING` calls to `RELEASED` during local cleanup.
  * Drop the Asterisk channel references normally, but retain modem call tracking and busy state until a successful hangup acknowledgement or modem-reported release. The `CHUP`/`CHLD_1x` OK handler may release only its own acknowledged `task->cpvt` when it is not `sys_chan` and has no channel; it must not sweep other detached calls or independently clear `pvt->dialing`. `change_channel_state()` handles dialing cleanup for the released call. A hangup ERROR is not success or proof that the radio call ended: preserve tracking and busy state until modem-reported release/disconnect. Local hangup alone is not a modem teardown acknowledgement.
  * The exact trigger of the unresponsive dongle incident is unproven. Continuing `^BOOT` URCs do not prove dead hardware or a responsive AT command interface. The observed USB hub has no port power switching: USB reset/rebind is not a true power cycle, and software reset recovery must not be promised.
* **AT timeout and queue discipline:**
  * A timeout alone does not prove firmware failure; parser/framing bugs can lose valid replies.
  * Compact `+CLCC`/`+CMGR` framing must preserve final payload fields and terminal replies.
  * A lost CLCC poll must not immediately transmit the next queued SMS command.
    The bounded CSQ recovery barrier waits for a distinctive response and its
    terminal result; late CLCC replies cannot complete unrelated work.
  * Failed recovery is bounded and disconnects rather than indefinitely
    suppressing liveness probes behind repeated CLCC polling.
  * BUSY/NO CARRIER must retain the original task's call context before dequeue.
  * Every accepted multipart/queued SMS part keeps restart deferral active until
    its task is removed; do not clear a single busy bit on the first part.
  * Serial discovery must not probe any interface of a USB modem already owned
    by another process. Lockfile checks alone do not establish exclusive
    ownership; preserve termios when probing a genuinely unowned endpoint.
  * Probe ownership regressions use
    `python3 -m unittest discover -s test -p 'test_probe_dongle_serial.py'`.
    Do not invoke `probe-dongle-serial.py --help`: it starts a real scan.
* **Driver release provenance:**
  * `asterisk/chan_dongle-series` is the complete, mandatory patch order.
    The source builder checks real patch hunks, not grep-based markers.
  * Rebuild and strip `installer-bundle/binaries/chan_dongle.so`, then update
    `SOKRAT_CHAN_DONGLE_BUNDLE_SHA256` in the shared helper. The digest there,
    not an old hash in documentation, is authoritative.
  * Use isolated compiled queue/response regressions plus the real source-build
    helper. String-presence tests do not prove modem behavior or installer safety.

---

## 4. Dialplan & PBX Rules

* **Never edit `/etc/asterisk/extensions_additional.conf` directly:**
  * This file is auto-generated by FreePBX/Issabel and will be overwritten.
  * All custom contexts belong in `/etc/asterisk/extensions_custom.conf`.
* **Applying FreePBX config changes:**
  * Whenever MariaDB PBX tables (IVR, ring groups, queues, incoming routes) are updated, run:
    ```bash
    /var/lib/asterisk/bin/retrieve_conf && asterisk -rx "dialplan reload"
    ```
* **Inbound Route DID Retention:**
  * In `[from-dongle-custom]`, incoming calls match `_+X.`. Do not replace `${EXTEN}` with `s` before preserving the DID into `${MY_SIM_NUMBER}`. If `${MY_SIM_NUMBER}` becomes `"s"`, FreePBX will fail to match specific inbound routes.
* **External Failover Routing (`[ext-external-failover]`):**
  * Modems cannot bridge incoming and outgoing calls on the same single SIM.
  * If a call arrives on `dongle0`, failover to an external number must route through `dongle1` (or vice versa), or specify an explicit trunk (`ext-external-failover,<number>/<dongle>,1`).
  * If using `outbound-allroutes`, append `/n` (`Local/<number>@outbound-allroutes/n,60`) to prevent caller ID mismatch and channel collapse.

---

## 5. UI & Frontend Conventions (`views/config.ejs`, `views/sidebar.ejs`)

* **Custom Select Dropdown Wrapper (`enhanceSelectElements`):**
  * `views/sidebar.ejs` converts standard `<select>` elements into custom UI components wrapped in `<div class="custom-select-wrapper">`, appending options menus to `document.body`.
  * If dynamically hiding a `<select>` via JavaScript, you must hide its parent `.custom-select-wrapper` and close any open floating menu. Use `setFieldVisibility(element, false)`.
* **Bilingual Arabic/English (RTL/LTR):**
  * Every new form input, label, badge, and table header must support Arabic (`isRtl` condition with `Cairo` font).

---

## 6. Multi-Installer Synchronization Requirement

Whenever dialplan contexts, database schemas, or driver configurations change, you must keep all three deployment scripts in sync:
1. `install.sh` (Fresh online single-script installer)
2. `installer-bundle/install-sokrat.sh` (Offline bundle installer)
3. `scripts/safe-upgrade.sh` (Non-destructive in-place upgrade script)

Database migrations in `backend/install_db.sql` must be idempotent (`CREATE TABLE IF NOT EXISTS`) and mapped in `scripts/safe-upgrade.sh` using `ensure_db_column` / `ensure_db_index`.

---

## 7. Public gateway mission (operator contract — preserve this section)

This section is standalone operational context for the mobile/public-gateway
work. It is appended to the existing PBX runbook; do not replace or reorder the
sections above.

### 7.1 Mission and non-negotiable constraints

- Goal: smooth, reliable **inbound and outbound** call audio for Sokrat Mobile
  **worldwide**, through the public gateway `13.140.209.230`, with the handset on
  ordinary Wi-Fi/cellular and **no VPN/overlay client on the phone** (no
  Tailscale, ZeroTier, WireGuard, OpenVPN, or similar).
- **Media must remain UDP end to end**: handset ↔ public gateway ↔ PBX.
  Signaling may be HTTPS/WSS. Do not add TCP/TLS media fallback or TURN-over-TCP
  for this mission. Do not change DSP unless synchronized interval evidence
  proves a specific defect and the change is explicitly approved.
- **Codec is PCMU only** (G.711 μ-law, 8000 Hz, RTP PT 0). DTMF may use RFC 4733
  `telephone-event`. PBX dongles support only PCMU; do not enable or offer Opus,
  add FEC codec trials, or introduce transcoding by default, even if a PBX
  supports Opus. Any codec change requires a new, explicit user request.
- Preserve the mobile app's native NetEq minimum playout delay at **300 ms**
  (`kAudioJitterBufferMinimumDelaySeconds = 0.300` in
  `apps/sokrat-mobile-main/android/app/src/main/cpp/neteq_minimum_delay.cpp`).
  It is the current baseline, not a speculative tuning knob.
- Preserve the existing **gateway ↔ PBX transport exactly**. The user initially
  described it as **OpenVPN over FRP** and explicitly qualified it as "I think".
  Verified read-only runtime evidence shows FRP over TCP/TLS 7000 carries
  **signalling/API only**, while media is plain UDP, HMAC-authenticated TUN on
  `skm3` (demo: gateway UDP 26003 ↔ 10.253.0.14) and `skm2` (sales: UDP 26002).
  `sokrat-wg-relay` is an orphan with no WireGuard interface or consumer, and the
  `openvpn-frp` labels/configs are stale. Do not change, migrate, relabel, or
  reconfigure the live transport without explicit approval.
- Preserve **push-to-wake** (FCM/APNs plus CallKit/TelecomManager), tenant
  authorization/approval, extension policy, SIP authentication, and desktop SIP
  behavior. Do not modify desktop extensions, outbound routes (`outrt-*`), or
  trunk macros (`macro-dialout-trunk`) for mobile work.
- No new VPS and no purchases. Improve the existing gateway and PBX.
- **This-session deployment override:** the user declared a test environment and
  pre-authorized immediate fix deployments and required service restarts on the
  existing gateway/PBX/emulator stack, with no routine per-fix prompts. This does
  not authorize a physical phone, new VPS/purchases, tunnel/firewall changes,
  unrelated scope, signature/security bypasses, forced faults, or unverified
  success claims. It also does not authorize ordinary-test calls, SMS, USSD, or
  resets; the restrictions in §2 remain. Preserve PCMU-only, UDP-only, NetEq
  300 ms, the production signer, and the existing transport.

### 7.2 Actual targets and access (sensitive — project use only)

- **Public gateway:** `13.140.209.230`
- **Control UI:** `https://13.140.209.230/control/`
- **Gateway root SSH:** `ssh root@13.140.209.230`
  - **Password:** `^uBZH£7]1Gx400`
  - The sixth character is the pound sign `£` (U+00A3), not `f`. The value has no
    trailing newline; copy it exactly.
- **PBX management IPv4 (Tailscale):** `100.98.185.86` — **management only**
- **PBX root SSH:** `ssh root@100.98.185.86`
  - **Password:** `Admin@123`
- **PBX codebase:** `/opt/sokrat-voip`

`13.140.209.230` is the **only** mobile end-to-end target. `100.98.185.86` is
management access to this PBX; never configure it as the handset's server and
never use it for mobile E2E tests. These root credentials are supplied by the
user for project-only access after explicit acceptance of plaintext exposure.
Never copy them into application source, runtime configuration, tests, logs,
tickets, chat, or unrelated documents, and do not use them for unrelated actions.
This file is Git-tracked in the PBX repository: do not commit it while plaintext
credentials are present. If a credential is committed or exposed, rotate it
immediately. For scripted SSH use a private mode-0600 file with
`sshpass -f <private-file>`, never `sshpass -p` or an echoed command line.

### 7.3 Mobile E2E and evidence rules

- Test only through the public gateway with **VPN disabled on the handset**.
  Never use `10.0.2.2`, the stopped isolated lab, a local gateway, or the PBX
  Tailscale address. `emulator-5554` is the available test device; only the parent
  agent may mutate it, install builds, or place calls. A physical phone is
  forbidden.
- Cover outbound answer/two-way audio and inbound wake/ring/answer/two-way audio,
  plus hold/resume, DTMF, transfer, screen-off/cold-process FCM wake,
  Wi-Fi/cellular switch, and concurrent CRM registration. Do not infer success
  from FCM/APNs provider acceptance, a WebSocket handshake, or SIP registration
  alone.
- Capture **synchronized interval evidence** from both directions on one clock:
  RTP/RTCP packets, sequence gaps, loss, jitter, RTT; NetEq/jitter-buffer delay
  and concealment/expand rate; PCM gaps/clipping/levels where safe; and
  gateway/PBX/handset CPU, memory, load, and socket/queue errors.
- Cumulative counters alone are not proof. Cumulative concealment does not
  establish the cause of a current gap. State the measurement window, clock
  source, and raw log locations.
- Do not enable broad RTP payload logging, capture real conversations, or record
  real users. Metadata/statistics only.
- Verify unknowns with tools; if a host or topology fact is unreachable, ask the
  user rather than inventing it or filling the gap from stale docs.

**Verified PBX audio state (2026-11-25):**

- Synthetic MILLIWATT/timerfd clock-stall gaps are a generator artifact:
  coalesced 9 ticks ack1 generates one frame; normal rtpclock resync is 80ms.
  Timerfd normal nice0 bare tests are healthy at 1.6–4.7ms with no CPU quota
  throttle. No safe global PBX tuning is justified; no config changed. Do not
  extrapolate synthetic timestamp gaps to live GSM voice.
- The dongle peak-gate fix is present in the live bundle/script (pin `7baa5c…`,
  same inode/source header): bounded 2100 mute+limiter, no `env_peak`.
- GSM is **VERIFIED end-to-end on one received-only call**; attempts 1–4 never
  reached an external party, attempts 5 and 6 connected and passed audio, and only
  attempt 6 had app-side capture. Attempt 6: dial 12:14:58Z,
  `dongle1-0100000004` up 69s, `max_connected=60000`ms; PBX
  `receive-attempt6.wav` 68.04s, peak 24435 (no clipping), RMS ~2700, 163 speech
  windows at 100ms. Emulator playout `capture/playout6.*` 69.59s, 6959 writes,
  `droppedCaptureFrames=0`, `shortAudioTrackWrites=0`, zero exact gaps >100ms.
  Correlation 0.939 at 1.8s lag; 26/163 (16%) PBX-active speech windows attenuated
  <100 RMS and longest dropout 100ms—normal PCMU/GSM + NetEq, not the original
  multi-second choppiness. ~65ms write-start gaps are buffered NetEq burst
  delivery; total audio duration matches. No microphone recording; user percept
  remains pending, so do not claim microphone/outbound GSM quality. Fixes: app
  stuck-call slot `9d12b5ff16`, harness gate `DialBegin`/`DestChannel` + 10s
  dogwatch, mixmonitor header-row parser. Do not write the target phone number.
- PBX duplicate PJSIP section handling is endpoint-discovery merging-only; this
  fixed the installer blocker and the strict dialplan parser is retained.
- Cold E2E pass call `0646cd8c…`: matched INVITE 5863.045, ANSWER 5890.678, AMI
  Originate Success Reason 4 at 5894.361, Wait 5 hangup; gateway readiness
  2412ms, old contact removed and new contact dialed, warm next-call wait 0.
  Native has no defect and APK `119/.22` is unchanged. This supersedes the failed
  `7bc1…` test (Dial before fresh REGISTER, AMI Reason 8). Unit/readiness passes
  are not E2E proof.
- PBX pcaps 131/170 had capture-kernel drops and are **invalid as sender-loss
  proof**; the gateway's three legs had 0 loss.
- GSM is verified on one received-only call; user percept and microphone
  direction remain unproven. Do not claim universal device or all-audio quality.

### 7.4 Delegation preference

For tedious test execution, file work, and report collation, prefer the requested
**OpenCodeGo DeepSeekV4.1Flash max** model when available. If it is unavailable,
report that explicitly; do not silently substitute another model.
