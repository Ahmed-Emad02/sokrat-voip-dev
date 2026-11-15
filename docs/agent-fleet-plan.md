# Agent fleet implementation plan — sokrat-voip

Status: draft for execution. Owner: coordinator pane (`w2:p7`). No product code changes in Phase 0.

## 1. Why this plan exists

The repository has outgrown single-file ownership:

| Hotspot | Size |
|---|---|
| `server.js` | 26,665 lines; 100 `/api/config/*` routes plus dashboards, CDR, GSM, system, federation |
| `views/config.ejs` | 5,683 lines / ~490 KB |
| `views/scripts/config-page.ejs` | 12,218 lines |
| `install.sh` / `installer-bundle/install-sokrat.sh` | 3,571 / 3,543 lines (must stay in sync) |
| `scripts/safe-upgrade.sh` | 1,862 lines |
| `backend/install_db.sql` | 1,448 lines |
| Tests | 146 `test/*.test.js`; no `.github/workflows` CI |

Every feature edit lands in shared files (`server.js`, `config.ejs`, `config-page.ejs`, installers), so unrelated changes collide. The fix is **domain ownership backed by physical file separation**, not more reviewers on the same files.

## 2. Principles

1. **One domain = one agent = one path set.** An agent edits only its owned files; no cross-domain edits.
2. **Coordinator owns shared contracts** until extraction is complete.
3. **Strangler extraction before ownership.** Agents cannot safely share `server.js`; extract first, assign second.
4. **Behavior-preserving moves.** Every extraction PR must keep API routes, response shapes, dialplan and DB behavior identical.
5. **Tests before moves.** Add characterization tests for the target domain, then move code.
6. **Three-way installer parity.** Any DB/dialplan/config change updates `install.sh`, `installer-bundle/install-sokrat.sh`, and `scripts/safe-upgrade.sh`.
7. **No direct production edits.** Agents work on the test bench; deployments go through the coordinator.

## 3. Domains and ownership

Future paths are the extraction targets; current shared files remain coordinator-owned until Phase 1 is complete.

| Agent | Owns (target files) | Shared contracts it consumes | Domain tests |
|---|---|---|---|
| `pbx-config` | `routes/config/extensions.js`, `trunks.js`, `inbound.js`, `outbound.js`, `ringgroups.js`, `queues.js`, `timeconditions.js`, `ivr.js`, `recordings.js`, `announcements.js`; `lib/pbx-*`; `views/config/<tab>.ejs`; `public/js/config/<tab>.js` | `lib/db`, `lib/permissions`, `lib/pbx-reload`, `lib/ami` | `config-*`, `extension-*`, `ringgroup*`, `queue*`, `time*`, `inbound*`, `outbound*` |
| `cdr-perms` | `routes/cdr.js`, `dashboard.js`, `users.js`, `permissions.js`, `api-keys.js`; `lib/cdr-*`, `lib/permissions.js`; `views/cdr.ejs`, `views/users.ejs` | `lib/db`, `lib/auth`, `lib/pbx-reload` | `cdr-*`, `dashboard-*`, `users-*`, `all-permissions-*`, `api-keys*` |
| `webrtc-telephony` | `routes/extension-chat.js`, `extension-video.js`, `extension-agent-status.js`; `lib/agent-status.js`, `lib/chat/*`, `lib/video/*`; `public/js/softphone-*`; `views/softphone*`; `scripts/*webrtc*`, `scripts/install-webrtc-wake.py`; `systemd/sokrat-webrtc*` | `lib/db`, `lib/permissions`, `lib/ami` | `softphone*`, `extension-chat*`, `webrtc*`, `agent-status*` |
| `gateway-tenant` | `lib/gateway-tunnel.js`, `lib/tenant-calls.js`, `lib/federation-*`; `routes/tenant-calls.js`, `routes/crm-integration.js`; `scripts/install-gateway*`, `scripts/tunnel_media*` | `lib/db`, `lib/auth`, `lib/pbx-reload` | `gateway*`, `tenant*`, `federation*`, `crm*` |
| `installers-db` | `install.sh`, `installer-bundle/install-sokrat.sh`, `scripts/safe-upgrade.sh`, `backend/install_db.sql`, `systemd/*` (shared with coordinator) | All domain migration requests | `installer*`, `system-upgrade*`, schema |
| `frontend-shell` | `views/sidebar.ejs`, `views/config.ejs` shell, `views/partials/*`, `public/css/*`, shared `public/js/*`; localization/theme | Every domain's tab partial contract | `accessibility*`, `config-tab-*`, `button-text*`, `fast-tab*`, `config-translations*` |
| `dongles-gsm` | `asterisk/chan_dongle.patch`, `installer-bundle/binaries/chan_dongle.so`, `dongle.conf`, `scripts/*dongle*`, `lib/dongle-*`, `scripts/laya-*`; GSM UI section | `lib/db`, `lib/ami`, `lib/pbx-reload` | `dongle*`, `cross-dongle*`, `laya*`, `gsm*` |
| `ai-stt` | `lib/ai/*`, `routes/ai-evaluation.js`, `scripts/stt-worker.js`, `scripts/enqueue-stt.js`, `views/quality.ejs` | `lib/db`, `lib/cdr-*`, `lib/auth` | `ai-*`, `stt*`, `evaluation*` |

**Coordinator owns (until Phase 1 completes):** `server.js`, `views/config.ejs`, `views/scripts/config-page.ejs`, `package.json`, `package-lock.json`, `AGENTS.md`, `.github/*`, this plan. **QA/CI is a coordinator gate**, not a separate product domain.

## 4. Shared contracts (build first)

Extract these before domain routes; they are the only cross-domain imports:

- `lib/db.js` — pools, table names, tenant/accounting helpers.
- `lib/permissions.js` — `isSuperAdmin`, `getUserScopedExtensions`, tab/action checks, CDR scope clause.
- `lib/pbx-reload.js` — `reloadPbxConfigPromise`, dialplan reload, AMI/CLI wrapper.
- `lib/ami.js` — AMI connection/action helpers.
- `lib/auth.js` — session/user lookup, API keys.
- `lib/format.js` — CDR formatting, phone normalization, bilingual labels.
- `lib/router-utils.js` — async error wrapper, validation, JSON error shape.

Contract rules:
- No route imports another route's internals.
- Shared-contract changes require coordinator + affected owners; add a contract test.
- Response JSON shapes and SQL result columns are contracts; preserve them in moves.

## 5. Phases

### Phase 0 — Baseline and guardrails (read-only)
- Run the full test suite; record baseline failures/flakes.
- Each domain agent produces a map: files, endpoints, DB tables, dialplan/installer touchpoints, tests, extraction seams, shared dependencies, risks.
- Coordinator writes `docs/OWNERSHIP.md` and `.github/CODEOWNERS` (path rules).
- Add CI skeleton: syntax checks, script checks, domain test matrix, installer/schema tests.
- Freeze `server.js`, `config.ejs`, `config-page.ejs`, installers for non-coordinator edits.

### Phase 1 — Extraction (behavior-preserving)
1. Shared contracts (`lib/db`, `permissions`, `pbx-reload`, `ami`, `auth`, `format`).
2. Low-risk routes: users/permissions, CDR/dashboard, contacts, settings.
3. PBX config: extensions, trunks, inbound, outbound, ringgroups, queues, timeconditions, IVR, recordings, announcements, modem/ipscan.
4. WebRTC: chat/video/agent-status, softphone wake.
5. Gateway/tenant/federation/CRM.
6. AI/STT.
7. Views split: `views/config/<tab>.ejs` + `public/js/config/<tab>.js`.
8. Installers/DB after route contracts stabilize.

Each extraction PR: one domain, no behavior change, route aliases preserved, domain tests green. `server.js` shrinks to bootstrap only.

### Phase 2 — Parallel domain ownership
- Agents edit only owned files; coordinator merges.
- Daily/weekly cadence: one PR per domain; shared changes via RFC.
- Domain smoke tests run before merge; coordinator runs integration + installer parity.

### Phase 3 — Enforcement
- CODEOWNERS path rules; CI path-filtered test matrix.
- PR template: domain, owned paths, contracts touched, tests, installer parity, rollback.
- Shared-file lock: `server.js`/config shell/installers require coordinator review.
- No new route added directly to `server.js`; use the domain router.

### Phase 4 — Decommission
- `server.js` < 1,000 lines (bootstrap/middleware only).
- Delete dead handlers and duplicate helpers.
- Archive original monolith in git history only; update AGENTS.md.

## 6. Herdr fleet layout

- New tab `agent-fleet` in workspace `w2`; coordinator remains `w2:p7` (focus preserved).
- 8 panes, 4 columns × 2 rows (`--no-focus` for every split).
- Agents started with `herdr agent start <name> --kind omp --pane <id>`.
- Phase 0 prompts are read-only: map the domain, no edits; write `/tmp/agent-maps/<name>.md`.
- Only panes/agents created by the coordinator are closed; no `herdr server stop`.

## 7. Agent rules

- Phase 0: read-only. Do not edit the repo.
- Edit only owned paths. Never edit `server.js`, `config.ejs`, `config-page.ejs`, installers, `package.json`, or another domain's files without coordinator approval.
- Run domain tests and `node --check`/`bash -n` before reporting.
- Keep PRs small; one domain, one intent.
- Never print secrets; never touch production hosts.
- Report blockers explicitly; do not bypass tests or ownership.

## 8. CI gates (to add)

| Gate | Command |
|---|---|
| JS syntax | `node --check` on changed JS |
| Shell syntax | `bash -n` on changed scripts |
| Domain tests | `node --test test/<domain>-*.test.js` |
| Installer/schema | `node --test test/installer-and-schema.test.js` |
| Upgrade/restore | `node --test test/system-upgrade-and-restore.test.js` |
| Installer parity | diff checks for dialplan/DB blocks across the three installers |
| Bilingual UI | `config-translations` / accessibility tests |
| Contract | API JSON shape + DB migration idempotency tests |

## 9. Risks

| Risk | Mitigation |
|---|---|
| `server.js` merge conflicts | Freeze until extracted; coordinator-only edits |
| Shared DB schema breaks domains | Installer/DB owner + coordinator; idempotent migrations; contract tests |
| `config.ejs`/`config-page.ejs` conflicts | Split per tab before parallel UI work |
| Installer drift | Three-way parity test; one installer owner |
| Agents overreach | Path allowlists, CODEOWNERS, coordinator review |
| Flaky/no CI | Baseline, quarantine flaky tests, add CI skeleton |
| Herdr resource pressure | 8 agents max; stop idle panes; no duplicate agents |
| Secrets | Never print; use `.env`; no credentials in prompts/commits |

## 10. Definition of done

- `server.js` is bootstrap-only; no domain handlers.
- Every domain has an owner, owned paths, and a green test command.
- `views/config.ejs` / `config-page.ejs` split per tab; frontend owns the shell.
- CODEOWNERS and CI path matrix enforce ownership.
- Installer three-way parity test exists and passes.
- Agents can ship a domain change without editing another domain's files.
