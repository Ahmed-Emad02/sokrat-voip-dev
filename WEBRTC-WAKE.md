# Scoped WebRTC incoming-call wake

Feature branch: `feature/webrtc-cold-wake`. This is not a replacement for
FreePBX's shared dialing macros or customer outbound routes.

## Scope and behavior

`scripts/install-webrtc-wake.py` derives eligible extensions from **both** a
provisioned `webrtc=yes` post-config section and the matching generated
`PJSIP/<extension>` hint. A stale WebRTC setting cannot intercept an extension
that has been converted back to standard SIP. Matching pinned reverse-TLS
enrollment is required. Extension numbers are discovered, never hardcoded.

For each eligible extension, the compiler preserves its four observed FreePBX
`ext-local` applications and inserts a `Gosub` immediately before its existing
`Macro(exten-vm,...)`. Hints and generated source stay untouched. Only exact
WebRTC entries are loaded through an additive include in the existing active
override file. A single managed `Gosub(sub-sokrat-group-wake,...)` is inserted
before `dialparties.agi` in the shared `macro-dial` context, so ring groups,
follow-me and other destinations that build their dial string there wake their
WebRTC members before FreePBX filters unavailable endpoints. The helper is a
no-op when the list has no WebRTC members, preserves all existing macro labels
(`dialparties.agi` jumps by label), and is removed again when no WebRTC
extension remains. Queues whose members use FreePBX's normal
`Local/<ext>@from-queue/n` path are covered by the existing `ext-local` wake
entry that the Local channel reaches. Trunk macros, global outbound patterns,
audio multipliers and early-media `Progress()` are not modified. Unknown/custom
route templates and conflicting operator overrides refuse before writes rather
than approximating the customer's call flow.

Wake preparation respects extension DND, unconditional forwarding and configured
unavailable forwarding. It sends a pinned authenticated HTTPS request with the
existing PBX identity/token. Only a response reporting at least one delivered
mobile push enables the bounded registration wait. Credential errors, missing
devices and gateway outages continue into normal FreePBX routing; credentials
and provider payloads are never logged.

The HTTP deadline is6 seconds; registration wait is at most12 seconds. Comparing
the new contact count with the pre-push count prevents an existing CRM contact
from immediately masking an asleep mobile. Existing contacts are never removed
or singled out for dialing; FreePBX still builds its normal multi-contact dial
string afterward. If a phone was already connected and no new contact appears,
the preparation can consume the bounded wait. This is not a transport-readiness
claim or an authorization decision based on a contact/user-agent heuristic.

A canonical raw call UUID is placed in inherited FreePBX SIP headers. The gateway
scopes the same raw UUID for push and the SIP application header; SIP protocol
Call-ID and SDP are not modified. A WebRTC-only compatibility flag prevents
duplicate historical Sokrat wake hooks on that same leg, without editing them.

## Installation and lifecycle

```sh
# Read-only plan first:
python3 scripts/install-webrtc-wake.py
# Apply, leaving reload to the enclosing maintenance operation:
python3 scripts/install-webrtc-wake.py --apply --no-reload --verify-access
```

Managed output is `/etc/asterisk/extensions_sokrat_webrtc_wake.conf`, root-owned
and readable by the Asterisk group. Existing include-file ownership and mode are
preserved. Changes are privately backed up under `/var/backups/sokrat-voip/`.
The dispatcher is installed root-owned at
`/usr/local/bin/sokrat-webrtc-wake-dispatch.py`. Apply is serialized; unsafe paths,
ambiguous includes, unmanaged output and mismatched enrollment refuse safely.

The root-owned dispatcher is installed with mode **0755** (no credentials are
embedded); hook credentials remain private. Apply repairs dispatcher permission
drift even when its contents already match. Do not manually copy it with
root:root0750: that prevents Asterisk from reading the script and produces an
empty SHELL result instead of sending a wake push.

All three installer/upgrader paths request `--verify-access`. For a paired PBX
with eligible extensions this reads the dispatcher, private hook, pinned CA and
managed dialplan as the actual `asterisk` user and runs a no-arguments dispatcher
probe. It must return exactly one byte (`0`), with exit0 and no stderr. No push,
call or account mutation occurs. Failure exits nonzero and the installer warns
that mobile incoming wake is **NOT verified**, without changing desktop routing.
Unpaired/no-eligible-extension installations skip this check. For a read-only
post-install check, run `python3 scripts/install-webrtc-wake.py --verify-access`.

The compiler runs during secure pairing, dashboard startup and after the existing
`retrieve_conf` reload lifecycle, as well as all three installer/upgrader paths.
Creating/removing/converting an extension therefore re-derives eligible entries.
An unpaired fresh PBX gets no wake route.

The generic readiness installer creates only the shared sender context, never
global dialing-macro overrides. Releases before this one wrote blanket
`[macro-dial-one]` / `[macro-dial]` overrides plus `[sokrat-wake-dial]`,
`[sokrat-wake-group]` and `[sub-sokrat-push-hook]` into
`/etc/asterisk/extensions_sokrat.conf`, which fired a wake for **every** dialed
extension and shadowed the shared FreePBX dialing macros. `--apply` now removes
only the complete, exact historical five-block template from `d7b0592`, with
its preceding Sokrat ownership marker and one retained `[sub-sokrat-push-send]`
context. Shared context names alone never establish ownership. A private `0600`
snapshot is written to
`/var/backups/sokrat-voip/extensions_sokrat.conf.wake-v1-<utc>-<nonce>` before the
atomic replacement. Customized, incomplete or duplicate marked v1 blocks refuse
without rewriting the dialplan and require operator review. All retained bytes
(including header options, comments, CRLF and missing final newlines) and file
ownership/mode are preserved. A successful migration requests the ordinary
dialplan reload unless `--no-reload` is supplied; an unchanged run does not.

Reviewed wake state is the scoped artifact: the gateway readiness probe requires
`extensions_sokrat_webrtc_wake.conf`, the root-owned dispatcher and the pinned CA,
and only additionally requires `[sub-sokrat-push-send]` + the tenant hook when
`/usr/local/bin/sokrat-tenant-push-hook.py` is actually installed. A wake-compiler
refusal is reported as a warning on Apply Config (`success: true` plus `warning`)
and never blocks the reload or leaves the dashboard stuck on *needs reload*.

Dashboard pairing accepts only the `sk_pair_v2_...` enrollment code; the legacy
host/port/token form and the manual remote-port fields were removed. The code is
authoritative for the gateway host, port and pinned CA, so a blank host field is
not treated as a mismatch.

## Acceptance and limitations

Fixture tests cover exact scope, stale SIP conversion, idempotence, metadata,
unmanaged conflicts, unsupported templates, private enrollment, bounded waits,
credential handling and installer/lifecycle wiring. A live test-PBX probe checks
actual override activation and ordinary no-device routing while comparing shared
macro/config hashes and Asterisk PID before/after. This is not a phone cold-wake
acceptance test; actual FCM delivery, answer, audio, decline and cancellation must
be verified separately on the selected employee phone.

Destinations that call `Dial(PJSIP/...)` directly and bypass both `macro-dial`
and the normal FreePBX queue `Local/<ext>@from-queue/n` path remain outside this
adapter. Do not claim coverage for a custom queue-agent dial string without
exercising that configured path. Caller cancellation before SIP INVITE and
notification timeout behavior remain explicit acceptance gates; no independent
push-cancel protocol is added here.

For rollback, remove only this managed include/output using the private snapshot
and reload the dialplan. Do not restore an old whole PBX database or gateway
control store over newer employee changes/approvals/revocations.
