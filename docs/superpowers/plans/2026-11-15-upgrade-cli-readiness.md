# PBX Upgrade CLI Readiness Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current session. Write a failing test before each change (`skill://test-driven`) and cite fresh evidence before claiming a task done (`skill://verification-before-completion`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an otherwise healthy PBX upgrade from failing while Asterisk's control socket is still starting.

**Architecture:** Keep the shared `dongle_module_wait_running` verifier and its existing deadline. Treat a temporarily unqueryable module state as not ready until that deadline, rather than returning immediately. Missing binaries, an absent daemon, and a module that never becomes running still fail closed.

**Tech Stack:** Bash helper; Node built-in test runner and isolated executable fixtures.

**Spec:** User request: fix the upgrader so updated servers can connect to a gateway seamlessly. Observed sales deployment: `asterisk.service` is `Type=simple`; its restart returned before the CLI socket was usable, causing the verifier to fail although the released module subsequently reached `Running` without another restart. This plan addresses that confirmed defect; the separately reported gateway provisioning failure is being diagnosed independently and is not claimed fixed by this change.

## Global Constraints

- Preserve the verifier's arguments and bounded timeout.
- Never accept unknown/unavailable module state as success.
- No extra Asterisk restart, account conversion, gateway enrollment, transport change, or phone upgrade.
- Keep the connected phone on tested APK 1.2.24.

## Review Focus

- CLI initially unavailable, then module Running: upgrade succeeds within its deadline.
- CLI remains unavailable: upgrade fails at the deadline.
- Module is explicitly Not Running: failure remains covered by the existing test.
- Zero timeout: the existing single-observation behavior is retained.
- Missing executable/daemon: existing fail-closed guards remain unchanged.

---

### Task 1: Make native-module startup verification honor its deadline

**Files:**
- Modify: `scripts/dongle-module.sh`, `dongle_module_wait_running`
- Modify: `test/dongle-module-install.test.js`
- Modify: `WEBRTC-WAKE.md` upgrade troubleshooting section after successful verification

**Interfaces:** Existing `dongle_module_wait_running [timeout] [asterisk-command]`; exit zero only after the actual module status is Running.

- [x] Add an isolated CLI fixture that fails its first query and subsequently reports Running; also exercise a permanently unavailable CLI.
- [x] Run the focused regression and observe the current premature failure.
- [x] Remove the immediate return for a failed status query, retaining that state in the existing bounded loop and final failure report.
- [x] Run the module-install test file and Bash syntax check.
- [x] Document the Type=simple/control-socket boundary without claiming gateway media readiness.
- [x] Request focused review and act on material findings.
