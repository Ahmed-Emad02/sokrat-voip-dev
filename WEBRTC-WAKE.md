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

For a single extension and each ring-group member, eligibility skips the push
only when `EXTENSION_STATE` is not `NOT_INUSE`, `UNAVAILABLE` or `UNKNOWN` and
(`CWIGNORE` is set or `DB(CW/<extension>)` is empty). There is no separate
CFB-empty condition: with call waiting unavailable, `macro-dial-one` clears
`DEXTEN` and sets `BUSY` before `macro-exten-vm` reaches call forwarding; with
call waiting available it continues and dials the original extension even when
CFB is populated. DND, CF and CFU checks remain. Eligibility does not increase
the HTTP or registration budget.

When `PJSIP_DIAL_CONTACTS` reports a WebSocket contact, the dispatcher uses the
gateway's `/api/gateway/incoming-call-live` endpoint instead. The gateway owns
the actual SIP WebSocket and suppresses the push only when that socket has
received a recent pong or client message. A stale Asterisk contact therefore
cannot suppress the wake. If an older gateway does not have the live-gated
endpoint, its `404` is treated as legacy behavior: the dialplan proceeds without
a push, as before. Upgrade the gateway first to gain stale-contact recovery;
upgrading the PBX first is safe but does not fix stale contacts until the
gateway is updated. Installers warn if the installed dispatcher lacks the
live-gated endpoint.

Central dispatcher configuration is optional. A valid `LOCAL_HOOK` is tried when
the central configuration is absent, unreachable or reports zero devices.
Cancellation attempts every configured gateway; a first `200` response no longer
masks local-only delivery.

The gateway sends FCM data messages with `android.priority=high`, a TTL of
15000 ms for incoming and 120000 ms for cancellation, and `type=cancel-call`
alongside `msg`. The same `buildCtx().sendToDevice` path covers legacy and tenant
delivery. This requires a gateway image rebuild/redeploy; no environment change
is needed. Tests perform no provider sends.

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

For ring groups, the same per-member eligibility is applied. The shared callId is
placed in `HASH(__SIPHEADERS,X-Sokrat-Call-ID)`, `__SOKRAT_PUSH_SENT` and the
hangup handler are set before dispatch, and every dispatched member is appended
to `__SOKRAT_WAKE_CALLEES`. `GROUP_TOTAL`/`READY` count only members that were
actually woken.

The hangup handler loops `CUT` over `__SOKRAT_WAKE_CALLEES`; `DIALSTATUS=ANSWER`
still skips cancellation. It is not the only cancellation path:
`lib/webrtc-wake-answer.js` runs one bridge per AMI connection and, on `DialEnd`
with `DialStatus=ANSWER`, reads `SOKRAT_CALL_ID` and `SOKRAT_WAKE_CALLEES` from
the original `event.Channel` through two correlated AMI `Getvar` requests with a
bounded 1.5-second timeout. After validating the canonical UUID and numeric
callee list it invokes the existing
`/usr/local/bin/sokrat-webrtc-wake-dispatch.py <callee> <callId>` for every
remaining unique woken recipient. The answered recipient is excluded when
`DestChannel` parses as a standard numeric PJSIP, SIP or Local endpoint. An
unknown non-mobile winner (for example a Dongle channel) cancels all woken mobile
callees; malformed or ambiguous endpoints and values fail closed. Pending lookups
are invalidated on AMI close/reconnect; there are no retries, UserEvent messages,
caches or telemetry. Caller-hangup cancellation still uses the hangup handler's
callee loop. Audio, RTP and outbound dialplan are untouched.

## Extension identity and policy visibility

Roster and overview technology use device/endpoint metadata, not special
extension numbers. Agent reporting retains its existing WebRTC and historical
state fallbacks. Policy listing keeps its existing technology/WebRTC conditions;
a SIP account is not included solely because of its number.

The internal-CDR predicate no longer has a fixed extension allowlist. Its
existing number-length, channel, DID and context classification rules remain.

Both installers' local push subroutines also require a numeric target whose
AstDB `DEVICE/<target>/tech` is `pjsip`; no extension number bypasses that check.
The duplicate-push guard and downstream hook remain unchanged.
`test/wake-routing-harness.py --installer-hooks` exercises the emitted guard
priorities on an isolated Asterisk, stopping before UUID/provider operations.
The test-only `WAKE_ASTERISK_MODULE_DIR` and
`WAKE_ASTERISK_DOCUMENTATION_DIR` variables allow a rootless extracted runtime.

Extension edits with no requested technology preserve the stored driver,
including imported `webrtc` aliases. Leaving PJSIP/WebRTC for SIP removes only
the 19 managed WebRTC SIP-table options for that account. The cleanup does not
run for ordinary SIP edits or delete secrets, custom settings or other accounts.
Creation and WebRTC updates share the same option values/flags, retaining
`rtp_timeout=360`, hold timeout 60 and keepalive 5.

The conversion regression runs the actual creation/update/policy handlers and
SQL against a disposable MariaDB fixture; file/reload/provider effects are stubbed.
Run `SOKRAT_EXTENSION_TEST_DB=<container> node --test test/extension-astdb-sync.test.js`
only after that fixture is ready. It must have a
`sokrat-extension-conversion-test-<hex>` name, label
`io.sokrat.test=extension-conversion`, network `none`, no host ports and no bind
mounts. With no fixture variable the integration test is explicitly skipped.
With `WAKE_ASTERISK_BIN` configured (and optional module/documentation paths),
the same suite also starts its own nonce-verified private Asterisk fixture via
`--serve`. It reads actual AstDB `DEVICE/<ext>/dial` and `tech` after SIP creation,
SIP-to-PJSIP and PJSIP-to-SIP edits. Native commands never target a live instance;
the fixture shuts down and removes its private state when the test closes stdin.
Without that binary the native subcase is explicitly skipped.

## Installation and lifecycle

```sh
# Read-only plan first:
python3 scripts/install-webrtc-wake.py
# Apply, leaving reload to the enclosing maintenance operation:
python3 scripts/install-webrtc-wake.py --apply --no-reload --verify-access
```

Managed output is `/etc/asterisk/extensions_sokrat_webrtc_wake.conf`, root-owned
and readable by the Asterisk group. The managed `macro-dial` hook is written to
the **target** of FreePBX's `extensions.conf` symlink, preserving the symlink
itself. Existing file ownership and mode are preserved. Changes are privately
backed up under `/var/backups/sokrat-voip/`.
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

The compiler runs during secure pairing, dashboard startup and all three
installer/upgrader paths. Creating/removing/converting an extension therefore
re-derives eligible entries. An unpaired fresh PBX gets no wake route.

Installers also enable `sokrat-webrtc-wake-apply.path`, which watches the target
of `/etc/asterisk/extensions.conf`, `extensions_additional.conf`,
`pjsip_custom_post.conf` and `queues_additional.conf`. FreePBX Apply Config
regenerates `extensions.conf` and would otherwise remove the managed hook; the
path unit re-applies it and reloads the dialplan. The service is idempotent and
does nothing when no WebRTC extension is eligible.

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
credential handling, FreePBX symlink targeting and installer/lifecycle wiring. A
live test-PBX probe checks actual override activation and ordinary no-device
routing while comparing shared macro/config hashes and Asterisk PID before/after.
This is not a phone cold-wake acceptance test; actual FCM delivery, answer, audio,
decline and cancellation must be verified separately on the selected employee
phone, including one inbound ring-group call after FreePBX Apply Config.

`test/wake-routing-harness.py` and `test/wake-routing.test.js` are test-only and
gated by `WAKE_ASTERISK_BIN`. The harness imports the pure `render()` function,
never runs the installer with `--apply`, and uses a temporary Asterisk with
`-f autoload=no` plus nonce and directory verification. The real wake file is
recompiled and reapplied only through the normal installer promotion after the
release gate is green. The answer-time cancellation contract is
`test/webrtc-wake-answer.test.js`.

For GSM audio, validate normal-to-louder speech separately from call wake.
The bundled `chan_dongle` preserves its bounded 2100-ms inbound answer protection
and soft-knee limiter, but never blanks ongoing speech based on a peak/background
ratio. NetEq cannot recover speech already zeroed by the PBX. The native regression
is `node --test test/dongle-rx-conditioning.test.js` and requires a C compiler
(`CC` or `cc`); it covers quiet-to-loud transitions, signed PCM, and startup/fade
boundaries. Updating the bundled module requires an idle dongle-module reload,
not a new APK; the wake installer itself does not reload that module.

Fresh installs and in-place upgrades share `scripts/dongle-module.sh`. Source
builds materialize the pinned `asterisk-chan-dongle` commit, require
`asterisk/dongle_rx_condition.h`, stage outside the operator tree, refuse to
reload while channels are active, and fail if `chan_dongle.so` is not Running
after the restart. Existing dongle gains, SIM accounts, call-waiting and AOR
settings are not rewritten. The install/reload behavior is covered by
`node --test test/dongle-module-install.test.js`.
Bundled installs, including the offline Issabel bootstrap, verify the
release-pinned SHA-256 before copying a module. A stale valid ELF is refused;
source builds remain governed by the pinned commit, patch and header rather
than the bundle's compiler-dependent digest. Authenticated mirror origins
are redacted from build output.

All three installation paths also source `scripts/wireguard-server.sh`.
Its private WireGuard key, profile and admission configuration survive repeat
installs/upgrades. Preserved secret paths are accepted only as root-owned
regular files: old permissive modes are tightened to 0600, and a symlink or
other non-regular entry makes the helper skip WireGuard setup rather than
follow it. The advertised server public key comes from the running `wg0`
interface, or from the `PrivateKey` in the preserved `wg0.conf`; when neither
can be verified the key is not printed. `/etc/sokrat` must remain traversable
by `asterisk` so the wake dispatcher can read its scoped hook; WireGuard setup
keeps that shared directory at 0755 and only removes group/other write access.
Those preservation, permission and public-key rules are covered by
`node --test test/wireguard-server.test.js`.
The WireGuard interface address must be one literal IPv4 address/prefix;
extra configuration lines are rejected before a profile is written.
The upgrader refreshes active, explicitly managed media units using their
existing unit/configuration and keys. Run upgrades
without active calls; this is not a live, interruption-free media migration.
Legacy media remains TCP through FRP; explicit plain/direct media stays UDP.
WebRTC `rtp_timeout` remains 360 seconds in extension and guest configuration;
the mainline integration retains that value rather than reducing it to 60.

Destinations that call `Dial(PJSIP/...)` directly and bypass both `macro-dial`
and the normal FreePBX queue `Local/<ext>@from-queue/n` path remain outside this
adapter. Do not claim coverage for a custom queue-agent dial string without
exercising that configured path. Caller cancellation and notification timeout
remain explicit acceptance gates. The hangup handler covers caller hangup, and
the AMI answer bridge covers `DialEnd ANSWER`; the bridge is fail-closed, so
malformed or ambiguous UUID/callee/endpoint values leave the remaining
notifications to the native 90-second timeout. The gateway emits the matching
`cancel-call` FCM message. Verification on the selected phone is still required.

For rollback, remove only this managed include/output using the private snapshot
and reload the dialplan. Do not restore an old whole PBX database or gateway
control store over newer employee changes/approvals/revocations.
