# chan_dongle lifecycle rules

These rules apply to driver patches and override historical startup-CHUP advice
in the parent runbook. See `../docs/chan-dongle-lifecycle-hardening.md`.

- Healthy modem-confirmed call release returns to Free without replacing the
  serial session. Do not add post-call restart/reset/rebind/reload hooks.
- Initialization ends in **read-only CLCC, never CHUP**. Preserve inherited calls.
  CSQ ERROR must not drop that CLCC. Startup CLCC retries are read-only and bounded
  to three transmitted attempts; exhaustion stays connected/not-ready for an
  operator, without a restart loop.
- Do not append CHUP to a poisoned/partial AT frame. A dirty SMS prompt must remain
  discoverable for bounded ESC cleanup even after its failed queue task is freed.
- Late terminal replies must not complete unsent work. Media/pipe writes must not
  wait on POLLOUT while holding device locks.
- Build all patches in `chan_dongle-series`, rebuild the stripped release bundle,
  and update the shared helper's SHA256 pin. A module reload is not activation.
- Unit regressions must be isolated from live modems, CLI, DB writes and IPC.
  Live tests and activation are separate, explicitly authorized operations.
