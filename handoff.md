# Sokrat VoIP Dashboard — Session Handoff

## Repositories & Locations

| Repo | Local Path | GitHub | Install Dir |
|---|---|---|---|
| **Dev** | `C:\Users\0xSiTe\Desktop\sokrat-voip-dev` | `Ahmed-Emad02/sokrat-voip-dev.git` | `/opt/issabel-dashboard` |
| **Stable** | `C:\Users\0xSiTe\Desktop\sokrat-voip-stable` | `Ahmed-Emad02/sokrat-voip-stable.git` | `/opt/sokrat-voip` |
| **Primary Server** | `192.168.100.200` | — | `/opt/issabel-dashboard` |

**Deployment policy:** `192.168.100.200` is the only active server. `100.91.135.84` is retired and MUST NOT be accessed, updated, or used for verification. Deploy from the dev repository and restart `issabel-dashboard.service`.

---

## What's Been Implemented

### 1. Time/Timezone Settings (sidebar settings dropdown)
- **Backend:** `GET/POST /api/settings/time` in `server.js`  
  Uses `timedatectl` to read/set timezone, NTP, and manual date/time
- **Frontend:** Time Settings button + modal in `views/sidebar.ejs`  
  Searchable timezone selector (419 zones), NTP toggle, manual date/time inputs
- **Languages:** Full EN/AR translations
- **Auth:** Super admin only (same as SMTP settings)

### 2. Install Script (`install.sh`)
- `INSTALL_DIR=/opt/issabel-dashboard`
- `REPO_URL` points to the dev repository
- Systemd service: `issabel-dashboard.service` (WorkingDirectory: `/opt/issabel-dashboard`)
- **Step 6:** Ensures dashboard, GSM, employee metadata tables, and `public/photos`
- **Step 12:** Sets timezone to `Africa/Cairo` via `timedatectl`

### 3. Config Diagram — Time Conditions
- `views/config.ejs` (~3950 lines)
- Time Condition nodes appear as yellow cards in column 1 of the diagram
- Wires: Inbound→TC (yellow), TC True→Dest (green), TC False→Dest (red)
- Backend API `/api/config/diagram` returns `timeconditions` with details

### 4. Deployment Runtime
- Apache reverse proxy unchanged (port 80/443 → 8080)
- Application directory: `/opt/issabel-dashboard`
- Systemd service: `issabel-dashboard.service`
- Sole deployment target: `192.168.100.200`

---

## How to Deploy Changes

```bash
ssh root@192.168.100.200 "cd /opt/issabel-dashboard \
  && git fetch origin \
  && git reset --hard origin/main \
  && systemctl restart issabel-dashboard \
  && systemctl is-active issabel-dashboard"
```

## How to Sync Dev → Stable
```powershell
Copy-Item "C:\Users\0xSiTe\Desktop\sokrat-voip-dev\server.js" "C:\Users\0xSiTe\Desktop\sokrat-voip-stable\server.js" -Force
# ... same for other files
# Then fix install.sh REPO_URL back to sokrat-voip-stable.git
```

---

## Key Users
- **admin / admin** (super admin — can access settings, time, SMTP)
- Apache proxy: `dashboard.conf` (port 80 → 8080)
- Database: `dashboard_settings` table stores SMTP config
