# Internal Extension Chat API

Server-side internal chat for Sokrat extensions. All messages are stored in
Sokrat VOIP; desktop, Chrome extension and mobile are clients.

## Base URL and auth

`/api/extension-chat/v1`

Every request is signed with the extension's own SIP credentials:

```
X-Sokrat-Extension: <extension>
X-Sokrat-Timestamp: <epoch milliseconds>
X-Sokrat-Signature: hex(HMAC-SHA256(sip_password, extension + "\n" + timestamp + "\n" + METHOD + "\n" + path_with_query))
```

The path must include the full `/api/extension-chat/v1/...` path and any query
string. Requests older than five minutes are rejected.

## Endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/conversations` | List conversations, participants, unread and last message |
| `POST` | `/conversations` | Create/find a direct conversation `{ "extension": "110" }` |
| `GET` | `/conversations/:id/messages?before_id=&limit=` | Paginated history (oldest first in the response) |
| `POST` | `/conversations/:id/messages` | Send `text`, `attachment` or `contact` |
| `POST` | `/conversations/:id/read` | `{ "message_id": 123 }` |
| `GET` | `/unread` | Total and per-conversation unread counts |
| `POST` | `/session` | Exchange HMAC auth for a 10-minute socket token |
| `POST` | `/attachments` | Multipart field `file`; returns attachment metadata |
| `GET` | `/attachments/:id` | Authenticated download / inline image or voice note |

### Send a text message

```json
{
  "type": "text",
  "body": "Hello",
  "client_id": "unique-client-id"
}
```

`client_id` is idempotent per conversation/sender.

### Send an attachment

Upload first, then send:

```json
{
  "type": "attachment",
  "body": "optional caption",
  "client_id": "unique-client-id",
  "attachment_ids": [123]
}
```

### Share a contact

```json
{
  "type": "contact",
  "body": "",
  "client_id": "unique-client-id",
  "contact": {
    "extension": "110",
    "name": "Walid Helmy",
    "company": "Green Energy Egypt",
    "phone": "",
    "email": ""
  }
}
```

A contact needs a name and either an existing extension or a phone number.
Address-book contacts can be shared with `name` and `phone` only (leave
`extension` empty). When `extension` is provided it must exist. The card is a
snapshot; later address-book changes do not alter sent cards.

## Realtime

Exchange the HMAC-authenticated `POST /session` response for a Socket.IO
connection:

```js
const socket = io(`${pbxUrl}/chat`, {
  auth: { token: session.token },
  transports: ['websocket'],
});
```

Events emitted by the server:

- `chat:ready` — `{ extension, online[] }`
- `chat:message` — `{ conversation_id, message }`
- `chat:read` — `{ conversation_id, extension, last_read_message_id }`
- `chat:conversation` — `{ conversation }`
- `chat:typing` — `{ conversation_id, extension, typing }`
- `chat:presence` — `{ extension, online }`

Client emits `chat:typing` with `{ conversation_id, typing }`.

Read receipts and message fan-out are also written server-side first, so the
socket never becomes the only copy of a message.

## Attachment rules

| Type | Formats | Limit |
| :--- | :--- | :--- |
| Image | JPEG, PNG, WebP, GIF | 2 MB |
| Document | PDF, XLS, XLSX | 10 MB |
| Voice note | WebM/Opus, Ogg, MP3, WAV, M4A | 10 MB |

- Maximum 3 attachments per message.
- Server validates magic bytes, extension, size and MIME.
- Files are stored outside the web root; only authenticated participants can
  download them.
- SVG, HTML, scripts and macro-enabled `.xlsm` are rejected.

## Storage

Tables (MariaDB `asterisk` database):

- `chat_conversations`
- `chat_participants`
- `chat_messages`
- `chat_attachments`
- `chat_admin_audit`

Voice notes recorded by the desktop and Chrome clients use WebM/Opus by default.
Attachment files default to `/var/lib/sokrat-voip/chat-uploads` and can be
overridden with `CHAT_UPLOAD_DIR`.

## Mobile client

The React Native app can use the same HMAC API. It needs a small pure-JS
HMAC-SHA256 implementation, or a native crypto module, to sign requests. Use
the existing saved `SavedAccount.password`/`serverHost`; never expose the
password to the chat UI. The API is REST-only for now; live updates will be
added through the `/chat` Socket.IO namespace in the next phase.

## Dashboard transcript and permissions

The Sokrat VOIP dashboard exposes the server-side log:

| Surface | Permission |
| :--- | :--- |
| `/chat-logs` page and transcript API | `chat-logs` |
| Chat export API | `chat-logs-export` |

The Call History top bar has an **Internal Chat Logs** button when the signed-in
user has `chat-logs`. Permissions are managed with the normal dashboard group
permissions; super admins have both.

Admin API routes:

- `GET /api/chat/admin/conversations`
- `GET /api/chat/admin/conversations/:id/messages`
- `GET /api/chat/admin/attachments/:id`
- `GET /api/chat/admin/export?from=&to=&extension=&format=csv|json`

Every transcript view, attachment download and export writes an audit row to
`asterisk.chat_admin_audit`.
