# Telegram Integration Plan for Swarm

## Overview
Add Telegram as a chat interface to Swarm so you can talk to the manager agent via Telegram messages.

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

## 3. Proposed Architecture

### New module: `apps/backend/src/telegram/`

| File | Purpose |
|------|---------|
| `telegram-client.ts` | Thin Bot API caller (getUpdates, sendMessage, getFile, etc.) |
| `telegram-bridge.ts` | Maps Telegram updates ↔ Swarm manager messages |
| `telegram-session-map.ts` | Maps Telegram chat/user → Swarm agent session |
| `telegram-security.ts` | Allowlist checks, webhook secret, dedupe/rate limit |
| `telegram-types.ts` | Minimal Telegram Update/Message types |
| `telegram-poller.ts` | Long-polling loop (V1) |
| `telegram-webhook.ts` | Webhook handler (V2, optional) |

### Lifecycle
- Start Telegram bridge after `swarmManager.boot()` in `apps/backend/src/index.ts`
- Stop bridge during shutdown

---

## 4. Message Flow Design

### Inbound (Telegram → Swarm)
1. Receive Telegram `Update` (polling/webhook)
2. Validate sender against allowlist
3. Normalize: text from `message.text`, photos → download → base64 image attachments
4. Call `swarmManager.handleUserMessage(...)` targeting manager agent

### Outbound (Swarm → Telegram)
1. Bridge listens to `conversation_message` events
2. Forward only `source: "speak_to_user"` messages
3. Chunk text at 4096 chars, send with typing indicator

---

## 5. Security & Auth

- **`SWARM_TELEGRAM_ALLOWED_USER_IDS`** — CSV of authorized Telegram user IDs (deny by default)
- Private-chat-only by default
- Ignore bot-origin messages
- Webhook mode: verify `X-Telegram-Bot-Api-Secret-Token` header
- Dedupe update IDs, maintain offset
- Never log bot token

---

## 6. Configuration (Env Vars)

```env
# Core
SWARM_TELEGRAM_ENABLED=false
SWARM_TELEGRAM_BOT_TOKEN=your-bot-token

# Mode
SWARM_TELEGRAM_MODE=polling          # polling | webhook
SWARM_TELEGRAM_TARGET_AGENT_ID=      # default: manager

# Auth
SWARM_TELEGRAM_ALLOWED_USER_IDS=     # CSV of user IDs
SWARM_TELEGRAM_ALLOWED_CHAT_IDS=     # CSV of chat IDs
SWARM_TELEGRAM_PRIVATE_CHATS_ONLY=true

# Polling config
SWARM_TELEGRAM_POLL_TIMEOUT_SEC=25
SWARM_TELEGRAM_POLL_LIMIT=100
SWARM_TELEGRAM_DROP_PENDING_UPDATES=true

# Webhook config (V2)
SWARM_TELEGRAM_WEBHOOK_URL=
SWARM_TELEGRAM_WEBHOOK_PATH=/api/telegram/webhook
SWARM_TELEGRAM_WEBHOOK_SECRET=

# Limits
SWARM_TELEGRAM_MAX_FILE_MB=20
SWARM_TELEGRAM_TYPING_INDICATOR=true
```

---

## 7. Dependencies

**Recommendation: Raw `fetch` API** — no new runtime dependencies. Full control, minimal footprint, consistent with current backend style. Reassess if middleware complexity grows (telegraf/etc).

---

## 8. Implementation Phases

### Phase 0: Foundations
- Config parsing + feature flag
- Telegram client abstraction + typed API errors

### Phase 1: Polling MVP (text only)
- Polling loop (`getUpdates` + offset persistence)
- Auth allowlist + private-only checks
- Route text → manager via `handleUserMessage`
- Forward `speak_to_user` → Telegram `sendMessage`
- Chunking + retry/backoff on 429

### Phase 2: Images + UX
- Photo/image-doc ingestion (download → base64 → attachment)
- Typing indicator (`sendChatAction`)
- Clearer system/error responses

### Phase 3: Webhook Mode
- Webhook endpoint integration
- Secret header verification
- Health tooling (`getWebhookInfo`)

### Phase 4: Session Mapping
- Optional per-chat manager mapping + persistence

### Phase 5: Advanced
- Non-image file attachments (requires contract extension)
- Optional streaming UX via `editMessageText` throttled updates

---

## 9. Limitations to Document

- Telegram message/media limits are stricter than web UI
- No rich UI/thread controls available
- V1 responses are final-chunk only (no token streaming)
- Non-image file attachments deferred to later phase
- Single-manager mode recommended; multi-user context can collide

---

## 10. Test Plan

**Unit tests (vitest):**
- Update parsing + sender authorization
- Dedupe/offset behavior
- Text chunking at 4096 boundary
- Image attachment transform pipeline
- Retry/backoff on 429

**Integration tests:**
- Mock Telegram HTTP endpoints
- End-to-end: Update → handleUserMessage → speak_to_user → sendMessage

**Manual smoke:**
- `/start` + text in private chat
- Image message
- Oversized response chunking
- Unauthorized user denial
