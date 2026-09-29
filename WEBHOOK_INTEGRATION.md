# Inbound Call Webhook — CRM Integration Guide

How to receive real-time notifications in your CRM when a lead calls a Sokrat VoIP
GSM dongle line, so you can look up the lead and pop their record on the call.

---

## Table of Contents

- [What you need](#what-you-need)
- [How it works](#how-it-works)
- [Configuration in Sokrat](#configuration-in-sokrat)
- [The outbound HTTP request](#the-outbound-http-request)
  - [Request line](#request-line)
  - [Headers](#headers)
  - [JSON body](#json-body)
  - [Field reference](#field-reference)
- [Number format — read this carefully](#number-format-read-this-carefully)
- [Request signing](#request-signing)
- [Your endpoint: requirements](#your-endpoint-requirements)
- [Reference implementations](#reference-implementations)
  - [Node.js / Express](#nodejs-express)
  - [Python / Flask](#python-flask)
  - [PHP](#php)
  - [Node.js number normalization](#nodejs-number-normalization)
- [Testing the integration](#testing-the-integration)
- [Delivery semantics and troubleshooting](#delivery-semantics-and-troubleshooting)
- [Security considerations](#security-considerations)
- [Reference: Sokrat management API](#reference-sokrat-management-api)
- [Known limitations](#known-limitations)

---

## What you need

| Item | Notes |
| :--- | :--- |
| A public HTTPS endpoint | Sokrat runs inside a private network. It can only reach addresses it can route to. See [network notes](#network-reachability). |
| SuperAdmin access to Sokrat | Required to configure the webhook. |
| Optionally a shared secret | Enables HMAC request signing. Strongly recommended. |

You do **not** need an API key, a pairing token, or a Socket.IO connection. Sokrat
pushes to you; you never poll it.

---

## How it works

```
   Lead dials your SIM number
            │
            ▼
   ┌──────────────────────┐
   │  GSM dongle (cellular)│   e.g. dongle0  +201156804841
   └──────────┬───────────┘
              │  Asterisk Newchannel AMI event
              ▼
   ┌──────────────────────┐
   │    Sokrat VoIP       │  builds JSON payload
   └──────────┬───────────┘
              │  HTTP POST (10s timeout, fire-and-forget)
              ▼
   ┌──────────────────────┐
   │   YOUR CRM ENDPOINT  │  → look up lead → pop screen
   └──────────────────────┘
```

Sokrat detects the call the instant the dongle channel is created, **before** the
call is answered and before it reaches an extension or IVR. Your CRM is notified
immediately, and the notification is not affected by what the call does next —
whether it is answered, sent to voicemail, routed to an IVR, or hangs up unanswered.

One inbound call produces **exactly one** webhook delivery.

---

## Configuration in Sokrat

Open the dashboard as a SuperAdmin and go to **Settings → Webhooks**.

| Field | Meaning |
| :--- | :--- |
| **Enabled** | Master switch. When off, no webhooks are sent even if a URL is set. |
| **Webhook URL** | Absolute `http://` or `https://` endpoint. Query strings are preserved. |
| **Signing Secret** | Optional. Enables the `X-Sokrat-Signature` header. |

Click **Test Webhook** before enabling. It sends a real request with `event: "test"`
so you can confirm connectivity, TLS, and signature handling without waiting for a
live call.

The configuration is stored in `asterisk.dashboard_settings` and cached in memory.
Saving takes effect immediately — no service restart required.

---

## The outbound HTTP request

### Request line

```
POST /api/incoming-call HTTP/1.1
```

The path and query string are whatever you configured in the webhook URL. Sokrat
splits your URL and preserves both `pathname` and `search`, so
`https://crm.example.com/hooks/voip?tenant=7` receives
`POST /hooks/voip?tenant=7`.

### Headers

| Header | Always present | Value |
| :--- | :---: | :--- |
| `Content-Type` | yes | `application/json` |
| `Content-Length` | yes | Byte length of the UTF-8 body |
| `User-Agent` | yes | `SokratVoIP-Webhook/1.0` |
| `Host` | yes | Your hostname |
| `X-Sokrat-Signature` | only if a secret is set | Hex HMAC-SHA256 of the raw body |

### JSON body

```json
{
  "event": "incoming_call",
  "caller_number": "01011719380",
  "called_number": "+201156804841",
  "dongle": "dongle0",
  "timestamp": "2026-09-29T10:45:56.931Z"
}
```

### Field reference

| Field | Type | Always present | Description |
| :--- | :--- | :---: | :--- |
| `event` | string | yes | `incoming_call` for live calls. `test` for the test endpoint. Branch on this. |
| `caller_number` | string | yes | The caller's number, exactly as the GSM network delivered it. May be empty if the carrier withheld CLI. |
| `called_number` | string | yes | The SIM number that was dialed, as reported by Asterisk. |
| `dongle` | string | yes | Receiving dongle, e.g. `dongle0`. Lets you attribute the call to a specific line/agent. |
| `timestamp` | string | yes | ISO-8601 UTC, e.g. `2026-09-29T10:45:56.931Z`. |

`caller_number` and `called_number` are always present as strings. They are **never**
`null`; an unavailable value is an empty string `""`. Check for `""` before
attempting a lookup.

---

## Number format — read this carefully

**Numbers are forwarded verbatim. Sokrat performs no normalization of any kind.**

This is a deliberate design decision. Sokrat cannot know which canonical form your
CRM stores leads in, and guessing would silently corrupt lookups. Reconciling the
forms is the receiving CRM's responsibility.

What actually arrives, observed in production:

| Scenario | `caller_number` | `called_number` |
| :--- | :--- | :--- |
| Etisalat caller → Etisalat SIM | `01011719380` | `+201156804841` |
| International caller | `+447700900123` | `+201156804841` |
| Orange caller → Orange SIM | `01280987456` | `+201280695454` |
| Carrier withheld CLI | `""` | `+201156804841` |

Note the asymmetry: the **called** (SIM) number is consistently E.164, while the
**caller** number depends entirely on what the originating network sends — often a
local-format number with no country code.

### What you must do about it

The same Egyptian subscriber can reach you as `01011719380`, `1011719380`, and
`+201011719380`. If your CRM indexes leads by exact string, lookups will miss.

Pick one of these strategies:

1. **Normalize on ingest** (recommended) — store a canonical key alongside the raw
   value, and look up on the canonical form.
2. **Index multiple forms** — store local, national, and E.164 variants per lead.
3. **Fuzzy match on the national significant number** — strip a leading `+20` or `0`
   and compare the remaining 8–10 digits. Fastest, but watch for short numbers.

Keep the raw value in your call log regardless, so support staff can see exactly
what the network sent.

### Normalization helper (Egypt example)

```js
/**
 * Reduce any phone number to a comparable national significant number.
 *
 *   '01011719380'     -> '1011719380'
 *   '+201011719380'   -> '1011719380'
 *   '00201011719380'  -> '1011719380'
 *   '1011719380'      -> '1011719380'
 *   '+447700900123'   -> '447700900123'   (non-Egypt, + stripped)
 *   ''                -> ''
 */
function egyptKey(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/[^\d+]/g, '');
  // A leading '+' or '00' means the number is already in international form.
  const international = d.startsWith('+') || d.startsWith('00');
  d = d.replace(/^\+/, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('20') && (international || d.length >= 12)) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}
```

Adapt the country prefix logic for your market. Keep the original string too.

---

## Request signing

If you set a signing secret, Sokrat computes an HMAC-SHA256 over the **raw request
body** and sends it as a hex digest:

```
X-Sokrat-Signature: 2408dacae2212116042a8fc4d910a6b55750f2447151ff77bf94f34393466486
```

Verify it before trusting the payload. **Compute the HMAC over the raw body
bytes, not over a re-serialized object** — JSON key order and whitespace must
match exactly, or verification will fail.

```js
const crypto = require('crypto');

function verify(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (signatureHeader.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}
```

Rotate the secret by saving a new value in Sokrat, then updating your CRM.

---

## Your endpoint: requirements

| Requirement | Detail |
| :--- | :--- |
| **Respond `2xx`** | Any `2xx` counts as delivered. `404` or `500` is logged as a failure. |
| **Respond fast** | You have 10 seconds. Return `2xx` immediately and process asynchronously. Do not block on a database round-trip, an email, or a slow lead-lookup service. |
| **Read the body once** | You need the raw bytes for HMAC. Capture them before any JSON parsing. |
| **Be idempotent** | Sokrat does not retry, so you should not need to. But if you add your own retry layer, dedupe on `(caller_number, called_number, dongle, timestamp)`. |

### Network reachability

Sokrat fires the webhook from the PBX host itself. Before configuring a URL,
confirm the host can actually reach it:

```bash
# On the Sokrat server
curl -v -X POST https://crm.example.com/api/incoming-call \
  -H 'Content-Type: application/json' \
  -d '{"event":"test","caller_number":"01011719380","called_number":"+201156804841","dongle":"dongle0","timestamp":"2026-09-29T10:45:56.931Z"}'
```

If the PBX sits behind NAT or a restrictive firewall, your CRM must be reachable
over the public internet, or you need a tunnel/relay. A `localhost` URL only works
if your CRM is on the same machine.

Self-signed certificates will fail TLS validation. Use a publicly trusted
certificate, or install your CA on the Sokrat host.

---

## Reference implementations

### Node.js / Express

```js
const express = require('express');
const crypto = require('crypto');

const app = express();
const SECRET = process.env.SOKRAT_WEBHOOK_SECRET || '';

// Capture the RAW body — HMAC is computed over exact bytes.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.post('/api/incoming-call', (req, res) => {
  if (SECRET) {
    const sig = req.headers['x-sokrat-signature'];
    if (!sig) return res.status(401).json({ error: 'missing signature' });
    const expected = crypto.createHmac('sha256', SECRET).update(req.rawBody).digest('hex');
    if (sig.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(401).json({ error: 'bad signature' });
    }
  }

  const { event, caller_number, called_number, dongle, timestamp } = req.body || {};

  if (event === 'test') {
    return res.status(200).json({ ok: true, message: 'test received' });
  }

  // ACK first — we have 10s and must not block the PBX.
  res.status(200).json({ ok: true });

  // Then handle asynchronously.
  setImmediate(async () => {
    try {
      const lead = await findLead(egyptKey(caller_number));
      await logCallRecord({ caller_number, called_number, dongle, timestamp });
      if (lead) await popLeadScreen(lead, dongle);
    } catch (err) {
      console.error('inbound call handling failed', err);
    }
  });
});

app.listen(3000);
```

### Python / Flask

```python
import hmac, hashlib, os
from flask import Flask, request, jsonify

app = Flask(__name__)
SECRET = os.environ.get("SOKRAT_WEBHOOK_SECRET", "")

@app.post("/api/incoming-call")
def incoming_call():
    raw = request.get_data()  # raw bytes, before JSON parsing

    if SECRET:
        sig = request.headers.get("X-Sokrat-Signature", "")
        expected = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return jsonify({"error": "bad signature"}), 401

    payload = request.get_json(silent=True) or {}
    if payload.get("event") == "test":
        return jsonify({"ok": True, "message": "test received"}), 200

    # ACK immediately
    response = jsonify({"ok": True})
    response.status_code = 200

    threading.Thread(
        target=handle_call, args=(payload,), daemon=True
    ).start()
    return response
```

### PHP

```php
<?php
$secret = getenv('SOKRAT_WEBHOOK_SECRET') ?: '';

$raw = file_get_contents('php://input');

if ($secret !== '') {
    $sig = $_SERVER['HTTP_X_SOKRAT_SIGNATURE'] ?? '';
    $expected = hash_hmac('sha256', $raw, $secret);
    if (!hash_equals($expected, $sig)) {
        http_response_code(401);
        echo json_encode(['error' => 'bad signature']);
        exit;
    }
}

$payload = json_decode($raw, true) ?: [];

if (($payload['event'] ?? '') === 'test') {
    header('Content-Type: application/json');
    echo json_encode(['ok' => true, 'message' => 'test received']);
    exit;
}

header('Content-Type: application/json');
echo json_encode(['ok' => true]);   // ACK first

// Then process: enqueue a job, look up the lead, push the pop.
fastcgi_finish_request();
handleIncomingCall($payload);
```

### Node.js number normalization

```js
const EGYPT = require('./egypt-key'); // helper from the Number format section

async function findLead(rawNumber) {
  if (!rawNumber) return null;
  const key = EGYPT(rawNumber);
  if (!key) return null;
  return db.query('SELECT * FROM leads WHERE phone_key = ? LIMIT 1', [key]);
}
```

---

## Testing the integration

### 1. From the Sokrat UI

**Settings → Webhooks → Test Webhook**. Sokrat sends a payload with
`event: "test"` and a 10-second timeout. A success toast means your endpoint
answered `2xx` in time.

### 2. From the command line on the Sokrat host

```bash
curl -v -X POST https://crm.example.com/api/incoming-call \
  -H 'Content-Type: application/json' \
  -d '{"event":"test","caller_number":"01011719380","called_number":"+201156804841","dongle":"dongle0","timestamp":"2026-09-29T10:45:56.931Z"}'
```

### 3. With a real call

Place a call to the SIM number of a connected dongle. Check the dongle list on the
Sokrat server:

```bash
asterisk -rx "dongle show devices"
```

Call the `Number` of any dongle in state `Free`. The webhook fires on ring, before
anyone answers.

### 4. Watch deliveries live on the Sokrat host

Run a listener, then point the webhook at it:

```bash
node -e "
const http = require('http');
http.createServer((req, res) => {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    console.log('\n=== ' + new Date().toLocaleTimeString() + ' ===');
    console.log('Signature:', req.headers['x-sokrat-signature'] || '(none)');
    console.log(JSON.stringify(JSON.parse(b), null, 2));
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end('{\"ok\":true}');
  });
}).listen(9999, '0.0.0.0', () =>
  console.log('Listening on :9999 — set the webhook URL to http://<server-ip>:9999'));
"
```

### 5. Confirm signature verification

```bash
BODY='{"event":"incoming_call","caller_number":"01011719380","called_number":"+201156804841","dongle":"dongle0","timestamp":"2026-09-29T10:45:56.931Z"}'
printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'your-secret'
```

Compare the output to the `X-Sokrat-Signature` header from the captured request.
Note the `printf '%s'` (no trailing newline) — a trailing newline changes the digest.

---

## Delivery semantics and troubleshooting

| Property | Value |
| :--- | :--- |
| Transport | HTTP/1.1 `POST` over `http` or `https` |
| Retries | **None.** One call, one attempt. |
| Timeout | 10 seconds, then the connection is destroyed |
| Ordering | Not guaranteed across simultaneous calls |
| Blocking | The PBX never waits — the call proceeds regardless |
| Concurrency | One independent request per inbound call |
| Response handling | Any `2xx` = success. Others are logged. |

### Finding failures

Delivery errors are logged to the Sokrat service journal:

```bash
journalctl -u sokrat-voip -f | grep -i webhook
```

```
sokrat-voip node[4138902]: Webhook delivery failed: getaddrinfo ENOTFOUND crm.example.com
sokrat-voip node[4138902]: Webhook delivery failed: connect ETIMEDOUT 203.0.113.10:443
```

### Common problems

| Symptom | Likely cause | Fix |
| :--- | :--- | :--- |
| Nothing arrives, no error logged | Webhook not enabled, or URL empty | Check Settings → Webhooks; confirm `enabled` is on |
| `ENOTFOUND` | DNS not resolving from the PBX host | Test `curl` from the PBX host; check its resolver |
| `ETIMEDOUT` | Firewall or unroutable address | Open egress to your endpoint, or set up a relay |
| `CERT_*` errors | Self-signed or expired certificate | Use a trusted certificate or install your CA on the PBX |
| `401` from your endpoint | Signature mismatch | HMAC must be over the raw body, not re-serialized JSON |
| Test works, live calls do not | Listener bound to `127.0.0.1` | Bind to `0.0.0.0` or the LAN IP |
| `caller_number` is `""` | Carrier withheld CLI | Expected. Handle the empty case. |
| Lead lookup misses | Number format mismatch | See [Number format](#number-format-read-this-carefully) |

---

## Security considerations

1. **Always use HTTPS.** Otherwise caller numbers and your signature travel in
   clear text. `http://` is accepted for testing only.
2. **Always set a signing secret** in production. Without it, anyone who learns
   your URL can inject fake call events.
3. **Verify the signature before parsing** — reject with `401` on mismatch.
4. **Do not trust the payload's shape.** Validate types and lengths, and treat
   `caller_number` as untrusted free text, not a phone number.
5. **Rate limit** your endpoint as a defence in depth, even though Sokrat's volume
   is low.
6. **The secret is write-only.** `GET /api/settings/webhook` returns `••••••••`
   once saved; it is never readable through the API. Keep your own copy.
7. **The URL is stored unencrypted** in the database. Restrict SuperAdmin access
   and database access accordingly.
8. **Consider a dedicated secret per integration** if you later add more webhook
   consumers.

---

## Reference: Sokrat management API

Configuration is also scriptable. All three endpoints require a SuperAdmin session
cookie.

### `GET` /api/settings/webhook

```bash
curl -X GET http://<sokrat-host>:8080/api/settings/webhook -b cookie.txt
```

```json
{
  "success": true,
  "enabled": true,
  "url": "https://crm.example.com/api/incoming-call",
  "secret": "••••••••"
}
```

### `POST` /api/settings/webhook

```bash
curl -X POST http://<sokrat-host>:8080/api/settings/webhook -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"url":"https://crm.example.com/api/incoming-call","secret":"s3cr3t"}'
```

```json
{ "success": true, "message": "Webhook settings saved successfully" }
```

Errors: `403` if not SuperAdmin, `400` if the URL is not a valid absolute
`http(s)` URL.

### `POST` /api/settings/webhook/test

```bash
curl -X POST http://<sokrat-host>:8080/api/settings/webhook/test -b cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://crm.example.com/api/incoming-call","secret":"s3cr3t"}'
```

```json
{ "success": true, "message": "Test webhook delivered successfully" }
```

```json
{
  "success": false,
  "error": "Webhook test failed: Remote server responded with HTTP 404: Not Found"
}
```

---

## Known limitations

- **Inbound GSM calls only.** Calls arriving on SIP trunks, the web softphone, or
  Issabel's internal extensions do not fire this webhook.
- **No retries.** If your CRM is briefly unavailable, that notification is lost.
  Build a fallback in your CRM — for example, reconcile against Sokrat's call history
  API on a schedule.
- **Caller ID may be withheld** by the carrier, yielding an empty `caller_number`.
- **No hangup or answered events.** This webhook signals arrival only. If you need
  call outcome (answered, duration, hangup cause), use the CDR/call-history API
  instead.
- **One call, one event.** If the same call is transferred or bridged between
  extensions, you still receive a single notification for the original dongle
  arrival.
- **Fire-and-forget, no queue.** If your endpoint is slow, Sokrat will not wait and
  will not record a backlog.
- **Not scoped per-dongle.** A single URL receives events from every dongle. Use
  the `dongle` field to route to the right agent, or run separate Sokrat instances
  per line.

---

## Related documentation

- [`API_DOCUMENTATION.md`](API_DOCUMENTATION.md) — full Sokrat REST API reference
- [`README.md`](README.md) — project overview and installation
- [`AGENTS.md`](AGENTS.md) — architecture notes and operational gotchas
