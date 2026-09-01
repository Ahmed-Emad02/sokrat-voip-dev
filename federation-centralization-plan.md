# Comprehensive Multi-Node Centralization Implementation Plan
## Sokrat VoIP / Asterisk PBX Federation: Dashboard, CDR, GSM Dongles, Contacts & Voicemails

---

## 1. Executive Summary & Architecture Overview

Building on the verified **IAX2 Multi-Server Federation Engine** and **Live Operator Panel**, this plan extends multi-server centralization across the five core operational subsystems:
1. **Dashboard (`/` & `/api/dashboard/stats`)**: Unified KPI cards, volume trends, hourly distribution, disposition breakdowns, and top talkers aggregated across all connected nodes with real-time node filtering.
2. **Call History / CDR (`/cdr` & `/api/cdr`)**: Multi-node call detail record aggregation, unified chronological merge, site code tagging, remote audio recording proxy streaming, and unified CSV export.
3. **GSM Dongles Monitor (`/gsm-dongles` & `/api/gsm-dongles/*`)**: Centralized dongle hardware overview, signal strength monitoring, SIM state tracking, and remote SMS/USSD action routing.
4. **Shared Address Book (`/contacts` & `/api/contacts/*`)**: Cross-server contact synchronization, caller ID name resolution, and global corporate directory.
5. **Voicemails (`/voicemails` & `/api/voicemail/*`)**: Multi-node inbox inspection, remote voicemail audio streaming, custom greeting synchronization, and AI speech-to-text transcript aggregation.

---

## 2. Core Architectural Principles & Invariants

1. **Role-Driven Centralization**:
   - **When `panel_role === 'central'`**: The server queries its local database and concurrently polls enabled remote federation peers via HTTPS/HTTP REST API. It aggregates datasets using composite keys (`<siteCode>:<id>`), provides node filtering tabs (`All Nodes`, `Site 10`, `Site 30`), and displays distinctive site badges.
   - **When `panel_role === 'local'`**: The server displays only local data. Top node switcher controls and remote telemetry are omitted from the UI.
   - **Simultaneous Central Hubs**: Multiple servers can act as Central Hubs at the same time without database locks or conflicts.

2. **Security & Authentication**:
   - All inter-PBX communication occurs over encrypted channels:
     - Telephony/Media: **IAX2 UDP 4569 with AES-128 call encryption**.
     - API/Data: **HTTPS on port 8443 / HTTP on 8080 with shared HMAC / bearer tokens**.
   - Audio files (recordings and voicemails) are streamed through ephemeral HMAC tokens (`createMediaId` / `decodeMediaId`) — physical filesystem paths are never exposed over the network.

3. **Fault-Tolerant Degraded Mode**:
   - If a remote PBX becomes unreachable or experiences latency, local server operations continue uninterrupted. Unreachable nodes are flagged as `offline`/`unreachable` with zero impact on local metrics or active calls.

---

## 3. Subsystem Breakdown & Implementation Slices

### Phase 1: Inter-PBX Federation API Layer Expansion (`server.js`)
Expose lightweight, authenticated endpoints under `/api/federation/v1/*` on all nodes:
- `GET /api/federation/v1/dashboard-stats?startDate=...&endDate=...&filters=...`:
  Returns structured summary metrics, disposition counts, hourly buckets, and extension activity from the remote node.
- `GET /api/federation/v1/cdr?startDate=...&endDate=...&offset=...&limit=...&filters=...`:
  Returns raw CDR rows from the remote `asteriskcdrdb.cdr` table with generated recording streaming tokens.
- `GET /api/federation/v1/recording/:mediaId`:
  Streams audio recording chunks from `/var/spool/asterisk/monitor/` for remote playback.
- `GET /api/federation/v1/gsm-dongles`:
  Returns live dongle hardware states, IMEI/IMSI, SIM numbers, signal dBm, carrier names, and sub-hub USB topology.
- `POST /api/federation/v1/gsm-dongles/action`:
  Executes remote SMS dispatch, AT commands, or USSD requests on the owning PBX.
- `GET /api/federation/v1/contacts` & `POST /api/federation/v1/contacts`:
  Provides bilateral address book synchronization.
- `GET /api/federation/v1/voicemails`:
  Returns voicemail messages across all mailboxes on the remote node with metadata.
- `GET /api/federation/v1/voicemail-audio/:mailbox/:msgId`:
  Streams voicemail WAV audio for remote playback.

---

### Phase 2: Centralized Dashboard (`views/dashboard.ejs` & `server.js`)

1. **Backend Aggregation (`/api/dashboard/stats`)**:
   - When `panel_role === 'central'`:
     - Fetch local CDR metrics from `asteriskcdrdb.cdr`.
     - In parallel (`Promise.allSettled`), fetch remote metrics from all enabled peers in `sokrat_federation_peers`.
     - If `nodeFilter === 'all'`: Sum KPI totals (Total Calls, Answered, Inbound, Outbound, Talk Time), combine hourly histograms, merge disposition totals, and aggregate employee performance rows tagged with `siteCode`.
     - If `nodeFilter === '10'`: Filter strictly to local node data.
     - If `nodeFilter === '30'`: Filter strictly to the selected remote peer's metrics.
2. **Frontend UI Updates (`views/dashboard.ejs`)**:
   - When `panel_role === 'central'`: Render the top node switcher bar (`All Nodes`, `Main PBX #10`, `masterpiece #30`) directly above the filter drawer.
   - Update Employee Performance table with site badges (e.g., `[#10]` or `[#30]`).
   - Clicking node buttons re-fetches metrics with `nodeFilter` parameter without reloading the page.

---

### Phase 3: Centralized Call History / CDR (`views/cdr.ejs` & `server.js`)

1. **Backend Aggregation (`/api/cdr` & `/api/cdr/export`)**:
   - Central node fetches local CDRs and remote peer CDRs.
   - Tags each record with `site_code`, `node_name`, and `is_remote`.
   - For remote records with recording files: Generate a remote proxy URL (`/api/recordings/remote-stream/:peerId/:recordingFile`) that securely proxies audio from the remote PBX.
   - Unified chronological sorting by `calldate DESC` across all nodes.
2. **Frontend UI Updates (`views/cdr.ejs`)**:
   - Add a `PBX Node` filter dropdown in the filter drawer (`All Nodes`, `Main PBX #10`, `Branch PBX #30`).
   - Add a `Node` column in the CDR table displaying `#10 Main PBX` or `#30 masterpiece`.
   - Audio playback button streams seamlessly whether the recording is stored locally or on a remote peer.

---

### Phase 4: Centralized GSM Dongles Monitor (`views/gsm-dongles.ejs` & `server.js`)

1. **Backend Aggregation (`/api/gsm-dongles`)**:
   - Merge local GSM dongles with remote dongles discovered from connected peers.
   - Attach owning node metadata (`siteCode`, `nodeName`, `host`).
2. **Remote Action Dispatch (`/api/gsm-dongles/send-sms`, `/api/gsm-dongles/ussd`)**:
   - When user triggers SMS or USSD on a remote dongle (e.g. `dongle0` on Site 30):
   - The central backend proxies the request to `POST https://192.168.100.228:8443/api/federation/v1/gsm-dongles/action` to execute directly via the remote node's chan_dongle interface.
3. **Frontend UI Updates (`views/gsm-dongles.ejs`)**:
   - Add top node switcher tabs (`All Dongles`, `Main PBX #10 (1 dongle)`, `masterpiece #30 (5 dongles)`).
   - Display site badge on each dongle card.

---

### Phase 5: Shared Address Book & Multi-Node Voicemails

1. **Address Book (`views/contacts.ejs` & `server.js`)**:
   - Provide a "Sync Across Nodes" option allowing contacts added on one PBX to automatically populate into connected peer databases.
   - Global contact search across local SQLite directory and federated node contacts.
2. **Voicemails (`views/voicemails.ejs` & `server.js`)**:
   - Central Live Panel aggregates voicemail inboxes across all PBX servers.
   - Mailbox cards tagged with `#10` or `#30`.
   - Audio playback streams directly from the originating server.
   - Speech-to-Text transcriptions displayed in a unified search interface.

---

## 4. Step-by-Step Implementation Roadmap

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Federation Core API Layer Expansion                            │
│ - Implement /api/federation/v1/{dashboard-stats, cdr, gsm, vm, contacts}│
│ - Implement remote audio streaming proxy                                │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
       ┌─────────────────────────────┼─────────────────────────────┐
       ▼                             ▼                             ▼
┌───────────────┐             ┌───────────────┐             ┌───────────────┐
│ Phase 2:      │             │ Phase 3:      │             │ Phase 4:      │
│ Centralized   │             │ Centralized   │             │ Centralized   │
│ Dashboard     │             │ Call History  │             │ GSM Dongles   │
│ & Analytics   │             │ & Recordings  │             │ & SMS/USSD    │
└──────┬────────┘             └───────┬───────┘             └───────┬───────┘
       │                              │                             │
       └──────────────────────────────┼─────────────────────────────┘
                                      │
                                      ▼
                       ┌───────────────────────────────┐
                       │ Phase 5: Shared Contacts &    │
                       │ Multi-Node Voicemails         │
                       └──────────────┬────────────────┘
                                      │
                                      ▼
                       ┌───────────────────────────────┐
                       │ Phase 6: Automated Testing &  │
                       │ Verification on Both Servers  │
                       └───────────────────────────────┘
```

---

## 5. Verification & Test Plan

1. **Automated Unit & Parity Tests (`test/federation-centralization.test.js`)**:
   - Test multi-node KPI aggregation math and histogram merging.
   - Test CDR multi-source merging and chronological sorting.
   - Test remote recording token generation and URL proxy derivation.
   - Test GSM remote command payload validation.
   - Run full suite: `node --test test/*.test.js` (Target: 100% pass).

2. **Live End-to-End Verification between `192.168.100.128` and `192.168.100.228`**:
   - **Dashboard**: Set Server 128 to Central; verify combined call metrics from both Server 128 and Server 228. Switch to `Site 30` and confirm filtered metrics.
   - **CDR**: Make a call on Server 228; open CDR on Server 128; verify the record appears with `#30` badge and remote audio playback works.
   - **GSM Dongles**: Open GSM Monitor on Server 128; verify both local `dongle0` and Server 228's 5 dongles appear with live signal levels. Send a test USSD to a Server 228 dongle from Server 128.
   - **Voicemails**: Leave a voicemail on Server 228; open `/voicemails` on Server 128; verify message appears and plays audio.
   - **Local Role Verification**: Switch Server 228 to Local; confirm it displays only local data without top node switchers.
