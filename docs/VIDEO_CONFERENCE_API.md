# Sokrat Video Conference API

Sokrat VOICE desktop uses LiveKit for media and this PBX API for room
authorization and short-lived tokens.

## Environment

Set these on the PBX host (never in the desktop package):

```env
LIVEKIT_URL=wss://livekit.example.com
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_TOKEN_TTL=7200
```

`LIVEKIT_URL` must be reachable by desktop clients (WSS in production). The
LiveKit API secret is used only by `lib/video/tokens.js`.

## Authentication

All endpoints use the same HMAC scheme as the extension address book/chat:

```text
X-Sokrat-Extension
X-Sokrat-Timestamp
X-Sokrat-Signature
```

Canonical string:

```text
<extension>\n<timestamp>\n<METHOD>\n/api/extension-video/v1/<path>
```

## Endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/status` | Whether LiveKit is configured |
| `POST` | `/rooms` | Create a room: `{ title, invitees?, max_participants? }` |
| `GET` | `/rooms` | List active rooms for the extension |
| `GET` | `/rooms/:id` | Load a room and its invited participants |
| `POST` | `/rooms/:id/token` | Mint a short-lived LiveKit token |
| `POST` | `/rooms/:id/invite` | Invite extensions: `{ extensions: [] }` |
| `POST` | `/rooms/:id/leave` | Mark the extension as left |
| `POST` | `/rooms/:id/end` | End the room (owner only) |

## Data

- `video_rooms` — room title/owner/status/LiveKit room name.
- `video_room_participants` — invited/joined/left timestamps and role.
- `video_room_audit` — create/invite/leave/end audit events.

Tokens are never stored. They expire after `LIVEKIT_TOKEN_TTL` seconds and are
minted only for an invited extension in an active room.
