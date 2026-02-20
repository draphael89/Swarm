# Telegram Integration Plan for Swarm

## Overview
Add Telegram as a chat interface to Swarm so you can talk to the manager agent via Telegram messages. **All configuration happens in the Swarm web UI** — no terminal/env var setup required.

---

## 1. Telegram Bot API — Key Facts

- Create bot with **@BotFather** (`/newbot`), get bot token
- Two update delivery modes (mutually exclusive):
  - **`getUpdates`** (long polling) — simplest, no public HTTPS needed
  - **`setWebhook`** (push) — needs HTTPS on port 443/80/88/8443
- `sendMessage` text limit: **4096 chars**
- File download via `getFile`: up to **20MB**
- Rate limits: ~1 msg/sec per chat, ~30 msgs/sec global

---

## 2. Current Swarm Message Flow (for reference)

1. UI sends WS command `{ type: "user_message", ... }`
2. WS server calls `swarmManager.handleUserMessage(text, { targetAgentId, delivery, attachments })`
3. Manager processes → replies via `speak_to_user` tool → emits `conversation_message` with `source: "speak_to_user"`
4. WS server broadcasts to subscribed clients

**Key insight:** Telegram bridge should call the same `handleUserMessage` API and listen for the same events — no need to route through WebSocket internally.

---

## 3. UI-First Configuration (NEW — replaces env var approach)

### Settings / Integrations Page

Instead of configuring Telegram via env vars and `.env` files, **all Telegram setup happens in the Swarm web UI**:

#### Settings Panel Design
- Accessible via a **Settings/gear icon** in the sidebar or header
- **Integrations** tab with a Telegram section containing:

```
┌─────────────────────────────────────────────┐
│  🤖 Telegram Integration                    │
│                                              │
│  Status: ● Connected (polling)    [Disable]  │
│                                              │
│  Bot Token:  [••••••••••••••••••]  [👁 Show] │
│                                              │
│  Allowed Users:                              │
│  ┌──────────────────────────────────┐       │
│  │ @sawyerhood (ID: 123456789)  ✕  │       │
│  └──────────────────────────────────┘       │
│  [+ Add User ID]                             │
│                                              │
│  ☑ Private chats only                        │
│  ☐ Drop pending updates on start             │
│  ☑ Show typing indicator                     │
│                                              │
│  Target Agent: [opus-manager ▼]              │
│                                              │
│  [Save & Connect]                            │
│                                              │
│  ─── Connection Log ───                      │
│  09:15 Connected to Telegram                 │
│  09:15 Polling started (25s timeout)         │
│  09:16 Message from @sawyerhood: "hello"     │
└─────────────────────────────────────────────┘
```

#### How Config is Stored
- Backend persists Telegram settings to `$SWARM_DATA_DIR/integrations/telegram.json`
- Settings are loaded at boot and can be hot-reloaded via the UI without restart
- **No env vars needed** — everything is configured through the UI
- The settings file is auto-created when the user first configures Telegram

#### Config Schema (`telegram.json`)
```json
{
  "enabled": true,
  "botToken": "encrypted-or-plaintext-token",
  "mode": "polling",
  "targetAgentId": "opus-manager",
  "allowedUserIds": [123456789],
  "allowedChatIds": [],
  "privateChatsOnly": true,
  "dropPendingUpdates": true,
  "typingIndicator": true,
  "pollTimeoutSec": 25,
  "pollLimit": 100
}
```

#### API Endpoints for Settings
- `GET /api/integrations/telegram` — get current config (token masked)
- `PUT /api/integrations/telegram` — update config + restart bridge
- `POST /api/integrations/telegram/test` — test connection with current token
- `DELETE /api/integrations/telegram` — disable and remove config

#### WS Events for Status
- `telegram_status` event — broadcast connection state changes to UI
  - `{ type: "telegram_status", status: "connected" | "disconnected" | "error", detail: "..." }`

---

## 4. Proposed Architecture

### New module: `apps/backend/src/telegram/`

| File | Purpose |
|------|---------|
| `telegram-client.ts` | Thin Bot API caller (getUpdates, sendMessage, getFile, etc.) |
| `telegram-bridge.ts` | Maps Telegram updates ↔ Swarm manager messages |
| `telegram-config.ts` | Load/save/validate config from `telegram.json` |
| `telegram-session-map.ts` | Maps Telegram chat/user → Swarm agent session |
| `telegram-security.ts` | Allowlist checks, dedupe/rate limit |
| `telegram-types.ts` | Minimal Telegram Update/Message types |
| `telegram-poller.ts` | Long-polling loop |

### Frontend additions: `apps/ui/src/`

| File | Purpose |
|------|---------|
| `components/settings/TelegramSettings.tsx` | Config form + connection status |
| `components/settings/SettingsPanel.tsx` | Settings panel container (for future integrations too) |

### Lifecycle integration
- On boot: load `telegram.json`, start bridge if enabled
- On UI config save: hot-reload bridge (stop → reconfigure → start)
- No server restart needed for config changes

---

## 5. Message Flow Design — Option 3: Broadcast + Source Annotation

### Principle
All channels (Web UI + Telegram) are windows into **one unified conversation**. The manager has one context regardless of where messages come from. All `speak_to_user` responses are **broadcast to all channels**.

### Inbound (Telegram → Swarm)
1. Receive Telegram `Update` via polling
2. Validate sender against allowlist (configured in UI)
3. Normalize: text from `message.text`, photos → download → base64 image attachments
4. Tag the message with source metadata: `{ source: "telegram", userId: ..., username: "..." }`
5. Call `swarmManager.handleUserMessage(...)` targeting configured agent

### Inbound (Web UI → Swarm)
1. Same as current flow, but tag with `{ source: "web" }`

### Outbound (Swarm → All Channels)
1. Bridge listens to `conversation_message` events
2. Forward all `source: "speak_to_user"` messages to **both** Web UI and Telegram
3. Telegram: chunk text at 4096 chars, send with typing indicator
4. Web UI: display as normal (already works)

### Source Annotations
- Messages in the Web UI show a small indicator: "via Telegram" / "via @username"
- Messages in Telegram optionally show "[from Web]" prefix when the user sent via web UI
- This prevents confusion about who said what from where

### Future: Multi-User Support (out of scope for V1)
- Multiple Telegram users can be allowed via the allowlist
- Each user's messages are tagged with their Telegram username/ID
- The manager sees all messages in one unified context but knows who's talking
- The manager can address responses to specific users: "Hey @sawyer, ..." 
- Requires extending `speak_to_user` to optionally target specific channels/users (V2)

---

## 6. Security & Auth

- **Allowlist configured in UI** — no need to edit env vars
- Private-chat-only by default (toggle in UI)
- Ignore bot-origin messages
- Dedupe update IDs, maintain offset
- Bot token stored in `telegram.json` (consider encryption at rest later)
- Never log bot token

---

## 7. Dependencies

**Recommendation: Raw `fetch` API** — no new runtime dependencies. Full control, minimal footprint, consistent with current backend style.

---

## 8. Implementation Phases

### Phase 0: Settings Infrastructure
- Add integrations config directory + telegram.json persistence
- Add REST endpoints for telegram config CRUD
- Add settings UI panel with Telegram config form

### Phase 1: Polling MVP (text only)
- Telegram client (raw fetch)
- Polling loop with offset persistence
- Auth allowlist checks (from UI config)
- Route text → manager via `handleUserMessage`
- Forward `speak_to_user` → Telegram `sendMessage`
- Chunking + retry/backoff on 429
- Connection status broadcast to UI

### Phase 2: Images + UX
- Photo/image-doc ingestion (download → base64 → attachment)
- Typing indicator
- Clearer system/error responses
- Connection log in UI

### Phase 3: Advanced
- Per-chat session mapping
- Non-image file attachments
- Optional streaming UX via `editMessageText`

---

## 9. Limitations

- Telegram message/media limits are stricter than web UI
- No rich UI/thread controls available
- V1 responses are final-chunk only (no token streaming)
- Non-image file attachments deferred to later phase
- Single-manager mode recommended; multi-user context can collide

---

## 10. Test Plan

**Unit tests (vitest):**
- Config load/save/validation
- Update parsing + sender authorization
- Dedupe/offset behavior
- Text chunking at 4096 boundary
- Image attachment transform pipeline

**Integration tests:**
- Mock Telegram HTTP endpoints
- End-to-end: Update → handleUserMessage → speak_to_user → sendMessage
- Config CRUD endpoints

**Manual smoke:**
- Configure Telegram in UI
- Send text in private chat
- Send image
- Toggle enabled/disabled
- Verify unauthorized user rejection
