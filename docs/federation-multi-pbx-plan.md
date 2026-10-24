# Multi-PBX Federation: One Pane of Glass

**Status:** Implementation plan (not yet implemented)
**Target nodes:** `192.168.100.50` (`sokrat-demo`, Site 10) and `192.168.100.92` (`pbx-connection-test-server`, proposed Site 20)
**Scope:** Overview, dongles, contacts, call history/reports, live panel, and node health from any single node.

---

## 1. Goal

A user signed in to **any** Sokrat node can select **All nodes** (or one node) and see:

- **Overview:** calls today, answer rate, active calls, extension/dongle counts, node health.
- **Dongles:** every modem on every node with live state, SIM, signal, operator, and permitted controls.
- **Contacts:** one searchable address book, deduplicated by phone, editable on the node that owns the record.
- **Reports / Call History:** merged CDR, per-node filters, per-node comparison, export, no double-counted federation legs.
- **Live panel:** remote extensions and dongles with presence and call state.

Writes are routed to the owning node. Reads are served from a local cache so pages stay fast and keep working when a peer is offline.

### Non-goals (this plan)

- Replacing IAX2 voice routing. The existing encrypted IAX2 links stay.
- A shared MariaDB cluster. Nodes keep separate databases.
- Real-time replication of every table. Only the read models listed below are mirrored.

---

## 2. Current State Audit

### What already works

- Encrypted IAX2 peer generation (`lib/federation-engine.js`), dialplan prefixes (`<site><ext>`, `9<site><number>`), loop protection, egress permission in AstDB.
- One-click SSH bootstrap that creates peer rows on both sides and exchanges IAX/API keys (`lib/federation-bootstrap.js`).
- Extension presence aggregation every 3 seconds (`lib/federation-hub.js`) and a central-mode operator filter (`views/operator.ejs`).
- Federation settings/peers UI (`views/config.ejs`) and peer sync/qualify actions.

### Blockers found in the current code

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | Federation API is completely unauthenticated; the whole `/api/federation/v1/` prefix bypasses session auth | `server.js:2044`, `19788-19836` | Anyone on the LAN can read extensions, IPs, and live call state |
| 2 | `api_key_enc` is generated but never sent or verified | `lib/federation-bootstrap.js`, `lib/federation-hub.js` | No authenticity, no replay protection |
| 3 | `api_base_url` is written as `https://<host>:8443` | `lib/federation-bootstrap.js:320,339,356` | Port 8443 is the softphone vhost and returns 404; hub only works via the `http://host:8080` fallback |
| 4 | `getLocalLiveStateFn` returns `activeCalls` as an **array**, while the documented contract and the remote `/live-state` payload use a map keyed by extension | `server.js:2275`, `lib/federation-hub.js:131` | Local active-call data is dropped; the shape mismatch will break any new consumer (dashboard/dongles) |
| 5 | Dongle sync selects only `dongle_name, phone_number` but reads a third `provider` column; no live state is synced at all | `lib/federation-bootstrap.js:480-500` | Remote dongles are stale placeholders; page never renders them |
| 6 | Both nodes currently report `local_site_code = 10` | live DB check | Site collision; remote aliases collide |
| 7 | Bootstrap SCPs `server.js`, `views/`, and `lib/` over the remote installation on every connect | `lib/federation-bootstrap.js:190-196` | Can silently downgrade/overwrite a newer remote node |
| 8 | `scripts/safe-upgrade.sh` contains **no** federation schema migration | `scripts/safe-upgrade.sh` | Fresh install and upgrade diverge; violates installer sync rule |
| 9 | Only extensions are aggregated. No contacts, CDR, dongles, recordings, campaigns, or node health | `lib/federation-hub.js` | Cannot deliver the requested single pane |
| 10 | No node identity (`uuid`), API version, capability flags, sync state, or audit | schema, UI | Cannot safely evolve the protocol or show sync health |
| 11 | Remote extension status is stored in a table but the UI only partially uses it; federation state socket only updates the operator page | `views/operator.ejs:1990` | No shared live state on dashboard/dongles |

### Live verification performed

- `ping 192.168.100.92` → ~0.4 ms, same LAN.
- Both nodes run Asterisk 18.19.0 and `chan_iax2.so`.
- `curl http://192.168.100.92:8080/api/federation/v1/health` → 200 with `local_site_code: "10"`.
- `curl https://192.168.100.92:8443/api/federation/v1/health` → `{"success":false,"error":"Not Found"}`.
- Local node currently has no federation peers; remote has none.

---

## 3. Target Architecture

```
                    ┌──────────────────────────────────────────┐
                    │  Central node (example: 192.168.100.50)   │
                    │                                          │
  Browser ────────► │  EJS pages + /api/federation/* (session) │
                    │            │                             │
                    │            ▼                             │
                    │  Read models in local MariaDB            │
                    │  (node status, remote ext/dongle/CDR/     │
                    │   contact mirrors, sync state)            │
                    │            ▲                             │
                    │  FederationAggregator (poll + upsert)     │
                    └────────────┼─────────────────────────────┘
                                 │ HTTPS + HMAC (per-peer key)
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌───────────┐      ┌───────────┐      ┌───────────┐
        │  Site 20  │      │  Site 30  │      │  Site N   │
        │ agent API │      │ agent API │      │ agent API │
        └───────────┘      └───────────┘      └───────────┘
```

- **Star for data**, **mesh for voice.** The central node polls every peer. IAX2 remains peer-to-peer (or via central for N-node later).
- **Each node is authoritative for its own data.** Mirrors are read-only and rebuildable.
- **All UI reads are local.** No page render waits on a remote HTTP call.
- **Any node can be promoted to central.** With two nodes, both may run as central for mutual visibility.

### Read model ownership

| Data | Authoritative node | Central copy |
|------|--------------------|--------------|
| Extensions / presence | Owner | `sokrat_federation_remote_extensions` + live state |
| Dongles | Owner | `sokrat_federation_remote_dongles` |
| Contacts | Owner (SQLite address book) | `sokrat_federation_remote_contacts` |
| CDR | Owner (`asteriskcdrdb.cdr`) | `asteriskcdrdb.sokrat_federation_remote_cdr` |
| Node metrics | Owner | `sokrat_federation_node_status` |
| Campaigns / follow-ups | Owner | Phase 5 (summary mirror or proxy) |
| Recordings / voicemail files | Owner | Phase 5 metadata + authenticated proxy |

---

## 4. Federation Protocol (v1)

### 4.1 Authentication

Every agent request carries:

```
X-Sokrat-Site: 20
X-Sokrat-Timestamp: 1792856059
X-Sokrat-Nonce: 8f3c...
X-Sokrat-Signature: <hex hmac-sha256>
X-Sokrat-Actor: <central username>        (writes only, for audit)
X-Sokrat-Federation-Version: 1
```

Canonical string:

```
METHOD \n originalUrl \n timestamp \n nonce \n sha256(rawBody)
```

Signature = `HMAC-SHA256(peer_api_key, canonical)`.

Verification rules:

- Look up the peer by `X-Sokrat-Site`; decrypt `api_key_enc`.
- Reject clock skew > 60 s (NTP required on all nodes).
- Reject replayed nonce for 5 minutes (in-memory LRU; per-process is enough for a pair).
- `crypto.timingSafeEqual`.
- Rate limit: 120 req/min for live reads, 20 req/min for writes, per site.
- Update `sokrat_federation_peers.last_seen_at`, `status`, `latency_ms` on every request.
- Never return secrets; redact `iax_secret_enc` and `api_key_enc`.

Remove `/api/federation/v1/` from the unauthenticated `publicPaths` bypass. Keep only `GET /api/federation/v1/ping` public, returning `{ ok: true }` with no node data.

### 4.2 Agent endpoints (exposed by every node)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/federation/v1/ping` | Liveness only (public, no data) |
| GET | `/api/federation/v1/meta` | Node UUID, site code, name, version, API version, capabilities |
| GET | `/api/federation/v1/live` | Extensions + presence, dongles + live state, active calls, node metrics |
| GET | `/api/federation/v1/inventory` | Extensions, dongles, queues, ring groups, trunks, IVR counts |
| GET | `/api/federation/v1/contacts?offset=&limit=` | Paged contact snapshot |
| POST/PUT/DELETE | `/api/federation/v1/contacts/:id` | Write-through contact mutation |
| GET | `/api/federation/v1/cdr?from=&to=&cursor=&limit=1000` | Incremental CDR page |
| GET | `/api/federation/v1/reports/summary?from=&to=` | Pre-aggregated KPIs |
| POST | `/api/federation/v1/actions` | Allow-listed remote actions (dongle, campaign, queue) |

Response envelope:

```json
{
  "success": true,
  "api_version": 1,
  "node": { "uuid": "...", "site_code": "20", "name": "Test PBX", "version": "..." },
  "server_time": "2026-10-24T18:40:00+03:00",
  "data": {},
  "next_cursor": null
}
```

### 4.3 Capability and policy flags

Add to `sokrat_federation_peers`:

- `node_uuid VARCHAR(36)`
- `api_version SMALLINT DEFAULT 1`
- `allow_report_read TINYINT(1) DEFAULT 1`
- `allow_contact_write TINYINT(1) DEFAULT 0`
- `allow_dongle_control TINYINT(1) DEFAULT 0`
- `allow_campaign_control TINYINT(1) DEFAULT 0`

Live health (`last_seen_at`, `latency_ms`) lives in `sokrat_federation_node_status`, not in the secrets-bearing peers table. Defaults are read-only; an admin must explicitly enable remote writes per peer.

```sql
ALTER TABLE `sokrat_federation_peers`
  ADD COLUMN `node_uuid` VARCHAR(36) DEFAULT NULL,
  ADD COLUMN `api_version` SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN `allow_report_read` TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN `allow_contact_write` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `allow_dongle_control` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `allow_campaign_control` TINYINT(1) NOT NULL DEFAULT 0;
```

### 4.4 Remote actions

```json
POST /api/federation/v1/actions
{
  "resource": "dongle",
  "target": "dongle1",
  "action": "restart",
  "params": {},
  "request_id": "uuid"
}
```

Allow-list per resource:

- `dongle`: `restart`, `reload`, `reboot_modem`, `set_sim_number`
- `campaign`: `start`, `pause`, `reset_leads`
- `queue`: `pause`, `unpause`, `add_agent`, `remove_agent`

Each action is validated on the remote node against the peer's policy flag, rate-limited, and written to `sokrat_federation_action_log` with the actor. Destructive actions require a typed confirmation in the UI.

---

## 5. Data Model

All DDL is idempotent and must be added to **all four** schema locations:
`backend/install_db.sql`, `install.sh`, `installer-bundle/install-sokrat.sh`, `scripts/safe-upgrade.sh`.

### 5.1 Node status

```sql
CREATE TABLE IF NOT EXISTS `sokrat_federation_node_status` (
  `peer_id` INT NOT NULL PRIMARY KEY,
  `status` ENUM('online','degraded','offline','error') NOT NULL DEFAULT 'offline',
  `latency_ms` INT DEFAULT NULL,
  `version` VARCHAR(32) DEFAULT NULL,
  `asterisk_version` VARCHAR(64) DEFAULT NULL,
  `uptime_sec` BIGINT DEFAULT NULL,
  `load1` DECIMAL(6,2) DEFAULT NULL,
  `disk_pct` TINYINT DEFAULT NULL,
  `extensions_total` INT NOT NULL DEFAULT 0,
  `extensions_online` INT NOT NULL DEFAULT 0,
  `dongles_total` INT NOT NULL DEFAULT 0,
  `dongles_free` INT NOT NULL DEFAULT 0,
  `active_calls` INT NOT NULL DEFAULT 0,
  `calls_today` INT NOT NULL DEFAULT 0,
  `last_seen_at` DATETIME DEFAULT NULL,
  `last_error` VARCHAR(255) DEFAULT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_fed_status_peer` FOREIGN KEY (`peer_id`) REFERENCES `sokrat_federation_peers`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 5.2 Remote dongles (extend existing table)

```sql
ALTER TABLE `sokrat_federation_remote_dongles`
  ADD COLUMN `state` VARCHAR(32) DEFAULT NULL,
  ADD COLUMN `signal_pct` TINYINT DEFAULT NULL,
  ADD COLUMN `operator_name` VARCHAR(64) DEFAULT NULL,
  ADD COLUMN `imsi` VARCHAR(32) DEFAULT NULL,
  ADD COLUMN `imei` VARCHAR(32) DEFAULT NULL,
  ADD COLUMN `sim_number` VARCHAR(32) DEFAULT NULL,
  ADD COLUMN `active_call` VARCHAR(128) DEFAULT NULL,
  ADD COLUMN `last_seen_at` DATETIME DEFAULT NULL,
  ADD COLUMN `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
```

Use `ensure_db_column` in `safe-upgrade.sh`, guarded `ALTER TABLE` in installers.

### 5.3 Remote CDR mirror

Stored in `asteriskcdrdb` next to the local `cdr` table so reporting does not cross databases for the large table. `peer_id` still references `asterisk.sokrat_federation_peers`.

```sql
CREATE TABLE IF NOT EXISTS `asteriskcdrdb`.`sokrat_federation_remote_cdr` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `peer_id` INT NOT NULL,
  `uniqueid` VARCHAR(150) NOT NULL,
  `linkedid` VARCHAR(150) DEFAULT NULL,
  `global_call_id` VARCHAR(150) DEFAULT NULL,
  `calldate` DATETIME NOT NULL,
  `clid` VARCHAR(120) DEFAULT NULL,
  `src` VARCHAR(80) DEFAULT NULL,
  `dst` VARCHAR(80) DEFAULT NULL,
  `dcontext` VARCHAR(80) DEFAULT NULL,
  `channel` VARCHAR(120) DEFAULT NULL,
  `dstchannel` VARCHAR(120) DEFAULT NULL,
  `lastapp` VARCHAR(80) DEFAULT NULL,
  `lastdata` VARCHAR(255) DEFAULT NULL,
  `duration` INT DEFAULT 0,
  `billsec` INT DEFAULT 0,
  `disposition` VARCHAR(45) DEFAULT NULL,
  `amaflags` INT DEFAULT NULL,
  `accountcode` VARCHAR(80) DEFAULT NULL,
  `userfield` VARCHAR(255) DEFAULT NULL,
  `did` VARCHAR(80) DEFAULT NULL,
  `recordingfile` VARCHAR(255) DEFAULT NULL,
  `direction` ENUM('INBOUND','OUTBOUND','INTERNAL','UNKNOWN') DEFAULT 'UNKNOWN',
  `call_scope` ENUM('INTERNAL','EXTERNAL','UNKNOWN') DEFAULT 'UNKNOWN',
  `fed_leg` TINYINT(1) NOT NULL DEFAULT 0,
  `synced_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_peer_uniqueid` (`peer_id`, `uniqueid`),
  KEY `idx_calldate` (`calldate`),
  KEY `idx_src` (`src`),
  KEY `idx_dst` (`dst`),
  KEY `idx_gclid` (`global_call_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 5.4 Remote contacts

```sql
CREATE TABLE IF NOT EXISTS `sokrat_federation_remote_contacts` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `peer_id` INT NOT NULL,
  `remote_id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(120) DEFAULT NULL,
  `last_name` VARCHAR(120) DEFAULT NULL,
  `phone` VARCHAR(64) DEFAULT NULL,
  `phone_norm` VARCHAR(64) DEFAULT NULL,
  `updated_at` DATETIME DEFAULT NULL,
  `synced_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_peer_contact` (`peer_id`, `remote_id`),
  KEY `idx_phone` (`phone_norm`),
  KEY `idx_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

The Issabel SQLite `contact` table has no reliable `updated_at`; contacts are small, so use a **full snapshot replace per peer every 5 minutes** in one transaction. Do not alter the third-party SQLite schema.

### 5.5 Sync state and audit

```sql
CREATE TABLE IF NOT EXISTS `sokrat_federation_sync_state` (
  `peer_id` INT NOT NULL,
  `resource` VARCHAR(32) NOT NULL,
  `status` ENUM('idle','syncing','ok','error') NOT NULL DEFAULT 'idle',
  `last_sync_at` DATETIME DEFAULT NULL,
  `last_success_at` DATETIME DEFAULT NULL,
  `cursor_value` VARCHAR(255) DEFAULT NULL,
  `rows_synced` INT NOT NULL DEFAULT 0,
  `last_error` VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (`peer_id`, `resource`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sokrat_federation_action_log` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `peer_id` INT NOT NULL,
  `actor` VARCHAR(64) DEFAULT NULL,
  `action` VARCHAR(64) NOT NULL,
  `target` VARCHAR(128) DEFAULT NULL,
  `payload` JSON DEFAULT NULL,
  `status` ENUM('pending','ok','error') NOT NULL DEFAULT 'pending',
  `response` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_peer_created` (`peer_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 5.6 Global identity

Never expose a bare local ID. Use:

- Extension: `20:101`
- Dongle: `20:dongle1`
- Contact: `20:contact:42`
- CDR: `20:<uniqueid>`
- Call: `<global_call_id>`

The `site_code` is the human prefix; `node_uuid` is the stable machine identity. Site codes remain unique and numeric.

---

## 6. Aggregation Design

### 6.1 Poll cadence

| Resource | Interval | Overlap / notes |
|----------|----------|-----------------|
| `/live` | 3 s | 2 s timeout, circuit breaker after 3 failures |
| `/inventory` | 60 s | Full replace of extensions/dongles; counts |
| `/contacts` | 5 min | Full snapshot, transaction |
| `/cdr` | 60 s | `from = last_success - 15 min`, upsert by `(peer_id, uniqueid)` |
| `/reports/summary` | 5 min | Optional; can be computed from mirror |
| `/meta` | 15 min | Version/capability drift detection |

All requests use `Promise.allSettled` and a shared keep-alive agent. One slow peer must never block the cycle.

### 6.2 Circuit breaker

Per peer:

- `closed` → normal.
- `open` after 3 consecutive failures; skip live polls for 30 s, keep inventory at 5 min.
- `half-open` probe with `/ping`.
- Mark `status='offline'` after 15 s without a successful live response; keep last snapshot and show `last_seen_at`.
- Exponential backoff with jitter for CDR/contacts.

### 6.3 Live event

Emit one Socket.IO event every cycle:

```js
io.emit('federation:overview', {
  timestamp,
  nodes: [{ siteCode, nodeName, status, latencyMs, extensionsOnline, donglesFree, activeCalls, lastSeenAt }],
  extensions: [...],
  dongles: [...]
});
```

Keep the existing `operator:federation_state` event for backward compatibility; feed it from the same snapshot.

### 6.4 Offline behavior

- UI shows last known data with a `Stale · 2m ago` badge.
- Writes to an offline node fail fast with `503` and a clear message; do not queue mutations.
- Page render never waits for a remote timeout.

---

## 7. Reporting Design

### 7.1 Federation call identity (critical)

Today a federated call creates two CDR rows (origin outbound leg + remote inbound leg), which would double-count reports.

Add to `generateDialplanConfig()` in `lib/federation-engine.js`:

Outbound `[peer_<site>]`:

```
same => n,Set(__SOKRAT_GCLID=${IF($["${SOKRAT_GCLID}" = ""]?${UNIQUEID}:${SOKRAT_GCLID})})
same => n,Set(CDR(userfield)=SOKRAT_FED:${SOKRAT_GCLID}:origin)
same => n,Set(IAXVAR(SOKRAT_GCLID)=${SOKRAT_GCLID})
```

Inbound `[from-federation-site<site>]`:

```
same => n,Set(__SOKRAT_GCLID=${IAXVAR(SOKRAT_GCLID)})
same => n,Set(__SOKRAT_FED_LEG=1)
same => n,Set(CDR(userfield)=SOKRAT_FED:${SOKRAT_GCLID}:leg)
```

Reporting rule:

- Totals count `fed_leg = 0` only.
- Federated legs are shown behind a "Include federation legs" toggle and badged.
- Legacy rows without `global_call_id` fall back to `linkedid`, then `uniqueid`; never dedupe by `src/dst/calldate` alone.

### 7.2 Federated CDR source

`lib/federation-reports.js` builds a `UNION ALL` source with an **identical explicit column list** in both branches (never `c.*` / `r.*`, which differ):

```sql
SELECT '10' AS node_site, 'Main PBX' AS node_name,
       c.uniqueid, c.linkedid, NULL AS global_call_id,
       c.calldate, c.src, c.dst, c.dcontext, c.channel, c.dstchannel,
       c.lastapp, c.lastdata, c.userfield, c.duration, c.billsec, c.disposition,
       c.did, c.recordingfile, 0 AS fed_leg
FROM asteriskcdrdb.cdr c
WHERE c.calldate BETWEEN ? AND ?
UNION ALL
SELECT p.site_code, p.node_name,
       r.uniqueid, r.linkedid, r.global_call_id,
       r.calldate, r.src, r.dst, r.dcontext, r.channel, r.dstchannel,
       r.lastapp, r.lastdata, r.userfield, r.duration, r.billsec, r.disposition,
       r.did, r.recordingfile, r.fed_leg
FROM asteriskcdrdb.sokrat_federation_remote_cdr r
JOIN asterisk.sokrat_federation_peers p ON p.id = r.peer_id
WHERE r.calldate BETWEEN ? AND ?
```

For local rows, the report layer extracts `global_call_id` and `fed_leg` from `userfield` (`SOKRAT_FED:<gclid>:origin|leg`); mirrored rows already carry them as columns.

The existing dashboard/CDR/ext-stats queries keep their local path when `scope=local`; only `scope=all|remote` switches to the union. This avoids a performance regression on single-node installs.

### 7.3 Daily rollups (for long ranges)

```sql
CREATE TABLE IF NOT EXISTS `sokrat_federation_daily_stats` (
  `peer_id` INT NOT NULL,
  `day` DATE NOT NULL,
  `direction` ENUM('INBOUND','OUTBOUND','INTERNAL','UNKNOWN') NOT NULL,
  `total_calls` INT NOT NULL DEFAULT 0,
  `answered_calls` INT NOT NULL DEFAULT 0,
  `billsec` BIGINT NOT NULL DEFAULT 0,
  `unique_contacts` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`peer_id`, `day`, `direction`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Built nightly from the mirror; dashboard ranges > 31 days read rollups.

### 7.4 Retention

- Mirror CDR: 180 days by default (`SOKRAT_FEDERATION_CDR_RETENTION_DAYS`).
- Rollups: 3 years.
- Purge job runs daily at 03:30 with a small batch limit.

---

## 8. UI Plan

### 8.1 Global node scope

Add a compact selector to `views/sidebar.ejs`:

- `All nodes`
- `Main PBX (10)` with status dot
- `Test PBX (20)` with status dot

Persist in `localStorage` and a `fed_scope` cookie. Server helper:

```js
res.locals.federationScope = getFederationScope(req); // 'all' | '10' | '20'
res.locals.federationNodes = await getFederationNodes();
```

When a single remote node is selected, show a banner: `Viewing Site 20 · synced 8s ago`.

New partials:

- `views/partials/node-badge.ejs` — colored site badge, online/stale dot.
- `views/partials/node-scope-selector.ejs` — desktop + mobile variants.
- `views/partials/node-health-rail.ejs` — dashboard rail.

### 8.2 Overview (`views/dashboard.ejs`)

- Node health rail above KPIs: status, latency, extensions online/total, dongles free/total, calls today, last sync.
- KPI cards aggregate when `scope=all`; otherwise scope to the selected node.
- Per-employee table gets a `Node` column and composite keys (`site:ext`).
- Live active-call count from `federation:overview`.
- Offline node cards are muted with `Stale` badge; clicking filters to that node.
- Desktop layout unchanged when `scope=local`; rail collapses on mobile.

### 8.3 Dongles (`views/gsm-dongles.ejs`)

- Group cards by node with a sticky section header.
- Remote cards show live `state`, `signal_pct`, `operator_name`, SIM, IMSI/IMEI, active call, last seen.
- Local-only controls (USB reset, audio test, AT terminal) are hidden on remote cards.
- Remote allow-listed controls: restart, reload, reboot modem, edit SIM number.
- Confirmation modal for destructive actions; toast with audit result.
- Summary strip: `Total · Free · In call · Offline` per node and global.

### 8.4 Contacts (`views/contacts.ejs`)

- Merged table: Name, Phone, Node, Source, Actions.
- Node filter and global search.
- Duplicate phones grouped with an "also on Site 20" chip; expandable.
- Add modal includes **Save to** node selector (default local).
- Edit/delete on a remote row calls the central proxy; the owning node validates `allow_contact_write`.
- Optimistic UI update, then refresh from mirror; clear error if the node is offline.
- Bulk import gets a target-node selector (Phase 5).

### 8.5 Call History / Reports (`views/cdr.ejs`, `views/ext-stats.ejs`)

- `Node` column and `Node` filter (multi-select).
- Node badge on each row; `Federated leg` badge when the toggle is on.
- Export CSV includes `node_site`, `node_name`, `global_call_id`.
- Summary header per node: total, answered, missed, avg talk, answer rate.
- Comparison table/chart: node vs node for the selected range.
- Employee metrics keyed by `site:ext`; remote employees included in central mode.

### 8.6 Live panel (`views/operator.ejs`)

- Keep existing node filter; add dongle cards and node health header.
- Fix active-call mapping in the socket handler.
- Remote actions routed with `peerId`; optimistic state with timeout.
- `All nodes` mode remains the default for central role.

### 8.7 Configuration (`views/config.ejs`)

- Peer table adds: API version, last seen, latency, sync status, capability toggles.
- Actions: `Test API auth`, `Force full resync`, `Rotate key`, `Promote to central`.
- Sync matrix: resource × peer with last success, rows, error.
- Version drift warning: `Local 3.4.1 / Peer 3.3.9`.
- Site code registry warning on duplicates.

### 8.8 Bilingual / RTL

Every new label, badge, table header, modal, and toast must exist in English and Arabic with `isRtl` branches and the Cairo font, per `AGENTS.md` §5. No hard-coded English in new EJS.

---

## 9. Implementation Phases

### Phase 0 — Security and correctness (0.5–1 day)

**Deliverables**

1. `lib/federation-auth.js` with HMAC sign/verify, replay cache, timing-safe compare.
2. Remove `/api/federation/v1/` from the public bypass; add middleware.
3. Fix `api_base_url` to `https://<host>` (443) and migrate existing rows; `http://<host>:8080` only with `SOKRAT_FEDERATION_ALLOW_HTTP=1`.
4. Make `activeCalls` a map keyed by extension everywhere (`getLocalLiveStateFn`, `/live-state`, hub).
5. Set Site 20 on `192.168.100.92`; bootstrap from `.50`; verify peer online.
6. Stop blind SCP of application code during bootstrap; add a version handshake and an explicit `force_code_sync` flag.
7. Add `node_uuid`, `api_version`, and capability columns to peers; add `sokrat_federation_node_status` for live health.
8. Protect or remove public `/extensions` and `/dongles` endpoints.

**Acceptance**

- Unsigned `curl` to every `/api/federation/v1/*` endpoint returns `401`.
- Signed request with a valid key returns `200`; replay returns `401`.
- `.92` reports Site 20, `.50` reports Site 10; both peer rows exist and qualify.
- No remote code is overwritten unless explicitly requested.

### Phase 1 — Control plane and health (2–3 days)

**Deliverables**

1. `lib/federation-client.js`: signed HTTP client, keep-alive, timeouts, retries, circuit breaker.
2. `lib/federation-aggregator.js`: poll `/live` and `/inventory`; upsert node status, extensions, dongles; sync state.
3. New tables from §5; migrations in all four schema locations.
4. `routes/federation-agent.js` and `routes/federation-central.js`.
5. `GET /api/federation/overview`, `GET /api/federation/nodes`, `POST /api/federation/nodes/:id/sync`.
6. Dashboard node rail, config sync matrix, `federation:overview` socket event.
7. Node scope selector and server-side scope helper.

**Acceptance**

- Both nodes show each other online within 5 s.
- Stopping `sokrat-voip` on `.92` marks it offline within 15 s; pages still render.
- Restarting `.92` recovers automatically without a manual refresh.
- No page render exceeds +150 ms versus the current local-only path.

### Phase 2 — Dongles everywhere (2 days)

**Deliverables**

1. Agent `/live` returns enriched dongles from `getEnrichedDevices()` (state, signal, operator, SIM, IMSI/IMEI, active call).
2. Fix `syncRemotePeerEntities` column mismatch; full dongle replacement per inventory cycle.
3. `GET /api/federation/dongles` merged endpoint.
4. `views/gsm-dongles.ejs` grouped by node with node badges and stale handling.
5. Remote action endpoint + policy flags + audit log; wire restart/reload/reboot/SIM update.
6. `federation-control` permission and per-peer capability toggles.

**Acceptance**

- `dongle1` on `.50` appears on `.92` (and vice versa) with live state within 5 s.
- Restarting a remote dongle from the central UI succeeds and writes an audit row.
- Disabling `allow_dongle_control` makes the same action return `403`.
- Remote cards hide USB/audio/AT controls.

### Phase 3 — Contacts (2–3 days)

**Deliverables**

1. Agent contacts snapshot + write-through create/update/delete.
2. `sokrat_federation_remote_contacts` mirror, full replace every 5 min in a transaction.
3. `GET /api/federation/contacts` with search, node filter, pagination, dedupe by normalized phone.
4. Contacts page: Node column, node filter, Save-to selector, remote edit/delete.
5. Duplicate-phone grouping and linked-node chips.
6. Audit for remote writes; reject when `allow_contact_write = 0` or node offline.

**Acceptance**

- A contact created on `.92` appears on `.50` within 5 minutes (or immediately after a manual sync).
- Editing from `.50` updates the SQLite row on `.92` and is visible after refresh.
- The same phone on both nodes is grouped, not duplicated.
- Offline write shows a clear error and does not silently queue.

### Phase 4 — Reports and call history (3–4 days)

**Deliverables**

1. GCLID propagation in the federation dialplan; `fed_leg` detection.
2. Agent `/cdr` incremental endpoint and `/reports/summary`.
3. CDR mirror upsert with 15-minute overlap; daily rollups; retention job.
4. `lib/federation-reports.js` union source and dedupe rules.
5. Dashboard, CDR, and ext-stats scope-aware queries; Node column/filter; export; per-node comparison.
6. Nightly rollup builder and 31+ day read path.

**Acceptance**

- Dashboard total equals the sum of node totals minus federation legs.
- Node filter returns only that node's rows; `All nodes` includes both.
- Export contains node and GCLID columns.
- 90-day, 100k-row query completes under 2 s on the test hardware.
- A federated call between `.50` and `.92` is counted once in totals.

### Phase 5 — Full single pane (3–5 days)

**Deliverables**

1. Operator: dongles, node health, remote actions, fixed active-call mapping.
2. Campaign summary mirror and remote start/pause/reset; follow-ups read-only across nodes.
3. Voicemail and recording metadata; authenticated proxy playback from the owning node.
4. Storage/SysMon per node (disk, CPU, load, service status).
5. Ext-stats employee metrics across nodes.
6. System alerts when a node is offline, disk > 85%, or sync stale > 10 min.
7. Bulk contact import to a selected node.

**Acceptance**

- Operator can see and control both nodes from one screen.
- A campaign on `.92` is visible and startable from `.50` (policy permitting).
- A recording on `.92` plays through `.50` without exposing a public URL.
- Node offline/disk alerts fire and clear.

### Phase 6 — N-node and hardening (2–3 days)

**Deliverables**

1. Peer roster distribution so 3+ nodes can be managed from one central.
2. Pairwise IAX key generation for spoke-to-spoke calls; or explicit via-central routing.
3. Site-code registry and collision rejection.
4. Key rotation without downtime; optional mTLS; per-peer IP allowlist.
5. Push mode (agent posts deltas to central) behind a flag for >10 nodes.
6. Central failover: promote another node and restore mirrors from peers.
7. Runbook, backup/restore of federation config, and upgrade notes.

**Acceptance**

- Three-node lab: all nodes visible from one; central failover works.
- Key rotation completes with no failed polls.
- 10-node simulation stays under 5% CPU on the central node.

**Estimated total:** 14–20 engineer-days for Phases 0–5; +2–3 days for Phase 6.

---

## 10. File Change Map

### New files

| File | Purpose |
|------|---------|
| `lib/federation-auth.js` | HMAC signing/verification, replay cache, middleware |
| `lib/federation-client.js` | Signed HTTP client with keep-alive, retries, circuit breaker |
| `lib/federation-aggregator.js` | Poll loops, mirror upserts, sync state, socket events |
| `lib/federation-reports.js` | Federated CDR union source, dedupe, rollups |
| `routes/federation-agent.js` | Agent API (live, inventory, contacts, CDR, actions) |
| `routes/federation-central.js` | UI API (overview, nodes, merged dongles/contacts/reports) |
| `views/partials/node-badge.ejs` | Consistent node badge |
| `views/partials/node-scope-selector.ejs` | Global scope selector |
| `views/partials/node-health-rail.ejs` | Dashboard node cards |
| `test/federation-auth.test.js` | Signature, replay, clock skew, policy |
| `test/federation-aggregator.test.js` | Merge, stale/offline, circuit breaker |
| `test/federation-reports.test.js` | Union, dedupe, node filter |
| `test/federation-ui.test.js` | EJS syntax, i18n keys, scope persistence |

### Modified files

| File | Changes |
|------|---------|
| `lib/federation-hub.js` | Delegate polling to aggregator; keep socket compatibility |
| `lib/federation-bootstrap.js` | API URL, site code, key handshake, no blind code overwrite, capability defaults |
| `lib/federation-engine.js` | New schema init, GCLID dialplan, include hooks |
| `server.js` | Remove public bypass, mount routers, scope helper, dashboard/CDR/contacts/dongles queries, locals |
| `views/sidebar.ejs` | Node scope selector + status dot |
| `views/dashboard.ejs` | Node rail, scoped KPIs, node column |
| `views/gsm-dongles.ejs` | Grouped by node, remote actions |
| `views/contacts.ejs` | Node column/filter, Save-to, remote edit |
| `views/cdr.ejs` | Node column/filter, export, federation-leg badge |
| `views/ext-stats.ejs` | Node scope and composite keys |
| `views/operator.ejs` | Dongles, node health, fixed socket mapping |
| `views/config.ejs` | Sync matrix, policy flags, auth test, rotate key |
| `backend/install_db.sql` | New tables + extended dongle columns |
| `install.sh` | Schema parity |
| `installer-bundle/install-sokrat.sh` | Schema parity |
| `scripts/safe-upgrade.sh` | `ensure_db_column` / `ensure_db_index` + new tables |
| `test/installer-and-schema.test.js` | New table assertions |
| `test/federation-config.test.js` | Auth/contract assertions |
| `test/views-syntax-and-brackets.test.js` | New partials/pages |

---

## 11. Security Review Checklist

- [ ] No federation endpoint returns data without a valid HMAC signature.
- [ ] `api_key_enc` is never decrypted into a response or log.
- [ ] Replay protection and 60 s clock-skew window enforced.
- [ ] Rate limits per site for reads and writes.
- [ ] Capability flags default to read-only.
- [ ] Remote writes require `federation-control` on central and the peer policy on remote.
- [ ] Actor is logged on both sides; no impersonation of a local admin.
- [ ] TLS preferred; HTTP fallback only with an explicit env flag.
- [ ] Optional certificate fingerprint pinning (`tls_cert_fingerprint`).
- [ ] Phone numbers respect `mask_phone_numbers` in aggregated views.
- [ ] Recording/voicemail proxy requires a session and checks extension scope.
- [ ] Audit log retention and rotation defined.

---

## 12. Testing and Acceptance

### Automated

```bash
node --test test/federation-auth.test.js
node --test test/federation-aggregator.test.js
node --test test/federation-reports.test.js
node --test test/federation-ui.test.js
node --test test/federation-config.test.js
node --test test/installer-and-schema.test.js
node --test test/views-syntax-and-brackets.test.js
node --test test/progressive-dialer.test.js
```

Contract tests use a local mock peer (Node `http` server) serving fixtures; no live PBX needed for CI.

### Live two-node checklist

1. Set `.92` to Site 20; bootstrap from `.50`; both peers online.
2. Extensions and dongles appear on both nodes within 10 s.
3. A contact created on `.92` is visible on `.50`; an edit from `.50` lands on `.92`.
4. A call on `.92` appears in `.50` call history with `Node = 20`.
5. A federated call `.50 → .92` is counted once.
6. Stop `sokrat-voip` on `.92`: `.50` shows offline/stale within 15 s; pages still load.
7. Restart `.92`: recovery without manual refresh.
8. Disable `allow_dongle_control`: remote restart returns 403.
9. Rotate the peer key: no failed polls after both sides update.
10. Run a 100k-row, 90-day report and record p95 latency.

### Performance targets

- Dashboard render: < 800 ms locally, < 1.2 s with 5 peers.
- Federation live poll cycle: < 500 ms for 5 peers on LAN.
- CDR mirror sync: < 2 s for 1,000 rows.
- No unbounded memory growth over 24 h (nonce cache, socket buffers, mirror queries).

---

## 13. Rollout Plan

### Today (before coding)

1. On `.92`:
   ```sql
   UPDATE asterisk.sokrat_federation_settings
   SET local_site_code='20', local_node_name='Test PBX'
   WHERE id=1;
   ```
2. From `.50`, run the one-click bootstrap to `.92` with Site 20.
3. Verify:
   ```bash
   asterisk -rx 'iax2 show peers'
   asterisk -rx 'iax2 show registry'
   mysql -u root -padmin asterisk -e "SELECT id,node_name,site_code,status,api_base_url FROM sokrat_federation_peers;"
   ```
4. Do **not** run production auto-dialer tests until Phase 0 auth is deployed on both nodes.

### Phase deployment order

1. Deploy Phase 0 code + migrations to `.50`, then `.92`.
2. Re-run bootstrap or rotate keys so both sides sign correctly.
3. Deploy Phase 1–2; verify node rail and dongles.
4. Deploy Phase 3–4; verify contacts/reports.
5. Deploy Phase 5; verify operator/campaign/recordings.
6. Keep a rollback tag before each phase; migrations are additive and reversible by code rollback.

### Installer sync (mandatory per `AGENTS.md` §6)

Every schema change must land in:

1. `backend/install_db.sql`
2. `install.sh`
3. `installer-bundle/install-sokrat.sh`
4. `scripts/safe-upgrade.sh`

Add a test assertion for each new table/column so drift fails CI.

---

## 14. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Auth rollout locks out a peer | Deploy both sides in one window; temporary `SOKRAT_FEDERATION_ALLOW_LEGACY=1` flag for 24 h; signed `curl` smoke test |
| Wrong API URL (`8443`) persists | Migration updates existing rows; bootstrap writes `https://host`; health check validates |
| CDR mirror volume | 180-day retention, incremental 15-min overlap, daily rollups, batched upserts, indexes |
| Double-counted federated calls | GCLID + `fed_leg`; count origin only; legacy fallback to `linkedid` |
| Contact duplicates | Normalize phone via `lib/phone-normalization.js`; group by `phone_norm`; owner-based edits |
| Silent code overwrite during bootstrap | Version handshake; no SCP of app code by default; explicit `force_code_sync` |
| Site code collision | Unique constraint + registry check + bootstrap rejection |
| Clock skew breaks HMAC | Require NTP; 60 s window; surface a clear error in config |
| Slow/offline peer blocks UI | Local mirrors, 2 s timeouts, circuit breaker, stale badges, no synchronous remote calls in render |
| Permission escalation via federation | Per-peer capability flags + central `federation-control` + audit actor |
| Large N-node polling cost | Star topology, tiered intervals, push mode behind a flag in Phase 6 |
| `.92` runs older code after bootstrap | Version handshake + `git pull`/explicit deploy, not blind SCP |

---

## 15. Decisions Needed

Recommended defaults are shown; confirm or change before Phase 1.

1. **Central node:** `.50` (`sokrat-demo`) is central; `.92` is a local node. Both can be central later.
2. **Write policy:** contacts and dongle controls are **read-only by default**; enable per peer in Config.
3. **CDR retention on central:** 180 days mirror + 3 years rollups.
4. **Contacts sync:** full snapshot every 5 minutes (simplest, safe for Issabel SQLite).
5. **Reports dedupe:** count origin legs only; show federation legs behind a toggle.
6. **Transport:** HTTPS on 443 with the existing self-signed cert; HTTP 8080 only as an explicit fallback.
7. **N-node voice:** full mesh IAX for up to 5 nodes; revisit via-central routing beyond that.

---

## 16. Definition of Done

- One login on any node can switch between `All nodes` and a specific node.
- Overview, dongles, contacts, and reports all show data from every online node.
- Remote data is visibly attributed to its node and marked stale when offline.
- Permitted writes reach the owning node and are audited; forbidden writes return 403.
- Federated calls are counted once.
- A node outage degrades gracefully and recovers automatically.
- Fresh install, offline bundle, and in-place upgrade all produce the same schema.
- English and Arabic UI are complete, responsive, and consistent with the existing design.
- All federation, installer, view, and dialer tests pass.
