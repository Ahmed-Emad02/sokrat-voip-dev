# Dongle lifecycle contract

Normal operation: modem-confirmed call release -> dispose of that call's resources
-> `Free`, retaining the current AT/serial session. No post-call restart, reset,
USB rebind, configuration rewrite or module reload is required.

## Manual recovery default

`/etc/sokrat/dongle-lifecycle-policy.json` is shared by the Node watchdog,
auto-adoption scheduler, Laya watcher/scheduled maintenance, and system watchdog.
Absent, unreadable or invalid policy means manual/observation-only mode.

```json
{"version":1,"mode":"manual","autonomousRecovery":false,"maxRecoveryAttempts":3,"backoffBaseMs":60000,"backoffMaxMs":1800000,"recoveryPauseMs":1800000}
```

Monitoring, CLCC/status reads, incoming/outgoing call control and physical device
presence discovery remain enabled. Authenticated explicit operator maintenance
and previously requested **operator-origin** deferred maintenance remain available.
Automatic-origin pending rollbacks retain their provenance and cannot stop, write
configuration or reload after policy revocation; their expected snapshot is taken
before deferral so later operator edits are protected. Manual mode also
disables automatic modem adoption/config synchronization; use explicit provisioning.
Policy revocation is checked again after asynchronous safety queries and when a
delayed adoption timer fires. Optional autonomous recovery requires both explicit
mode (`"autonomous"` or `"auto"`) and the JSON boolean `true`, not a string or
number. JS and Python share typed numeric limits and bounded attempts/backoff/stop
reporting. A stopped automatic ladder still permits explicit manual maintenance,
subject to normal idle/cooldown safety.

The driver still closes an actually failed serial session and performs configured
device discovery after true endpoint loss; this is distinct from restarting a
healthy modem at call release. Manual policy does not power-cycle hardware or
turn off Asterisk/systemd crash supervision. The existing local Laya IPC trust
boundary is unchanged.

## Driver protections (16-patch series)

- Skipped DTMF/COPS/CCWA timeouts use the same bounded distinctive CSQ response
  boundary as CLCC; a late terminal reply cannot acknowledge the successor.
- Unsent DTMF is cancelled at call destruction and validated against the original
  ACTIVE owner and radio index at dispatch. In-flight work keeps its boundary.
- AT command writes use POLLOUT and a monotonic total deadline, checked even during
  repeated EINTR or partial progress. Temporary zero-progress writes keep queue
  ownership within a bound. Partial/fatal writes poison the session: no successor
  command is sent before monitor teardown. No partial call/SMS command is replayed.
  A dirty SMS prompt survives task removal so teardown can send bounded ESC; CHUP
  is skipped on a poisoned stream even if ESC succeeds. Shared media/pipe writes
  never wait on POLLOUT (at most ten immediate write attempts). AT writes still
  have a one-second total budget under the device lock: bounded, not wait-free.
- An unsent queue head cannot consume OK/ERROR/BUSY/NO CARRIER/SMS-prompt replies;
  zero-progress back-pressure is not proof that a hangup reached the modem.
- Orphan/mismatched SMS completions are ignored; each written PDU accepts at most
  one completion, without dereferencing absent tasks or consuming unrelated work.
- Startup has no unconditional CHUP. A read-only CLCC reconciles calls before
  publishing readiness. Incoming calls are handled without blanket termination;
  inherited active/outgoing/held calls retain exact-index detached tracking until
  reported release or explicit maintenance. Failed reconciliation does not falsely
  advertise availability. CSQ ERROR does not discard the following CLCC. Failed
  startup CLCC is retried read-only up to **three transmitted attempts**, with a
  distinctive CSQ barrier before timeout retries. Exhaustion logs an operator
  inspection requirement and remains connected/not-ready, without restarting.
  Unknown post-init CONN also allows exact-index read-only reconciliation, without
  duplicating an unindexed outbound call. DDSETEX ACK is not init completion.
- Shutdown closes the discovery-wake gate and joins without holding the lock
  needed by monitor cleanup. A condition variable and persistent wake generation
  prevent a stop/restate notification being lost before the discovery wait.
  Thread lifetime is preserved with a complete join.

## Verification and activation

Use the actual pinned source, complete `asterisk/chan_dongle-series`, shared build
helper, and compiled ASan/UBSan regressions. The mandatory bundle digest is in
`scripts/dongle-module.sh`. Replace installed ELF files atomically; activate code
with `dongle_module_restart_verified`, not a module reload. Check all radio call,
channel, SMS and AT queues before this one deployment restart.

The ordinary regression suite must not access the live CLI, network or DB. Laya
Python unit tests use `test/fixtures/laya-offline.js`: external processes, socket
connects, device/sysfs opens/ioctls and DB writes fail loudly unless explicitly
mocked. HTTP integration probes are skipped unless `SOKRAT_LIVE_TESTS=1`.
Previous “offline” runs before this guard were not truly isolated (an unmocked
ladder escalation issued actual dongle restarts); do not reuse those results as
no-mutation evidence.

Live cellular tests require explicit opt-in, must target only the operator's test
SIMs, and must not use resets/rebinds as a way to make a test pass. Verify answer,
release ownership, post-call queues, session/daemon continuity and synthetic media.
A ringing call or queued SMS alone does not prove completed delivery/audio.
No software-only test certifies immunity from all firmware, network, power or USB
faults.
