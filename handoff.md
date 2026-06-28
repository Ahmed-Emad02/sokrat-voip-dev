# Issabel Analytics Dashboard — Project Handoff

**Date:** May 21, 2026 (Updated Session 4)
**Location:** `/home/site/vm-issabel`
**GitHub:** https://github.com/Ahmed-Emad02/issabel-dashboard
**Stack:** Node.js 22 + Express 4, MySQL (Issabel/Asterisk CDR), Socket.io v4, Asterisk AMI, EJS, Tailwind CSS v4, ECharts 5

---

## 1. Architecture Overview

```
server.js          ← Express app, AMI TCP listener, Socket.io, 7 routes
├── views/
│   ├── sidebar.ejs       ← Shared nav (EN/AR, RTL-aware)
│   ├── cdr.ejs           ← Call Detail Records with filters
│   ├── employees.ejs     ← Per-employee inbound/outbound metrics
│   ├── ext-stats.ejs     ← Per-extension deep-dive stats with ECharts
│   ├── operator.ejs      ← Live real-time switchboard (WebSocket)
│   └── dashboard.ejs     ← KPI summary with ECharts pie chart
├── .env                  ← DB/AMI credentials (gitignored)
├── package.json          ← express, mysql2, socket.io, ejs, dotenv, moment
└── .gitignore            ← node_modules/, .env, *.log
```

**Port:** 3000 (configurable in `.env`)

### Real-time data flow
```
Asterisk AMI (TCP 5038)  →  server.js parses events  →  Socket.io emits
→  operator.ejs client receives via socket.on('callUpdate')
```

---

## 2. Routes

| Route | View | Description |
|---|---|---|
| `GET /` | — | Redirects to `/cdr` |
| `GET /cdr` | `cdr.ejs` | CDR logs with datetime/extension/status/src/dst filters, audio download |
| `GET /employees` | `employees.ejs` | Employee talk-time breakdown (inbound vs outbound), unique contacts |
| `GET /ext-stats` | `ext-stats.ejs` | Per-extension analytics: KPI cards, disposition pie chart, daily bar chart, unique contacts, recent calls |
| `GET /api/ext-stats/:ext` | — | JSON API for ext-stats data (date/direction filters) |
| `GET /operator` | `operator.ejs` | Live extension grid — idle/ringing/in-call states, call timers, Barge/Whisper/Listen buttons |
| `GET /download-audio` | — | Streams `.wav` from `/var/spool/asterisk/monitor/` by `uniqueid` |

### `dashboard.ejs` (standalone, no sidebar)
Served by the `/cdr` route (deprecated — not directly routed). Displays KPI cards, employee table, ECharts inbound/outbound donut, and recent call feed. Uses `stats` and `employeeMetrics` computed in the / route handler (not currently in server.js — needs a dedicated route or integration).

---

## 3. Key Technical Details

### AMI Event Handling (`server.js:33-99`)
- Connects via raw TCP to `127.0.0.1:5038`
- Listens for `Newchannel`, `Newstate`, `BridgeEnter`, `Hangup`
- Tracks calls by extension in `activeCalls{}` with `{ state, partner, start }`
- `ChannelStateDesc === 'Up'` or `ChannelState === '6'` → marks as "In Call"
- Auto-reconnects every 5s on disconnect

### i18n (English / Arabic)
- Language persisted via `?lang=ar` or `?lang=en` query param
- `res.locals.currentLang` set in shared middleware (`server.js:112`)
- Arabic layout flips to `dir="rtl"` and loads Cairo font
- `operator.ejs` is English-only (hardcoded) to avoid JS parsing conflicts with Socket.io updates

### CDR Query (`server.js:128-153`)
- Joins `asteriskcdrdb.cdr` from Issabel's MySQL
- Filters: date range, extension (src OR dst), src/dst LIKE, disposition
- Case-insensitive status matching via `TRIM(UPPER())`
- Limited to 2000 rows, ordered by `calldate DESC`

### Employee Metrics (`server.js:164-211`)
- Groups CDR rows by extension from `asterisk.users` roster
- Splits inbound vs outbound by checking `channel` vs `dstchannel` for `SIP/`
- Tracks: total calls, inbound talk seconds, outbound talk seconds, unique numbers (Set)

### Operator Board Timers (`operator.ejs:130-154`)
- Client-side `setInterval` every 1s computes `MM:SS` from `data-start` (epoch ms)
- No server-side timer polling — single timestamp pushed via Socket.io
- `formatDuration()` computes elapsed locally

### Audio Download (`server.js:221-242`)
- Looks up `recordingfile` from `cdr` table by `uniqueid`
- Searches `/var/spool/asterisk/monitor/YYYY/MM/DD/filename` then flat fallback
- Streams as `audio/wav` with `Content-Disposition` attachment

### Extension Statistics API (`server.js:359-465`)
- `GET /api/ext-stats/:extension` returns JSON with:
  - KPI totals (total/answered calls, answer rate, avg talk time)
  - Inbound/outbound split (count + talk seconds)
  - Unique contact count + list
  - Disposition distribution (for pie chart)
  - Daily call volume breakdown (for bar chart)
  - Recent 50 calls table
- Filters: date range, direction (inbound/outbound/all)
- Direction detection: `channel` vs `dstchannel` SIP/ prefix analysis

### Extension Statistics View (`views/ext-stats.ejs`)
- Left panel: clickable extension list with online/offline status dots
- 5 KPI stat cards: Total Calls, Answered, Answer Rate, Unique Contacts, Avg Talk Time
- Inbound/Outbound dual stat boxes with call counts and talk minutes
- ECharts donut pie: call status distribution (ANSWERED/BUSY/NO ANSWER/FAILED/CANCEL)
- ECharts bar chart: daily call volume (total + answered)
- Unique contacts displayed as a tag cloud
- Recent calls table (last 50)
- Filter form: date range + direction
- Language: full EN/AR with RTL support

### Operator Board Call Monitoring Buttons (`views/operator.ejs`)
- Three buttons per extension card: **Listen** (222), **Whisper** (223), **Barge** (224)
- Buttons are `<a href="sip:...">` links — clicking triggers MicroSIP (`st-sip`) or compatible softphones to dial the feature code
- Asterisk dialplan (`/etc/asterisk/extensions_custom.conf`) routes these to `ChanSpy()`:
  - `Answer()` is called to establish the audio channel
  - AstDB is queried for `/DEVICE/<extension>/dial` to determine device technology dynamically (e.g. `SIP/102`)
  - `222 + ext` → `ChanSpy(${spyee_dial},q)` — silent listen
  - `223 + ext` → `ChanSpy(${spyee_dial},qw)` — whisper to target only
  - `224 + ext` → `ChanSpy(${spyee_dial},qB)` — barge (both parties hear)
- Arabic translations: تدخل / همس / استماع

---

## 4. Known Bugs & Per-Environment Issues

1. **`dashboard.ejs` has no route** — The `/` route redirects to `/cdr`. `dashboard.ejs` expects `stats` and `employeeMetrics` locals that no middleware computes. Needs a dedicated `/dashboard` route or integration into the `/` handler.
2. **`dashboard.ejs` references `emp.totalTalkSec`** — The employees route computes `inboundTalkSec`/`outboundTalkSec` separately; `dashboard.ejs` expects a `totalTalkSec` property. The employee data is not passed to dashboard at all currently.
3. **No `public/` directory** — `app.use(express.static('public'))` will silently 404. Only needed if custom CSS/JS is added beyond CDN links.
4. **`.env` contains credentials** — Already gitignored. If cloning, users must create their own `.env`:
   ```
   PORT=3000
   DB_HOST=localhost
   DB_USER=root
   DB_PASS=yourpassword
   DB_NAME=asteriskcdrdb
   AMI_PORT=5038
   AMI_USER=admin
   AMI_PASS=yourpassword
   ```
5. **No `npm start` script** — `package.json` has no `start` script. Run with `node server.js`.
6. **CDR database might differ** — Some Issabel setups use `asteriskcdr` DB or different column names. Adjust `server.js` queries if needed.
7. **AMI event edge case** — If `CallerIDNum` is > 5 chars (trunk calls), the extension is ignored. This prevents external calls from appearing on the operator board, which is the intended behavior for internal-only monitoring.

---

## 5. Issues Resolved in Previous Sessions

1. **SQL case-sensitive status filter** — Fixed with `TRIM(UPPER(c.disposition))` wrapping
2. **Layout overflow** — Removed `max-h-[550px] overflow-y-auto` from CDR table
3. **Language reset on route change** — `?lang=` param carried across all nav links
4. **AMI stuck on Ringing** — Added `ChannelStateDesc === 'Up'` and `ChannelState === '6'` checks
5. **Call timer performance** — Client-side duration calculation from single server timestamp
6. **Out-of-order AMI packets** — State protection guard preserves "In Call" state if already set
7. **`side bar` -> `sidebar` rename** — Fixed include path from `side bar` to `sidebar`

---

## 6. Session 2 — May 20, 2026

### Done
- **Created README.md** — Full project documentation: features, prerequisites, install, `.env` config, auto-start (systemd + pm2), routes table, project structure, tech stack, notes
- **Uploaded all files to GitHub** — `server.js`, `views/operator.ejs`, `README.md`, `handoff.md` pushed to `Ahmed-Emad02/issabel-dashboard`
- **Fixed empty upload bug** — First upload failed due to SSHFS disconnect; re-uploaded with correct content after remount
- **Documented auto-start** — Added systemd service unit and pm2 instructions to README
- **handoff.md now on GitHub** — Can be loaded into a new AI session via `read handoff.md from the repo`

### Still open
- Online/offline detection: all extensions still show online when only some should be (need direct AMI/DB access to debug)
- `dashboard.ejs` still has no dedicated route
- No `npm start` script in `package.json`

---

## 7. Session 3 — May 21, 2026

### Done
- **Added Extension Statistics tab** — New route `/ext-stats` with clickable extension list, KPI cards, ECharts disposition pie chart, daily volume bar chart, unique contacts tag cloud, recent calls table. Full EN/AR support.
- **Added Barge/Whisper/Listen buttons** — Three `tel:` link buttons on each operator card (Listen=`222`, Whisper=`223`, Barge=`224`). Arabic translations added.
- **Added Asterisk ChanSpy dialplan** — Appended to `[from-internal-custom]` in `/etc/asterisk/extensions_custom.conf` on the Issabel server. CDR logging suppressed. Dialplan reloaded live.
- **Operator panel scroll fix** — Fixed layout for `ext-stats.ejs` to use proper `flex-1 min-h-0` chain so scroll works within the detail panel.

---

## 8. Session 4 — May 21, 2026

### Done
- **Replaced `/` landing page** — `/` now renders a proper aggregate dashboard instead of redirecting to CDR. New route queries CDR for total calls, inbound/outbound counts with air minutes, answer rate, per-extension metrics, and recent calls feed. Dashboard rewritten with sidebar include, full EN/AR bilingual support, ECharts pie chart.
- **In-browser audio playback** — Old `/download-audio` route replaced with `/audio/:uniqueid` supporting `Range` headers for HTML5 `<audio>` seeking. CDR table shows inline audio controls + download button for answered calls.
- **Added Dashboard nav link** — Sidebar now has Dashboard (🏠) as the first navigation item, with active state highlighting.
- **Server restarted** — Old server process killed and restarted via nohup.
- **GitHub push** — All 4 changed files pushed via API.

### Still open
- Language preference not persisted across page loads (via cookie/localStorage)

---

## 9. Session 5 — June 28, 2026

### Done
- **Overhauled UI layout & colors**: Overhauled EJS templates to implement horizontal top-navbar tabs and custom OpDesk color palette (`#0f1117` page background, `#161b22` panels, `#58a6ff` brand highlights).
- **Cleaned redundant navigation & UI elements**: Removed duplicate floating language dropdowns, sync-status blocks, and emojis (replacing with clean SVGs and CSS micro-animations).
- **Fixed active status monitoring**: Fixed state tracking bugs in AMI client which previously caused unregistered extensions to stay permanently green.
- **Real-Time Operators Dropdown**: Created a dropdown menu for every extension (Listen, Whisper, Barge, End Call) that is greyed-out and disabled unless the extension is actively in a call.
- **SIP softphone integration**: Switched links from `tel:` to `sip:` protocol to launch `st-sip`/MicroSIP client natively.
- **Hangup Channel API**: Created a `/api/hangup/:extension` backend route that locates the active bridge channel name from AMI and terminates it dynamically.
- **Dynamic AstDB ChanSpy dialplan**: Wrote and deployed custom extensions in `/etc/asterisk/extensions_custom.conf` that dynamically query AstDB `/DEVICE/<extension>/dial` to determine device technology (SIP vs PJSIP) and execute `Answer()` first to resolve audio path silence.

---

## 10. File Inventory

| File | Lines | Key Role |
|---|---|---|
| `server.js` | 576 | Backend: Express, AMI, Socket.io, 8 routes (added `/dashboard` + `/audio/:uniqueid`) |
| `views/sidebar.ejs` | 64 | Shared nav (EN/AR), clock widget, **5 nav links** (added Dashboard) |
| `views/cdr.ejs` | 148 | CDR table with 6 filters, **inline audio player** + download |
| `views/employees.ejs` | 114 | Employee perf table, inbound/outbound split |
| `views/ext-stats.ejs` | 293 | Per-extension analytics: KPI cards, ECharts pie/bar, filters, recent calls |
| `views/operator.ejs` | 223 | Live switchboard, WebSocket, Barge/Whisper/Listen tel: buttons |
| `views/dashboard.ejs` | 253 | **Landing page**: KPI cards, ECharts pie, employee table, recent calls feed, full EN/AR, sidebar |
| `package.json` | 20 | Dependencies (express, mysql2, socket.io, etc.) |
| `.gitignore` | 3 | node_modules, .env, *.log |
| `README.md` | ~170 | Installation, config, routes, auto-start guide |

---

*Upload this file to load full project context into a new AI session.*
