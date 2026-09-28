<div align="center">

# ⚡ Sokrat VoIP — Master REST & Telephony API Documentation
### Comprehensive Technical Reference for Asterisk 18 & Issabel 5 PBX Architecture
**Complete Endpoint Inventory • Authentication • Dialplan Operations • Real-Time Media**

[![API Version](https://img.shields.io/badge/API-v1.0.4-blue?style=for-the-badge)](package.json)
[![Asterisk](https://img.shields.io/badge/Asterisk-18.19.0-f38b00?style=for-the-badge&logo=asterisk)](https://www.asterisk.org/)
[![Issabel](https://img.shields.io/badge/Issabel-5.0.0-cb2026?style=for-the-badge)](https://www.issabel.org/)
[![Node.js Version](https://img.shields.io/badge/Node.js-v22.x-68a063?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![Endpoints](https://img.shields.io/badge/Endpoints-255%20Documented-success?style=for-the-badge)](#table-of-contents)

</div>

---

## 🏛️ System Architecture & Protocols

Sokrat VoIP operates as a unified telecommunications management platform running natively on Rocky Linux 8. The application integrates deep Asterisk 18 core services with high-throughput Express.js REST endpoints, real-time WebSocket event streaming, hardware USB GSM cellular modems, and enterprise database persistence.

```mermaid
graph TB
    subgraph Clients["Client Layer"]
        WebUI["Desktop Web Dashboard (EJS / WebRTC Softphone)"]
        CRM["Third-Party CRM (Zoho, Salesforce, HubSpot)"]
        Branch["Remote Branch PBX (Federation Node)"]
    end
    subgraph Sokrat["Sokrat VoIP Application Server (Port 8080)"]
        Express["Express HTTP / REST API (255 Endpoints)"]
        SocketIO["Socket.IO WebSocket Telemetry (AMI Streaming)"]
        AuthRBAC["RBAC & Session Engine (bcrypt / Permissions)"]
        DialerEngine["Progressive Campaign Outbound Dialer Engine"]
        STTEngine["AI Speech-to-Text Transcription Worker"]
    end
    subgraph PBX["Asterisk 18 Core Engine"]
        AMI["Asterisk Manager Interface (AMI :5038)"]
        Dialplan["Dialplan & AstDB (/etc/asterisk)"]
        ChanDongle["chan_dongle (Hardware USB GSM)"]
        SIP_PJSIP["SIP / PJSIP / IAX2 Protocols"]
    end
    subgraph Storage["Data & Media Layer"]
        MySQL[("MariaDB / MySQL (asterisk & asteriskcdrdb)")]
        SpoolAudio["/var/spool/asterisk/monitor (WAV / MP3)"]
    end
    WebUI -->|HTTP Session / Socket.IO| Express
    CRM -->|Bearer Token / Embed Ticket| Express
    Branch -->|Cluster Secret / IAX2| Express
    Express --> AuthRBAC
    Express --> DialerEngine
    Express --> STTEngine
    Express -->|AMI Actions / Async Tail| AMI
    Express -->|SQL Queries| MySQL
    Express -->|HTTP Range Audio| SpoolAudio
    DialerEngine -->|AMI Originate| AMI
    AMI --> Dialplan
    Dialplan --> ChanDongle
    Dialplan --> SIP_PJSIP
```

---

## 🌐 Network Ports & Service Bindings

| Port | Protocol | Service | Description |
| :--- | :--- | :--- | :--- |
| `8080` | TCP / HTTP | Sokrat VoIP Web Server | Express REST API, EJS Views, WebSocket Server |
| `5060` | UDP / TCP | Asterisk SIP / PJSIP | Telephony extension & SIP trunk signaling |
| `5038` | TCP | Asterisk Manager (AMI) | Low-level telephony event streaming & control |
| `4569` | UDP | Asterisk IAX2 | Inter-branch PBX federation & trunk mesh |
| `10000-20000` | UDP | RTP Media Audio | Voice stream transport channels |
| `3306` | TCP | MariaDB / MySQL | Relational databases (`asterisk`, `asteriskcdrdb`) |
| `80 / 443` | TCP / HTTP(S) | Issabel Web Admin | Underlying Issabel Apache PBX management |

---

## 🔐 Authentication & Access Control Models

Sokrat VoIP enforces five distinct security tiers depending on the endpoint category:

### 1. Browser Session Authentication (`connect.sid` Cookie)
- Authenticated via `POST /login`.
- Emits an HTTP-only, secure session cookie (`connect.sid`).
- Grants access according to the user's role and granular tab/action permissions stored in MySQL (`asterisk.dashboard_users`, `asterisk.dashboard_group_permissions`).

### 2. Role-Based Access Control (RBAC)
- **SuperAdmin**: Root administrator (`userId === 1` or group `SuperAdmin`). Has unrestricted access to all endpoints, system commands, raw configuration reload, and service control.
- **User Permissions (`userPermissions`)**: Restricts visibility of navigation tabs (`dashboard`, `cdr`, `operator`, `ext-stats`, `contacts`, `voicemails`, `gsm-dongles`, `dialer`, `storage`, `config`, `users`).
- **Action Permissions**: Protects specific high-impact actions (e.g. `crm_integration` required to manage integration tokens).
- **Extension Scope (`allowedExtensions`)**: Restricts non-superadmin accounts to viewing and managing only their assigned extension(s) in CDR, stats, and recordings.

### 3. CRM Integration Bearer Authentication
- Endpoints under `/api/integrations/crm/v1/*` require an HTTP `Authorization: Bearer <token>` header.
- Tokens are provisioned by pairing a 6-digit cryptographic PIN via `POST /api/integrations/crm/v1/pair`.
- Enforces OAuth-style scopes: `calls:read`, `recordings:read`, `extensions:read`, `embed:live`.

### 4. Single-Use Embed Tickets
- Endpoint `/embed/crm/live` renders the embedded softphone widget inside third-party iframes.
- Authenticated via single-use signed tokens (`?ticket=emb_...`) issued by `/api/integrations/crm/v1/embed-tickets` (15-minute validity window).

### 5. Multi-Site Federation Secret
- Inter-node clustering endpoints (`/api/federation/v1/*`) validate the header `X-Federation-Secret: <cluster_secret>` to allow secure inter-branch data synchronization.

---

## 📑 Table of Contents

The 255 API endpoints are organized into 30 functional modules:

- [**1. Authentication, Sessions & Preferences**](#auth-sessions) *(12 endpoints)*
  - [`GET` /login](#get-login)
  - [`POST` /login](#post-login)
  - [`GET` /logout](#get-logout)
  - [`GET` /no-access](#get-no-access)
  - [`POST` /api/auth/forgot-password](#post-apiauthforgot-password)
  - [`GET` /reset-password](#get-reset-password)
  - [`POST` /reset-password](#post-reset-password)
  - [`POST` /forgot-password](#post-forgot-password)
  - [`POST` /api/auth/reset-password](#post-apiauthreset-password)
  - [`GET` /api/user/default-filters](#get-apiuserdefault-filters)
  - [`POST` /api/user/default-filters](#post-apiuserdefault-filters)
  - [`POST` /api/user/theme-lang](#post-apiusertheme-lang)
- [**2. User Administration & Role-Based Access Control (RBAC)**](#users-rbac) *(9 endpoints)*
  - [`GET` /users](#get-users)
  - [`POST` /users/add](#post-usersadd)
  - [`POST` /users/edit](#post-usersedit)
  - [`POST` /users/delete](#post-usersdelete)
  - [`POST` /users/change-password](#post-userschange-password)
  - [`GET` /groups](#get-groups)
  - [`POST` /groups/add](#post-groupsadd)
  - [`POST` /groups/delete](#post-groupsdelete)
  - [`POST` /groups/permissions](#post-groupspermissions)
- [**3. Core Application Views & Web Navigation**](#core-views) *(17 endpoints)*
  - [`GET` /](#get-)
  - [`GET` /cdr](#get-cdr)
  - [`GET` /operator](#get-operator)
  - [`GET` /ext-stats](#get-ext-stats)
  - [`GET` /contacts](#get-contacts)
  - [`GET` /voicemails](#get-voicemails)
  - [`GET` /gsm-dongles](#get-gsm-dongles)
  - [`GET` /dialer](#get-dialer)
  - [`GET` /storage](#get-storage)
  - [`GET` /config](#get-config)
  - [`GET` /integrations/crm](#get-integrationscrm)
  - [`GET` /embed/crm/live](#get-embedcrmlive)
  - [`GET` /401](#get-401)
  - [`GET` /403](#get-403)
  - [`GET` /404](#get-404)
  - [`GET` /favicon.ico](#get-faviconico)
  - [`GET` /favicon.png](#get-faviconpng)
- [**4. Call Detail Records (CDR) & Analytics**](#cdr-reporting) *(2 endpoints)*
  - [`GET` /cdr/export](#get-cdrexport)
  - [`POST` /api/cdr/delete](#post-apicdrdelete)
- [**5. Call Audio Playback & Media Streaming**](#media-playback) *(1 endpoints)*
  - [`GET` /audio/:uniqueid](#get-audiouniqueid)
- [**6. Voicemail Management & Custom Greetings**](#voicemail-greetings) *(9 endpoints)*
  - [`GET` /api/voicemails](#get-apivoicemails)
  - [`GET` /vm-audio/:mailbox/:file](#get-vm-audiomailboxfile)
  - [`GET` /vm-export](#get-vm-export)
  - [`GET` /api/config/voicemail/extensions](#get-apiconfigvoicemailextensions)
  - [`POST` /api/config/voicemail/greeting](#post-apiconfigvoicemailgreeting)
  - [`POST` /api/config/voicemail/reset](#post-apiconfigvoicemailreset)
  - [`GET` /api/voicemail-storage/settings](#get-apivoicemail-storagesettings)
  - [`POST` /api/voicemail-storage/settings](#post-apivoicemail-storagesettings)
  - [`POST` /api/voicemail-storage/purge](#post-apivoicemail-storagepurge)
- [**7. Live Operator Switchboard & Real-Time Call Supervision**](#operator-call-control) *(5 endpoints)*
  - [`POST` /api/hangup/:extension](#post-apihangupextension)
  - [`POST` /api/transfer](#post-apitransfer)
  - [`POST` /api/spy](#post-apispy)
  - [`POST` /api/hijack](#post-apihijack)
  - [`POST` /api/intercom/call](#post-apiintercomcall)
- [**8. Extension Analytics & Routing Policies**](#ext-analytics) *(7 endpoints)*
  - [`GET` /api/ext-overview](#get-apiext-overview)
  - [`GET` /api/ext-stats/:extension](#get-apiext-statsextension)
  - [`GET` /api/ext-status-logs/:extension](#get-apiext-status-logsextension)
  - [`GET` /api/extension-policies](#get-apiextension-policies)
  - [`GET` /api/extension-policy/:extension](#get-apiextension-policyextension)
  - [`POST` /api/extension-policies/:extension](#post-apiextension-policiesextension)
  - [`POST` /api/extension-policies-bulk](#post-apiextension-policies-bulk)
- [**9. Employee Directory & Departmental Groups**](#employee-directory) *(8 endpoints)*
  - [`GET` /api/employee/groups](#get-apiemployeegroups)
  - [`POST` /api/employee/groups](#post-apiemployeegroups)
  - [`PUT` /api/employee/groups/:id](#put-apiemployeegroupsid)
  - [`DELETE` /api/employee/groups/:id](#delete-apiemployeegroupsid)
  - [`GET` /api/employee/extras/:extension](#get-apiemployeeextrasextension)
  - [`PUT` /api/employee/extras/:extension](#put-apiemployeeextrasextension)
  - [`PUT` /api/employee/group-assignment](#put-apiemployeegroup-assignment)
  - [`POST` /api/employee/photo](#post-apiemployeephoto)
- [**10. PBX Configuration: Extensions & AGC Audio Tuning**](#pbx-extensions) *(5 endpoints)*
  - [`GET` /api/config/extensions](#get-apiconfigextensions)
  - [`POST` /api/config/extensions](#post-apiconfigextensions)
  - [`PUT` /api/config/extensions/:extension](#put-apiconfigextensionsextension)
  - [`DELETE` /api/config/extensions/:extension](#delete-apiconfigextensionsextension)
  - [`GET` /api/config/extension-conflicts](#get-apiconfigextension-conflicts)
- [**11. PBX Configuration: Trunks & VoIP Gateways**](#pbx-trunks) *(4 endpoints)*
  - [`GET` /api/config/trunks](#get-apiconfigtrunks)
  - [`POST` /api/config/trunks](#post-apiconfigtrunks)
  - [`PUT` /api/config/trunks/:trunkid](#put-apiconfigtrunkstrunkid)
  - [`DELETE` /api/config/trunks/:trunkid](#delete-apiconfigtrunkstrunkid)
- [**12. PBX Configuration: Inbound & Outbound Call Routing**](#pbx-routing) *(9 endpoints)*
  - [`GET` /api/config/routes/inbound](#get-apiconfigroutesinbound)
  - [`POST` /api/config/routes/inbound](#post-apiconfigroutesinbound)
  - [`PUT` /api/config/routes/inbound](#put-apiconfigroutesinbound)
  - [`DELETE` /api/config/routes/inbound](#delete-apiconfigroutesinbound)
  - [`GET` /api/config/routes/outbound](#get-apiconfigroutesoutbound)
  - [`POST` /api/config/routes/outbound](#post-apiconfigroutesoutbound)
  - [`PUT` /api/config/routes/outbound/:route_id](#put-apiconfigroutesoutboundroute-id)
  - [`DELETE` /api/config/routes/outbound/:route_id](#delete-apiconfigroutesoutboundroute-id)
  - [`POST` /api/config/routes/outbound/reorder](#post-apiconfigroutesoutboundreorder)
- [**13. PBX Configuration: Queues & Call Distribution**](#pbx-queues) *(4 endpoints)*
  - [`GET` /api/config/queues](#get-apiconfigqueues)
  - [`POST` /api/config/queues](#post-apiconfigqueues)
  - [`PUT` /api/config/queues/:extension](#put-apiconfigqueuesextension)
  - [`DELETE` /api/config/queues/:extension](#delete-apiconfigqueuesextension)
- [**14. PBX Configuration: Ring Groups & Cascades**](#pbx-ringgroups) *(4 endpoints)*
  - [`GET` /api/config/ringgroups](#get-apiconfigringgroups)
  - [`POST` /api/config/ringgroups](#post-apiconfigringgroups)
  - [`PUT` /api/config/ringgroups/:grpnum](#put-apiconfigringgroupsgrpnum)
  - [`DELETE` /api/config/ringgroups/:grpnum](#delete-apiconfigringgroupsgrpnum)
- [**15. PBX Configuration: Interactive Voice Response (IVR)**](#pbx-ivrs) *(5 endpoints)*
  - [`GET` /api/config/ivrs](#get-apiconfigivrs)
  - [`GET` /api/config/ivrs/:id](#get-apiconfigivrsid)
  - [`POST` /api/config/ivrs](#post-apiconfigivrs)
  - [`PUT` /api/config/ivrs/:id](#put-apiconfigivrsid)
  - [`DELETE` /api/config/ivrs/:id](#delete-apiconfigivrsid)
- [**16. PBX Configuration: System Announcements**](#pbx-announcements) *(4 endpoints)*
  - [`GET` /api/config/announcements](#get-apiconfigannouncements)
  - [`POST` /api/config/announcements](#post-apiconfigannouncements)
  - [`PUT` /api/config/announcements/:id](#put-apiconfigannouncementsid)
  - [`DELETE` /api/config/announcements/:id](#delete-apiconfigannouncementsid)
- [**17. PBX Configuration: Time Groups & Time Conditions**](#pbx-time-conditions) *(8 endpoints)*
  - [`GET` /api/config/timeconditions](#get-apiconfigtimeconditions)
  - [`POST` /api/config/timeconditions](#post-apiconfigtimeconditions)
  - [`PUT` /api/config/timeconditions/:id](#put-apiconfigtimeconditionsid)
  - [`DELETE` /api/config/timeconditions/:id](#delete-apiconfigtimeconditionsid)
  - [`GET` /api/config/timegroups](#get-apiconfigtimegroups)
  - [`POST` /api/config/timegroups](#post-apiconfigtimegroups)
  - [`PUT` /api/config/timegroups/:id](#put-apiconfigtimegroupsid)
  - [`DELETE` /api/config/timegroups/:id](#delete-apiconfigtimegroupsid)
- [**18. PBX Configuration: System Recordings & DSP Processing**](#pbx-recordings) *(7 endpoints)*
  - [`GET` /api/config/recordings](#get-apiconfigrecordings)
  - [`GET` /api/config/recordings/:id/info](#get-apiconfigrecordingsidinfo)
  - [`GET` /api/config/recordings/audio/:id](#get-apiconfigrecordingsaudioid)
  - [`DELETE` /api/config/recordings/:id](#delete-apiconfigrecordingsid)
  - [`POST` /api/config/recordings/:id/volume](#post-apiconfigrecordingsidvolume)
  - [`POST` /api/config/recordings/:id/dsp](#post-apiconfigrecordingsiddsp)
  - [`POST` /api/settings/recordings/upload](#post-apisettingsrecordingsupload)
- [**19. PBX Configuration: Music on Hold (MOH) & Audio Globals**](#pbx-moh) *(8 endpoints)*
  - [`GET` /api/config/moh](#get-apiconfigmoh)
  - [`POST` /api/config/moh/category](#post-apiconfigmohcategory)
  - [`DELETE` /api/config/moh/category/:name](#delete-apiconfigmohcategoryname)
  - [`POST` /api/config/moh/upload](#post-apiconfigmohupload)
  - [`DELETE` /api/config/moh/file](#delete-apiconfigmohfile)
  - [`GET` /api/config/moh/stream/:category/:file](#get-apiconfigmohstreamcategoryfile)
  - [`GET` /api/config/audio-globals](#get-apiconfigaudio-globals)
  - [`PUT` /api/config/audio-globals](#put-apiconfigaudio-globals)
- [**20. PBX Configuration: Visual Dialplan & Core Reload**](#pbx-diagram-reload) *(2 endpoints)*
  - [`GET` /api/config/diagram](#get-apiconfigdiagram)
  - [`POST` /api/config/reload](#post-apiconfigreload)
- [**21. Hardware Modem DSP, JitterBuffer, Gain & RTCP**](#modem-dsp) *(13 endpoints)*
  - [`GET` /api/config/modem](#get-apiconfigmodem)
  - [`GET` /api/config/modem/reports](#get-apiconfigmodemreports)
  - [`GET` /api/config/modem/rtcp](#get-apiconfigmodemrtcp)
  - [`POST` /api/config/modem/gain](#post-apiconfigmodemgain)
  - [`POST` /api/config/modem/reset](#post-apiconfigmodemreset)
  - [`POST` /api/config/modem/dongle-slot](#post-apiconfigmodemdongle-slot)
  - [`DELETE` /api/config/modem/dongle-slot/:dongleName?](#delete-apiconfigmodemdongle-slotdonglename)
  - [`GET` /api/config/modem/jitterbuffer](#get-apiconfigmodemjitterbuffer)
  - [`POST` /api/config/modem/jitterbuffer](#post-apiconfigmodemjitterbuffer)
  - [`GET` /api/config/modem/denoise](#get-apiconfigmodemdenoise)
  - [`POST` /api/config/modem/denoise](#post-apiconfigmodemdenoise)
  - [`GET` /api/config/dongle-mappings](#get-apiconfigdongle-mappings)
  - [`POST` /api/config/dongle-mappings/:dongleName/toggle](#post-apiconfigdongle-mappingsdonglenametoggle)
- [**22. Hardware GSM Dongles, Cellular Gateways, USSD & SMS**](#gsm-dongles) *(20 endpoints)*
  - [`GET` /api/gsm-dongles](#get-apigsm-dongles)
  - [`POST` /api/gsm-dongles/save-number](#post-apigsm-donglessave-number)
  - [`POST` /api/gsm-dongles/reset-usb-port](#post-apigsm-donglesreset-usb-port)
  - [`POST` /api/gsm-dongles/reload/:dongleId](#post-apigsm-donglesreloaddongleid)
  - [`POST` /api/gsm-dongles/reboot-modem/:dongleId](#post-apigsm-donglesreboot-modemdongleid)
  - [`POST` /api/gsm-dongles/virtual-replug/:dongleId](#post-apigsm-donglesvirtual-replugdongleid)
  - [`POST` /api/gsm-dongles/at-diagnostic/:dongleId](#post-apigsm-donglesat-diagnosticdongleid)
  - [`POST` /api/gsm-dongles/populate-hardware/:dongleId](#post-apigsm-donglespopulate-hardwaredongleid)
  - [`POST` /api/gsm-dongles/update-ports/:dongleId](#post-apigsm-donglesupdate-portsdongleid)
  - [`GET` /api/gsm-dongles/audit](#get-apigsm-donglesaudit)
  - [`POST` /api/gsm-dongles/reconcile-conf](#post-apigsm-donglesreconcile-conf)
  - [`POST` /api/gsm-dongles/redetect](#post-apigsm-donglesredetect)
  - [`POST` /api/gsm-dongles/emit-usb-update](#post-apigsm-donglesemit-usb-update)
  - [`GET` /api/gsm-dongles/ttyusb-devices](#get-apigsm-donglesttyusb-devices)
  - [`POST` /api/gsm-dongles/ussd](#post-apigsm-donglesussd)
  - [`POST` /api/gsm-dongles/call-forwarding](#post-apigsm-donglescall-forwarding)
  - [`GET` /api/gsm-dongles/sms](#get-apigsm-donglessms)
  - [`POST` /api/gsm-dongles/send-sms](#post-apigsm-donglessend-sms)
  - [`POST` /api/gsm-dongles/clear-sms](#post-apigsm-donglesclear-sms)
  - [`POST` /api/gsm-dongles/delete-thread](#post-apigsm-donglesdelete-thread)
- [**23. Progressive Outbound Campaign Dialer & Leads**](#progressive-dialer) *(19 endpoints)*
  - [`GET` /api/dialer/campaigns](#get-apidialercampaigns)
  - [`GET` /api/dialer/campaigns/:id](#get-apidialercampaignsid)
  - [`POST` /api/dialer/campaigns](#post-apidialercampaigns)
  - [`PUT` /api/dialer/campaigns/:id](#put-apidialercampaignsid)
  - [`POST` /api/dialer/campaigns/:id/control](#post-apidialercampaignsidcontrol)
  - [`GET` /api/dialer/attempts/recent](#get-apidialerattemptsrecent)
  - [`GET` /api/dialer/dongles](#get-apidialerdongles)
  - [`GET` /api/dialer/leads/template](#get-apidialerleadstemplate)
  - [`GET` /api/dialer/leads/:campaignId](#get-apidialerleadscampaignid)
  - [`POST` /api/dialer/leads](#post-apidialerleads)
  - [`POST` /api/dialer/leads/import](#post-apidialerleadsimport)
  - [`DELETE` /api/dialer/leads/:id](#delete-apidialerleadsid)
  - [`POST` /api/dialer/leads/:id/reset](#post-apidialerleadsidreset)
  - [`GET` /api/dialer/campaigns/:id/export](#get-apidialercampaignsidexport)
  - [`POST` /api/dialer/disposition](#post-apidialerdisposition)
  - [`GET` /api/dialer/dispositions](#get-apidialerdispositions)
  - [`GET` /api/dialer/dnc](#get-apidialerdnc)
  - [`POST` /api/dialer/dnc](#post-apidialerdnc)
  - [`DELETE` /api/dialer/dnc/:phone](#delete-apidialerdncphone)
- [**24. CRM Integration REST API v1 & WebSocket Stream**](#crm-integration) *(12 endpoints)*
  - [`GET` /api/integrations/crm/v1/health](#get-apiintegrationscrmv1health)
  - [`POST` /api/integrations/crm/v1/pair](#post-apiintegrationscrmv1pair)
  - [`GET` /api/integrations/crm/v1/capabilities](#get-apiintegrationscrmv1capabilities)
  - [`GET` /api/integrations/crm/v1/extensions](#get-apiintegrationscrmv1extensions)
  - [`GET` /api/integrations/crm/v1/calls](#get-apiintegrationscrmv1calls)
  - [`GET` /api/integrations/crm/v1/recordings/:mediaId](#get-apiintegrationscrmv1recordingsmediaid)
  - [`GET` /api/integrations/crm/v1/extensions/:extension/stats](#get-apiintegrationscrmv1extensionsextensionstats)
  - [`POST` /api/integrations/crm/v1/embed-tickets](#post-apiintegrationscrmv1embed-tickets)
  - [`POST` /integrations/crm/pairing-code](#post-integrationscrmpairing-code)
  - [`POST` /integrations/crm/clients/:id/revoke](#post-integrationscrmclientsidrevoke)
  - [`POST` /integrations/crm/clients/:id/rotate](#post-integrationscrmclientsidrotate)
  - [`POST` /integrations/crm/clients/:id/update](#post-integrationscrmclientsidupdate)
- [**25. Speech-to-Text (STT) AI Transcription Engine**](#stt-transcription) *(8 endpoints)*
  - [`GET` /api/transcripts/call/:uniqueid](#get-apitranscriptscalluniqueid)
  - [`POST` /api/transcripts/call/:uniqueid/transcribe](#post-apitranscriptscalluniqueidtranscribe)
  - [`GET` /api/transcripts/voicemail/:mailbox/:file](#get-apitranscriptsvoicemailmailboxfile)
  - [`POST` /api/transcripts/voicemail/:mailbox/:file/transcribe](#post-apitranscriptsvoicemailmailboxfiletranscribe)
  - [`GET` /api/config/stt](#get-apiconfigstt)
  - [`PUT` /api/config/stt](#put-apiconfigstt)
  - [`POST` /api/config/stt/test-connection](#post-apiconfigstttest-connection)
  - [`POST` /api/transcripts/scan](#post-apitranscriptsscan)
- [**26. Multi-Site PBX Federation & Centralized Routing**](#federation) *(14 endpoints)*
  - [`GET` /api/config/federation/settings](#get-apiconfigfederationsettings)
  - [`PUT` /api/config/federation/settings](#put-apiconfigfederationsettings)
  - [`GET` /api/config/federation/peers](#get-apiconfigfederationpeers)
  - [`POST` /api/config/federation/peers](#post-apiconfigfederationpeers)
  - [`PUT` /api/config/federation/peers/:id](#put-apiconfigfederationpeersid)
  - [`DELETE` /api/config/federation/peers/:id](#delete-apiconfigfederationpeersid)
  - [`POST` /api/config/federation/peers/:id/sync](#post-apiconfigfederationpeersidsync)
  - [`POST` /api/config/federation/peers/:id/qualify](#post-apiconfigfederationpeersidqualify)
  - [`POST` /api/config/federation/bootstrap](#post-apiconfigfederationbootstrap)
  - [`POST` /api/config/federation/remote-cleanup](#post-apiconfigfederationremote-cleanup)
  - [`GET` /api/federation/v1/extensions](#get-apifederationv1extensions)
  - [`GET` /api/federation/v1/dongles](#get-apifederationv1dongles)
  - [`GET` /api/federation/v1/health](#get-apifederationv1health)
  - [`GET` /api/federation/v1/live-state](#get-apifederationv1live-state)
- [**27. Blacklist & Number Blocking Management**](#blacklist) *(6 endpoints)*
  - [`GET` /api/blacklist](#get-apiblacklist)
  - [`POST` /api/blacklist](#post-apiblacklist)
  - [`PUT` /api/blacklist/:id](#put-apiblacklistid)
  - [`DELETE` /api/blacklist/:id](#delete-apiblacklistid)
  - [`POST` /api/blacklist/sync](#post-apiblacklistsync)
  - [`POST` /api/blacklist/import](#post-apiblacklistimport)
- [**28. Corporate Contacts & Phonebook Directory**](#contacts) *(5 endpoints)*
  - [`GET` /api/contacts](#get-apicontacts)
  - [`POST` /api/contacts/add](#post-apicontactsadd)
  - [`POST` /api/contacts/edit](#post-apicontactsedit)
  - [`POST` /api/contacts/delete](#post-apicontactsdelete)
  - [`POST` /api/contacts/csv-import](#post-apicontactscsv-import)
- [**29. Storage Management, Retention Auto-Purge & Cloud Backup**](#storage-backup) *(6 endpoints)*
  - [`GET` /api/storage/info](#get-apistorageinfo)
  - [`GET` /api/storage/export/pc](#get-apistorageexportpc)
  - [`POST` /api/storage/gdrive/setup](#post-apistoragegdrivesetup)
  - [`POST` /api/storage/gdrive/sync](#post-apistoragegdrivesync)
  - [`POST` /api/storage/purge-settings](#post-apistoragepurge-settings)
  - [`POST` /api/storage/purge](#post-apistoragepurge)
- [**30. System Telemetry, Services, Watchdog Alerts & Server Operations**](#system-alerts) *(22 endpoints)*
  - [`GET` /api/system/resources](#get-apisystemresources)
  - [`GET` /api/system/resources/history](#get-apisystemresourceshistory)
  - [`GET` /api/system/services](#get-apisystemservices)
  - [`POST` /api/system/service-action](#post-apisystemservice-action)
  - [`POST` /api/system/drop-caches](#post-apisystemdrop-caches)
  - [`POST` /api/system/asterisk-reload](#post-apisystemasterisk-reload)
  - [`GET` /api/settings/smtp](#get-apisettingssmtp)
  - [`POST` /api/settings/smtp](#post-apisettingssmtp)
  - [`GET` /api/settings/alerts](#get-apisettingsalerts)
  - [`POST` /api/settings/alerts](#post-apisettingsalerts)
  - [`POST` /api/settings/alerts/test-telegram](#post-apisettingsalertstest-telegram)
  - [`POST` /api/settings/alerts/test-email](#post-apisettingsalertstest-email)
  - [`POST` /api/settings/alerts/test-heartbeat](#post-apisettingsalertstest-heartbeat)
  - [`GET` /api/settings/alerts/watchdog-status](#get-apisettingsalertswatchdog-status)
  - [`GET` /api/settings/client](#get-apisettingsclient)
  - [`POST` /api/settings/client](#post-apisettingsclient)
  - [`PUT` /api/settings/client](#put-apisettingsclient)
  - [`GET` /api/settings/time](#get-apisettingstime)
  - [`POST` /api/settings/time](#post-apisettingstime)
  - [`POST` /api/system/update](#post-apisystemupdate)
  - [`GET` /api/network-info](#get-apinetwork-info)
  - [`POST` /log_error](#post-log-error)

---

<a id="auth-sessions"></a>
## 1. Authentication, Sessions & Preferences

*Endpoints managing user authentication, login/logout, session tracking, password reset flows, theme, language, and custom dashboard filter preferences.*

<a id="get-login"></a>
### `GET` /login

**Description**: Renders the interactive HTML login page. Auto-detects preferred language and theme from cookies, query parameters, or previous session. If the user is already authenticated, redirects them immediately to their default landing page or previously requested URL.

- **Authentication**: Public
- **Headers**: None required
- **System Impact**: Establishes or refreshes session language and theme state in memory and cookies.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `lang` | `query` | `string` | No | Interface language ('en' or 'ar') |
| `theme` | `query` | `string` | No | Interface color theme ('dark' or 'light') |
| `redirect` | `query` | `string` | No | Destination path to redirect after successful login (e.g. '/cdr') |
| `username` | `query` | `string` | No | Pre-filled username in form field |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/login?lang=ar&theme=dark'
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8

<!DOCTYPE html><html>...</html>
```

---

<a id="post-login"></a>
### `POST` /login

**Description**: Authenticates user credentials against the database or hardcoded root administrator credentials. On success, creates a secure session, persists chosen language and theme into `asterisk.dashboard_user_preferences`, and issues a 302 redirect to the destination URL.

- **Authentication**: Public
- **Headers**: Content-Type: application/x-www-form-urlencoded or application/json
- **System Impact**: Updates `asterisk.dashboard_user_preferences`, initializes `req.session` with `userId`, `username`, `userGroup`, `allowedExtensions`, `userPermissions`, `lang`, and `theme`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `username` | `body` | `string` | **Yes** | Account username (e.g. 'admin' or 'root') |
| `password` | `body` | `string` | **Yes** | Account password |
| `lang` | `body` | `string` | No | Language selection ('en' or 'ar'). Default: 'en' |
| `theme` | `body` | `string` | No | Theme selection ('dark' or 'light'). Default: 'dark' |
| `redirect` | `body` | `string` | No | Destination path after login |

#### Example Request

```bash
curl -X POST http://localhost:8080/login \
  -d 'username=root&password=YourPassword&lang=ar&theme=dark&redirect=/' \
  -c cookie.txt -i
```

#### Example Response

```http
HTTP/1.1 302 Found
Location: /?lang=ar
Set-Cookie: connect.sid=s%3A...; Path=/; HttpOnly; SameSite=Lax
```

---

<a id="get-logout"></a>
### `GET` /logout

**Description**: Destroys the current user session and clears all authentication context, redirecting to the login screen.

- **Authentication**: Session Cookie (`connect.sid`)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Destroys server-side session memory and invalidates session token.

#### Example Request

```bash
curl -X GET http://localhost:8080/logout -b cookie.txt -i
```

#### Example Response

```http
HTTP/1.1 302 Found
Location: /login
```

---

<a id="get-no-access"></a>
### `GET` /no-access

**Description**: Displays the 403 Forbidden Access Denied page when an authenticated user has zero assigned tab permissions.

- **Authentication**: Session Cookie (`connect.sid`)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: None (read-only view render).

#### Example Request

```bash
curl -X GET http://localhost:8080/no-access -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 403 Forbidden
Content-Type: text/html

<html>...Access Denied...</html>
```

---

<a id="post-apiauthforgot-password"></a>
### `POST` /api/auth/forgot-password

**Description**: Initiates a password reset workflow for the specified username and email. If matched, generates a secure cryptographically random reset token and dispatches an email via configured SMTP.

- **Authentication**: Public
- **Headers**: Content-Type: application/json
- **System Impact**: Generates `reset_token` and `reset_expires` in `asterisk.dashboard_users` and sends reset link email via Nodemailer.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `username` | `body` | `string` | **Yes** | Account username |
| `email` | `body` | `string` | **Yes** | Registered email address for account |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"username": "agent1", "email": "agent1@example.com"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Password reset instructions have been sent to your email."
}
```

---

<a id="get-reset-password"></a>
### `GET` /reset-password

**Description**: Renders the password reset form validating the single-use token provided in the URL query string.

- **Authentication**: Public
- **Headers**: None required
- **System Impact**: Validates token existence and expiry in `asterisk.dashboard_users`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `token` | `query` | `string` | **Yes** | Cryptographic reset token received in email |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/reset-password?token=a1b2c3d4e5f6...'
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html

<html>...Reset Password...</html>
```

---

<a id="post-reset-password"></a>
### `POST` /reset-password

**Description**: Handles web form submission for completing password reset via token.

- **Authentication**: Public
- **Headers**: Content-Type: application/x-www-form-urlencoded
- **System Impact**: Updates `password_hash` in `asterisk.dashboard_users` and clears reset token.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `token` | `body` | `string` | **Yes** | Password reset token |
| `password` | `body` | `string` | **Yes** | New plaintext password to hash and set |

#### Example Request

```bash
curl -X POST http://localhost:8080/reset-password \
  -d 'token=a1b2c3d4...&password=NewSecurePassword123' -i
```

#### Example Response

```http
HTTP/1.1 302 Found
Location: /login?reset=success
```

---

<a id="post-forgot-password"></a>
### `POST` /forgot-password

**Description**: Form POST endpoint fallback for requesting password reset via standard HTML form.

- **Authentication**: Public
- **Headers**: Content-Type: application/x-www-form-urlencoded
- **System Impact**: Updates `asterisk.dashboard_users` with reset token and sends email.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `username` | `body` | `string` | **Yes** | Account username |
| `email` | `body` | `string` | **Yes** | Account email |

#### Example Request

```bash
curl -X POST http://localhost:8080/forgot-password \
  -d 'username=agent1&email=agent1@example.com'
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="post-apiauthreset-password"></a>
### `POST` /api/auth/reset-password

**Description**: REST API endpoint to verify token and update account password with bcrypt hashing.

- **Authentication**: Public
- **Headers**: Content-Type: application/json
- **System Impact**: Saves bcrypt hash in `asterisk.dashboard_users` and invalidates token.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `token` | `body` | `string` | **Yes** | Valid password reset token |
| `password` | `body` | `string` | **Yes** | New password (minimum 6 characters) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"token": "abc123token", "password": "StrongPass@2026"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Password has been reset successfully. You can now log in."
}
```

---

<a id="get-apiuserdefault-filters"></a>
### `GET` /api/user/default-filters

**Description**: Retrieves the authenticated user's saved default filter preferences for Dashboard KPIs and CDR history view.

- **Authentication**: Session Cookie (`connect.sid`)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dashboard_user_preferences` for JSON filter settings.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/user/default-filters -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "filters": {
    "dashboard": {
      "datePreset": "today",
      "targetExtension": ["ALL"],
      "statusFilter": ["ALL"],
      "directionFilter": "ALL",
      "callScopeFilter": "ALL"
    },
    "cdr": {
      "datePreset": "today",
      "targetExtension": ["ALL"],
      "statusFilter": ["ALL"],
      "directionFilter": "ALL",
      "callScopeFilter": "ALL",
      "perPage": 25
    }
  }
}
```

---

<a id="post-apiuserdefault-filters"></a>
### `POST` /api/user/default-filters

**Description**: Saves customized default filter criteria (presets, extensions, statuses, call scopes) for the current user into database storage.

- **Authentication**: Session Cookie (`connect.sid`)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Executes `INSERT ... ON DUPLICATE KEY UPDATE` in `asterisk.dashboard_user_preferences` and syncs `req.session.userPreferences`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dashboard` | `body` | `object` | No | Dashboard filter object (datePreset, targetExtension, statusFilter, directionFilter, callScopeFilter) |
| `cdr` | `body` | `object` | No | CDR filter object (datePreset, targetExtension, statusFilter, directionFilter, callScopeFilter, perPage) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/user/default-filters \
  -b cookie.txt -H 'Content-Type: application/json' \
  -d '{"dashboard":{"datePreset":"last_7_days","targetExtension":["101","102"],"statusFilter":["ALL"],"directionFilter":"ALL","callScopeFilter":"ALL"}}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Default filter preferences saved successfully.",
  "filters": { ... }
}
```

---

<a id="post-apiusertheme-lang"></a>
### `POST` /api/user/theme-lang

**Description**: Dynamically updates the user's active UI color theme ('dark'/'light') and/or language ('en'/'ar'). Persists both into server-side session, client cookies, and database user preferences.

- **Authentication**: Session Cookie (`connect.sid`)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `req.session.theme`, `req.session.lang`, sets persistent cookies, and writes `{ theme, lang }` to `asterisk.dashboard_user_preferences`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `theme` | `body` | `string` | No | Color theme ('light' or 'dark') |
| `lang` | `body` | `string` | No | Language code ('en' or 'ar') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/user/theme-lang \
  -b cookie.txt -H 'Content-Type: application/json' \
  -d '{"theme":"light","lang":"ar"}'
```

#### Example Response

```json
{
  "success": true,
  "theme": "light",
  "lang": "ar"
}
```

---

<a id="users-rbac"></a>
## 2. User Administration & Role-Based Access Control (RBAC)

*Endpoints managing dashboard accounts, user-to-extension scoping, security roles, and granular tab/action permissions.*

<a id="get-users"></a>
### `GET` /users

**Description**: Renders the User Management administration page listing registered accounts, their assigned roles, and permitted extension scopes.

- **Authentication**: Session Cookie (`users` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dashboard_users`, `dashboard_groups`, and `dashboard_user_extensions`.

#### Example Request

```bash
curl -X GET http://localhost:8080/users -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="post-usersadd"></a>
### `POST` /users/add

**Description**: Creates a new dashboard user account with bcrypt password hashing, group role association, and optional multi-extension visibility scoping.

- **Authentication**: Session Cookie (`users` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/x-www-form-urlencoded or application/json
- **System Impact**: Inserts record into `asterisk.dashboard_users` and entries into `asterisk.dashboard_user_extensions`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `username` | `body` | `string` | **Yes** | Unique account username |
| `email` | `body` | `string` | No | User email address |
| `password` | `body` | `string` | **Yes** | Initial account password |
| `group_id` | `body` | `integer` | **Yes** | ID of assigned security group from `dashboard_groups` |
| `extension` | `body` | `string` | No | Primary extension (e.g. '101') |
| `allowed_extensions` | `body` | `array|string` | No | List or comma-separated string of extensions this user can monitor |

#### Example Request

```bash
curl -X POST http://localhost:8080/users/add -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"username":"john","email":"john@corp.com","password":"Pass@1234","group_id":2,"allowed_extensions":["101","102"]}'
```

#### Example Response

```json
{
  "success": true,
  "message": "User john created successfully."
}
```

---

<a id="post-usersedit"></a>
### `POST` /users/edit

**Description**: Updates an existing dashboard user's profile, email, group assignment, primary extension, and allowed extension scopes.

- **Authentication**: Session Cookie (`users` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.dashboard_users` and synchronizes entries in `asterisk.dashboard_user_extensions`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `body` | `integer` | **Yes** | ID of user to update |
| `email` | `body` | `string` | No | Updated email address |
| `group_id` | `body` | `integer` | **Yes** | Assigned security group ID |
| `extension` | `body` | `string` | No | Primary extension |
| `allowed_extensions` | `body` | `array|string` | No | Updated list of permitted extensions |

#### Example Request

```bash
curl -X POST http://localhost:8080/users/edit -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"id":5,"email":"john.doe@corp.com","group_id":2,"allowed_extensions":["101","102","103"]}'
```

#### Example Response

```json
{
  "success": true,
  "message": "User updated successfully."
}
```

---

<a id="post-usersdelete"></a>
### `POST` /users/delete

**Description**: Permanently deletes a dashboard user account and cleans up their extension scoping associations.

- **Authentication**: Session Cookie (`users` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Deletes row from `asterisk.dashboard_users`, `dashboard_user_extensions`, and `dashboard_user_preferences`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `body` | `integer` | **Yes** | ID of user account to remove |

#### Example Request

```bash
curl -X POST http://localhost:8080/users/delete -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"id":5}'
```

#### Example Response

```json
{
  "success": true,
  "message": "User deleted successfully."
}
```

---

<a id="post-userschange-password"></a>
### `POST` /users/change-password

**Description**: Enables an administrator to reset or override any user's password, or allows a logged-in user to update their own credentials.

- **Authentication**: Session Cookie (`users` permission or self-service)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Generates new bcrypt hash and updates `password_hash` in `asterisk.dashboard_users`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `user_id` | `body` | `integer` | **Yes** | ID of account to update |
| `new_password` | `body` | `string` | **Yes** | New plaintext password (min 6 chars) |

#### Example Request

```bash
curl -X POST http://localhost:8080/users/change-password -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"user_id":5,"new_password":"NewSecret@2026"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Password changed successfully."
}
```

---

<a id="get-groups"></a>
### `GET` /groups

**Description**: Renders the Security Groups and Permissions management console.

- **Authentication**: Session Cookie (`users` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dashboard_groups` and `asterisk.dashboard_group_permissions`.

#### Example Request

```bash
curl -X GET http://localhost:8080/groups -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="post-groupsadd"></a>
### `POST` /groups/add

**Description**: Creates a new RBAC security role/group.

- **Authentication**: Session Cookie (`users` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.dashboard_groups`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `body` | `string` | **Yes** | Group name (e.g. 'Shift Supervisors') |
| `description` | `body` | `string` | No | Role description |

#### Example Request

```bash
curl -X POST http://localhost:8080/groups/add -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"Team Leads","description":"Supervisors for Floor 1"}'
```

#### Example Response

```json
{
  "success": true,
  "groupId": 3,
  "message": "Group created successfully."
}
```

---

<a id="post-groupsdelete"></a>
### `POST` /groups/delete

**Description**: Deletes a security group and associated permission grants (super admin group is protected from deletion).

- **Authentication**: Session Cookie (`users` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Deletes from `asterisk.dashboard_groups` and `asterisk.dashboard_group_permissions`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `body` | `integer` | **Yes** | ID of group to delete |

#### Example Request

```bash
curl -X POST http://localhost:8080/groups/delete -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"id":3}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Group deleted successfully."
}
```

---

<a id="post-groupspermissions"></a>
### `POST` /groups/permissions

**Description**: Updates granular tab visibility and action permissions for a specific security group.

- **Authentication**: Session Cookie (`users` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Replaces permission rows in `asterisk.dashboard_group_permissions`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `group_id` | `body` | `integer` | **Yes** | Target security group ID |
| `permissions` | `body` | `array` | **Yes** | Array of permission keys (e.g. ['dashboard', 'cdr', 'operator', 'config-extensions']) |

#### Example Request

```bash
curl -X POST http://localhost:8080/groups/permissions -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"group_id":2,"permissions":["dashboard","cdr","operator","ext-stats"]}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Permissions updated successfully."
}
```

---

<a id="core-views"></a>
## 3. Core Application Views & Web Navigation

*Primary HTML view rendering routes that deliver responsive dashboard interfaces, softphone panels, and error screens.*

<a id="get-"></a>
### `GET` /

**Description**: Renders the primary executive Analytics Dashboard with real-time call KPIs, hourly trends, inbound vs outbound distribution, airtime gauges, and live agent roster.

- **Authentication**: Session Cookie (`dashboard` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asteriskcdrdb.cdr` aggregated metrics.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `startDate` | `query` | `string` | No | Filter start datetime (YYYY-MM-DD HH:mm:ss) |
| `endDate` | `query` | `string` | No | Filter end datetime (YYYY-MM-DD HH:mm:ss) |
| `targetExtension` | `query` | `string|array` | No | Filter by extension(s) |
| `lang` | `query` | `string` | No | Override language ('en' or 'ar') |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/?lang=en' -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
```

---

<a id="get-cdr"></a>
### `GET` /cdr

**Description**: Renders the Call Detail Records (CDR) search and audit console with advanced multi-criteria filters, audio wave players, and pagination.

- **Authentication**: Session Cookie (`call_history` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads `asteriskcdrdb.cdr` with index optimization.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `page` | `query` | `integer` | No | Page number (default: 1) |
| `limit` | `query` | `integer` | No | Records per page (default: 25) |
| `startDate` | `query` | `string` | No | Start datetime filter |
| `endDate` | `query` | `string` | No | End datetime filter |
| `searchSrc` | `query` | `string` | No | Source caller number/extension |
| `searchDst` | `query` | `string` | No | Destination callee number/extension |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/cdr?page=1&limit=50' -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-operator"></a>
### `GET` /operator

**Description**: Renders the real-time Operator Switchboard / Agent Console with live drag-and-drop transfers, call supervision, peer IP badges, and WebRTC dialer.

- **Authentication**: Session Cookie (`operator` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Connects to WebSocket and reads Asterisk AMI live channels.

#### Example Request

```bash
curl -X GET http://localhost:8080/operator -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-ext-stats"></a>
### `GET` /ext-stats

**Description**: Renders the Extension Performance Analytics tab showcasing call volume distribution, talk times, answered ratios, and timeline charts.

- **Authentication**: Session Cookie (`ext-stats` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Aggregates CDR records per extension.

#### Example Request

```bash
curl -X GET http://localhost:8080/ext-stats -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-contacts"></a>
### `GET` /contacts

**Description**: Renders the Corporate Contact Directory and Phonebook management view.

- **Authentication**: Session Cookie (`contacts` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads `asterisk.contacts`.

#### Example Request

```bash
curl -X GET http://localhost:8080/contacts -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-voicemails"></a>
### `GET` /voicemails

**Description**: Renders the Centralized Voicemail Management interface with audio streaming, custom greeting tools, and retention controls.

- **Authentication**: Session Cookie (`voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads `/var/spool/asterisk/voicemail/` and `asterisk.voicemail_messages`.

#### Example Request

```bash
curl -X GET http://localhost:8080/voicemails -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-gsm-dongles"></a>
### `GET` /gsm-dongles

**Description**: Renders the Hardware GSM Dongle Command Center with real-time signal strength (RSSI), USSD dialers, SMS thread messenger, and port mapping.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Polls `asterisk -rx 'dongle show devices'` and USB bus.

#### Example Request

```bash
curl -X GET http://localhost:8080/gsm-dongles -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-dialer"></a>
### `GET` /dialer

**Description**: Renders the Progressive Outbound Campaign Dialer dashboard with live pacing, campaign controls, lead imports, and disposition stats.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads `asterisk.dialer_campaigns` and active lead queues.

#### Example Request

```bash
curl -X GET http://localhost:8080/dialer -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-storage"></a>
### `GET` /storage

**Description**: Renders the Storage & Retention Management screen detailing disk utilization, call recording purge rules, and cloud backup setup.

- **Authentication**: Session Cookie (`storage` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Scans `/var/spool/asterisk/monitor/` and disk filesystem.

#### Example Request

```bash
curl -X GET http://localhost:8080/storage -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-config"></a>
### `GET` /config

**Description**: Renders the Comprehensive PBX Administration Suite (Extensions, Trunks, Inbound/Outbound Routes, Queues, Ring Groups, IVR, Announcements, Time Conditions, MOH, Modem DSP, Recordings, Federation).

- **Authentication**: Session Cookie (`config` permission or sub-tab permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries Asterisk configuration schema across PBX tables.

#### Example Request

```bash
curl -X GET http://localhost:8080/config -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-integrationscrm"></a>
### `GET` /integrations/crm

**Description**: Renders the CRM Integration Administration Console where pairing codes are generated, API client tokens are rotated or revoked, and embed widgets are managed.

- **Authentication**: Session Cookie (`crm_integration` action permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads `asterisk.crm_integration_clients` and `crm_pairing_codes`.

#### Example Request

```bash
curl -X GET http://localhost:8080/integrations/crm -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html
```

---

<a id="get-embedcrmlive"></a>
### `GET` /embed/crm/live

**Description**: Renders the standalone embeddable CRM Live Softphone & Call Control Widget designed for iframe integration inside third-party CRM platforms (Salesforce, HubSpot, Zoho, Bitrix24). Authenticated via single-use embed ticket.

- **Authentication**: Single-use Embed Ticket (`ticket` query param)
- **Headers**: None required
- **System Impact**: Validates ticket in `asterisk.crm_embed_tickets` and opens CRM live socket session.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `ticket` | `query` | `string` | **Yes** | Cryptographic embed ticket issued by `/api/integrations/crm/v1/embed-tickets` |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/embed/crm/live?ticket=emb_abc123...'
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
```

---

<a id="get-401"></a>
### `GET` /401

**Description**: Renders the 401 Unauthorized error page.

- **Authentication**: Public
- **Headers**: None required
- **System Impact**: None.

#### Example Request

```bash
curl -X GET http://localhost:8080/401
```

#### Example Response

```http
HTTP/1.1 401 Unauthorized
Content-Type: text/html
```

---

<a id="get-403"></a>
### `GET` /403

**Description**: Renders the 403 Forbidden permission denied error page.

- **Authentication**: Public
- **Headers**: None required
- **System Impact**: None.

#### Example Request

```bash
curl -X GET http://localhost:8080/403
```

#### Example Response

```http
HTTP/1.1 403 Forbidden
Content-Type: text/html
```

---

<a id="get-404"></a>
### `GET` /404

**Description**: Renders the 404 Not Found error page for undefined routes.

- **Authentication**: Public
- **Headers**: None required
- **System Impact**: None.

#### Example Request

```bash
curl -X GET http://localhost:8080/404
```

#### Example Response

```http
HTTP/1.1 404 Not Found
Content-Type: text/html
```

---

<a id="get-faviconico"></a>
### `GET` /favicon.ico

**Description**: Serves the browser favicon asset.

- **Authentication**: Public
- **Headers**: None required
- **System Impact**: Streams static image file.

#### Example Request

```bash
curl -X GET http://localhost:8080/favicon.ico
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: image/x-icon
```

---

<a id="get-faviconpng"></a>
### `GET` /favicon.png

**Description**: Serves the high-resolution PNG brand icon asset.

- **Authentication**: Public
- **Headers**: None required
- **System Impact**: Streams static image file.

#### Example Request

```bash
curl -X GET http://localhost:8080/favicon.png
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: image/png
```

---

<a id="cdr-reporting"></a>
## 4. Call Detail Records (CDR) & Analytics

*Endpoints for querying call historical logs, applying multi-dimensional filters, generating native Excel (.xlsx) reports, and auditing call metadata.*

<a id="get-cdrexport"></a>
### `GET` /cdr/export

**Description**: Generates and streams a high-performance native Excel workbook (.xlsx) containing filtered Call Detail Records. Uses streaming workbook compilation to handle large datasets without memory spikes.

- **Authentication**: Session Cookie (`call_history` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asteriskcdrdb.cdr` and streams `.xlsx` binary directly to client with `Content-Disposition: attachment`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `startDate` | `query` | `string` | No | Start timestamp (YYYY-MM-DD HH:mm:ss) |
| `endDate` | `query` | `string` | No | End timestamp (YYYY-MM-DD HH:mm:ss) |
| `targetExtension` | `query` | `string|array` | No | Filter by one or more extension numbers |
| `statusFilter` | `query` | `string|array` | No | Disposition status ('ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED') |
| `directionFilter` | `query` | `string` | No | Call direction ('INBOUND', 'OUTBOUND', 'INTERNAL', 'ALL') |
| `callScopeFilter` | `query` | `string` | No | Call scope ('LOCAL', 'DID', 'PSTN') |
| `searchSrc` | `query` | `string` | No | Filter by source caller number substring |
| `searchDst` | `query` | `string` | No | Filter by destination callee number substring |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/cdr/export?startDate=2026-09-01+00:00:00&endDate=2026-09-28+23:59:59&statusFilter=ANSWERED' -b cookie.txt -O -J
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="cdr-report-2026-09-28.xlsx"

[Binary XLSX content]
```

---

<a id="post-apicdrdelete"></a>
### `POST` /api/cdr/delete

**Description**: Deletes a specific CDR record and deletes its corresponding audio recording file from disk storage.

- **Authentication**: Session Cookie (`call_history` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Deletes row from `asteriskcdrdb.cdr` and unlinks `/var/spool/asterisk/monitor/YYYY/MM/DD/*<uniqueid>*.wav`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `uniqueid` | `body` | `string` | **Yes** | Asterisk Unique ID of the call record (e.g. '1727440000.12') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/cdr/delete -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"uniqueid":"1727440000.12"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "CDR record and audio file deleted successfully."
}
```

---

<a id="media-playback"></a>
## 5. Call Audio Playback & Media Streaming

*Endpoints dedicated to low-latency HTTP byte-range audio streaming for call recordings.*

<a id="get-audiouniqueid"></a>
### `GET` /audio/:uniqueid

**Description**: Locates and streams the recorded audio file associated with an Asterisk Unique ID. Supports HTTP 206 Partial Content byte ranges, enabling browser audio wave scrubbers to seek instantly without downloading the entire file.

- **Authentication**: Session Cookie (`call_history` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Range: bytes=0- (optional)
- **System Impact**: Scans `/var/spool/asterisk/monitor/` for `.wav` / `.mp3` / `.WAV` / `.gsm` files matching unique ID.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `uniqueid` | `path` | `string` | **Yes** | Call recording unique identifier (e.g. '1727440000.12') |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/audio/1727440000.12' -b cookie.txt -H 'Range: bytes=0-1024' -i
```

#### Example Response

```http
HTTP/1.1 206 Partial Content
Content-Type: audio/wav
Content-Range: bytes 0-1024/154320
Accept-Ranges: bytes

[Binary Audio Stream]
```

---

<a id="voicemail-greetings"></a>
## 6. Voicemail Management & Custom Greetings

*Endpoints managing voicemail boxes, audio retrieval, custom mailbox greetings upload/reset, retention policies, and storage cleanup.*

<a id="get-apivoicemails"></a>
### `GET` /api/voicemails

**Description**: Retrieves the list of stored voicemail messages across mailboxes with caller ID, duration, timestamp, read status, and transcription if available.

- **Authentication**: Session Cookie (`voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Scans `/var/spool/asterisk/voicemail/default/` message headers and audio files.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `mailbox` | `query` | `string` | No | Filter by extension mailbox (e.g. '101') |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/api/voicemails?mailbox=101' -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "voicemails": [
    {
      "mailbox": "101",
      "folder": "INBOX",
      "msgnum": "msg0000",
      "callerid": "01012345678",
      "origdate": "2026-09-28 14:30:10",
      "duration": 24,
      "file": "msg0000.wav"
    }
  ]
}
```

---

<a id="get-vm-audiomailboxfile"></a>
### `GET` /vm-audio/:mailbox/:file

**Description**: Streams a specific voicemail recording audio file with HTTP Range support.

- **Authentication**: Session Cookie (`voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Streams `/var/spool/asterisk/voicemail/default/<mailbox>/*/<file>`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `mailbox` | `path` | `string` | **Yes** | Mailbox extension number |
| `file` | `path` | `string` | **Yes** | Audio filename (e.g. 'msg0000.wav') |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/vm-audio/101/msg0000.wav' -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: audio/wav
Accept-Ranges: bytes
```

---

<a id="get-vm-export"></a>
### `GET` /vm-export

**Description**: Exports voicemail records and metadata to an Excel workbook.

- **Authentication**: Session Cookie (`voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Compiles and streams Excel spreadsheet of mailbox messages.

#### Example Request

```bash
curl -X GET http://localhost:8080/vm-export -b cookie.txt -O -J
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Disposition: attachment; filename="voicemails.xlsx"
```

---

<a id="get-apiconfigvoicemailextensions"></a>
### `GET` /api/config/voicemail/extensions

**Description**: Lists all extensions configured with voicemail enabled along with their mailbox greeting statuses.

- **Authentication**: Session Cookie (`config` or `voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.users` and checks `/var/spool/asterisk/voicemail/default/<ext>/`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/voicemail/extensions -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "extensions": [
    {
      "extension": "101",
      "name": "John Doe",
      "hasCustomGreeting": true
    }
  ]
}
```

---

<a id="post-apiconfigvoicemailgreeting"></a>
### `POST` /api/config/voicemail/greeting

**Description**: Uploads an audio file (WAV/MP3) to serve as a custom voicemail greeting for an extension, auto-converting to Asterisk 8kHz mono WAV format.

- **Authentication**: Session Cookie (`config` or `voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: multipart/form-data
- **System Impact**: Converts file with `ffmpeg` and writes to `/var/spool/asterisk/voicemail/default/<extension>/unavail.wav`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | Target extension number |
| `greetingType` | `body` | `string` | **Yes** | Greeting type ('unavail', 'busy', 'greet') |
| `audio` | `body` | `file` | **Yes** | Audio file payload (WAV or MP3) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/voicemail/greeting -b cookie.txt \
  -F 'extension=101' -F 'greetingType=unavail' -F 'audio=@greeting.mp3'
```

#### Example Response

```json
{
  "success": true,
  "message": "Custom greeting uploaded and converted successfully for extension 101."
}
```

---

<a id="post-apiconfigvoicemailreset"></a>
### `POST` /api/config/voicemail/reset

**Description**: Removes custom voicemail greetings for an extension, restoring Asterisk system default spoken prompts.

- **Authentication**: Session Cookie (`config` or `voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Removes custom greeting `.wav` files from `/var/spool/asterisk/voicemail/default/<extension>/`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | Extension number to reset |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/voicemail/reset -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"extension":"101"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Greeting reset to system default."
}
```

---

<a id="get-apivoicemail-storagesettings"></a>
### `GET` /api/voicemail-storage/settings

**Description**: Retrieves the current voicemail storage quota, retention duration, and auto-purge threshold settings.

- **Authentication**: Session Cookie (`storage` or `voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.voicemail_settings`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/voicemail-storage/settings -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "settings": {
    "maxMessagesPerMailbox": 100,
    "retentionDays": 90,
    "autoPurgeEnabled": true
  }
}
```

---

<a id="post-apivoicemail-storagesettings"></a>
### `POST` /api/voicemail-storage/settings

**Description**: Updates voicemail retention rules, message limits per mailbox, and auto-cleanup schedules.

- **Authentication**: Session Cookie (`storage` or `voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.voicemail_settings`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `maxMessagesPerMailbox` | `body` | `integer` | **Yes** | Max recordings kept per mailbox |
| `retentionDays` | `body` | `integer` | **Yes** | Days before voicemails are automatically deleted |
| `autoPurgeEnabled` | `body` | `boolean` | **Yes** | Enable automated retention purge worker |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/voicemail-storage/settings -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"maxMessagesPerMailbox":150,"retentionDays":60,"autoPurgeEnabled":true}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Voicemail storage settings updated successfully."
}
```

---

<a id="post-apivoicemail-storagepurge"></a>
### `POST` /api/voicemail-storage/purge

**Description**: Manually triggers an immediate retention purge of voicemails older than the specified retention window.

- **Authentication**: Session Cookie (`storage` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Deletes expired voicemail audio files and metadata across all mailboxes.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `olderThanDays` | `body` | `integer` | No | Purge files older than N days (defaults to configured retention) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/voicemail-storage/purge -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"olderThanDays":30}'
```

#### Example Response

```json
{
  "success": true,
  "purgedCount": 42,
  "freedSpaceBytes": 12582912
}
```

---

<a id="operator-call-control"></a>
## 7. Live Operator Switchboard & Real-Time Call Supervision

*High-priority telephony endpoints facilitating operator transfers, call disconnection, supervisor ChanSpy (listen/whisper/barge), channel hijack, and instant intercom paging.*

<a id="post-apihangupextension"></a>
### `POST` /api/hangup/:extension

**Description**: Terminates any active calls on the specified extension immediately via Asterisk Manager Interface (AMI).

- **Authentication**: Session Cookie (`operator` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Fires AMI `Hangup` command on active channels matching the extension.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension to hang up (e.g. '101') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/hangup/101 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Call terminated successfully on extension 101."
}
```

---

<a id="post-apitransfer"></a>
### `POST` /api/transfer

**Description**: Executes an immediate blind or attended transfer of an active call channel to a new destination extension or external telephone number.

- **Authentication**: Session Cookie (`operator` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Dispatches AMI `BlindTransfer` or `Atxfer` action.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `channel` | `body` | `string` | **Yes** | Active Asterisk channel identifier (e.g. 'PJSIP/101-0000001a') |
| `targetExt` | `body` | `string` | **Yes** | Destination extension or phone number |
| `type` | `body` | `string` | No | Transfer type: 'blind' (default) or 'attended' |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/transfer -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"channel":"PJSIP/101-0000001a","targetExt":"105","type":"blind"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Transfer initiated to 105."
}
```

---

<a id="post-apispy"></a>
### `POST` /api/spy

**Description**: Initiates a real-time ChanSpy supervisory session connecting the supervisor's phone to the target agent's live call in Listen, Whisper, or Barge mode.

- **Authentication**: Session Cookie (`operator` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Fires AMI `Originate` action to supervisor extension executing `ChanSpy` application with flags `q` (listen), `w` (whisper), or `B` (barge).

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | Target agent extension being monitored (e.g. '102') |
| `mode` | `body` | `string` | **Yes** | Supervision mode: 'listen' (silent), 'whisper' (only agent hears supervisor), 'barge' (three-way conference) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/spy -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"extension":"102","mode":"whisper"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Supervisory spy call originated in whisper mode."
}
```

---

<a id="post-apihijack"></a>
### `POST` /api/hijack

**Description**: Forces an immediate call takeover: redirects the customer party to the supervisor's phone and disconnects the original agent channel.

- **Authentication**: Session Cookie (`operator` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Fires AMI `Redirect` to transfer caller to supervisor, followed by AMI `Hangup` on agent channel.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `channel` | `body` | `string` | **Yes** | Customer channel to redirect |
| `extension` | `body` | `string` | **Yes** | Agent extension to disconnect |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/hijack -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"channel":"PJSIP/trunk-0000004b","extension":"102"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Call successfully hijacked to supervisor."
}
```

---

<a id="post-apiintercomcall"></a>
### `POST` /api/intercom/call

**Description**: Initiates an auto-answer two-way intercom page to an extension or group of extensions using SIP alert-info headers.

- **Authentication**: Session Cookie (`operator` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Fires AMI `Originate` injecting `Alert-Info: <http://127.0.0.1>;info=alert-autoanswer;delay=0`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `callerExtension` | `body` | `string` | **Yes** | Initiator extension |
| `targetExtension` | `body` | `string` | **Yes** | Target extension to page |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/intercom/call -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"callerExtension":"100","targetExtension":"105"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Intercom page initiated."
}
```

---

<a id="ext-analytics"></a>
## 8. Extension Analytics & Routing Policies

*Endpoints providing live extension telemetry, SIP registration states, historical KPI metrics, and call forwarding/DND routing policies.*

<a id="get-apiext-overview"></a>
### `GET` /api/ext-overview

**Description**: Returns real-time status of all extensions: online/offline status, device IP address, latency (RTT), technology, current call state, and active call partner.

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Polls in-memory AMI presence cache (`sipPresence`, `pjsipPresence`, `peerIPs`, `activeCalls`).

#### Example Request

```bash
curl -X GET http://localhost:8080/api/ext-overview -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "extensions": [
    {
      "extension": "101",
      "name": "Alice",
      "online": true,
      "ip": "192.168.1.55",
      "state": "in_call",
      "partner": "01099887766",
      "duration": 48
    }
  ]
}
```

---

<a id="get-apiext-statsextension"></a>
### `GET` /api/ext-stats/:extension

**Description**: Calculates aggregated analytics for a specific extension: total calls, answered calls, missed calls, talk time duration, average handle time (AHT), and hourly volume.

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asteriskcdrdb.cdr` indexed by `src` and `dst`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension number |
| `startDate` | `query` | `string` | No | Start timestamp filter |
| `endDate` | `query` | `string` | No | End timestamp filter |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/api/ext-stats/101?startDate=2026-09-01+00:00:00' -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "stats": {
    "extension": "101",
    "totalCalls": 340,
    "answeredCalls": 312,
    "missedCalls": 28,
    "totalTalkTimeSec": 45210,
    "avgTalkTimeSec": 144
  }
}
```

---

<a id="get-apiext-status-logsextension"></a>
### `GET` /api/ext-status-logs/:extension

**Description**: Retrieves the timeline of registration events, status changes, and network connect/disconnect events for an extension.

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.extension_status_logs`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension number |
| `limit` | `query` | `integer` | No | Max records (default: 50) |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/api/ext-status-logs/101?limit=25' -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "logs": [
    {
      "status": "REACHABLE",
      "ip": "192.168.1.55",
      "rtt_ms": 12,
      "timestamp": "2026-09-28T12:00:00Z"
    }
  ]
}
```

---

<a id="get-apiextension-policies"></a>
### `GET` /api/extension-policies

**Description**: Retrieves the global list of extension calling policies (Do Not Disturb, Call Waiting, Call Forwarding, and outbound permissions).

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries AstDB keys `/DND/*`, `/CF/*`, `/CW/*`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/extension-policies -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "policies": [
    {
      "extension": "101",
      "dnd": false,
      "callWaiting": true,
      "callForward": ""
    }
  ]
}
```

---

<a id="get-apiextension-policyextension"></a>
### `GET` /api/extension-policy/:extension

**Description**: Retrieves routing policies and AstDB states for a single extension.

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries AstDB for `/DND/<ext>`, `/CF/<ext>`, `/CW/<ext>`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension number |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/extension-policy/101 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "policy": {
    "extension": "101",
    "dnd": false,
    "callWaiting": true,
    "callForward": "01012345678"
  }
}
```

---

<a id="post-apiextension-policiesextension"></a>
### `POST` /api/extension-policies/:extension

**Description**: Updates DND, Call Waiting, and Call Forwarding policies for a single extension in AstDB.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Modifies AstDB keys `/DND/<ext>`, `/CW/<ext>`, `/CF/<ext>` via Asterisk CLI.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension number to update |
| `dnd` | `body` | `boolean` | No | Enable/disable Do Not Disturb |
| `callWaiting` | `body` | `boolean` | No | Enable/disable Call Waiting |
| `callForward` | `body` | `string` | No | Forwarding destination number (empty to disable) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/extension-policies/101 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"dnd":true,"callWaiting":false,"callForward":""}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Extension policy updated successfully."
}
```

---

<a id="post-apiextension-policies-bulk"></a>
### `POST` /api/extension-policies-bulk

**Description**: Bulk updates calling policies (e.g. mass enable Call Waiting or mass toggle DND) across multiple extensions simultaneously.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Iterates AstDB mutations across the extension list.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extensions` | `body` | `array` | **Yes** | Array of extension numbers |
| `dnd` | `body` | `boolean` | No | DND state to apply |
| `callWaiting` | `body` | `boolean` | No | Call Waiting state to apply |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/extension-policies-bulk -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"extensions":["101","102","103"],"callWaiting":true}'
```

#### Example Response

```json
{
  "success": true,
  "updatedCount": 3
}
```

---

<a id="employee-directory"></a>
## 9. Employee Directory & Departmental Groups

*Endpoints managing corporate agent departments, custom employee metadata, photos, and team structures.*

<a id="get-apiemployeegroups"></a>
### `GET` /api/employee/groups

**Description**: Lists all departmental employee groups (e.g. Sales, Support, Finance) with member counts.

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.employee_groups`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/employee/groups -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "groups": [
    {"id": 1, "name": "Customer Support", "color": "#3b82f6", "memberCount": 8}
  ]
}
```

---

<a id="post-apiemployeegroups"></a>
### `POST` /api/employee/groups

**Description**: Creates a new employee department group.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.employee_groups`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `body` | `string` | **Yes** | Department name |
| `color` | `body` | `string` | No | Hex badge color (e.g. '#10b981') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/employee/groups -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"Technical Support","color":"#f59e0b"}'
```

#### Example Response

```json
{
  "success": true,
  "groupId": 2,
  "message": "Department created successfully."
}
```

---

<a id="put-apiemployeegroupsid"></a>
### `PUT` /api/employee/groups/:id

**Description**: Updates an existing employee department name or badge color.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.employee_groups`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Department group ID |
| `name` | `body` | `string` | **Yes** | Updated name |
| `color` | `body` | `string` | No | Updated hex color |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/employee/groups/2 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"Tier 2 Support","color":"#ef4444"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Department updated successfully."
}
```

---

<a id="delete-apiemployeegroupsid"></a>
### `DELETE` /api/employee/groups/:id

**Description**: Deletes an employee department and clears associations from members.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes row from `asterisk.employee_groups` and sets `group_id = NULL` on members.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Department group ID |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/employee/groups/2 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Department deleted."
}
```

---

<a id="get-apiemployeeextrasextension"></a>
### `GET` /api/employee/extras/:extension

**Description**: Retrieves extended metadata for an extension: job title, email, mobile phone, avatar photo URL, and assigned department.

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.employee_extras`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension number |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/employee/extras/101 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "extras": {
    "extension": "101",
    "jobTitle": "Senior Support Engineer",
    "email": "alice@corp.com",
    "mobile": "01012345678",
    "photoUrl": "/uploads/avatars/101.jpg",
    "groupId": 1
  }
}
```

---

<a id="put-apiemployeeextrasextension"></a>
### `PUT` /api/employee/extras/:extension

**Description**: Updates extended metadata for an extension.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Executes `INSERT ... ON DUPLICATE KEY UPDATE` in `asterisk.employee_extras`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension number |
| `jobTitle` | `body` | `string` | No | Job title or position |
| `email` | `body` | `string` | No | Direct work email |
| `mobile` | `body` | `string` | No | Mobile telephone number |
| `groupId` | `body` | `integer` | No | Department group ID |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/employee/extras/101 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"jobTitle":"Lead DevOps","email":"alice@ops.net","mobile":"01099887766"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Employee metadata updated successfully."
}
```

---

<a id="put-apiemployeegroup-assignment"></a>
### `PUT` /api/employee/group-assignment

**Description**: Reassigns one or more extensions to a specific department in bulk.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `group_id` column in `asterisk.employee_extras`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extensions` | `body` | `array` | **Yes** | Array of extension numbers |
| `groupId` | `body` | `integer` | **Yes** | Destination department group ID |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/employee/group-assignment -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"extensions":["101","102"],"groupId":1}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Department assignments updated."
}
```

---

<a id="post-apiemployeephoto"></a>
### `POST` /api/employee/photo

**Description**: Uploads and crops an avatar profile picture for an employee extension.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: multipart/form-data
- **System Impact**: Saves optimized thumbnail into `/opt/sokrat-voip/public/uploads/avatars/<ext>.jpg` and updates `photo_url` in `asterisk.employee_extras`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | Target extension number |
| `photo` | `body` | `file` | **Yes** | Image file (JPEG/PNG/WebP) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/employee/photo -b cookie.txt \
  -F 'extension=101' -F 'photo=@avatar.jpg'
```

#### Example Response

```json
{
  "success": true,
  "photoUrl": "/uploads/avatars/101.jpg"
}
```

---

<a id="pbx-extensions"></a>
## 10. PBX Configuration: Extensions & AGC Audio Tuning

*Endpoints managing SIP/PJSIP/IAX2 extension endpoints, credentials, voicemail attachments, and per-extension Automatic Gain Control (AGC) volume leveling.*

<a id="get-apiconfigextensions"></a>
### `GET` /api/config/extensions

**Description**: Retrieves all PBX extensions with their assigned caller IDs, technology (PJSIP/SIP/IAX2), voicemail statuses, and AstDB AGC gain levels.

- **Authentication**: Session Cookie (`config` or `config-extensions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.users`, `asterisk.devices`, `asterisk.sip` and reads `/AMPUSER/<ext>/agc` from AstDB.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/extensions -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "extensions": [
    {
      "extension": "101",
      "name": "Alice",
      "tech": "pjsip",
      "secret": "Secret123",
      "callerid": "Alice <101>",
      "agc": "8000",
      "voicemail": true
    }
  ]
}
```

---

<a id="post-apiconfigextensions"></a>
### `POST` /api/config/extensions

**Description**: Provisions a new PBX extension across Asterisk databases, creates SIP credentials, initializes voicemail, and seeds AstDB AGC configuration.

- **Authentication**: Session Cookie (`config` or `config-extensions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts records into `asterisk.users`, `asterisk.devices`, `asterisk.sip`. Writes AstDB keys `/AMPUSER/<ext>/agc`, `/AMPUSER/<ext>/cidname`, `/AMPUSER/<ext>/cidnum`, and `/CW/<ext>`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | Extension number (digits only, e.g. '101') |
| `name` | `body` | `string` | **Yes** | Display name (e.g. 'Alice') |
| `tech` | `body` | `string` | No | Technology: 'pjsip' (default), 'sip', or 'iax2' |
| `secret` | `body` | `string` | **Yes** | SIP authentication password |
| `callerid` | `body` | `string` | No | Outbound caller ID name/number |
| `agc` | `body` | `string` | No | Automatic Gain Control level ('8000' default, '6000', '10000', '12000', or 'off') |
| `callwaiting` | `body` | `boolean` | No | Enable call waiting |
| `voicemail_enable` | `body` | `boolean` | No | Enable voicemail box |
| `voicemail_pin` | `body` | `string` | No | Voicemail security PIN |
| `voicemail_email` | `body` | `string` | No | Email address for voicemail audio notifications |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/extensions -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"extension":"115","name":"Mark","tech":"pjsip","secret":"MarkPass@2026","agc":"8000","voicemail_enable":true,"voicemail_pin":"1234"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Extension 115 created successfully."
}
```

---

<a id="put-apiconfigextensionsextension"></a>
### `PUT` /api/config/extensions/:extension

**Description**: Modifies an existing PBX extension's name, password, caller ID, technology, voicemail settings, and per-extension AGC level.

- **Authentication**: Session Cookie (`config` or `config-extensions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.users`, `asterisk.devices`, `asterisk.sip` and AstDB `/AMPUSER/<ext>/agc`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension number to update |
| `name` | `body` | `string` | No | Updated display name |
| `secret` | `body` | `string` | No | Updated SIP password |
| `callerid` | `body` | `string` | No | Updated caller ID |
| `agc` | `body` | `string` | No | Updated AGC gain ('8000', '6000', '10000', '12000', 'off') |
| `callwaiting` | `body` | `boolean` | No | Call waiting state |
| `voicemail_enable` | `body` | `boolean` | No | Voicemail state |
| `voicemail_pin` | `body` | `string` | No | Voicemail PIN |
| `voicemail_email` | `body` | `string` | No | Voicemail notification email |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/extensions/115 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mark Spencer","agc":"10000"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Extension 115 updated successfully."
}
```

---

<a id="delete-apiconfigextensionsextension"></a>
### `DELETE` /api/config/extensions/:extension

**Description**: Removes an extension from Asterisk database, cleans up AstDB entries, and deletes voicemail boxes.

- **Authentication**: Session Cookie (`config` or `config-extensions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.users`, `asterisk.devices`, `asterisk.sip` and AstDB `/AMPUSER/<ext>/*`, `/CW/<ext>`, `/CF/<ext>`, `/DND/<ext>`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension number to delete |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/extensions/115 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Extension 115 deleted successfully."
}
```

---

<a id="get-apiconfigextension-conflicts"></a>
### `GET` /api/config/extension-conflicts

**Description**: Audits the PBX dialplan across extensions, ring groups, queues, feature codes, and IVR direct dials to detect conflicting extension numbers.

- **Authentication**: Session Cookie (`config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Scans `users`, `ringgroups`, `queues_config`, and `incoming`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/extension-conflicts -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "conflicts": []
}
```

---

<a id="pbx-trunks"></a>
## 11. PBX Configuration: Trunks & VoIP Gateways

*Endpoints managing SIP, PJSIP, IAX2, and hardware GSM/DONGLE voice trunks connecting the PBX to telecom carriers.*

<a id="get-apiconfigtrunks"></a>
### `GET` /api/config/trunks

**Description**: Lists all configured inbound and outbound voice trunks with their registration states, protocol technology, and trunk IDs.

- **Authentication**: Session Cookie (`config` or `config-trunks` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.trunks` and checks AMI registry status.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/trunks -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "trunks": [
    {"trunkid": 1, "name": "Carrier_SIP", "tech": "sip", "disabled": "off", "channelid": "Carrier_SIP"}
  ]
}
```

---

<a id="post-apiconfigtrunks"></a>
### `POST` /api/config/trunks

**Description**: Provisions a new SIP/PJSIP trunk with custom peer configuration details, registration strings, and dial rules.

- **Authentication**: Session Cookie (`config` or `config-trunks` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.trunks`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `body` | `string` | **Yes** | Trunk identifier name |
| `tech` | `body` | `string` | **Yes** | Technology ('sip', 'pjsip', 'iax2', 'dongle') |
| `outcid` | `body` | `string` | No | Outbound caller ID |
| `maxchans` | `body` | `integer` | No | Maximum concurrent channels allowed |
| `peerdetails` | `body` | `string` | No | Asterisk peer configuration string (host, secret, codecs) |
| `usercontext` | `body` | `string` | No | Incoming user context |
| `userconfig` | `body` | `string` | No | User details configuration block |
| `registerstring` | `body` | `string` | No | SIP registration string (user:pass@host/did) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/trunks -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"VoIP_Provider","tech":"sip","outcid":"0223456789","peerdetails":"host=sip.provider.com\nsecret=Pass123\ntype=peer"}'
```

#### Example Response

```json
{
  "success": true,
  "trunkid": 2,
  "message": "Trunk created successfully."
}
```

---

<a id="put-apiconfigtrunkstrunkid"></a>
### `PUT` /api/config/trunks/:trunkid

**Description**: Updates configuration details, peer parameters, caller IDs, or enable/disable state for an existing trunk.

- **Authentication**: Session Cookie (`config` or `config-trunks` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.trunks`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `trunkid` | `path` | `integer` | **Yes** | Trunk ID |
| `name` | `body` | `string` | No | Updated trunk name |
| `disabled` | `body` | `string` | No | Trunk state ('on' for disabled, 'off' for active) |
| `peerdetails` | `body` | `string` | No | Updated peer details |
| `registerstring` | `body` | `string` | No | Updated registration string |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/trunks/2 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"disabled":"off","maxchans":30}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Trunk updated successfully."
}
```

---

<a id="delete-apiconfigtrunkstrunkid"></a>
### `DELETE` /api/config/trunks/:trunkid

**Description**: Deletes a trunk from Asterisk and cleans up any references in outbound route sequences.

- **Authentication**: Session Cookie (`config` or `config-trunks` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.trunks` and cleans `asterisk.outbound_route_trunks`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `trunkid` | `path` | `integer` | **Yes** | Trunk ID to remove |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/trunks/2 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Trunk deleted successfully."
}
```

---

<a id="pbx-routing"></a>
## 12. PBX Configuration: Inbound & Outbound Call Routing

*Endpoints managing incoming DID/CID routing, destinations (extensions, queues, IVRs, ring groups), outbound dial patterns, trunk priority failovers, and route ordering.*

<a id="get-apiconfigroutesinbound"></a>
### `GET` /api/config/routes/inbound

**Description**: Lists all Inbound Routes (DIDs) with their destination targets, CID filters, recording settings, and MOH categories.

- **Authentication**: Session Cookie (`config` or `config-routes` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.incoming`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/routes/inbound -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "routes": [
    {"extension": "0223456789", "destination": "ext-queues,300,1", "description": "Main Helpdesk DID"}
  ]
}
```

---

<a id="post-apiconfigroutesinbound"></a>
### `POST` /api/config/routes/inbound

**Description**: Creates a new inbound route matching incoming DID and Caller ID pattern to route to a destination target.

- **Authentication**: Session Cookie (`config` or `config-routes` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.incoming`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | Inbound DID number pattern |
| `cidnum` | `body` | `string` | No | Caller ID filter pattern |
| `description` | `body` | `string` | No | Route description |
| `destination` | `body` | `string` | **Yes** | Destination target (e.g. 'from-did-direct,101,1' or 'ext-queues,300,1') |
| `recording` | `body` | `string` | No | Call recording policy ('ALWAYS', 'NEVER', 'DONTCARE') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/routes/inbound -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"extension":"0211223344","destination":"ext-queues,300,1","description":"Support Line"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Inbound route created successfully."
}
```

---

<a id="put-apiconfigroutesinbound"></a>
### `PUT` /api/config/routes/inbound

**Description**: Updates an existing inbound route's destination, description, or recording policy.

- **Authentication**: Session Cookie (`config` or `config-routes` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.incoming`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | Target DID pattern |
| `cidnum` | `body` | `string` | No | Target CID pattern |
| `destination` | `body` | `string` | **Yes** | Updated destination target |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/routes/inbound -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"extension":"0211223344","destination":"from-did-direct,105,1"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Inbound route updated successfully."
}
```

---

<a id="delete-apiconfigroutesinbound"></a>
### `DELETE` /api/config/routes/inbound

**Description**: Deletes an inbound route by DID and CID pattern.

- **Authentication**: Session Cookie (`config` or `config-routes` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Deletes from `asterisk.incoming`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | DID pattern to delete |
| `cidnum` | `body` | `string` | No | CID pattern |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/routes/inbound -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"extension":"0211223344"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Inbound route deleted successfully."
}
```

---

<a id="get-apiconfigroutesoutbound"></a>
### `GET` /api/config/routes/outbound

**Description**: Lists all Outbound Routes with their dial pattern rules, trunk priorities, PIN protection, and caller IDs.

- **Authentication**: Session Cookie (`config` or `config-routes` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.outbound_routes` and `asterisk.outbound_route_trunks`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/routes/outbound -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "routes": [
    {"route_id": 1, "name": "Mobile_Outbound", "outcid": "01012345678", "trunks": [1, 2]}
  ]
}
```

---

<a id="post-apiconfigroutesoutbound"></a>
### `POST` /api/config/routes/outbound

**Description**: Creates a new outbound route matching dial patterns (prefix, prepend, match pattern) and assigning ordered trunk sequences for automatic failover.

- **Authentication**: Session Cookie (`config` or `config-routes` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts into `asterisk.outbound_routes`, `asterisk.outbound_route_patterns`, and `asterisk.outbound_route_trunks`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `body` | `string` | **Yes** | Route name |
| `outcid` | `body` | `string` | No | Override caller ID |
| `patterns` | `body` | `array` | **Yes** | Array of dial pattern objects ({match_pattern, prepend, prefix}) |
| `trunks` | `body` | `array` | **Yes** | Ordered array of trunk IDs |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/routes/outbound -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"Egypt_Mobile","patterns":[{"match_pattern":"01XXXXXXXXX"}],"trunks":[1,2]}'
```

#### Example Response

```json
{
  "success": true,
  "route_id": 3,
  "message": "Outbound route created successfully."
}
```

---

<a id="put-apiconfigroutesoutboundroute-id"></a>
### `PUT` /api/config/routes/outbound/:route_id

**Description**: Updates an existing outbound route's dial patterns, assigned trunk sequence, and caller ID override.

- **Authentication**: Session Cookie (`config` or `config-routes` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.outbound_routes` and recreates pattern/trunk records.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `route_id` | `path` | `integer` | **Yes** | Route ID to update |
| `name` | `body` | `string` | No | Updated route name |
| `patterns` | `body` | `array` | No | Updated dial patterns |
| `trunks` | `body` | `array` | No | Updated trunk IDs array |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/routes/outbound/3 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"trunks":[2,1]}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Outbound route updated successfully."
}
```

---

<a id="delete-apiconfigroutesoutboundroute-id"></a>
### `DELETE` /api/config/routes/outbound/:route_id

**Description**: Deletes an outbound route, its pattern rules, and trunk associations.

- **Authentication**: Session Cookie (`config` or `config-routes` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.outbound_routes`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `route_id` | `path` | `integer` | **Yes** | Route ID to remove |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/routes/outbound/3 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Outbound route deleted successfully."
}
```

---

<a id="post-apiconfigroutesoutboundreorder"></a>
### `POST` /api/config/routes/outbound/reorder

**Description**: Reorders the evaluation sequence of outbound routes (routes are checked top-to-bottom).

- **Authentication**: Session Cookie (`config` or `config-routes` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates sequence indices in `asterisk.outbound_routes`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `routeOrder` | `body` | `array` | **Yes** | Ordered list of route IDs [id1, id2, ...] |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/routes/outbound/reorder -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"routeOrder":[3,1,2]}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Outbound route sequence updated successfully."
}
```

---

<a id="pbx-queues"></a>
## 13. PBX Configuration: Queues & Call Distribution

*Endpoints managing Call Center Queues, ring strategies (ringall, roundrobin, leastrecent), agent member rosters, music on hold, and timeout failovers.*

<a id="get-apiconfigqueues"></a>
### `GET` /api/config/queues

**Description**: Lists all Call Center Queues with their assigned strategies, agent member counts, timeouts, and failover destinations.

- **Authentication**: Session Cookie (`config` or `config-queues` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.queues_config` and `asterisk.queues_details`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/queues -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "queues": [
    {"extension": "300", "name": "Support Queue", "strategy": "ringall", "members": ["101", "102"]}
  ]
}
```

---

<a id="post-apiconfigqueues"></a>
### `POST` /api/config/queues

**Description**: Provisions a new Call Center Queue with strategy, agent members, periodic announcements, and timeout failover target.

- **Authentication**: Session Cookie (`config` or `config-queues` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts records into `asterisk.queues_config` and `asterisk.queues_details`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | Queue virtual extension number (e.g. '300') |
| `name` | `body` | `string` | **Yes** | Queue name |
| `strategy` | `body` | `string` | No | Ring strategy ('ringall', 'leastrecent', 'fewestcalls', 'random', 'rrmemory') |
| `timeout` | `body` | `integer` | No | Ring timeout in seconds |
| `members` | `body` | `array` | No | List of member extensions |
| `failover_destination` | `body` | `string` | No | Target destination if queue times out |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/queues -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"extension":"305","name":"VIP Sales","strategy":"rrmemory","members":["101","102"],"timeout":30}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Queue 305 created successfully."
}
```

---

<a id="put-apiconfigqueuesextension"></a>
### `PUT` /api/config/queues/:extension

**Description**: Updates an existing queue's strategy, agent member roster, timeouts, music on hold, or failover destination.

- **Authentication**: Session Cookie (`config` or `config-queues` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.queues_config` and `asterisk.queues_details`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Queue extension |
| `name` | `body` | `string` | No | Updated queue name |
| `strategy` | `body` | `string` | No | Updated strategy |
| `members` | `body` | `array` | No | Updated member extensions list |
| `failover_destination` | `body` | `string` | No | Updated failover target |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/queues/305 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"members":["101","102","103"]}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Queue 305 updated successfully."
}
```

---

<a id="delete-apiconfigqueuesextension"></a>
### `DELETE` /api/config/queues/:extension

**Description**: Deletes a queue from Asterisk.

- **Authentication**: Session Cookie (`config` or `config-queues` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.queues_config` and `asterisk.queues_details`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Queue extension to delete |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/queues/305 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Queue 305 deleted successfully."
}
```

---

<a id="pbx-ringgroups"></a>
## 14. PBX Configuration: Ring Groups & Cascades

*Endpoints managing Ring Groups, hunt groups, extension lists, cascading ring strategies, and unanswered call failover destinations.*

<a id="get-apiconfigringgroups"></a>
### `GET` /api/config/ringgroups

**Description**: Lists all configured Ring Groups with their group numbers, member lists, ring times, and destinations if no answer.

- **Authentication**: Session Cookie (`config` or `config-ringgroups` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.ringgroups`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/ringgroups -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "ringgroups": [
    {"grpnum": "600", "description": "Front Desk Ring Group", "grplist": "101-102-103", "grptime": 20}
  ]
}
```

---

<a id="post-apiconfigringgroups"></a>
### `POST` /api/config/ringgroups

**Description**: Creates a new Ring Group with extension member list, ring strategy, ring time, and no-answer destination.

- **Authentication**: Session Cookie (`config` or `config-ringgroups` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.ringgroups`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `grpnum` | `body` | `string` | **Yes** | Ring Group number (e.g. '601') |
| `description` | `body` | `string` | **Yes** | Group description |
| `grplist` | `body` | `string|array` | **Yes** | Extensions list (e.g. '101-102' or ['101', '102']) |
| `strategy` | `body` | `string` | No | Ring strategy ('ringall', 'hunt', 'memoryhunt', 'firstavailable') |
| `grptime` | `body` | `integer` | No | Ring time in seconds (default: 20) |
| `postdest` | `body` | `string` | **Yes** | Destination if no answer (e.g. 'ext-local,101,dest') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/ringgroups -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"grpnum":"605","description":"Sales Group","grplist":"101-102","strategy":"ringall","grptime":20,"postdest":"app-blackhole,hangup,1"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Ring group 605 created successfully."
}
```

---

<a id="put-apiconfigringgroupsgrpnum"></a>
### `PUT` /api/config/ringgroups/:grpnum

**Description**: Updates an existing Ring Group's member list, strategy, duration, or no-answer destination.

- **Authentication**: Session Cookie (`config` or `config-ringgroups` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.ringgroups`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `grpnum` | `path` | `string` | **Yes** | Ring Group number to update |
| `description` | `body` | `string` | No | Updated description |
| `grplist` | `body` | `string|array` | No | Updated extensions list |
| `grptime` | `body` | `integer` | No | Updated ring time |
| `postdest` | `body` | `string` | No | Updated failover destination |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/ringgroups/605 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"grplist":"101-102-103","grptime":25}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Ring group 605 updated successfully."
}
```

---

<a id="delete-apiconfigringgroupsgrpnum"></a>
### `DELETE` /api/config/ringgroups/:grpnum

**Description**: Deletes a Ring Group.

- **Authentication**: Session Cookie (`config` or `config-ringgroups` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.ringgroups`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `grpnum` | `path` | `string` | **Yes** | Ring Group number to remove |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/ringgroups/605 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Ring group 605 deleted successfully."
}
```

---

<a id="pbx-ivrs"></a>
## 15. PBX Configuration: Interactive Voice Response (IVR)

*Endpoints managing multi-level interactive auto-attendant voice menus, DTMF keypress routing (0-9, *, #), timeout and invalid input recovery.*

<a id="get-apiconfigivrs"></a>
### `GET` /api/config/ivrs

**Description**: Lists all configured IVR menus with announcement audio references and timeout configurations.

- **Authentication**: Session Cookie (`config` or `config-ivrs` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.ivr_details`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/ivrs -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "ivrs": [
    {"id": 1, "name": "Main Reception IVR", "announcement": "welcome-prompt", "timeout": 10}
  ]
}
```

---

<a id="get-apiconfigivrsid"></a>
### `GET` /api/config/ivrs/:id

**Description**: Retrieves the full configuration of a single IVR menu including DTMF options and keypress destinations.

- **Authentication**: Session Cookie (`config` or `config-ivrs` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.ivr_details` and `asterisk.ivr_entries`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | IVR ID |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/ivrs/1 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "ivr": {
    "id": 1,
    "name": "Main Reception IVR",
    "entries": [
      {"selection": "1", "dest": "ext-queues,300,1"},
      {"selection": "2", "dest": "ext-local,101,dest"}
    ]
  }
}
```

---

<a id="post-apiconfigivrs"></a>
### `POST` /api/config/ivrs

**Description**: Creates a new IVR auto-attendant menu with announcement greeting and DTMF key options.

- **Authentication**: Session Cookie (`config` or `config-ivrs` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts into `asterisk.ivr_details` and `asterisk.ivr_entries`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `body` | `string` | **Yes** | IVR menu name |
| `description` | `body` | `string` | No | Description |
| `announcement` | `body` | `string` | **Yes** | Audio recording prompt ID |
| `timeout` | `body` | `integer` | No | Timeout before default action (seconds) |
| `entries` | `body` | `array` | No | Array of DTMF entries [{selection: '1', dest: '...'}, ...] |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/ivrs -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"After Hours IVR","announcement":"after-hours","timeout":10,"entries":[{"selection":"1","dest":"app-blackhole,hangup,1"}]}'
```

#### Example Response

```json
{
  "success": true,
  "id": 2,
  "message": "IVR created successfully."
}
```

---

<a id="put-apiconfigivrsid"></a>
### `PUT` /api/config/ivrs/:id

**Description**: Updates an IVR menu's prompt, timeout, direct dial settings, and DTMF routing matrix.

- **Authentication**: Session Cookie (`config` or `config-ivrs` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.ivr_details` and replaces rows in `asterisk.ivr_entries`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | IVR ID to update |
| `name` | `body` | `string` | No | Updated menu name |
| `announcement` | `body` | `string` | No | Updated audio prompt ID |
| `entries` | `body` | `array` | No | Updated DTMF entries array |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/ivrs/2 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"timeout":15}'
```

#### Example Response

```json
{
  "success": true,
  "message": "IVR updated successfully."
}
```

---

<a id="delete-apiconfigivrsid"></a>
### `DELETE` /api/config/ivrs/:id

**Description**: Deletes an IVR menu and all associated DTMF routing entries.

- **Authentication**: Session Cookie (`config` or `config-ivrs` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.ivr_details` and `asterisk.ivr_entries`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | IVR ID to delete |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/ivrs/2 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "IVR deleted successfully."
}
```

---

<a id="pbx-announcements"></a>
## 16. PBX Configuration: System Announcements

*Endpoints managing PBX audio announcements played to callers before continuing to downstream destinations (queues, IVRs, or extensions).*

<a id="get-apiconfigannouncements"></a>
### `GET` /api/config/announcements

**Description**: Lists all configured announcements with audio recording references and post-playback destination targets.

- **Authentication**: Session Cookie (`config` or `config-announcements` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.announcements`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/announcements -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "announcements": [
    {"announcement_id": 1, "description": "Call Recording Notice", "recording_id": 5, "post_dest": "ext-queues,300,1"}
  ]
}
```

---

<a id="post-apiconfigannouncements"></a>
### `POST` /api/config/announcements

**Description**: Creates a new announcement linking a system recording to a destination.

- **Authentication**: Session Cookie (`config` or `config-announcements` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.announcements`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `description` | `body` | `string` | **Yes** | Announcement name/label |
| `recording_id` | `body` | `integer` | **Yes** | System recording ID |
| `allow_skip` | `body` | `boolean` | No | Allow caller to skip playback by pressing any key |
| `post_dest` | `body` | `string` | **Yes** | Destination target following playback |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/announcements -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"description":"Holiday Closure Notice","recording_id":6,"post_dest":"app-blackhole,hangup,1"}'
```

#### Example Response

```json
{
  "success": true,
  "announcement_id": 2,
  "message": "Announcement created successfully."
}
```

---

<a id="put-apiconfigannouncementsid"></a>
### `PUT` /api/config/announcements/:id

**Description**: Updates an announcement's description, recording, or post-playback destination.

- **Authentication**: Session Cookie (`config` or `config-announcements` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.announcements`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Announcement ID |
| `description` | `body` | `string` | No | Updated description |
| `recording_id` | `body` | `integer` | No | Updated recording ID |
| `post_dest` | `body` | `string` | No | Updated destination target |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/announcements/2 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"allow_skip":true}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Announcement updated successfully."
}
```

---

<a id="delete-apiconfigannouncementsid"></a>
### `DELETE` /api/config/announcements/:id

**Description**: Deletes an announcement.

- **Authentication**: Session Cookie (`config` or `config-announcements` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.announcements`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Announcement ID to remove |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/announcements/2 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Announcement deleted successfully."
}
```

---

<a id="pbx-time-conditions"></a>
## 17. PBX Configuration: Time Groups & Time Conditions

*Endpoints managing schedule-based call routing, business hours, weekend rules, and holiday overrides.*

<a id="get-apiconfigtimeconditions"></a>
### `GET` /api/config/timeconditions

**Description**: Lists all Time Conditions with their assigned Time Group, matched destination (open hours), and unmatched destination (closed hours).

- **Authentication**: Session Cookie (`config` or `config-timeconditions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.timeconditions`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/timeconditions -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "timeconditions": [
    {"timeconditions_id": 1, "displayname": "Business Hours", "time": 1, "truegoto": "ext-queues,300,1", "falsegoto": "ivr-2,s,1"}
  ]
}
```

---

<a id="post-apiconfigtimeconditions"></a>
### `POST` /api/config/timeconditions

**Description**: Creates a new Time Condition evaluating a Time Group schedule.

- **Authentication**: Session Cookie (`config` or `config-timeconditions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.timeconditions`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `displayname` | `body` | `string` | **Yes** | Condition name |
| `time` | `body` | `integer` | **Yes** | Time Group ID to evaluate |
| `truegoto` | `body` | `string` | **Yes** | Destination when condition matches (e.g. during work hours) |
| `falsegoto` | `body` | `string` | **Yes** | Destination when condition fails (e.g. after hours IVR) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/timeconditions -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"displayname":"Work Hours Routing","time":1,"truegoto":"ext-queues,300,1","falsegoto":"ext-local,101,dest"}'
```

#### Example Response

```json
{
  "success": true,
  "timeconditions_id": 2,
  "message": "Time Condition created successfully."
}
```

---

<a id="put-apiconfigtimeconditionsid"></a>
### `PUT` /api/config/timeconditions/:id

**Description**: Updates destinations, associated Time Group, or manual override for a Time Condition.

- **Authentication**: Session Cookie (`config` or `config-timeconditions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.timeconditions`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Time Condition ID |
| `displayname` | `body` | `string` | No | Updated name |
| `truegoto` | `body` | `string` | No | Updated match destination |
| `falsegoto` | `body` | `string` | No | Updated unmatch destination |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/timeconditions/2 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"truegoto":"ext-queues,305,1"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Time Condition updated successfully."
}
```

---

<a id="delete-apiconfigtimeconditionsid"></a>
### `DELETE` /api/config/timeconditions/:id

**Description**: Deletes a Time Condition.

- **Authentication**: Session Cookie (`config` or `config-timeconditions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.timeconditions`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Time Condition ID to remove |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/timeconditions/2 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Time Condition deleted successfully."
}
```

---

<a id="get-apiconfigtimegroups"></a>
### `GET` /api/config/timegroups

**Description**: Lists all Time Groups with their defined time ranges, active days of the week, and calendar day intervals.

- **Authentication**: Session Cookie (`config` or `config-timeconditions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.timegroups_groups` and `asterisk.timegroups_details`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/timegroups -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "timegroups": [
    {"id": 1, "description": "Standard Work Week (Sun-Thu 9-5)", "times": ["09:00-17:00|sun-thu|*|*"]}
  ]
}
```

---

<a id="post-apiconfigtimegroups"></a>
### `POST` /api/config/timegroups

**Description**: Creates a new Time Group defining weekly schedules or holiday dates.

- **Authentication**: Session Cookie (`config` or `config-timeconditions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts records into `asterisk.timegroups_groups` and `asterisk.timegroups_details`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `description` | `body` | `string` | **Yes** | Time Group label |
| `time_ranges` | `body` | `array` | **Yes** | Array of Asterisk time specifications (e.g. ['09:00-17:00|sun-thu|*|*']) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/timegroups -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"description":"Friday Shifts","time_ranges":["14:00-22:00|fri|*|*"]}'
```

#### Example Response

```json
{
  "success": true,
  "id": 2,
  "message": "Time Group created successfully."
}
```

---

<a id="put-apiconfigtimegroupsid"></a>
### `PUT` /api/config/timegroups/:id

**Description**: Updates time ranges and schedule rules for an existing Time Group.

- **Authentication**: Session Cookie (`config` or `config-timeconditions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.timegroups_groups` and recreates `asterisk.timegroups_details`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Time Group ID |
| `description` | `body` | `string` | No | Updated label |
| `time_ranges` | `body` | `array` | No | Updated Asterisk time range array |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/timegroups/2 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"time_ranges":["13:00-21:00|fri|*|*"]}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Time Group updated successfully."
}
```

---

<a id="delete-apiconfigtimegroupsid"></a>
### `DELETE` /api/config/timegroups/:id

**Description**: Deletes a Time Group.

- **Authentication**: Session Cookie (`config` or `config-timeconditions` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.timegroups_groups` and `asterisk.timegroups_details`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Time Group ID to remove |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/timegroups/2 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Time Group deleted successfully."
}
```

---

<a id="pbx-recordings"></a>
## 18. PBX Configuration: System Recordings & DSP Processing

*Endpoints managing system audio assets, IVR prompts, volume normalization, and digital signal processing (DSP) dynamic gain.*

<a id="get-apiconfigrecordings"></a>
### `GET` /api/config/recordings

**Description**: Lists all registered System Audio Recordings with file size, format, duration, and usage references in IVRs or announcements.

- **Authentication**: Session Cookie (`config` or `config-recordings` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.recordings`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/recordings -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "recordings": [
    {"id": 1, "displayname": "Welcome Greeting", "filename": "custom/welcome"}
  ]
}
```

---

<a id="get-apiconfigrecordingsidinfo"></a>
### `GET` /api/config/recordings/:id/info

**Description**: Retrieves detailed audio metadata (bitrate, sample rate, channels, waveform peak dB) for a system recording.

- **Authentication**: Session Cookie (`config` or `config-recordings` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Executes `ffprobe` on `/var/lib/asterisk/sounds/custom/<filename>`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Recording ID |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/recordings/1/info -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "info": {"format": "wav", "sample_rate": 8000, "channels": 1, "duration": 12.4, "peak_db": -1.2}
}
```

---

<a id="get-apiconfigrecordingsaudioid"></a>
### `GET` /api/config/recordings/audio/:id

**Description**: Streams the audio binary of a system recording with HTTP range request support.

- **Authentication**: Session Cookie (`config` or `config-recordings` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Streams `/var/lib/asterisk/sounds/custom/<filename>.wav`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Recording ID |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/recordings/audio/1 -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: audio/wav
Accept-Ranges: bytes
```

---

<a id="delete-apiconfigrecordingsid"></a>
### `DELETE` /api/config/recordings/:id

**Description**: Deletes a system recording from database and unlinks audio files from Asterisk sounds directory.

- **Authentication**: Session Cookie (`config` or `config-recordings` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.recordings` and removes `/var/lib/asterisk/sounds/custom/<file>.*`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Recording ID to delete |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/recordings/1 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Recording deleted successfully."
}
```

---

<a id="post-apiconfigrecordingsidvolume"></a>
### `POST` /api/config/recordings/:id/volume

**Description**: Adjusts audio volume gain of a system recording in decibels using FFmpeg audio filtering.

- **Authentication**: Session Cookie (`config` or `config-recordings` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Processes file with `ffmpeg -filter:a 'volume=...dB'` and updates audio file in place.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Recording ID |
| `gainDb` | `body` | `number` | **Yes** | Gain adjustment in decibels (e.g. +3.0 or -6.0) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/recordings/1/volume -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"gainDb": 3.5}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Volume adjusted by +3.5 dB."
}
```

---

<a id="post-apiconfigrecordingsiddsp"></a>
### `POST` /api/config/recordings/:id/dsp

**Description**: Applies digital signal processing (highpass, lowpass, noise gate, compand, normalization) to optimize clarity for telephony.

- **Authentication**: Session Cookie (`config` or `config-recordings` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Reruns audio through FFmpeg DSP filters and saves 8kHz 16-bit mono PCM WAV.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Recording ID |
| `denoise` | `body` | `boolean` | No | Apply background noise reduction |
| `normalize` | `body` | `boolean` | No | Apply EBU R128 loudness normalization |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/recordings/1/dsp -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"denoise":true,"normalize":true}'
```

#### Example Response

```json
{
  "success": true,
  "message": "DSP audio filters applied successfully."
}
```

---

<a id="post-apisettingsrecordingsupload"></a>
### `POST` /api/settings/recordings/upload

**Description**: Uploads an audio file to the System Recordings library with automatic transcoding to Asterisk 8kHz mono WAV.

- **Authentication**: Session Cookie (`config` or `config-recordings` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: multipart/form-data
- **System Impact**: Transcodes with FFmpeg, writes to `/var/lib/asterisk/sounds/custom/`, and registers in `asterisk.recordings`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `displayname` | `body` | `string` | **Yes** | Recording title/display name |
| `file` | `body` | `file` | **Yes** | Audio file payload (WAV, MP3, OGG, FLAC) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/settings/recordings/upload -b cookie.txt \
  -F 'displayname=Main IVR Menu' -F 'file=@menu.mp3'
```

#### Example Response

```json
{
  "success": true,
  "recordingId": 5,
  "message": "Recording uploaded and converted successfully."
}
```

---

<a id="pbx-moh"></a>
## 19. PBX Configuration: Music on Hold (MOH) & Audio Globals

*Endpoints managing Music On Hold classes, playlists, file uploads, audio streaming, and global audio parameters.*

<a id="get-apiconfigmoh"></a>
### `GET` /api/config/moh

**Description**: Lists all Music On Hold categories, playlists, mode (files/custom/stream), and track listings.

- **Authentication**: Session Cookie (`config` or `config-moh` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Scans `/var/lib/asterisk/moh/` and reads `/etc/asterisk/musiconhold_additional.conf`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/moh -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "categories": [
    {"name": "default", "type": "files", "files": ["macroform-robot_dity.wav"]}
  ]
}
```

---

<a id="post-apiconfigmohcategory"></a>
### `POST` /api/config/moh/category

**Description**: Creates a new Music On Hold class/category with dedicated directory.

- **Authentication**: Session Cookie (`config` or `config-moh` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Creates `/var/lib/asterisk/moh/<name>` and writes to `/etc/asterisk/musiconhold_additional.conf`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `body` | `string` | **Yes** | MOH category name (alphanumeric, e.g. 'jazz') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/moh/category -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"classical"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "MOH category classical created successfully."
}
```

---

<a id="delete-apiconfigmohcategoryname"></a>
### `DELETE` /api/config/moh/category/:name

**Description**: Deletes a Music On Hold category and its tracks (the 'default' category is protected).

- **Authentication**: Session Cookie (`config` or `config-moh` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Removes directory and updates Asterisk MOH configuration.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `path` | `string` | **Yes** | Category name to remove |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/moh/category/classical -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Category deleted."
}
```

---

<a id="post-apiconfigmohupload"></a>
### `POST` /api/config/moh/upload

**Description**: Uploads an audio track into an MOH category, transcoding to 8kHz mono WAV.

- **Authentication**: Session Cookie (`config` or `config-moh` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: multipart/form-data
- **System Impact**: Converts with FFmpeg and saves into `/var/lib/asterisk/moh/<category>/`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `category` | `body` | `string` | **Yes** | Target MOH category |
| `file` | `body` | `file` | **Yes** | Audio file payload (MP3 or WAV) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/moh/upload -b cookie.txt \
  -F 'category=default' -F 'file=@track1.mp3'
```

#### Example Response

```json
{
  "success": true,
  "message": "Audio track uploaded and converted successfully."
}
```

---

<a id="delete-apiconfigmohfile"></a>
### `DELETE` /api/config/moh/file

**Description**: Deletes a specific audio track from an MOH category directory.

- **Authentication**: Session Cookie (`config` or `config-moh` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Unlinks file from `/var/lib/asterisk/moh/<category>/<file>`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `category` | `body` | `string` | **Yes** | Category name |
| `file` | `body` | `string` | **Yes** | Filename to delete |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/moh/file -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"category":"default","file":"track1.wav"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "File deleted."
}
```

---

<a id="get-apiconfigmohstreamcategoryfile"></a>
### `GET` /api/config/moh/stream/:category/:file

**Description**: Streams an MOH audio track for in-browser preview.

- **Authentication**: Session Cookie (`config` or `config-moh` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Streams audio file with HTTP range headers.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `category` | `path` | `string` | **Yes** | Category name |
| `file` | `path` | `string` | **Yes** | Filename to preview |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/moh/stream/default/track1.wav -b cookie.txt
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: audio/wav
```

---

<a id="get-apiconfigaudio-globals"></a>
### `GET` /api/config/audio-globals

**Description**: Retrieves system-wide global audio settings (default codecs, silence suppression, Comfort Noise Generation (CNG), and global AGC defaults).

- **Authentication**: Session Cookie (`config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads Asterisk audio pipeline parameters.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/audio-globals -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "globals": {"codecs": ["ulaw", "alaw", "g729"], "silenceThreshold": 250, "defaultAgc": "8000"}
}
```

---

<a id="put-apiconfigaudio-globals"></a>
### `PUT` /api/config/audio-globals

**Description**: Updates system-wide audio pipeline globals.

- **Authentication**: Session Cookie (`config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates Asterisk audio settings.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `defaultAgc` | `body` | `string` | No | Default AGC level for new extensions ('8000', '6000', '10000', '12000', 'off') |
| `silenceThreshold` | `body` | `integer` | No | Silence detection threshold in ms |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/audio-globals -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"defaultAgc":"8000"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Audio globals updated."
}
```

---

<a id="pbx-diagram-reload"></a>
## 20. PBX Configuration: Visual Dialplan & Core Reload

*Endpoints providing visual dialplan graph topology and executing live Asterisk configuration compilation without dropping active calls.*

<a id="get-apiconfigdiagram"></a>
### `GET` /api/config/diagram

**Description**: Computes and returns the complete PBX call flow graph topology (Inbound Routes -> Time Conditions -> IVR -> Queues/Ring Groups -> Extensions) for rendering interactive Mermaid/vis.js architecture diagrams.

- **Authentication**: Session Cookie (`config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Performs cross-table graph analysis across `incoming`, `timeconditions`, `ivr_details`, `queues_config`, `ringgroups`, and `users`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/diagram -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "nodes": [
    {"id": "did_1", "label": "DID: 0223456789", "type": "inbound"},
    {"id": "tc_1", "label": "Work Hours", "type": "timecondition"},
    {"id": "q_300", "label": "Support Queue (300)", "type": "queue"}
  ],
  "edges": [
    {"from": "did_1", "to": "tc_1"},
    {"from": "tc_1", "to": "q_300", "label": "Match"}
  ]
}
```

---

<a id="post-apiconfigreload"></a>
### `POST` /api/config/reload

**Description**: Executes an Asterisk dialplan reload (`dialplan reload` and `core reload`) via AMI, applying all uncommitted configuration changes into the active Asterisk PBX memory without dropping in-progress phone calls.

- **Authentication**: Session Cookie (`config` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Fires AMI command `Command: dialplan reload` and `Command: module reload`.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/reload -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Asterisk dialplan reloaded successfully."
}
```

---

<a id="modem-dsp"></a>
## 21. Hardware Modem DSP, JitterBuffer, Gain & RTCP

*Endpoints managing physical USB GSM modem hardware ports, digital signal processing (DSP) speech enhancement, adaptive jitter buffers, gain controls, RTCP voice quality metrics, and slot binding.*

<a id="get-apiconfigmodem"></a>
### `GET` /api/config/modem

**Description**: Retrieves the master modem configuration, active audio filters, rx/tx volume gains, and hardware slot allocations.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.modem_settings` and parses `/etc/asterisk/dongle.conf`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/modem -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "modem": {
    "rxGain": 0,
    "txGain": 0,
    "jitterBufferEnabled": true,
    "denoiseEnabled": true,
    "activeSlots": 4
  }
}
```

---

<a id="get-apiconfigmodemreports"></a>
### `GET` /api/config/modem/reports

**Description**: Retrieves real-time RF health reports, bit error rate (BER), signal quality (CSQ), and dropped frame tallies across all connected modems.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Polls modem serial diagnostic channel (`AT+CSQ`, `AT^HCSQ`).

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/modem/reports -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "reports": [
    {"dongle": "dongle0", "rssi_dbm": -65, "ber": 0, "frame_errors": 0}
  ]
}
```

---

<a id="get-apiconfigmodemrtcp"></a>
### `GET` /api/config/modem/rtcp

**Description**: Retrieves real-time RTCP (Real-time Transport Control Protocol) network voice statistics: jitter, packet round-trip time (RTT), and packet loss percentage.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Aggregates AMI RTCP channel events.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/modem/rtcp -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "stats": {
    "avgJitterMs": 4.2,
    "avgRttMs": 22.1,
    "packetLossPct": 0.02
  }
}
```

---

<a id="post-apiconfigmodemgain"></a>
### `POST` /api/config/modem/gain

**Description**: Updates hardware reception (rx) and transmission (tx) audio gain levels globally or on a specific modem channel.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.modem_settings`, modifies `/etc/asterisk/dongle.conf`, and executes `dongle cmd <dongle> AT^GAIN` via Asterisk CLI.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongle` | `body` | `string` | No | Dongle identifier (or 'all' for global) |
| `rxGain` | `body` | `integer` | **Yes** | Microphone receive gain (-10 to +10) |
| `txGain` | `body` | `integer` | **Yes** | Speaker transmit gain (-10 to +10) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/modem/gain -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"dongle":"dongle0","rxGain":3,"txGain":2}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Gain levels updated successfully."
}
```

---

<a id="post-apiconfigmodemreset"></a>
### `POST` /api/config/modem/reset

**Description**: Resets modem DSP audio parameters and gain configurations back to factory calibrated defaults.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Restores default gain values (rx: 0, tx: 0) in `/etc/asterisk/dongle.conf` and reloads `chan_dongle`.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/modem/reset -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Modem audio settings reset to defaults."
}
```

---

<a id="post-apiconfigmodemdongle-slot"></a>
### `POST` /api/config/modem/dongle-slot

**Description**: Binds a physical USB bus/port topology address to a fixed logical modem slot index, preventing device drift across server reboots.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Saves persistent device mapping in `asterisk.dongle_slots` and updates udev rules.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleName` | `body` | `string` | **Yes** | Logical dongle name (e.g. 'dongle0') |
| `usbBusPort` | `body` | `string` | **Yes** | USB sysfs path (e.g. '1-1.2:1.0') |
| `imei` | `body` | `string` | No | Hardware IMEI identifier |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/modem/dongle-slot -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"dongleName":"dongle0","usbBusPort":"1-1.2:1.0","imei":"353142035570335"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Dongle slot bound successfully."
}
```

---

<a id="delete-apiconfigmodemdongle-slotdonglename"></a>
### `DELETE` /api/config/modem/dongle-slot/:dongleName?

**Description**: Unbinds a physical USB slot mapping for a specific dongle or all dongles.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Removes entries from `asterisk.dongle_slots`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleName` | `path` | `string` | No | Dongle identifier to unbind (omit to unbind all) |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/modem/dongle-slot/dongle0 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Dongle slot unpinned."
}
```

---

<a id="get-apiconfigmodemjitterbuffer"></a>
### `GET` /api/config/modem/jitterbuffer

**Description**: Retrieves the current adaptive jitter buffer configuration parameters.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads Asterisk jitter buffer dialplan variables.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/modem/jitterbuffer -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "jitterbuffer": {
    "enabled": true,
    "type": "adaptive",
    "maxSizeMs": 200,
    "resyncThreshold": 1000
  }
}
```

---

<a id="post-apiconfigmodemjitterbuffer"></a>
### `POST` /api/config/modem/jitterbuffer

**Description**: Updates adaptive jitter buffer settings (max size, drop threshold, resynchronization limits) to eliminate audio stutter on high-latency links.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates Asterisk dialplan hook `/etc/asterisk/extensions_custom.conf` under `[from-pstn-dongle]`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `enabled` | `body` | `boolean` | **Yes** | Enable adaptive jitter buffer |
| `type` | `body` | `string` | No | Buffer algorithm ('adaptive' or 'fixed') |
| `maxSizeMs` | `body` | `integer` | No | Maximum buffer capacity in ms (default: 200) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/modem/jitterbuffer -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"maxSizeMs":250}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Jitter buffer configuration saved."
}
```

---

<a id="get-apiconfigmodemdenoise"></a>
### `GET` /api/config/modem/denoise

**Description**: Retrieves digital background noise reduction and acoustic echo cancellation status for cellular calls.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries Asterisk `DENOISE()` dialplan function configuration.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/modem/denoise -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "denoise": {"enabled": true, "direction": "both"}
}
```

---

<a id="post-apiconfigmodemdenoise"></a>
### `POST` /api/config/modem/denoise

**Description**: Enables or disables real-time DSP background noise filtering (`DENOISE()`) on incoming and outgoing cellular voice streams.

- **Authentication**: Session Cookie (`config` or `config-modem` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates dialplan macro in `/etc/asterisk/extensions_custom.conf`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `enabled` | `body` | `boolean` | **Yes** | Enable DENOISE DSP |
| `direction` | `body` | `string` | No | Audio direction ('rx', 'tx', or 'both') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/modem/denoise -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"direction":"both"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Modem denoise DSP settings updated."
}
```

---

<a id="get-apiconfigdongle-mappings"></a>
### `GET` /api/config/dongle-mappings

**Description**: Lists logical dongle to outbound trunk and SIM card phone number mappings.

- **Authentication**: Session Cookie (`config` or `gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dongle_mappings` and `asterisk.trunks`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/dongle-mappings -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "mappings": [
    {"dongleName": "dongle0", "enabled": true, "phoneNumber": "01012345678", "carrier": "Vodafone"}
  ]
}
```

---

<a id="post-apiconfigdongle-mappingsdonglenametoggle"></a>
### `POST` /api/config/dongle-mappings/:dongleName/toggle

**Description**: Enables or disables routing outbound calls through a specific GSM dongle without physically removing the USB stick.

- **Authentication**: Session Cookie (`config` or `gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.dongle_mappings` and sets Asterisk trunk disabled flag.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleName` | `path` | `string` | **Yes** | Dongle identifier (e.g. 'dongle0') |
| `enabled` | `body` | `boolean` | **Yes** | Target state |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/dongle-mappings/dongle0/toggle -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```

#### Example Response

```json
{
  "success": true,
  "dongleName": "dongle0",
  "enabled": false
}
```

---

<a id="gsm-dongles"></a>
## 22. Hardware GSM Dongles, Cellular Gateways, USSD & SMS

*Endpoints managing USB GSM/LTE modems (Huawei E173, E1750, E1550, etc.), live cellular telemetry (RSSI, provider, registration, IMSI, IMEI), SMS messaging threads, USSD balance queries, call forwarding, and low-level USB hub recovery.*

<a id="get-apigsm-dongles"></a>
### `GET` /api/gsm-dongles

**Description**: Retrieves real-time telemetry for all connected GSM dongles: signal strength RSSI dBm, mobile network operator, registration status, IMEI, IMSI, active call status, and assigned phone number.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Executes `dongle show devices` via AMI, scans USB sysfs tree, and queries `asterisk.dongle_mappings`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/gsm-dongles -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "dongles": [
    {
      "id": "dongle0",
      "model": "Huawei E173",
      "imei": "353142035570335",
      "imsi": "602021234567890",
      "operator": "Vodafone EG",
      "rssi": 19,
      "rssi_dbm": -75,
      "status": "Free",
      "phoneNumber": "01012345678"
    }
  ]
}
```

---

<a id="post-apigsm-donglessave-number"></a>
### `POST` /api/gsm-dongles/save-number

**Description**: Saves or updates the associated phone number / caller ID label for a specific GSM dongle in the database and caller ID routing.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Executes `INSERT ... ON DUPLICATE KEY UPDATE` in `asterisk.dongle_mappings`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `body` | `string` | **Yes** | Dongle identifier (e.g. 'dongle0') |
| `phoneNumber` | `body` | `string` | **Yes** | SIM card phone number (e.g. '01012345678') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/save-number -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"dongleId":"dongle0","phoneNumber":"01099887766"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Phone number saved successfully."
}
```

---

<a id="post-apigsm-donglesreset-usb-port"></a>
### `POST` /api/gsm-dongles/reset-usb-port

**Description**: Performs an electrical power-cycle reset on a specific USB port via `usbreset` utility to recover an unresponsive or locked modem.

- **Authentication**: Session Cookie (`gsm-dongles` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Executes privileged `usbreset` on the specified hardware USB device node.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `bus` | `body` | `string` | **Yes** | USB bus device path (e.g. '/dev/bus/usb/001/005') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/reset-usb-port -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"bus":"/dev/bus/usb/001/005"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "USB port reset signal dispatched."
}
```

---

<a id="post-apigsm-donglesreloaddongleid"></a>
### `POST` /api/gsm-dongles/reload/:dongleId

**Description**: Reloads the Asterisk `chan_dongle` channel driver state for a single dongle without touching other active modems.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Executes AMI command `dongle reload <dongleId>`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `path` | `string` | **Yes** | Dongle identifier to reload (e.g. 'dongle0') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/reload/dongle0 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Dongle dongle0 reloaded successfully."
}
```

---

<a id="post-apigsm-donglesreboot-modemdongleid"></a>
### `POST` /api/gsm-dongles/reboot-modem/:dongleId

**Description**: Sends an `AT+CFUN=1,1` software reboot command to the modem baseband processor over the serial control port.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Dispatches AT command `AT+CFUN=1,1` to modem serial control node.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `path` | `string` | **Yes** | Dongle identifier |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/reboot-modem/dongle0 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Modem reboot command sent."
}
```

---

<a id="post-apigsm-donglesvirtual-replugdongleid"></a>
### `POST` /api/gsm-dongles/virtual-replug/:dongleId

**Description**: Simulates a physical unplug and re-plug event by unbinding and rebinding the USB driver in the Linux sysfs kernel tree.

- **Authentication**: Session Cookie (`gsm-dongles` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Writes device ID to `/sys/bus/usb/drivers/usb/unbind` followed by `bind`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `path` | `string` | **Yes** | Dongle identifier |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/virtual-replug/dongle0 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Virtual replug completed for dongle0."
}
```

---

<a id="post-apigsm-donglesat-diagnosticdongleid"></a>
### `POST` /api/gsm-dongles/at-diagnostic/:dongleId

**Description**: Executes a custom Hayes AT diagnostic command on the modem's secondary AT command port and returns the raw modem response.

- **Authentication**: Session Cookie (`gsm-dongles` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Fires AMI `DongleSendAT` or writes directly to secondary ttyUSB port with timeout protection.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `path` | `string` | **Yes** | Dongle identifier |
| `command` | `body` | `string` | **Yes** | Raw AT command string (e.g. 'AT+COPS?' or 'AT^CARDMODE') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/at-diagnostic/dongle0 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"command":"AT+COPS?"}'
```

#### Example Response

```json
{
  "success": true,
  "command": "AT+COPS?",
  "response": "+COPS: 0,0,\"Vodafone EG\",2\r\n\r\nOK"
}
```

---

<a id="post-apigsm-donglespopulate-hardwaredongleid"></a>
### `POST` /api/gsm-dongles/populate-hardware/:dongleId

**Description**: Interrogates the modem hardware to auto-discover and cache IMEI, IMSI, firmware version, and SIM serial number in Asterisk database.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries AT commands `AT+CGSN`, `AT+CIMI`, `AT+CGMR` and updates `asterisk.dongle_mappings`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `path` | `string` | **Yes** | Dongle identifier |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/populate-hardware/dongle0 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "hardware": {
    "imei": "353142035570335",
    "imsi": "602021234567890",
    "firmware": "21.157.00.00.00"
  }
}
```

---

<a id="post-apigsm-donglesupdate-portsdongleid"></a>
### `POST` /api/gsm-dongles/update-ports/:dongleId

**Description**: Updates the assigned data and audio ttyUSB character devices for a dongle in `/etc/asterisk/dongle.conf`.

- **Authentication**: Session Cookie (`gsm-dongles` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Rewrites configuration block in `/etc/asterisk/dongle.conf` and reloads `chan_dongle`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `path` | `string` | **Yes** | Dongle identifier |
| `dataPort` | `body` | `string` | **Yes** | Data character device (e.g. '/dev/ttyUSB1') |
| `audioPort` | `body` | `string` | **Yes** | Audio character device (e.g. '/dev/ttyUSB2') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/update-ports/dongle0 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"dataPort":"/dev/ttyUSB1","audioPort":"/dev/ttyUSB2"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Serial ports updated for dongle0."
}
```

---

<a id="get-apigsm-donglesaudit"></a>
### `GET` /api/gsm-dongles/audit

**Description**: Audits physical USB ports vs configured `/etc/asterisk/dongle.conf` definitions, identifying orphan devices or port misalignments.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Compares `/sys/bus/usb-serial/devices` against active Asterisk channel drivers.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/gsm-dongles/audit -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "audit": {"configured": 4, "detected": 4, "mismatches": []}
}
```

---

<a id="post-apigsm-donglesreconcile-conf"></a>
### `POST` /api/gsm-dongles/reconcile-conf

**Description**: Automatically reconciles and rewrites `/etc/asterisk/dongle.conf` to match the exact physical hardware USB topology.

- **Authentication**: Session Cookie (`gsm-dongles` permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Overwrites `/etc/asterisk/dongle.conf`, backs up previous version to `.bak`, and reloads Asterisk.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/reconcile-conf -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "dongle.conf reconciled successfully with hardware."
}
```

---

<a id="post-apigsm-donglesredetect"></a>
### `POST` /api/gsm-dongles/redetect

**Description**: Triggers a full kernel USB bus rescan and refreshes Asterisk dongle hardware registry.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Triggers udevadm events and executes `asterisk -rx 'dongle reload now'`.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/redetect -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "detectedCount": 4
}
```

---

<a id="post-apigsm-donglesemit-usb-update"></a>
### `POST` /api/gsm-dongles/emit-usb-update

**Description**: Broadcasts a WebSocket telemetry event to all connected dashboard operator clients with updated dongle statuses.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Emits `dongle_update` event via Socket.IO.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/emit-usb-update -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "emitted": true
}
```

---

<a id="get-apigsm-donglesttyusb-devices"></a>
### `GET` /api/gsm-dongles/ttyusb-devices

**Description**: Enumerates all `/dev/ttyUSB*` character devices with kernel sysfs metadata (vendor ID, product ID, serial, interface number).

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads `/sys/bus/usb-serial/devices/`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/gsm-dongles/ttyusb-devices -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "devices": [
    {"port": "/dev/ttyUSB0", "vendor": "12d1", "product": "1001", "driver": "option"}
  ]
}
```

---

<a id="post-apigsm-donglesussd"></a>
### `POST` /api/gsm-dongles/ussd

**Description**: Dispatches an interactive or standard Unstructured Supplementary Service Data (USSD) code (e.g. *888# or *100#) to query prepaid balance or bundle quotas.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Executes AMI `DongleSendUSSD` and monitors AMI `DongleNewUSSD` response event.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `body` | `string` | **Yes** | Dongle identifier |
| `code` | `body` | `string` | **Yes** | USSD dial string (e.g. '*888#' or '*100#') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/ussd -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"dongleId":"dongle0","code":"*888#"}'
```

#### Example Response

```json
{
  "success": true,
  "dongleId": "dongle0",
  "response": "Your current balance is 45.50 EGP. Valid until 2026-12-31."
}
```

---

<a id="post-apigsm-donglescall-forwarding"></a>
### `POST` /api/gsm-dongles/call-forwarding

**Description**: Configures cellular network-level unconditional or busy call forwarding on the SIM card via GSM MMI codes (*21*, ##002#).

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Sends MMI USSD string (`*21*<number>#` or `##002#`) via `chan_dongle`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `body` | `string` | **Yes** | Dongle identifier |
| `action` | `body` | `string` | **Yes** | Action ('enable' or 'cancel') |
| `forwardNumber` | `body` | `string` | No | Target forwarding number (required if action is 'enable') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/call-forwarding -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"dongleId":"dongle0","action":"enable","forwardNumber":"01012345678"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Call forwarding enabled on SIM card."
}
```

---

<a id="get-apigsm-donglessms"></a>
### `GET` /api/gsm-dongles/sms

**Description**: Retrieves stored SMS text messages, grouped into conversational threads by phone number with unread badges.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dongle_sms` table.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `query` | `string` | No | Filter by dongle |
| `limit` | `query` | `integer` | No | Max threads (default: 50) |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/api/gsm-dongles/sms?dongleId=dongle0' -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "threads": [
    {
      "phone": "01012345678",
      "lastMessage": "Your verification code is 884122",
      "timestamp": "2026-09-28T14:15:00Z",
      "unreadCount": 1
    }
  ]
}
```

---

<a id="post-apigsm-donglessend-sms"></a>
### `POST` /api/gsm-dongles/send-sms

**Description**: Transmits an outbound SMS text message via a specific GSM dongle.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Executes AMI `DongleSendSMS` action and logs message into `asterisk.dongle_sms`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `body` | `string` | **Yes** | Dongle identifier to send through |
| `to` | `body` | `string` | **Yes** | Destination mobile telephone number |
| `message` | `body` | `string` | **Yes** | SMS message text body (supports standard GSM 7-bit and UCS-2 Arabic) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/send-sms -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"dongleId":"dongle0","to":"01012345678","message":"Hello from Sokrat PBX!"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "SMS queued and dispatched successfully."
}
```

---

<a id="post-apigsm-donglesclear-sms"></a>
### `POST` /api/gsm-dongles/clear-sms

**Description**: Clears incoming SMS storage buffer on the SIM card to prevent memory overflow errors.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Sends `AT+CMGD=1,4` (delete all SMS) to modem serial channel.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `dongleId` | `body` | `string` | **Yes** | Dongle identifier |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/clear-sms -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"dongleId":"dongle0"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "SIM card SMS storage cleared."
}
```

---

<a id="post-apigsm-donglesdelete-thread"></a>
### `POST` /api/gsm-dongles/delete-thread

**Description**: Deletes an entire SMS conversational history thread for a specific telephone number from the database.

- **Authentication**: Session Cookie (`gsm-dongles` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Deletes rows from `asterisk.dongle_sms` matching `sender` or `recipient`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `phone` | `body` | `string` | **Yes** | Telephone number thread to delete |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/gsm-dongles/delete-thread -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"phone":"01012345678"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "SMS conversation thread deleted."
}
```

---

<a id="progressive-dialer"></a>
## 23. Progressive Outbound Campaign Dialer & Leads

*Endpoints managing the automated progressive outbound dialer engine: campaign creation, lead spreadsheet uploads, real-time pacing control, agent bridging, call dispositions, Do Not Call (DNC) lists, and lead recycle workflows.*

<a id="get-apidialercampaigns"></a>
### `GET` /api/dialer/campaigns

**Description**: Lists all outbound calling campaigns with their active statuses, total leads, completed leads, answered ratio, and assigned trunk/dongle channels.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dialer_campaigns` and aggregates lead metrics.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/dialer/campaigns -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "campaigns": [
    {
      "id": 1,
      "name": "September Renewals",
      "status": "running",
      "total_leads": 500,
      "dialed_leads": 142,
      "answered_leads": 98
    }
  ]
}
```

---

<a id="get-apidialercampaignsid"></a>
### `GET` /api/dialer/campaigns/:id

**Description**: Retrieves comprehensive details, dialer configuration, agent rosters, and pacing parameters for a single campaign.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dialer_campaigns`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Campaign ID |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/dialer/campaigns/1 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "campaign": {
    "id": 1,
    "name": "September Renewals",
    "concurrency": 2,
    "max_retries": 3,
    "retry_delay_minutes": 60,
    "destination_type": "queue",
    "destination_target": "300"
  }
}
```

---

<a id="post-apidialercampaigns"></a>
### `POST` /api/dialer/campaigns

**Description**: Creates a new progressive outbound dialing campaign.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.dialer_campaigns`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `body` | `string` | **Yes** | Campaign name |
| `destination_type` | `body` | `string` | **Yes** | Target upon answer ('queue', 'extension', 'ivr', 'announcement') |
| `destination_target` | `body` | `string` | **Yes** | Target ID or extension (e.g. '300') |
| `trunk_id` | `body` | `integer` | No | Assigned outbound trunk ID (or dongle) |
| `concurrency` | `body` | `integer` | No | Max simultaneous outbound calls (default: 1) |
| `max_retries` | `body` | `integer` | No | Max retry attempts on unanswered leads (default: 3) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/dialer/campaigns -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"Telesales Q4","destination_type":"queue","destination_target":"300","concurrency":3}'
```

#### Example Response

```json
{
  "success": true,
  "campaignId": 2,
  "message": "Campaign created successfully."
}
```

---

<a id="put-apidialercampaignsid"></a>
### `PUT` /api/dialer/campaigns/:id

**Description**: Modifies configuration, concurrency limits, or target destinations for an existing campaign.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.dialer_campaigns`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Campaign ID |
| `name` | `body` | `string` | No | Updated name |
| `concurrency` | `body` | `integer` | No | Updated concurrency level |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/dialer/campaigns/2 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"concurrency":5}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Campaign updated."
}
```

---

<a id="post-apidialercampaignsidcontrol"></a>
### `POST` /api/dialer/campaigns/:id/control

**Description**: Controls campaign execution state: start, pause, resume, or abort.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `status` in `asterisk.dialer_campaigns` and triggers or stops dialer engine worker loop.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Campaign ID |
| `action` | `body` | `string` | **Yes** | Control action: 'start', 'pause', 'resume', or 'stop' |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/dialer/campaigns/2/control -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"action":"start"}'
```

#### Example Response

```json
{
  "success": true,
  "status": "running",
  "message": "Campaign started."
}
```

---

<a id="get-apidialerattemptsrecent"></a>
### `GET` /api/dialer/attempts/recent

**Description**: Retrieves the live ledger of recent outbound dial attempts, live call states, and trunk allocations.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dialer_attempts`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/dialer/attempts/recent -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "attempts": [
    {"lead_id": 450, "phone": "01012345678", "status": "answered", "duration": 35}
  ]
}
```

---

<a id="get-apidialerdongles"></a>
### `GET` /api/dialer/dongles

**Description**: Lists GSM dongles eligible and available for assignment to outbound dialer campaigns.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Filters online dongles from `chan_dongle`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/dialer/dongles -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "dongles": [{"id": "dongle0", "available": true}]
}
```

---

<a id="get-apidialerleadstemplate"></a>
### `GET` /api/dialer/leads/template

**Description**: Downloads the official CSV lead import template formatted with required columns (`phone`, `name`, `notes`, `custom_field`).

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Streams static CSV template file.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/dialer/leads/template -b cookie.txt -O -J
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: text/csv
Content-Disposition: attachment; filename="leads_template.csv"
```

---

<a id="get-apidialerleadscampaignid"></a>
### `GET` /api/dialer/leads/:campaignId

**Description**: Retrieves paginated list of leads assigned to a campaign, including call statuses, retry counts, and call outcomes.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dialer_leads`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `campaignId` | `path` | `integer` | **Yes** | Campaign ID |
| `status` | `query` | `string` | No | Filter by status ('pending', 'completed', 'failed') |
| `page` | `query` | `integer` | No | Page number (default: 1) |
| `limit` | `query` | `integer` | No | Records per page (default: 50) |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/api/dialer/leads/2?status=pending' -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "leads": [
    {"id": 101, "phone": "01012345678", "name": "Ahmed", "status": "pending", "attempts": 0}
  ]
}
```

---

<a id="post-apidialerleads"></a>
### `POST` /api/dialer/leads

**Description**: Adds an individual lead directly to a dialing campaign.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.dialer_leads`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `campaign_id` | `body` | `integer` | **Yes** | Campaign ID |
| `phone` | `body` | `string` | **Yes** | Lead phone number |
| `name` | `body` | `string` | No | Lead contact name |
| `notes` | `body` | `string` | No | Customer notes |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/dialer/leads -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"campaign_id":2,"phone":"01099887766","name":"Kareem"}'
```

#### Example Response

```json
{
  "success": true,
  "leadId": 102,
  "message": "Lead added successfully."
}
```

---

<a id="post-apidialerleadsimport"></a>
### `POST` /api/dialer/leads/import

**Description**: Bulk imports leads into a campaign from a CSV or Excel (.xlsx) file, automatically filtering duplicates and DNC numbers.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: multipart/form-data
- **System Impact**: Parses spreadsheet, performs phone number normalization, checks `dialer_dnc`, and batch inserts into `asterisk.dialer_leads`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `campaignId` | `body` | `integer` | **Yes** | Target Campaign ID |
| `file` | `body` | `file` | **Yes** | CSV or XLSX file payload |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/dialer/leads/import -b cookie.txt \
  -F 'campaignId=2' -F 'file=@leads.csv'
```

#### Example Response

```json
{
  "success": true,
  "importedCount": 450,
  "duplicatesSkipped": 12,
  "dncSkipped": 3
}
```

---

<a id="delete-apidialerleadsid"></a>
### `DELETE` /api/dialer/leads/:id

**Description**: Removes a lead from a campaign queue.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.dialer_leads`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Lead ID to delete |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/dialer/leads/102 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Lead removed."
}
```

---

<a id="post-apidialerleadsidreset"></a>
### `POST` /api/dialer/leads/:id/reset

**Description**: Resets a completed or failed lead back to 'pending' state, clearing its attempt counter to allow redialing.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Updates `status = 'pending'` and `attempts = 0` in `asterisk.dialer_leads`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Lead ID to reset |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/dialer/leads/101/reset -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Lead reset for redialing."
}
```

---

<a id="get-apidialercampaignsidexport"></a>
### `GET` /api/dialer/campaigns/:id/export

**Description**: Exports campaign lead results and disposition audit trail to an Excel workbook (.xlsx).

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Compiles Excel report of campaign leads and streams attachment.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Campaign ID |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/dialer/campaigns/2/export -b cookie.txt -O -J
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Disposition: attachment; filename="campaign-2-results.xlsx"
```

---

<a id="post-apidialerdisposition"></a>
### `POST` /api/dialer/disposition

**Description**: Submits a call outcome disposition code and agent wrap-up notes for a dialed lead.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.dialer_leads` and creates log in `asterisk.dialer_lead_dispositions`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `leadId` | `body` | `integer` | **Yes** | Lead ID |
| `disposition` | `body` | `string` | **Yes** | Disposition code ('INTERESTED', 'NOT_INTERESTED', 'CALLBACK', 'WRONG_NUMBER') |
| `notes` | `body` | `string` | No | Agent call notes |
| `callbackDate` | `body` | `string` | No | Scheduled callback timestamp |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/dialer/disposition -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"leadId":101,"disposition":"INTERESTED","notes":"Client requested proposal via WhatsApp."}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Disposition recorded successfully."
}
```

---

<a id="get-apidialerdispositions"></a>
### `GET` /api/dialer/dispositions

**Description**: Lists all available disposition categories and wrap-up codes configured in the system.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dialer_dispositions_master`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/dialer/dispositions -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "dispositions": ["INTERESTED", "NOT_INTERESTED", "BUSY", "NO_ANSWER", "CALLBACK"]
}
```

---

<a id="get-apidialerdnc"></a>
### `GET` /api/dialer/dnc

**Description**: Retrieves the campaign Do Not Call (DNC) exclusion list with phone numbers, add dates, and reasons.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.dialer_dnc`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/dialer/dnc -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "dnc": [{"phone": "01000000000", "reason": "Customer request"}]
}
```

---

<a id="post-apidialerdnc"></a>
### `POST` /api/dialer/dnc

**Description**: Adds a telephone number to the global Do Not Call (DNC) list, preventing all campaigns from dialing it.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.dialer_dnc` and marks existing matching pending leads as cancelled.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `phone` | `body` | `string` | **Yes** | Phone number to blacklist from campaigns |
| `reason` | `body` | `string` | No | Reason for adding |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/dialer/dnc -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"phone":"01011112222","reason":"Explicit opt-out"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Phone added to Do Not Call list."
}
```

---

<a id="delete-apidialerdncphone"></a>
### `DELETE` /api/dialer/dnc/:phone

**Description**: Removes a telephone number from the Do Not Call (DNC) list.

- **Authentication**: Session Cookie (`dialer` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes row from `asterisk.dialer_dnc`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `phone` | `path` | `string` | **Yes** | Phone number to unblock |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/dialer/dnc/01011112222 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Number removed from DNC list."
}
```

---

<a id="crm-integration"></a>
## 24. CRM Integration REST API v1 & WebSocket Stream

*High-security REST API and WebSocket interfaces engineered for third-party CRM systems (Salesforce, HubSpot, Zoho, Bitrix24, ERPNext). Supports token pairing, scoped Bearer token auth, real-time extension presence, customer CDR history, audio stream retrieval, and single-use iframe embed tickets.*

<a id="get-apiintegrationscrmv1health"></a>
### `GET` /api/integrations/crm/v1/health

**Description**: Public health check endpoint validating CRM integration service availability and API version.

- **Authentication**: Public
- **Headers**: None required
- **System Impact**: Reads system version and health.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/integrations/crm/v1/health
```

#### Example Response

```json
{
  "service": "sokrat-voip",
  "status": "ok",
  "api_version": "1.0",
  "application_version": "1.0.4",
  "timestamp": "2026-09-28T14:45:00.000Z"
}
```

---

<a id="post-apiintegrationscrmv1pair"></a>
### `POST` /api/integrations/crm/v1/pair

**Description**: Exchanges a temporary 6-digit cryptographic pairing code generated in the Sokrat GUI for an API access token, client ID, and webhook secret.

- **Authentication**: Public (Rate limited: max 5 attempts/minute/IP)
- **Headers**: Content-Type: application/json
- **System Impact**: Marks pairing code as used in `crm_pairing_codes`, generates cryptographically random token, hashes token with SHA-256, and stores client in `crm_integration_clients`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `pairing_code` | `body` | `string` | **Yes** | 6-digit pairing code |
| `crm_name` | `body` | `string` | **Yes** | CRM platform name (e.g. 'Zoho CRM') |
| `crm_instance_url` | `body` | `string` | No | Origin URL of CRM tenant |
| `requested_scopes` | `body` | `array` | No | Requested permissions ('calls:read', 'recordings:read', 'extensions:read', 'embed:live') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/integrations/crm/v1/pair \
  -H 'Content-Type: application/json' \
  -d '{"pairing_code":"839104","crm_name":"Zoho Production"}'
```

#### Example Response

```json
{
  "success": true,
  "client_id": "crm_c1a2b3d4...",
  "access_token": "crm_tok_live_9f8e7d...",
  "token_type": "Bearer",
  "scopes": ["calls:read", "recordings:read", "extensions:read", "embed:live"]
}
```

---

<a id="get-apiintegrationscrmv1capabilities"></a>
### `GET` /api/integrations/crm/v1/capabilities

**Description**: Returns supported API scopes, telephony features, and WebSocket endpoints available to the authenticated integration client.

- **Authentication**: Bearer Token (`Authorization: Bearer <token>`)
- **Headers**: Authorization: Bearer <access_token>
- **System Impact**: Validates Bearer token in `crm_integration_clients`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/integrations/crm/v1/capabilities \
  -H 'Authorization: Bearer crm_tok_live_9f8e7d...'
```

#### Example Response

```json
{
  "supported_scopes": ["calls:read", "recordings:read", "extensions:read", "embed:live"],
  "supported_features": {
    "webrtc_softphone": true,
    "live_call_events": true,
    "recording_byte_ranges": true
  }
}
```

---

<a id="get-apiintegrationscrmv1extensions"></a>
### `GET` /api/integrations/crm/v1/extensions

**Description**: Retrieves real-time status of all extensions: online state, call status, duration, and call partner party.

- **Authentication**: Bearer Token (requires `extensions:read` scope)
- **Headers**: Authorization: Bearer <access_token>
- **System Impact**: Queries Asterisk users and in-memory live channel maps.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/integrations/crm/v1/extensions \
  -H 'Authorization: Bearer crm_tok_live_9f8e7d...'
```

#### Example Response

```json
{
  "extensions": [
    {
      "extension": "101",
      "name": "Alice",
      "online": true,
      "in_call": true,
      "status": "in_call",
      "call": {
        "state": "In Call",
        "partner": "01012345678",
        "duration_seconds": 54
      }
    }
  ]
}
```

---

<a id="get-apiintegrationscrmv1calls"></a>
### `GET` /api/integrations/crm/v1/calls

**Description**: Retrieves normalized call history for a customer telephone number matching international formats (e.g. +2010..., 010..., 002010...).

- **Authentication**: Bearer Token (requires `calls:read` scope)
- **Headers**: Authorization: Bearer <access_token>
- **System Impact**: Executes phone normalization and queries `asteriskcdrdb.cdr`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `phone` | `query` | `string` | **Yes** | Customer phone number |
| `limit` | `query` | `integer` | No | Max records (default: 20) |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/api/integrations/crm/v1/calls?phone=01012345678' \
  -H 'Authorization: Bearer crm_tok_live_9f8e7d...'
```

#### Example Response

```json
{
  "phone": "01012345678",
  "total_calls": 3,
  "calls": [
    {
      "uniqueid": "1727440000.12",
      "timestamp": "2026-09-28 12:00:00",
      "direction": "inbound",
      "disposition": "ANSWERED",
      "duration": 120,
      "recording_available": true
    }
  ]
}
```

---

<a id="get-apiintegrationscrmv1recordingsmediaid"></a>
### `GET` /api/integrations/crm/v1/recordings/:mediaId

**Description**: Streams a call recording audio file directly to the CRM interface with byte-range support.

- **Authentication**: Bearer Token (requires `recordings:read` scope)
- **Headers**: Authorization: Bearer <access_token>, Range: bytes=0- (optional)
- **System Impact**: Resolves recording file path and streams audio with HTTP 200 or 206.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `mediaId` | `path` | `string` | **Yes** | Asterisk Call Unique ID |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/integrations/crm/v1/recordings/1727440000.12 \
  -H 'Authorization: Bearer crm_tok_live_9f8e7d...'
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: audio/wav
Accept-Ranges: bytes
```

---

<a id="get-apiintegrationscrmv1extensionsextensionstats"></a>
### `GET` /api/integrations/crm/v1/extensions/:extension/stats

**Description**: Retrieves performance analytics for a single extension specifically formatted for CRM agent dashboards.

- **Authentication**: Bearer Token (requires `extensions:read` scope)
- **Headers**: Authorization: Bearer <access_token>
- **System Impact**: Aggregates CDR stats for extension.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `path` | `string` | **Yes** | Extension number |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/integrations/crm/v1/extensions/101/stats \
  -H 'Authorization: Bearer crm_tok_live_9f8e7d...'
```

#### Example Response

```json
{
  "extension": "101",
  "total_calls": 45,
  "answered": 42,
  "talk_time_minutes": 95.5
}
```

---

<a id="post-apiintegrationscrmv1embed-tickets"></a>
### `POST` /api/integrations/crm/v1/embed-tickets

**Description**: Issues a single-use cryptographically signed embed ticket to securely render the softphone widget inside an iframe.

- **Authentication**: Bearer Token (requires `embed:live` scope)
- **Headers**: Authorization: Bearer <access_token>, Content-Type: application/json
- **System Impact**: Generates 15-minute single-use ticket in `asterisk.crm_embed_tickets`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `extension` | `body` | `string` | **Yes** | Agent extension number to embed |
| `origin_url` | `body` | `string` | No | Domain embedding the softphone (for CSP framing validation) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/integrations/crm/v1/embed-tickets \
  -H 'Authorization: Bearer crm_tok_live_9f8e7d...' \
  -H 'Content-Type: application/json' \
  -d '{"extension":"101"}'
```

#### Example Response

```json
{
  "success": true,
  "ticket": "emb_a1b2c3d4e5f6...",
  "embed_url": "/embed/crm/live?ticket=emb_a1b2c3d4e5f6...",
  "expires_in_seconds": 900
}
```

---

<a id="post-integrationscrmpairing-code"></a>
### `POST` /integrations/crm/pairing-code

**Description**: Generates a fresh 6-digit numeric pairing code in the Sokrat GUI to authorize a new CRM system.

- **Authentication**: Session Cookie (`crm_integration` action permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Inserts 6-digit code with 10-minute expiry into `asterisk.crm_pairing_codes`.

#### Example Request

```bash
curl -X POST http://localhost:8080/integrations/crm/pairing-code -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "pairing_code": "839104",
  "expires_in_minutes": 10
}
```

---

<a id="post-integrationscrmclientsidrevoke"></a>
### `POST` /integrations/crm/clients/:id/revoke

**Description**: Instantly revokes an active CRM API client, invalidating all associated tokens and closing open socket connections.

- **Authentication**: Session Cookie (`crm_integration` action permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Updates `status = 'revoked'` in `asterisk.crm_integration_clients`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `string` | **Yes** | Client ID (e.g. 'crm_c1a2b3...') |

#### Example Request

```bash
curl -X POST http://localhost:8080/integrations/crm/clients/crm_c1a2b3/revoke -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "CRM integration client revoked."
}
```

---

<a id="post-integrationscrmclientsidrotate"></a>
### `POST` /integrations/crm/clients/:id/rotate

**Description**: Rotates the access token secret for an active CRM client while preserving client configuration and scopes.

- **Authentication**: Session Cookie (`crm_integration` action permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Generates new token hash in `asterisk.crm_integration_clients`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `string` | **Yes** | Client ID |

#### Example Request

```bash
curl -X POST http://localhost:8080/integrations/crm/clients/crm_c1a2b3/rotate -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "new_token": "crm_tok_live_newsecret123..."
}
```

---

<a id="post-integrationscrmclientsidupdate"></a>
### `POST` /integrations/crm/clients/:id/update

**Description**: Updates permitted scopes or default country code for an existing CRM integration client.

- **Authentication**: Session Cookie (`crm_integration` action permission or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.crm_integration_clients`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `string` | **Yes** | Client ID |
| `scopes` | `body` | `array` | No | Updated scopes array |
| `default_country_code` | `body` | `string` | No | Country dialing prefix (e.g. '20') |

#### Example Request

```bash
curl -X POST http://localhost:8080/integrations/crm/clients/crm_c1a2b3/update -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"scopes":["calls:read","recordings:read"]}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Client updated."
}
```

---

<a id="stt-transcription"></a>
## 25. Speech-to-Text (STT) AI Transcription Engine

*Endpoints managing AI-powered voice call and voicemail transcription services (Whisper, Vosk, Google Cloud Speech, OpenAI), language models, asynchronous queue workers, and transcript search.*

<a id="get-apitranscriptscalluniqueid"></a>
### `GET` /api/transcripts/call/:uniqueid

**Description**: Retrieves the AI-generated text transcript, confidence score, speaker diarization, and word-level timestamps for a call recording.

- **Authentication**: Session Cookie (`call_history` or `config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.call_transcripts`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `uniqueid` | `path` | `string` | **Yes** | Call recording unique identifier (e.g. '1727440000.12') |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/transcripts/call/1727440000.12 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "transcript": {
    "uniqueid": "1727440000.12",
    "status": "completed",
    "text": "Hello, thank you for calling Sokrat customer support. How can I help you today?",
    "language": "en",
    "confidence": 0.96
  }
}
```

---

<a id="post-apitranscriptscalluniqueidtranscribe"></a>
### `POST` /api/transcripts/call/:uniqueid/transcribe

**Description**: Dispatches an asynchronous transcription worker job for a specific call recording using the configured STT engine.

- **Authentication**: Session Cookie (`call_history` or `config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Locates audio file, queues background STT worker, and sets status to 'processing' in `asterisk.call_transcripts`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `uniqueid` | `path` | `string` | **Yes** | Call recording unique identifier |
| `language` | `body` | `string` | No | Language hint (e.g. 'ar', 'en', 'auto') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/transcripts/call/1727440000.12/transcribe -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"language":"auto"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Transcription job queued successfully.",
  "status": "processing"
}
```

---

<a id="get-apitranscriptsvoicemailmailboxfile"></a>
### `GET` /api/transcripts/voicemail/:mailbox/:file

**Description**: Retrieves the transcript for a voicemail message audio file.

- **Authentication**: Session Cookie (`voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.voicemail_transcripts`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `mailbox` | `path` | `string` | **Yes** | Voicemail mailbox number |
| `file` | `path` | `string` | **Yes** | Audio filename (e.g. 'msg0000.wav') |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/transcripts/voicemail/101/msg0000.wav -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "transcript": {
    "mailbox": "101",
    "file": "msg0000.wav",
    "text": "Hi Alice, please call me back regarding invoice 402.",
    "confidence": 0.94
  }
}
```

---

<a id="post-apitranscriptsvoicemailmailboxfiletranscribe"></a>
### `POST` /api/transcripts/voicemail/:mailbox/:file/transcribe

**Description**: Enqueues an AI transcription job for a voicemail message.

- **Authentication**: Session Cookie (`voicemails` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Transcodes audio to 16kHz mono and sends to STT worker.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `mailbox` | `path` | `string` | **Yes** | Voicemail mailbox number |
| `file` | `path` | `string` | **Yes** | Audio filename |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/transcripts/voicemail/101/msg0000.wav/transcribe -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Voicemail transcription job enqueued."
}
```

---

<a id="get-apiconfigstt"></a>
### `GET` /api/config/stt

**Description**: Retrieves the active Speech-to-Text configuration (engine provider, API endpoint, model size, auto-transcribe rules).

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.stt_settings`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/stt -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "config": {
    "provider": "whisper-local",
    "model": "base",
    "autoTranscribeVoicemail": true,
    "autoTranscribeCalls": false,
    "defaultLanguage": "ar"
  }
}
```

---

<a id="put-apiconfigstt"></a>
### `PUT` /api/config/stt

**Description**: Updates Speech-to-Text provider credentials, local engine parameters, or auto-transcription toggles.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.stt_settings`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `provider` | `body` | `string` | **Yes** | Provider ('whisper-local', 'openai', 'vosk', 'google') |
| `apiKey` | `body` | `string` | No | API key for cloud services |
| `model` | `body` | `string` | No | Model identifier (e.g. 'whisper-1' or 'base') |
| `autoTranscribeVoicemail` | `body` | `boolean` | No | Auto-transcribe new voicemails |
| `defaultLanguage` | `body` | `string` | No | Default speech recognition language |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/stt -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"provider":"openai","apiKey":"sk-...","model":"whisper-1","defaultLanguage":"ar"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "STT configuration updated successfully."
}
```

---

<a id="post-apiconfigstttest-connection"></a>
### `POST` /api/config/stt/test-connection

**Description**: Sends a synthetic audio sample to test the active STT provider and validates API authentication and latency.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Sends sample audio probe to configured STT backend.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/stt/test-connection -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "latency_ms": 245,
  "transcription": "Test connection successful."
}
```

---

<a id="post-apitranscriptsscan"></a>
### `POST` /api/transcripts/scan

**Description**: Scans historical untranscribed call recordings within a date range and queues batch transcription jobs.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Batches calls from `asteriskcdrdb.cdr` and creates pending records in `asterisk.call_transcripts`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `startDate` | `body` | `string` | **Yes** | Start date (YYYY-MM-DD) |
| `endDate` | `body` | `string` | **Yes** | End date (YYYY-MM-DD) |
| `maxJobs` | `body` | `integer` | No | Maximum calls to queue (default: 50) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/transcripts/scan -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"startDate":"2026-09-27","endDate":"2026-09-28","maxJobs":25}'
```

#### Example Response

```json
{
  "success": true,
  "queuedCount": 25
}
```

---

<a id="federation"></a>
## 26. Multi-Site PBX Federation & Centralized Routing

*Endpoints managing multi-branch PBX clustering, IAX2/SIP inter-office trunks, automatic remote peer synchronization, health heartbeats, centralized dialplan routing, and distributed GSM dongle pooling across geographic locations.*

<a id="get-apiconfigfederationsettings"></a>
### `GET` /api/config/federation/settings

**Description**: Retrieves local PBX federation cluster identity, node role (hub or satellite branch), cluster secret, and inter-branch dialing prefix.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.federation_settings`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/federation/settings -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "settings": {
    "node_id": "cairo-hq",
    "role": "hub",
    "inter_branch_prefix": "8",
    "auto_sync": true
  }
}
```

---

<a id="put-apiconfigfederationsettings"></a>
### `PUT` /api/config/federation/settings

**Description**: Updates federation cluster settings, inter-site prefix, or secret key.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.federation_settings`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `node_id` | `body` | `string` | **Yes** | Unique cluster node ID |
| `role` | `body` | `string` | **Yes** | Role: 'hub' or 'branch' |
| `inter_branch_prefix` | `body` | `string` | No | Prefix for remote extensions (e.g. '8') |
| `cluster_secret` | `body` | `string` | No | Shared cluster authentication secret |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/federation/settings -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"node_id":"cairo-hq","role":"hub","inter_branch_prefix":"8"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Federation settings updated successfully."
}
```

---

<a id="get-apiconfigfederationpeers"></a>
### `GET` /api/config/federation/peers

**Description**: Lists all registered remote PBX branch peers with IP/FQDN, technology, round-trip latency, and sync status.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.federation_peers` and tests live ping.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/config/federation/peers -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "peers": [
    {
      "id": 1,
      "name": "Alexandria Branch",
      "host": "192.168.10.1",
      "status": "online",
      "rtt_ms": 14,
      "synced_extensions": 25
    }
  ]
}
```

---

<a id="post-apiconfigfederationpeers"></a>
### `POST` /api/config/federation/peers

**Description**: Registers a new remote PBX peer node in the federation mesh.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.federation_peers` and configures inter-site IAX2 trunk in Asterisk.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `body` | `string` | **Yes** | Branch name (e.g. 'Dubai Office') |
| `host` | `body` | `string` | **Yes** | Remote host IP or domain |
| `port` | `body` | `integer` | No | Port (default: 8080 or 5060) |
| `tech` | `body` | `string` | No | Protocol: 'iax2' (default) or 'sip' |
| `secret` | `body` | `string` | **Yes** | Authentication secret |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/federation/peers -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dubai Office","host":"dubai.corp.com","secret":"ClusterPass123"}'
```

#### Example Response

```json
{
  "success": true,
  "peerId": 2,
  "message": "Remote PBX peer registered."
}
```

---

<a id="put-apiconfigfederationpeersid"></a>
### `PUT` /api/config/federation/peers/:id

**Description**: Updates configuration parameters or credentials for an existing remote PBX peer.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.federation_peers`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Peer ID |
| `name` | `body` | `string` | No | Updated branch name |
| `host` | `body` | `string` | No | Updated IP/FQDN |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/config/federation/peers/2 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"host":"vpn.dubai.corp.com"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Peer updated successfully."
}
```

---

<a id="delete-apiconfigfederationpeersid"></a>
### `DELETE` /api/config/federation/peers/:id

**Description**: Deletes a remote peer and dismantles associated inter-branch voice trunks.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.federation_peers` and removes inter-site routes.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Peer ID to remove |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/config/federation/peers/2 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Peer deleted."
}
```

---

<a id="post-apiconfigfederationpeersidsync"></a>
### `POST` /api/config/federation/peers/:id/sync

**Description**: Initiates an immediate mutual dialplan synchronization pulling extensions and dongles from the remote PBX node.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `/api/federation/v1/extensions` on remote node and updates local remote routing tables.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Peer ID to sync |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/federation/peers/1/sync -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "synced_extensions": 25,
  "synced_dongles": 2
}
```

---

<a id="post-apiconfigfederationpeersidqualify"></a>
### `POST` /api/config/federation/peers/:id/qualify

**Description**: Performs an active SIP/IAX2 latency ping (qualify) against the remote peer and returns round-trip time.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Executes Asterisk qualify probe.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Peer ID |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/federation/peers/1/qualify -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "status": "REACHABLE",
  "rtt_ms": 12.8
}
```

---

<a id="post-apiconfigfederationbootstrap"></a>
### `POST` /api/config/federation/bootstrap

**Description**: Automatically provisions all inter-branch dialplan hooks, IAX2 trunks, and prefix routing rules for a connected peer.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Writes `/etc/asterisk/extensions_custom.conf` under `[from-internal-custom]` and reloads dialplan.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `peer_id` | `body` | `integer` | **Yes** | Peer ID to bootstrap |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/federation/bootstrap -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"peer_id":1}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Federation dialplan bootstrapped successfully."
}
```

---

<a id="post-apiconfigfederationremote-cleanup"></a>
### `POST` /api/config/federation/remote-cleanup

**Description**: Cleans up stale cached extensions and routes from disconnected or decommissioned federation nodes.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Purges unreachable peer entries from local cache.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/config/federation/remote-cleanup -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "cleanedCount": 14
}
```

---

<a id="get-apifederationv1extensions"></a>
### `GET` /api/federation/v1/extensions

**Description**: Public/Peer inter-node endpoint exposing local extensions list for federation sync.

- **Authentication**: Cluster Secret Header (`X-Federation-Secret: <secret>`)
- **Headers**: X-Federation-Secret: <cluster_secret>
- **System Impact**: Reads local extensions from `asterisk.users`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/federation/v1/extensions \
  -H 'X-Federation-Secret: ClusterPass123'
```

#### Example Response

```json
{
  "node_id": "cairo-hq",
  "extensions": [{"extension": "101", "name": "Alice"}]
}
```

---

<a id="get-apifederationv1dongles"></a>
### `GET` /api/federation/v1/dongles

**Description**: Public/Peer inter-node endpoint exposing local GSM dongles for inter-branch cellular gateway pooling.

- **Authentication**: Cluster Secret Header (`X-Federation-Secret: <secret>`)
- **Headers**: X-Federation-Secret: <cluster_secret>
- **System Impact**: Reads local dongle statuses.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/federation/v1/dongles \
  -H 'X-Federation-Secret: ClusterPass123'
```

#### Example Response

```json
{
  "node_id": "cairo-hq",
  "dongles": [{"id": "dongle0", "status": "Free", "number": "01012345678"}]
}
```

---

<a id="get-apifederationv1health"></a>
### `GET` /api/federation/v1/health

**Description**: Lightweight health heartbeat probe used by remote cluster nodes to measure latency and connectivity.

- **Authentication**: Cluster Secret or Public
- **Headers**: None required
- **System Impact**: Returns timestamp and uptime.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/federation/v1/health
```

#### Example Response

```json
{
  "status": "healthy",
  "node_id": "cairo-hq",
  "uptime": 184520,
  "timestamp": "2026-09-28T14:50:00Z"
}
```

---

<a id="get-apifederationv1live-state"></a>
### `GET` /api/federation/v1/live-state

**Description**: Returns live channels and extension states across the cluster mesh for centralized multi-site switchboard display.

- **Authentication**: Cluster Secret Header (`X-Federation-Secret: <secret>`)
- **Headers**: X-Federation-Secret: <cluster_secret>
- **System Impact**: Aggregates AMI channel state snapshot.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/federation/v1/live-state \
  -H 'X-Federation-Secret: ClusterPass123'
```

#### Example Response

```json
{
  "node_id": "cairo-hq",
  "active_calls": 3,
  "extensions_online": 8
}
```

---

<a id="blacklist"></a>
## 27. Blacklist & Number Blocking Management

*Endpoints managing PBX inbound call blocking, spam caller prevention, AstDB blacklist synchronization, and bulk CSV number importing.*

<a id="get-apiblacklist"></a>
### `GET` /api/blacklist

**Description**: Retrieves all blocked telephone numbers with their block date and reason description.

- **Authentication**: Session Cookie (`blacklist` or `config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.blacklist` and synchronizes with AstDB `/blacklist` keys.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/blacklist -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "blacklist": [
    {"id": 1, "number": "01009988776", "description": "Persistent Telemarketer"}
  ]
}
```

---

<a id="post-apiblacklist"></a>
### `POST` /api/blacklist

**Description**: Adds a telephone number to the PBX blacklist, immediately rejecting incoming calls with congestion tone or disconnect.

- **Authentication**: Session Cookie (`blacklist` or `config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.blacklist` and sets AstDB key `/blacklist/<number>` to '1'.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `number` | `body` | `string` | **Yes** | Caller phone number (digits only) |
| `description` | `body` | `string` | No | Reason or note |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/blacklist -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"number":"01234567890","description":"Spam Robocall"}'
```

#### Example Response

```json
{
  "success": true,
  "id": 2,
  "message": "Number added to blacklist."
}
```

---

<a id="put-apiblacklistid"></a>
### `PUT` /api/blacklist/:id

**Description**: Updates the description or phone number for an existing blacklist entry.

- **Authentication**: Session Cookie (`blacklist` or `config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.blacklist` and syncs AstDB key.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Blacklist entry ID |
| `number` | `body` | `string` | No | Updated number |
| `description` | `body` | `string` | No | Updated description |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/blacklist/2 -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"description":"Verified Debt Collector"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Blacklist entry updated."
}
```

---

<a id="delete-apiblacklistid"></a>
### `DELETE` /api/blacklist/:id

**Description**: Removes a telephone number from the blacklist, restoring their ability to call into the PBX.

- **Authentication**: Session Cookie (`blacklist` or `config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Deletes from `asterisk.blacklist` and deletes AstDB key `/blacklist/<number>`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `path` | `integer` | **Yes** | Blacklist entry ID to delete |

#### Example Request

```bash
curl -X DELETE http://localhost:8080/api/blacklist/2 -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Number removed from blacklist."
}
```

---

<a id="post-apiblacklistsync"></a>
### `POST` /api/blacklist/sync

**Description**: Performs a full bi-directional synchronization between the SQL `blacklist` table and Asterisk AstDB internal database.

- **Authentication**: Session Cookie (`blacklist` or `config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Iterates AstDB `/blacklist` keys and SQL table, reconciling differences.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/blacklist/sync -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "synchronizedCount": 12
}
```

---

<a id="post-apiblacklistimport"></a>
### `POST` /api/blacklist/import

**Description**: Bulk imports spam telephone numbers from a CSV file into the blacklist.

- **Authentication**: Session Cookie (`blacklist` or `config` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: multipart/form-data
- **System Impact**: Parses CSV and inserts records into `asterisk.blacklist` and AstDB.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `file` | `body` | `file` | **Yes** | CSV file containing telephone numbers |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/blacklist/import -b cookie.txt \
  -F 'file=@spam_numbers.csv'
```

#### Example Response

```json
{
  "success": true,
  "importedCount": 85
}
```

---

<a id="contacts"></a>
## 28. Corporate Contacts & Phonebook Directory

*Endpoints managing the corporate shared phonebook directory, contact searching, speed dial numbers, and CSV directory imports.*

<a id="get-apicontacts"></a>
### `GET` /api/contacts

**Description**: Retrieves the list of corporate directory contacts with searching, filtering, and pagination.

- **Authentication**: Session Cookie (`contacts` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.contacts`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `search` | `query` | `string` | No | Search by name, phone, or company |
| `limit` | `query` | `integer` | No | Max results (default: 50) |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/api/contacts?search=Acme' -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "contacts": [
    {"id": 1, "name": "Acme Corp", "phone": "0225566778", "email": "info@acme.com", "company": "Acme Inc"}
  ]
}
```

---

<a id="post-apicontactsadd"></a>
### `POST` /api/contacts/add

**Description**: Creates a new contact in the corporate shared directory.

- **Authentication**: Session Cookie (`contacts` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Inserts record into `asterisk.contacts`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `name` | `body` | `string` | **Yes** | Contact full name |
| `phone` | `body` | `string` | **Yes** | Primary telephone number |
| `mobile` | `body` | `string` | No | Mobile phone number |
| `email` | `body` | `string` | No | Email address |
| `company` | `body` | `string` | No | Company or organization |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/contacts/add -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"name":"Tariq Ali","phone":"01012345678","email":"tariq@corp.com","company":"Tech Solutions"}'
```

#### Example Response

```json
{
  "success": true,
  "contactId": 2,
  "message": "Contact added successfully."
}
```

---

<a id="post-apicontactsedit"></a>
### `POST` /api/contacts/edit

**Description**: Updates details for an existing contact.

- **Authentication**: Session Cookie (`contacts` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.contacts`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `body` | `integer` | **Yes** | Contact ID |
| `name` | `body` | `string` | No | Updated name |
| `phone` | `body` | `string` | No | Updated phone |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/contacts/edit -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"id":2,"name":"Tariq Ali - Senior Consultant"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Contact updated."
}
```

---

<a id="post-apicontactsdelete"></a>
### `POST` /api/contacts/delete

**Description**: Deletes a contact from the shared directory.

- **Authentication**: Session Cookie (`contacts` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Deletes from `asterisk.contacts`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `id` | `body` | `integer` | **Yes** | Contact ID to remove |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/contacts/delete -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"id":2}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Contact deleted."
}
```

---

<a id="post-apicontactscsv-import"></a>
### `POST` /api/contacts/csv-import

**Description**: Imports contacts in bulk from a CSV file (columns: name, phone, email, company).

- **Authentication**: Session Cookie (`contacts` permission)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: multipart/form-data
- **System Impact**: Batch inserts into `asterisk.contacts`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `file` | `body` | `file` | **Yes** | CSV file payload |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/contacts/csv-import -b cookie.txt \
  -F 'file=@directory.csv'
```

#### Example Response

```json
{
  "success": true,
  "importedCount": 120
}
```

---

<a id="storage-backup"></a>
## 29. Storage Management, Retention Auto-Purge & Cloud Backup

*Endpoints managing server storage volume, call recording disk consumption, automated retention purge schedules, Google Drive cloud backup sync, and archive exports.*

<a id="get-apistorageinfo"></a>
### `GET` /api/storage/info

**Description**: Returns total, used, and free disk space for `/var/spool/asterisk/monitor/`, database size, recording count, and oldest recorded call date.

- **Authentication**: Session Cookie (`storage` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Executes `statvfs` on recording directory and scans MySQL storage metrics.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/storage/info -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "storage": {
    "totalBytes": 107374182400,
    "usedBytes": 42949672960,
    "freeBytes": 64424509440,
    "recordingsCount": 15420,
    "oldestRecordingDate": "2026-01-15"
  }
}
```

---

<a id="get-apistorageexportpc"></a>
### `GET` /api/storage/export/pc

**Description**: Creates a streaming compressed ZIP archive containing call recordings within a specified date window for local backup on an administrator's PC.

- **Authentication**: Session Cookie (`storage` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Streams dynamic ZIP archive of recordings from `/var/spool/asterisk/monitor/`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `startDate` | `query` | `string` | **Yes** | Start date (YYYY-MM-DD) |
| `endDate` | `query` | `string` | **Yes** | End date (YYYY-MM-DD) |

#### Example Request

```bash
curl -X GET 'http://localhost:8080/api/storage/export/pc?startDate=2026-09-01&endDate=2026-09-28' -b cookie.txt -O -J
```

#### Example Response

```http
HTTP/1.1 200 OK
Content-Type: application/zip
Content-Disposition: attachment; filename="recordings-2026-09-28.zip"
```

---

<a id="post-apistoragegdrivesetup"></a>
### `POST` /api/storage/gdrive/setup

**Description**: Configures Google Drive cloud backup OAuth2 service account credentials and destination folder ID.

- **Authentication**: Session Cookie (`storage` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Encodes and stores credentials in `asterisk.storage_settings`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `credentialsJson` | `body` | `string` | **Yes** | Google Service Account JSON key content |
| `folderId` | `body` | `string` | **Yes** | Target Google Drive Folder ID |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/storage/gdrive/setup -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"credentialsJson":"{...}","folderId":"1A2B3C..."}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Google Drive backup credentials configured."
}
```

---

<a id="post-apistoragegdrivesync"></a>
### `POST` /api/storage/gdrive/sync

**Description**: Initiates an immediate background synchronization job uploading new call recordings and database backups to Google Drive.

- **Authentication**: Session Cookie (`storage` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Spawns background sync worker process.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/storage/gdrive/sync -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Cloud backup synchronization job started."
}
```

---

<a id="post-apistoragepurge-settings"></a>
### `POST` /api/storage/purge-settings

**Description**: Configures automated retention rules (e.g. purge recordings older than 90 days, or trigger auto-purge when disk exceeds 85% capacity).

- **Authentication**: Session Cookie (`storage` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.storage_settings`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `retentionDays` | `body` | `integer` | **Yes** | Max days to keep recordings |
| `autoPurgeThresholdPct` | `body` | `integer` | No | Disk full trigger percentage (e.g. 85) |
| `purgeVoicemails` | `body` | `boolean` | No | Also purge expired voicemails |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/storage/purge-settings -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"retentionDays":90,"autoPurgeThresholdPct":85}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Retention purge policies saved."
}
```

---

<a id="post-apistoragepurge"></a>
### `POST` /api/storage/purge

**Description**: Manually triggers an immediate retention purge deleting recordings and database records older than the specified retention window.

- **Authentication**: Session Cookie (`storage` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Unlinks audio files from disk and removes corresponding CDR recordings metadata.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `days` | `body` | `integer` | No | Purge recordings older than N days |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/storage/purge -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"days":60}'
```

#### Example Response

```json
{
  "success": true,
  "purgedFiles": 1240,
  "freedBytes": 3221225472
}
```

---

<a id="system-alerts"></a>
## 30. System Telemetry, Services, Watchdog Alerts & Server Operations

*Endpoints managing underlying server operating system telemetry (CPU, RAM, disk, network), systemd service management (Asterisk, MariaDB, Node.js), hardware watchdog alerts (Telegram, SMTP email, heartbeat monitors), NTP time synchronization, brand client themes, and core updates.*

<a id="get-apisystemresources"></a>
### `GET` /api/system/resources

**Description**: Retrieves instantaneous server resource metrics: CPU load average, RAM utilization, swap, disk I/O, network throughput, Asterisk active channels, and uptime.

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads `/proc/stat`, `/proc/meminfo`, `/proc/loadavg` and AMI status.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/system/resources -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "cpu": {"usagePct": 14.5, "loadAvg": [0.25, 0.32, 0.40]},
  "memory": {"totalMb": 7820, "usedMb": 3120, "freeMb": 4700},
  "disk": {"usedPct": 42},
  "activeChannels": 4
}
```

---

<a id="get-apisystemresourceshistory"></a>
### `GET` /api/system/resources/history

**Description**: Retrieves historical time-series data of CPU and memory utilization for rendering analytics charts.

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries in-memory circular resource history buffer.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `points` | `query` | `integer` | No | Number of data points (default: 60) |

#### Example Request

```bash
curl -X GET http://localhost:8080/api/system/resources/history -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "history": [
    {"timestamp": "2026-09-28T14:40:00Z", "cpu": 12.1, "mem": 39.8}
  ]
}
```

---

<a id="get-apisystemservices"></a>
### `GET` /api/system/services

**Description**: Retrieves the operational status (running, stopped, failed, uptime) of critical Linux systemd services (`asterisk`, `mariadb`, `sokrat-voip`, `tailscaled`).

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Executes `systemctl is-active` queries across managed services.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/system/services -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "services": [
    {"name": "asterisk", "status": "active", "running": true},
    {"name": "mariadb", "status": "active", "running": true}
  ]
}
```

---

<a id="post-apisystemservice-action"></a>
### `POST` /api/system/service-action

**Description**: Executes an administrative service lifecycle operation: restart, stop, or start on an authorized PBX service.

- **Authentication**: Session Cookie (SuperAdmin only)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Executes privileged `systemctl <action> <service>`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `service` | `body` | `string` | **Yes** | Service name ('asterisk', 'mariadb', 'sokrat-voip') |
| `action` | `body` | `string` | **Yes** | Action ('restart', 'start', 'stop') |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/system/service-action -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"service":"asterisk","action":"restart"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Service asterisk restarted successfully."
}
```

---

<a id="post-apisystemdrop-caches"></a>
### `POST` /api/system/drop-caches

**Description**: Frees Linux kernel page cache, dentries, and inodes from RAM to reclaim system memory immediately.

- **Authentication**: Session Cookie (SuperAdmin only)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Executes `sync && echo 3 > /proc/sys/vm/drop_caches`.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/system/drop-caches -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Kernel memory caches dropped successfully."
}
```

---

<a id="post-apisystemasterisk-reload"></a>
### `POST` /api/system/asterisk-reload

**Description**: Executes a clean, graceful module reload of Asterisk PBX without dropping active calls.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Fires AMI `Command: core reload`.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/system/asterisk-reload -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Asterisk core reloaded."
}
```

---

<a id="get-apisettingssmtp"></a>
### `GET` /api/settings/smtp

**Description**: Retrieves the current SMTP email relay settings (host, port, security, username, from address).

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.smtp_settings`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/settings/smtp -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "secure": false,
    "user": "notifications@corp.com",
    "from": "Sokrat PBX <notifications@corp.com>"
  }
}
```

---

<a id="post-apisettingssmtp"></a>
### `POST` /api/settings/smtp

**Description**: Updates SMTP server parameters and credentials for sending email notifications and password resets.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.smtp_settings` and tests SMTP handshake.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `host` | `body` | `string` | **Yes** | SMTP server host |
| `port` | `body` | `integer` | **Yes** | Port (465, 587, 25) |
| `secure` | `body` | `boolean` | No | SSL/TLS toggle |
| `user` | `body` | `string` | No | SMTP auth user |
| `pass` | `body` | `string` | No | SMTP auth password |
| `from` | `body` | `string` | **Yes** | Sender address header |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/settings/smtp -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"host":"smtp.office365.com","port":587,"secure":false,"user":"voip@corp.com","pass":"SecretPass","from":"voip@corp.com"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "SMTP settings updated and validated."
}
```

---

<a id="get-apisettingsalerts"></a>
### `GET` /api/settings/alerts

**Description**: Retrieves real-time alert trigger thresholds (CPU > 90%, RAM > 95%, disk > 90%, trunk down, dongle disconnect) and recipient channels.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.alert_settings`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/settings/alerts -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "alerts": {
    "telegramEnabled": true,
    "emailEnabled": true,
    "cpuThreshold": 90,
    "diskThreshold": 85
  }
}
```

---

<a id="post-apisettingsalerts"></a>
### `POST` /api/settings/alerts

**Description**: Updates alert trigger thresholds, notification channels, Telegram Bot tokens, and chat IDs.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.alert_settings`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `telegramEnabled` | `body` | `boolean` | No | Enable Telegram alerts |
| `telegramBotToken` | `body` | `string` | No | Telegram bot API token |
| `telegramChatId` | `body` | `string` | No | Telegram chat ID |
| `emailEnabled` | `body` | `boolean` | No | Enable email alerts |
| `emailRecipients` | `body` | `string` | No | Comma-separated recipient emails |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/settings/alerts -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"telegramEnabled":true,"telegramBotToken":"123456:ABC-DEF...","telegramChatId":"-1001234567"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Alert settings updated successfully."
}
```

---

<a id="post-apisettingsalertstest-telegram"></a>
### `POST` /api/settings/alerts/test-telegram

**Description**: Dispatches an immediate test alert message through the configured Telegram bot to verify connectivity.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Calls Telegram Bot API `sendMessage`.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/settings/alerts/test-telegram -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Test alert sent to Telegram chat."
}
```

---

<a id="post-apisettingsalertstest-email"></a>
### `POST` /api/settings/alerts/test-email

**Description**: Sends a test system alert email to the configured administrator email recipients.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Sends test email via Nodemailer.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/settings/alerts/test-email -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "Test alert email dispatched successfully."
}
```

---

<a id="post-apisettingsalertstest-heartbeat"></a>
### `POST` /api/settings/alerts/test-heartbeat

**Description**: Triggers a synthetic watchdog heartbeat cycle, evaluating all system triggers and logging the result.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Runs watchdog health check routine.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/settings/alerts/test-heartbeat -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "heartbeat": {"status": "ok", "healthy": true}
}
```

---

<a id="get-apisettingsalertswatchdog-status"></a>
### `GET` /api/settings/alerts/watchdog-status

**Description**: Retrieves the current operational status of the internal system health watchdog thread.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Reads watchdog thread state.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/settings/alerts/watchdog-status -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "watchdog": {"active": true, "intervalSec": 60, "lastRun": "2026-09-28T14:49:10Z"}
}
```

---

<a id="get-apisettingsclient"></a>
### `GET` /api/settings/client

**Description**: Retrieves custom brand styling, client logo, enterprise name, and custom UI color overrides.

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Queries `asterisk.client_branding`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/settings/client -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "branding": {
    "companyName": "Sokrat Telecom",
    "logoUrl": "/uploads/branding/logo.png",
    "accentColor": "#3b82f6"
  }
}
```

---

<a id="post-apisettingsclient"></a>
### `POST` /api/settings/client

**Description**: Uploads custom brand logo or banner for the dashboard interface.

- **Authentication**: Session Cookie (SuperAdmin only)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: multipart/form-data
- **System Impact**: Saves image to `/opt/sokrat-voip/public/uploads/branding/` and updates `client_branding`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `logo` | `body` | `file` | **Yes** | Brand image file (PNG/SVG/WebP) |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/settings/client -b cookie.txt \
  -F 'logo=@brand_logo.png'
```

#### Example Response

```json
{
  "success": true,
  "logoUrl": "/uploads/branding/logo.png"
}
```

---

<a id="put-apisettingsclient"></a>
### `PUT` /api/settings/client

**Description**: Updates enterprise company name, footer text, or custom theme accent colors.

- **Authentication**: Session Cookie (SuperAdmin only)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Updates `asterisk.client_branding`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `companyName` | `body` | `string` | No | Company brand name |
| `accentColor` | `body` | `string` | No | Hex accent color |

#### Example Request

```bash
curl -X PUT http://localhost:8080/api/settings/client -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"companyName":"Enterprise VOIP","accentColor":"#10b981"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Branding settings updated."
}
```

---

<a id="get-apisettingstime"></a>
### `GET` /api/settings/time

**Description**: Retrieves server clock, system timezone, and NTP synchronization status.

- **Authentication**: Session Cookie (`config` or SuperAdmin)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Executes `timedatectl status`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/settings/time -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "time": {
    "currentTime": "2026-09-28 14:50:00",
    "timezone": "Africa/Cairo",
    "ntpSynchronized": true
  }
}
```

---

<a id="post-apisettingstime"></a>
### `POST` /api/settings/time

**Description**: Updates the server timezone and synchronizes time via NTP servers (e.g. `pool.ntp.org`).

- **Authentication**: Session Cookie (SuperAdmin only)
- **Headers**: Cookie: connect.sid=<session_cookie>, Content-Type: application/json
- **System Impact**: Executes privileged `timedatectl set-timezone <timezone>` and updates chrony/NTP service.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `timezone` | `body` | `string` | **Yes** | IANA Timezone string (e.g. 'Africa/Cairo' or 'Asia/Dubai') |
| `ntpServer` | `body` | `string` | No | NTP server address |

#### Example Request

```bash
curl -X POST http://localhost:8080/api/settings/time -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"timezone":"Africa/Cairo"}'
```

#### Example Response

```json
{
  "success": true,
  "message": "Server timezone updated to Africa/Cairo."
}
```

---

<a id="post-apisystemupdate"></a>
### `POST` /api/system/update

**Description**: Initiates an automated in-place upgrade pulling the latest Sokrat VoIP code from GitHub, running migrations, and restarting the service safely.

- **Authentication**: Session Cookie (SuperAdmin only)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Executes `/opt/sokrat-voip/scripts/upgrade.sh`.

#### Example Request

```bash
curl -X POST http://localhost:8080/api/system/update -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "message": "System upgrade initiated in background. Server will restart shortly."
}
```

---

<a id="get-apinetwork-info"></a>
### `GET` /api/network-info

**Description**: Retrieves network interface details (IP addresses, MAC, subnet mask, gateway, DNS servers, and Tailscale VPN status).

- **Authentication**: Session Cookie (Authenticated)
- **Headers**: Cookie: connect.sid=<session_cookie>
- **System Impact**: Scans `os.networkInterfaces()` and reads `/etc/resolv.conf`.

#### Example Request

```bash
curl -X GET http://localhost:8080/api/network-info -b cookie.txt
```

#### Example Response

```json
{
  "success": true,
  "interfaces": {
    "eth0": [{"address": "192.168.1.10", "netmask": "255.255.255.0"}],
    "tailscale0": [{"address": "100.100.10.5"}]
  }
}
```

---

<a id="post-log-error"></a>
### `POST` /log_error

**Description**: Client-side browser JavaScript error reporting endpoint that captures uncaught frontend exceptions into server diagnostics logs.

- **Authentication**: Public
- **Headers**: Content-Type: application/json
- **System Impact**: Appends formatted diagnostic event to `/opt/sokrat-voip/logs/frontend-errors.log`.

#### Request Parameters

| Name | Location | Type | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `message` | `body` | `string` | **Yes** | Error message string |
| `source` | `body` | `string` | No | Source script URL |
| `lineno` | `body` | `integer` | No | Line number of error |
| `colno` | `body` | `integer` | No | Column number |
| `stack` | `body` | `string` | No | Error stack trace |

#### Example Request

```bash
curl -X POST http://localhost:8080/log_error \
  -H 'Content-Type: application/json' \
  -d '{"message":"Uncaught TypeError: Cannot read property of undefined","source":"/js/operator.js","lineno":42}'
```

#### Example Response

```json
{
  "success": true
}
```

---

## ⚠️ Standard Error Codes & Diagnostics

| Status Code | Error Message | Common Cause | Recommended Action |
| :---: | :--- | :--- | :--- |
| `400` | `Bad Request` | Missing required parameters or malformed JSON payload | Inspect request body against parameter table |
| `401` | `Unauthorized` | Session expired, invalid credentials, or missing Bearer token | Authenticate via `/login` or check `Authorization` header |
| `403` | `Forbidden` | User lacks permission for this tab, action, or extension scope | Request role promotion or permission grant from SuperAdmin |
| `404` | `Not Found` | Resource (recording, lead, extension, trunk) does not exist | Verify resource identifier |
| `429` | `Too Many Requests` | Exceeded rate limit (e.g. max 5 CRM pairing attempts/minute) | Throttle requests or wait 60 seconds |
| `500` | `Internal Server Error` | Database query failure or Asterisk AMI communication timeout | Check `/var/log/asterisk/full` and `/opt/sokrat-voip/logs/` |

---

## 📡 Real-Time Telephony Protocol Reference

### Socket.IO Real-Time Events (`ws://<host>:8080`)

| Event Name | Direction | Payload | Description |
| :--- | :---: | :--- | :--- |
| `call_event` | Server -> Client | `{ channel, caller, callee, state }` | Broadcasts live call state changes (Ringing, Up, Hangup) |
| `dongle_update` | Server -> Client | `{ dongles: [...] }` | Broadcasts live hardware GSM signal RSSI and status changes |
| `ext_status` | Server -> Client | `{ extension, online, rtt }` | Broadcasts SIP/PJSIP endpoint registration/reachability |
| `sysmon_update` | Server -> Client | `{ cpu, mem, disk, channels }` | Broadcasts 2-second real-time system telemetry |

---

<div align="center">

### ⚡ Sokrat VoIP — Master Documentation Compiled Automatically
</div>
