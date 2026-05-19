# Issabel Analytics Dashboard — Project Handoff

**Date:** May 19, 2026
**Location:** `/home/site/vm-issabel`
**GitHub:** https://github.com/Ahmed-Emad02/issabel-dashboard
**Stack:** Node.js 22 + Express 4, MySQL (Issabel/Asterisk CDR), Socket.io v4, Asterisk AMI, EJS, Tailwind CSS v4, ECharts 5

---

## 1. Architecture Overview

```
server.js          ← Express app, AMI TCP listener, Socket.io, 4 routes
├── views/
│   ├── sidebar.ejs       ← Shared nav (EN/AR, RTL-aware)
│   ├── cdr.ejs           ← Call Detail Records with filters
│   ├── employees.ejs     ← Per-employee inbound/outbound metrics
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
| `GET /operator` | `operator.ejs` | Live extension grid — idle/ringing/in-call states, call timers |
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

## 6. File Inventory

| File | Lines | Key Role |
|---|---|---|
| `server.js` | 244 | Backend: Express, AMI, Socket.io, routes |
| `views/sidebar.ejs` | 50 | Shared nav, EN/AR, clock widget |
| `views/cdr.ejs` | 147 | CDR table with 6 filters, audio download |
| `views/employees.ejs` | 114 | Employee perf table, inbound/outbound split |
| `views/operator.ejs` | 204 | Live real-time switchboard, WebSocket |
| `views/dashboard.ejs` | 207 | KPI cards, ECharts, employee table |
| `package.json` | 20 | Dependencies (express, mysql2, socket.io, etc.) |
| `.gitignore` | 3 | node_modules, .env, *.log |

---

*Upload this file to load full project context into a new AI session.*
