# Dongle configuration and recovery

## Configuration ownership

`/etc/asterisk/dongle.conf` owns the logical `dongleN` slots. An existing
configuration is preserved even when it contains no `dongle0` section.
Fresh installations create empty capacity slots, not guessed `/dev/ttyUSB*`
bindings. Root can add/remove empty slots through **GSM Dongles → Dongle
slots** or `/api/gsm-dongles/slots`.

Huawei devices can expose different numbers and roles of serial interfaces.
Use the model/interface inventory and `/dev/serial/by-path/...` bindings.
The physical USB port is stable while `/dev/ttyUSB*` enumeration numbers and
the fleet's colliding Huawei `by-id` names are not.

Discovery may fill or repair existing slots; it does not create additional
capacity slots. A modem needs an available slot before it can be adopted.
Serial probing must not open any interface of a modem already owned by
another process. Unknown models and unknown ownership fail closed.

The former `scripts/dongle-autoconfig.py` package and its reconciliation timer
are retired. Do not install or invoke them.

## Automatic reconciliation

The Node application schedules reconciliation after startup, USB-link changes,
and live/configured IMSI drift. Settings are in
`/etc/sokrat/dongle-auto-adopt.json`. USB events use trailing debounce and an
enumeration-readiness check rather than a periodic port-probing loop.

Configuration writes preserve unrelated sections and metadata. Active or
unknown call/SMS state postpones disruptive operations. Failed changes are
rolled back per slot; rollback never unloads the entire dongle module.
An orphaned runtime entry can remain stopped until the next natural Asterisk
restart rather than resetting every modem to clear a cosmetic entry.

An intentional `initstate=stop`, removal, or empty unassigned slot is not a
recovery failure. Recovery must not resurrect it.

For eligible unhealthy slots, the app recovery watchdog can request a targeted
restart after 90 seconds and a USB detach/rebind after a further 120 seconds.
Persistent failure is flagged for attention. USB deauthorization, rebind and
reset are **not guaranteed physical power cycles**; recovery cannot repair an
unresponsive baseband by software on every hub.

## Driver safety

- Configuration reload applies the requested restart policy before checking
  eligibility. Repeating an unchanged reload does not cancel a pending change.
- Graceful changes wait for modem call tracking and all accepted SMS parts,
  not just Asterisk's active-channel count.
- Local hangup preserves modem call tracking until modem acknowledgement.
  BUSY/NO CARRIER uses the original dial's context even when another AT task
  is queued.
- A CLCC `ERROR` is nonfatal. A lost CLCC response holds the queue behind a
  bounded, identifiable CSQ resynchronization probe. Late terminal responses
  cannot complete the next SMS command. Failed resynchronization disconnects
  rather than leaving an indefinitely busy ghost call.
- Inbox polling starts only after SMS initialization succeeds. Voice-only
  hardware rejects SMS submission explicitly.

## Deployment

`scripts/dongle-module.sh` builds from the pinned upstream commit and the
complete ordered `asterisk/chan_dongle-series`. Every listed patch is required;
missing or incompatible patches abort before replacing an installed driver.
Patch state is checked from the actual hunks, never a source-text marker.

The stripped release artifact is
`installer-bundle/binaries/chan_dongle.so`; its SHA-256 is pinned in the shared
helper. Regenerate the artifact and its pin together after C changes.

`module reload chan_dongle.so` reads configuration; it does **not** activate
new binary code. Binary replacement is atomic and activation uses a verified
graceful daemon restart. Verification checks the daemon generation and mapped
driver inode rather than accepting an old module's `Running` status. Asterisk
may re-exec with the same PID.

Online install, offline install, upgrade and restore share these policies.
`sokrat-watchdog` is left disabled; Laya autonomous maintenance is not
automatically enabled. Upgrade/restore do not start a disabled daemon or erase
the SIM's SMS storage.

## Logs and incident bundles

Driver lifecycle, call transitions, restart decisions, configuration changes,
network registration and SMS/USSD events are recorded in
`/var/log/asterisk/full`. Persistent Asterisk settings are verbose 3/debug 2.
The logging setup preserves operator categories and avoids duplicate `full`
channels across Issabel regeneration.

Rotation retains 14 archives with a 250 MB size threshold and frequent checks.
This is a check-interval bound, not an instantaneous hard size limit; a burst
can exceed the threshold before the next check.

Collect a read-only snapshot:

```bash
sudo bash scripts/dongle-debug-bundle.sh
```

The collector creates a new private directory, bounds command execution time,
and records collection failures. Existing/custom output directories are not
reused. Bundles contain subscriber identities, phone numbers and potentially
message content; do not publish or attach them without reviewing/redacting.

## Verification

Run isolated regression tests without hardware:

```bash
node --test test/dongle-module-install.test.js test/dongle-graceful-restart.test.js test/live-cellular-opt-in.test.js
python3 -m unittest discover -s test -p 'test_probe_dongle_serial.py'
```

Read-only deployed-host checks are explicit:

```bash
SOKRAT_HOST_TESTS=1 node --test test/dongle-module-installed.test.js
```

Cellular scenarios place real calls and send SMS/USSD, potentially consuming
credit. They are excluded by default and require a maintenance window:

```bash
SOKRAT_LIVE_TESTS=1 node --test test/cross-dongle-call-scenarios.test.js
SOKRAT_LIVE_TESTS=1 bash scripts/test-cross-dongle-scenarios.sh
```
