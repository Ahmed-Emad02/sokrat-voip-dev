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
