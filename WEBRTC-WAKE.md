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
override file. No shared `macro-dial-one`, `macro-dial`, trunk macro, global
outbound pattern, audio multiplier or early-media `Progress()` is introduced.
Unknown/custom route templates and conflicting operator overrides refuse before
writes rather than approximating the customer's call flow.

Wake preparation respects extension DND, unconditional forwarding and configured
unavailable forwarding. It sends a pinned authenticated HTTPS request with the
existing PBX identity/token. Only a response reporting at least one delivered
mobile push enables the bounded registration wait. Credential errors, missing
devices and gateway outages continue into normal FreePBX routing; credentials
and provider payloads are never logged.

The HTTP deadline is3 seconds; registration wait is at most5 seconds. Comparing
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
python3 scripts/install-webrtc-wake.py --apply --no-reload
```

Managed output is `/etc/asterisk/extensions_sokrat_webrtc_wake.conf`, root-owned
and readable by the Asterisk group. Existing include-file ownership and mode are
preserved. Changes are privately backed up under `/var/backups/sokrat-voip/`.
The dispatcher is installed root-owned at
`/usr/local/bin/sokrat-webrtc-wake-dispatch.py`. Apply is serialized; unsafe paths,
ambiguous includes, unmanaged output and mismatched enrollment refuse safely.

The compiler runs during secure pairing, dashboard startup and after the existing
`retrieve_conf` reload lifecycle, as well as all three installer/upgrader paths.
Creating/removing/converting an extension therefore re-derives eligible entries.
An unpaired fresh PBX gets no wake route. The generic readiness installer now
creates only the shared sender context, never global dialing-macro overrides;
pre-existing custom macros are not silently rewritten or removed.

## Acceptance and limitations

Fixture tests cover exact scope, stale SIP conversion, idempotence, metadata,
unmanaged conflicts, unsupported templates, private enrollment, bounded waits,
credential handling and installer/lifecycle wiring. A live test-PBX probe checks
actual override activation and ordinary no-device routing while comparing shared
macro/config hashes and Asterisk PID before/after. This is not a phone cold-wake
acceptance test; actual FCM delivery, answer, audio, decline and cancellation must
be verified separately on the selected employee phone.

Direct `Dial(PJSIP/...)` destinations (for example some queue-agent configurations)
that bypass `ext-local` are not covered by this adapter. Do not claim queue/group
coverage without exercising the actual configured call path. Caller cancellation
before SIP INVITE and notification timeout behavior remain explicit acceptance
gates; no independent push-cancel protocol is added here.

For rollback, remove only this managed include/output using the private snapshot
and reload the dialplan. Do not restore an old whole PBX database or gateway
control store over newer employee changes/approvals/revocations.
