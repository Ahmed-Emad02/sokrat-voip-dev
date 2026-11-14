# Extension-Independent Behavior Implementation Plan

> **For agentic workers:** The user approved source implementation and subsequently requested committing and pushing the reviewed cleanup to `main`. Follow `skill://test-driven` and `skill://verification-before-completion`. Deployment and a changed APK remain unapproved.

**Goal:** Remove extension-number-specific behavior without changing configured accounts, call media, permissions or user-owned contacts.

**Architecture:** Technology and eligibility come from the existing PBX device/endpoint/WebRTC metadata paths, never a particular extension number. Reuse `getExtensionTech`, the existing `isPjsipTech` predicate and the roster's batched metadata; do not create a parallel resolver or replace magic numbers with an environment-variable allowlist. Mobile first-run storage must not invent dialable contacts or service targets.

**Tech Stack:** Existing Node.js/CommonJS PBX and gateway, MariaDB-compatible SQL, React Native/TypeScript/AsyncStorage, Node test runner and Jest. No new production dependency.

**Spec:** This document's [Scope and contract](#scope-and-contract), based on the user's request to plan removal of hardcoded extensions.

## Scope and contract

- An extension's number identifies an account; it must not determine its SIP driver, WebRTC status, agent eligibility or policy visibility.
- With identical metadata, renumbering `150` or `151` to an ordinary valid extension must not change those decisions.
- Preserve existing metadata precedence/fallback behavior for ordinary extensions. Do not silently redesign historical agent-status reporting, CDR number-length heuristics or extension validation in this patch.
- Fresh mobile storage contains no fabricated `101`, `102` or `*88` contacts. An unconfigured speed-dial key must not silently become `*97`.
- Existing saved contacts, favourites and user-configured speed dials remain byte-for-byte unchanged. Do not auto-delete records that resemble old samples: they could be legitimate user data.
- Keep harmless explanatory placeholders and test fixtures; do not perform a blind numeric-string replacement.
- IP-address defaults and provisioning address pools are outside this extension-only plan.

## Global constraints

- Keep installed Android **1.2.24** unchanged. Mobile source cleanup is approved; build/install requires separate approval. Do not roll in the pending 1.2.25 work.
- Keep PCMU, UDP media policy, NetEq, dongle audio conditioning, `rtp_timeout=360`, hold timeout and keepalive unchanged.
- No live account renumbering, database migration, contact deletion, Asterisk restart or test call during implementation without the appropriate deployment/test approval.
- Preserve authorization, tenant filtering, API response shapes and existing account/extension identifiers as strings.
- Commit and push only this reviewed cleanup to `main`; preserve unrelated mobile staged/unstaged work. No deployment is authorized.

## Review focus

1. A normal SIP account numbered `150`/`151` must not gain PJSIP/WebRTC behavior solely from its number.
2. PJSIP/WebRTC accounts such as `2401`/`5072` must retain all eligible features, including policy listing and availability reporting.
3. Missing metadata and existing historical agent-state fallbacks must behave the same for special and ordinary numbers; retain authorization and tenant boundaries.
4. Removing the CDR allowlist must not change call totals or direction decisions, including null/blank destinations and real trunk calls.
5. Upgrading the app must not erase contacts or custom speed dials, and clearing a speed-dial slot must not recreate a default target.

## Verified inventory

Evidence scoped on 2026-11-14; recheck anchors against the implementation checkout.

| Location | Assumption to remove |
|---|---|
| PBX `server.js:4749,4767` | Missing device metadata defaults `150` to PJSIP while other numbers default to SIP. |
| PBX `server.js:4882,9425,9581` | Roster, metrics and overview force `150` into PJSIP/WebRTC behavior. |
| PBX `server.js:16044` | Extension-policy listing unconditionally includes `150` and `151`. |
| PBX `lib/agent-status.js:470` | Agent report treats `150` as WebRTC regardless of the technology result. |
| PBX `server.js:321` | CDR internal predicate contains a literal six-extension allowlist. Every listed destination has three digits while the external-number predicate requires at least seven; the allowlist is redundant, not a reason to invent a replacement list. |
| Mobile `src/storage/store.ts:238-249` | First read persists sample `101`, `102`, `*88` contacts. |
| Mobile `src/storage/store.ts:52-54,263-269` and `src/ui/StandardPhoneScreen.tsx:817-818,1027,1265` | Storage and UI repeatedly seed or restore `*97` as speed dial 1. |

The targeted gateway production scan found no corresponding literal-number branch. This is not a claim that every numeric literal in all repositories was audited.

---

### Task 1: Remove PBX technology and eligibility exceptions

**Files:**
- Modify `lib/agent-status.js` (`isPjsipTech`, `getAgentStatusReport`, exports).
- Modify `server.js` roster construction, roster decoration, employee metrics, overview and `/api/extension-policies`.
- Extend existing `test/agent-status.test.js`.

**Interfaces:**
- Retain `getExtensionTech(pool, extension)` and its existing consumers/signature.
- Export the existing `isPjsipTech(value)` predicate for server consumers; do not add another competing predicate.
- Preserve public response fields (`tech`, `isPjsip`, `isWebRTC`, policy records) and existing eligibility semantics for metadata-confirmed endpoints.

- [x] Find references before changing exports; use LSP when available, otherwise scoped references. Recheck all production extension-specific branches, including SQL conditions and initializers; classify each match rather than deleting placeholders.
- [x] Extend behavioral agent-report tests with these cases:
  - SIP metadata, no WebRTC flags/history: reports for `150` and `2401` both have `isWebRTC === false`.
  - PJSIP metadata: reports for `150` and `2401` both have `isWebRTC === true`.
  - Missing metadata/history: `150` follows the same result as an ordinary unknown extension.
  - Existing supported fallback metadata/history produces the same outcome after renumbering; no history rows are deleted.
- [x] Run `node --test test/agent-status.test.js`; confirm the new SIP-150/unknown-150 cases expose the number exception before changing production code.
- [x] Remove `|| ext === '150'`. Keep the existing non-number fallback logic; do not expand eligibility or change historical-report policy while making this fix.
- [x] Replace both roster number-dependent defaults with the same existing ordinary-extension fallback. Use metadata and the existing predicate for all three later roster/metrics/overview decisions; remove every unconditional `extension === '150'` override. Keep batched lookups rather than querying once per roster entry.
- [x] Remove `OR u.extension IN ('150', '151')` from policy selection. Keep the existing metadata conditions, Super Admin check and response shape unchanged.
- [ ] Rerun the focused agent-status tests. In a disposable PBX/database fixture, exercise the actual policy query and roster/overview surface: SIP `150`/`151` must not acquire PJSIP eligibility; configured PJSIP `2401`/`5072` must appear. Swap numbers while retaining metadata and compare outcomes. Do not substitute a mock that returns a prefiltered list for SQL execution.
  - Actual SQL, both roster builders and all three view predicates passed fixture checks. Full browser/application acceptance remains pending; predicate execution is not a browser check.
- [x] Update the existing PBX behavior notes after proof, describing metadata-based eligibility rather than special extension numbers.

### Task 2: Remove the redundant CDR extension allowlist

**Files:** Modify only the internal CDR predicate in `server.js`, plus existing documentation if its behavior is described there.

**Interface:** Existing CDR SQL fragments and callers stay intact. No new query, database schema, extension cache or configurable allowlist.

- [x] Prepare a throwaway SQL fixture that evaluates the actual old and new predicates on the same derived CDR rows in a disposable MariaDB instance. Include the six old literals, ordinary short extensions, numeric destinations of at least seven characters, feature codes, blank/null destinations, and SIP/PJSIP/Dongle/DAHDI channel/context combinations.
- [x] Remove only the redundant literal `OR c.dst IN (...)` term. Preserve the external-destination length test and all channel, DID and context rules.
- [x] Run the SQL fixture and require identical old/new results for every row. This task is a behavior-preserving simplification, so a red behavior test is not expected; do not manufacture a source-text test to force a failure.
- [x] Include CDR count/direction parity in the fixture-PBX review. Treat changing how long internal extensions are classified as a separate requirement, not part of this cleanup.

### Task 3: Remove invented mobile contacts and speed-dial targets — source only, APK gated

**Files:**
- Modify mobile `src/storage/store.ts` and `src/ui/StandardPhoneScreen.tsx`.
- Create mobile `__tests__/contactsStorage.test.ts` for persisted-state behavior.
- Update existing `PRODUCTION-RELEASE.md` only when a mobile release is approved.

**Interfaces:** Keep `StorageService.getContacts(): Promise<Contact[]>`, `saveContacts`, `getSpeedDial(): Promise<SpeedDialMap>` and `saveSpeedDial`. Do not add a new contact-discovery API; retain existing directory and caller-name lookup flows.

- [x] Before mobile implementation, isolate this patch from the pending 1.2.25 changes. Establish the approved source/build baseline; do not relabel the current modified tree as an exact build-84 reproduction.
- [x] Add storage regressions asserting: absent contacts return `[]`; existing saved contacts/favourites are unchanged; absent speed dials return no assigned target; an explicitly saved `*97` or any custom target is preserved; a cleared key stays unassigned after another read/mount.
- [x] Run `npx jest __tests__/contactsStorage.test.ts --runInBand` to expose current sample/default seeding.
- [x] Remove the sample contact initialization and unverified speed-dial target defaults. Remove the duplicate `*97` seeds/forced fallback in the phone-screen initializer, storage-loading callback and save handler. Render empty slots as unassigned; placeholders may illustrate a format but must not determine a dial target.
- [ ] Rerun storage regressions and exercise the actual fresh/upgrade phone screen on an approved test build: no invented contacts, existing contacts preserved, and an empty speed-dial slot cannot initiate a call. No blanket clearing of AsyncStorage or migration that deletes old `c1`/`c2`/`c3` records.
  - Storage and rendered-component regressions pass, including saving, remounting and long-press dialing. Native-device acceptance still requires an approved changed APK.
- [x] Do not build/install a changed APK while the current 1.2.24 freeze stands. No unrelated push, media or VPN changes are included in this stage.

### Task 4: Verification and controlled rollout

- [ ] Verify the implementation in a checkout with the required files/dependencies present. The current PBX sparse checkout previously omitted route files and Express; do not misreport module-loading failures as passing behavior checks or silently change the user's sparse-checkout settings.
- [x] Run the affected Node/Jest tests and relevant syntax checks once after integration. Delete touched source-wording/wiring tests rather than repinning them to new literals. Use fixtures containing former special numbers and unrelated numbers, not permanent assertions that source strings disappeared.
- [x] Review the bounded production scan: no extension number may select technology or grant policy eligibility. Tests, user-saved data, configuration examples and validation limits are separate categories.
- [x] Independently review classification, policy authorization, CDR parity and preservation of mobile data. Do not let number cleanup change tenant boundaries or expose additional records.
- [ ] With separate deployment approval, apply the PBX-only fix first without changing the installed app/audio policy. Verify roster/status/policy behavior for differently numbered SIP and PJSIP accounts, then approved extension-to-phone and phone-to-extension calls.
- [x] Keep the mobile cleanup unshipped until its source baseline and new APK are separately approved. Preserve account data on any later upgrade.
- [x] Commit/push only when explicitly requested for implementation; never force-push or deploy as a side effect of writing this plan.

## Done criteria

- Production behavior no longer depends on whether an extension is `150`, `151`, `101`, `102` or another previously listed identity.
- Metadata-confirmed SIP/PJSIP behavior, authorization and CDR results pass the acceptance cases above.
- New mobile storage invents no contact/speed-dial target; existing user data is preserved when the mobile stage is approved.
- Installed 1.2.24, PCMU, NetEq, UDP policy, dongle conditioning and RTP timeout remain unchanged during PBX-only work.
- Planning completion is not implementation, deployment or acceptance of a new APK.

## Implementation evidence and remaining gates

- PBX agent reports: 10 tests passed after the two number-exception regressions failed before the fix.
- Actual roster builders and three view predicates: 24 metadata/number combinations passed. Actual policy SQL excluded SIP `150`/`151`; swapping the configured technology swapped eligibility.
- Actual old/new CDR expressions: 5,376 synthetic MariaDB rows, zero scope differences and zero direction differences, including nulls, failover and trunk contexts.
- Initial mobile evidence: 9 storage tests and 16 phone-screen tests passed. These are rendered-component checks, not native-device acceptance; the fresh review-stage rerun results below supersede any full-pass interpretation.
- Implementation-time targeted mobile ESLint: zero errors, 47 warnings. Fresh review-stage PBX agent tests (10) and `server.js`/`lib/agent-status.js` syntax checks passed.
- Both mobile production files matched the release-code-84 source map before this patch. This establishes a two-file baseline, not a claim that the whole dirty mobile tree reproduces build 84.
- Additional user-requested creation audit: actual single/bulk creation handlers created 11 fixture extensions through 507 real MariaDB queries. Driver/dial metadata, policy eligibility, generated WebRTC sections, leading-zero identity and RTP timeout 360 passed. Filesystem/AstDB effects were isolated in the harness, with no live Asterisk operation. Existing creation logic needed no rewrite.
- The task-owned MariaDB container was stopped after verification. No live database, account, APK or deployment was changed by these checks.
- Separate OpenCode DeepSeek 4.1 Flash `medium` PBX/mobile reviews found no introduced defects in the original patch. The PBX review identified two older installer number gates; both were fixed, and the bounded follow-up review also found no actionable introduced defect.
- Full PBX startup/browser acceptance, approved test calls and native-device acceptance remain gated. The sparse PBX checkout was not silently expanded and missing startup dependencies were not treated as a successful application boot.

### Review follow-through: installer wake eligibility

The medium review found two pre-existing runtime gates outside the original
inventory: `install.sh` and `installer-bundle/install-sokrat.sh` emit a
`sub-sokrat-push-hook` that permits only extension `150`.

- [x] Replace that number check with the existing dialplan convention:
  require a nonempty numeric target and `DB(DEVICE/<target>/tech) = pjsip`.
  Keep the duplicate-push guard and downstream hook unchanged. Do not simply
  delete the check and send wake requests for every SIP/unknown destination.
- [x] Exercise the actual emitted guard priorities on an isolated Asterisk:
  differently numbered PJSIP targets proceed; SIP `150`, absent metadata,
  empty/non-numeric targets and duplicate requests do not.
- [x] Check both installer shell syntaxes and obtain a medium review of the
  bounded change. No system package installation, live PBX operation or
  deployment is authorized.

Follow-through evidence: native Asterisk 22 evaluated 22 cases across both
installer templates. Before the fix, ten eligibility decisions were wrong;
after the metadata guards, all cases passed. Both isolated routing tests passed,
including the existing wake-routing matrix. Installer shell syntax and Python
harness parsing passed. Runtime packages were extracted into a task-owned
temporary directory, not installed into the system.

Fresh mobile verification: 9 storage tests passed; all 3 changed speed-dial
screen cases passed with bounded discovery roots and a 120-second cold-render
allowance. A broader 25-test rerun had 23 passes and two older cold-render
timeouts (RingingScreen and ActiveCallModal); it is not a full passing rerun.
The default whole-project Jest crawl also exceeded 300 seconds; instrumentation
located the delay in its native filesystem crawl before test execution.

## Publication scope

Commit/push was explicitly requested after the medium reviews. PBX main is
current with the authoritative remote main tip. Mobile main is older than the
uncommitted build-84/85 UI work, so publish only this cleanup on top of mobile
main: retain its existing settings layout and remove its corresponding seeds,
forced key-1 fallback, voicemail placeholder and key-1 clear restriction.
Use an alternate Git index; do not include asset deletions, media changes,
WhatsApp defaults, dependency removals or the pending UI redesign.
