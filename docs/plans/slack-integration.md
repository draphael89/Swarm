# Slack Integration Plan for Swarm

## Objective
Add a Slack bot integration to Swarm with **channel-aware messaging**:
- Every inbound message is tagged with source/channel metadata (web, Slack DM, Slack channel, etc.).
- `speak_to_user` sends to a **single chosen channel target** (default = originating channel), not blind broadcast.
- Slack channel listening should allow the manager to see channel traffic but be selective about when to respond.

This plan is **research + implementation plan only** (no code changes yet).

---

## Research Summary

## Slack API findings (official docs + SDK references)
- Slack supports two event delivery modes:
  - **Socket Mode** (WebSocket, no public URL required)
  - **Events API over HTTP** (requires public Request URL)
- Socket Mode requires an **app-level token** (`xapp-...`) with `connections:write` and a bot token (`xoxb-...`) for Web API calls.
- Socket Mode is recommended by Slack for local development; HTTP is typically better for horizontally scaled production and is required for Marketplace apps.
- Socket Mode payloads must be **acknowledged** (`envelope_id` / SDK `ack`) quickly.
- Key events for this use case:
  - `message.im` (DMs)
  - `app_mention` (explicit @mentions in channels)
  - `message.channels` (all public channel messages where bot is present)
  - optionally `message.groups` for private channels
- Message send path is Web API `chat.postMessage` (supports `thread_ts`, `reply_broadcast`, `mrkdwn`).
- Rate limiting guidance:
  - roughly **1 message/sec/channel** for posting messages
  - 429 handling via `Retry-After`
- File handling:
  - inbound file metadata appears on message events
  - private file URLs require bearer token and appropriate scopes (`files:read`)

## Current Swarm message flow (from code)
- Web UI sends WS `user_message` command.
- `apps/backend/src/ws/server.ts` calls `swarmManager.handleUserMessage(text, { targetAgentId, delivery, attachments })`.
- `SwarmManager` emits `conversation_message` with `source: "user_input"`.
- Manager replies via `speak_to_user` tool (`apps/backend/src/swarm/swarm-tools.ts`), which calls `publishToUser(...)`.
- `publishToUser(...)` emits `conversation_message` with `source: "speak_to_user"`.
- WS server currently broadcasts by subscribed agent ID only.

## Important current constraints
- `speak_to_user` only accepts `{ text }` right now.
- `handleUserMessage(...)` has no source/channel context fields.
- `ConversationMessageEvent` has no channel metadata field.
- Manager prompt (`apps/backend/src/swarm/archetypes/builtins/manager.md`) currently requires at least one `speak_to_user` for every user message.

## Telegram-plan consistency note
- Existing Telegram plan uses a **broadcast** model.
- This Slack plan introduces a **generic channel-aware core** that should become the shared architecture for Slack + future Telegram (and supersede broadcast behavior where needed).

---

## Cross-Cutting Channel/Source Architecture (Phase 0)

## 1) Add canonical source metadata model

Add a shared type in backend+frontend protocol/types (names can vary, shape should match this intent):

```ts
type MessageChannel = "web" | "slack";

interface MessageSourceContext {
  channel: MessageChannel;
  channelId?: string;   // Slack conversation ID (C..., D..., G...)
  userId?: string;      // Slack user ID (U...)
  threadTs?: string;    // Slack thread target
  // optional future-safe fields:
  channelType?: "dm" | "channel" | "group" | "mpim";
  teamId?: string;
}
```

Also add:

```ts
type ResponseExpectation = "required" | "optional";
```

Why: supports web + Slack uniformly and enables selective-response behavior without overloading `source`.

## 2) Extend `handleUserMessage(...)`

Current:
- `handleUserMessage(text, { targetAgentId, delivery, attachments })`

Proposed:
- include `sourceContext` and `responseExpectation`:

```ts
handleUserMessage(text, {
  targetAgentId,
  delivery,
  attachments,
  sourceContext,
  responseExpectation,
})
```

Defaults:
- Web WS path sets `sourceContext = { channel: "web" }`, `responseExpectation = "required"`.
- Slack DM / @mention: `responseExpectation = "required"`.
- Slack ambient channel chatter: `responseExpectation = "optional"`.

## 3) Replace pending reply count with pending reply context queue

Current manager state tracks only `pendingUserRepliesByManagerId: number`.

Proposed:
- keep count for status if desired, but also track queue entries with source context:

```ts
interface PendingReplyContext {
  sourceContext: MessageSourceContext;
  responseExpectation: ResponseExpectation;
  receivedAt: string;
}
```

Default response target resolution for `speak_to_user`:
1. Explicit target passed by tool call
2. Oldest pending `required` context
3. Most recent pending context
4. fallback `{ channel: "web" }`

## 4) Extend `speak_to_user` tool contract

Current params: `{ text }`

Proposed params:

```ts
{
  text: string,
  target?: {
    channel: "web" | "slack",
    channelId?: string,
    userId?: string,
    threadTs?: string
  }
}
```

Behavior:
- If `target` omitted, manager defaults to originating channel context.
- Tool returns which target was resolved (for observability/debug).

## 5) Extend `publishToUser(...)`

Current:
- `publishToUser(agentId, text, source = "speak_to_user")`

Proposed:
- accept resolved target metadata:

```ts
publishToUser(agentId, text, source, targetContext?)
```

## 6) Schema change: `conversation_message` event

Add channel/source metadata to conversation messages (at minimum):
- `sourceContext?: MessageSourceContext`
- `responseExpectation?: ResponseExpectation` (mainly useful on user messages)

This applies to both backend (`apps/backend/src/swarm/types.ts`, `apps/backend/src/protocol/ws-types.ts`) and frontend mirror (`apps/ui/src/lib/ws-types.ts`).

Backward compatibility:
- Keep fields optional in validators so old persisted session entries still load.
- Existing `source` (`user_input`/`speak_to_user`/`system`) remains.

## 7) Manager prompt updates

Update `apps/backend/src/swarm/archetypes/builtins/manager.md` to include:
- source-aware behavior
- selective response rules for optional channel chatter
- updated requirement wording:
  - `required` user requests must still end with `speak_to_user`
  - `optional` channel chatter may be ignored without violating turn rules
- explicit instruction to pick `target` in `speak_to_user` when needed

## 8) WS server behavior

WS ingress:
- Web `user_message` automatically tagged `sourceContext: { channel: "web" }`.

WS egress:
- Continue emitting canonical `conversation_message` events with new metadata.
- UI can decide whether to show all channels, filter, or badge messages by source.

---

## Slack-Specific Design

## 1) Slack app setup and scopes

### Tokens
- **Bot token** (`xoxb-...`) for Web API (send messages, fetch files, list channels)
- **App token** (`xapp-...`) for Socket Mode connection

### Recommended scopes by phase

**Phase 1 (DM MVP):**
- `connections:write` (app-level)
- `chat:write`
- `im:history` (for `message.im`)

**Phase 2 (channel listening):**
- `app_mentions:read`
- `channels:history` (public channels)
- optional `groups:history` (private channels)

**Phase 3 (files):**
- `files:read`

**Optional for channel picker UI:**
- `channels:read`, optional `groups:read`

## 2) Connection mode decision

### Recommendation: Socket Mode first
Why:
- Local-first Swarm (no public HTTPS endpoint requirement)
- Fastest development loop
- Aligns with single-process local daemon architecture

Tradeoffs:
- Stateful WebSocket handling, reconnection complexity
- Not suitable for Slack Marketplace listing

Keep HTTP Events API as a future production mode (not MVP).

## 3) Slack integration module structure

Proposed backend module:

`apps/backend/src/integrations/slack/`

- `slack-config.ts` — load/save/validate `slack.json`
- `slack-types.ts` — minimal Slack event/config/domain types
- `slack-client.ts` — Web API wrapper (`chat.postMessage`, file download, channels list)
- `slack-socket.ts` — Socket Mode lifecycle/reconnect/ack
- `slack-router.ts` — inbound event normalization + routing to `SwarmManager`
- `slack-delivery.ts` — consume `conversation_message` + deliver targeted Slack replies
- `slack-heuristics.ts` — “directed at bot?” classifier
- `slack-status.ts` — status/log events for UI

Startup integration point:
- `apps/backend/src/index.ts` creates/starts Slack integration service after `SwarmManager.boot()`.
- Clean shutdown in SIGINT/SIGTERM path.

## 4) Inbound Slack message listening

Listen to:
- `message.im` for DMs
- `app_mention` for explicit mentions
- `message.channels` (+ optional `message.groups`) for channel traffic

Ignore events that cause loops/noise:
- bot’s own messages (`event.user === botUserId` or `bot_id` present)
- non-message edit/replay subtypes unless intentionally supported
- duplicate events (dedupe by `event_id` or fallback `channel+ts`)

Normalize each inbound message to:
- text
- attachments (later phases)
- `sourceContext` (channel/channelId/userId/threadTs)
- `responseExpectation` (`required` for DM/mention, optional for ambient channel chatter)

## 5) Selective response logic

Manager should only respond when one of these is true:
1. DM (`message.im`)
2. `app_mention`
3. message appears directed at bot (heuristic)

Heuristic examples (configurable):
- starts with bot name / configured wake word
- asks direct question in a thread where bot participates
- explicit second-person prompt pattern (`"can you"`, `"please"` + bot alias)

For ambient chatter:
- still ingest into manager context (optional expectation)
- manager may choose not to `speak_to_user`

## 6) Thread support

Default behavior for channel replies:
- If inbound has `thread_ts`, reply in same thread.
- Else if channel message and config `respondInThread=true`, reply with `thread_ts = event.ts` (start thread).
- Keep `reply_broadcast=false` by default to reduce channel noise.

DMs can reply directly without forced threading.

## 7) Message formatting

MVP:
- send plain `text` (safe baseline)

Phase 3+:
- lightweight Markdown -> Slack mrkdwn conversion:
  - preserve code fences/backticks
  - escape `<`, `>`, `&`
  - keep links readable
- keep output chunks below practical Slack limits

## 8) File/image ingestion

Inbound Slack file flow:
1. detect files in message payload
2. fetch `url_private` / `url_private_download` with bearer bot token
3. map to Swarm attachments:
   - image/* -> image attachment
   - text/* + small structured text -> text attachment
   - other -> binary attachment (size-gated)
4. enforce max file size + allowed MIME policy

Security and performance:
- strict byte limits
- reject unknown giant binaries
- never log raw file bytes

## 9) Config storage and API

Config path:
- `$SWARM_DATA_DIR/integrations/slack.json`

Suggested schema:

```json
{
  "enabled": false,
  "mode": "socket",
  "appToken": "xapp-...",
  "botToken": "xoxb-...",
  "targetManagerId": "manager",
  "listen": {
    "dm": true,
    "channelIds": [],
    "includePrivateChannels": false
  },
  "response": {
    "respondInThread": true,
    "replyBroadcast": false,
    "wakeWords": ["swarm", "bot"]
  },
  "attachments": {
    "maxFileBytes": 10485760,
    "allowImages": true,
    "allowText": true,
    "allowBinary": false
  }
}
```

Backend endpoints (similar to settings env style):
- `GET /api/integrations/slack` (token masked)
- `PUT /api/integrations/slack` (save + hot-reload bridge)
- `POST /api/integrations/slack/test` (auth + connection smoke)
- `GET /api/integrations/slack/channels` (optional channel picker support)
- `DELETE /api/integrations/slack` (disable)

WS status events:
- `slack_status` (`connecting|connected|disconnected|error`, details)

## 10) UI configuration

Extend existing settings dialog (or move to integrations tab) with Slack section:
- enable/disable toggle
- app token + bot token fields (masked)
- target manager dropdown
- DM on/off
- channel picker (multi-select)
- “respond in thread” toggle
- wake words input
- connection/status log panel
- test connection button

---

## Implementation Phases

## Phase 0 — Channel/Source Core (cross-cutting)

Scope:
- Implement source metadata model and response expectation.
- Extend `handleUserMessage`, `publishToUser`, `speak_to_user` target support.
- Update manager prompt and pending reply bookkeeping.
- Add metadata to `conversation_message` schema (backend + frontend).

Primary files:
- `apps/backend/src/swarm/types.ts`
- `apps/backend/src/protocol/ws-types.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/swarm-tools.ts`
- `apps/backend/src/swarm/archetypes/builtins/manager.md`
- `apps/backend/src/ws/server.ts`
- `apps/ui/src/lib/ws-types.ts`
- UI display components (source badges)

Acceptance:
- Web messages are tagged as `{ channel: "web" }`.
- `speak_to_user` can explicitly target channel metadata.
- Default response target resolves to originating context.
- Manager can ignore optional chatter without missing-speak warnings.

## Phase 1 — Slack Socket Mode MVP (DM-only)

Scope:
- Add Slack integration service using Socket Mode.
- Support DMs only (`message.im`).
- Route inbound DM -> `handleUserMessage` with Slack context.
- Route outbound `speak_to_user` targeted to Slack DM via `chat.postMessage`.
- Add config file + REST CRUD + status events.

Acceptance:
- DM with bot reaches manager.
- Manager reply reaches same DM.
- Web and Slack coexist without forced cross-channel reply broadcast.

## Phase 2 — Channel listening + selective response

Scope:
- Add channel event subscriptions (`app_mention`, `message.channels`, optional private channels).
- Implement heuristic classifier and optional/required response expectation mapping.
- Pass channel/thread metadata through source context.
- Update manager prompt behavior for selective responses.

Acceptance:
- Manager responds for mentions/DMs.
- Ambient channel chatter can be ignored.
- Replies default to thread policy in channels.

## Phase 3 — Thread fidelity + file/image support

Scope:
- Robust thread behavior (`thread_ts`, start-thread-on-first-reply mode).
- Inbound file/image download and mapping to Swarm attachments.
- Message formatting improvements (markdown->mrkdwn).
- 429 retry/backoff and send queue hardening.

Acceptance:
- Channel replies stay in intended threads.
- Images/files from Slack can reach Swarm agent context safely.

## Phase 4 — Full UI settings experience

Scope:
- Integrations UI polish (channel selection, diagnostics, token masking, test tools).
- Optional observability controls (show all-channel transcript vs filtered view).

Acceptance:
- Entire Slack setup is configurable from UI with no terminal/env edits.

---

## Dependencies

Backend runtime deps:
- `@slack/socket-mode`
- `@slack/web-api`

No Bolt requirement for MVP; keep integration lightweight and aligned with existing custom server architecture.

---

## Auth, Security, and Reliability

- Treat Slack tokens as secrets; mask in API responses/logs.
- Store config under integrations directory; lock file permissions where possible.
- Ignore self/bot echo events to prevent loops.
- Dedupe event deliveries.
- Enforce attachment size limits and MIME allowlists.
- Handle Slack 429 with `Retry-After`.
- Socket reconnect with jittered backoff.
- Optional workspace/team allowlist (`teamId`) to prevent accidental cross-workspace routing.

---

## Limitations / Risks

- Socket Mode is not Marketplace-friendly and is stateful.
- High-traffic channels can create context noise/cost.
- Slack formatting differs from Markdown.
- File handling increases memory/latency risk without strict limits.
- Selective-response heuristics can have false positives/negatives.

Mitigations:
- configurable channel list + heuristics
- optional ingestion throttling/summarization later
- strict attachment constraints

---

## Test Plan

## Unit tests
- source context parsing and defaults
- pending reply context resolution
- `speak_to_user` target resolution
- Slack heuristic classifier
- Slack config validation/masking
- attachment mapping limits/type handling

## Integration tests
- mock Socket Mode event envelopes -> manager ingestion
- manager `speak_to_user` -> Slack `chat.postMessage` routing
- DM vs channel expectation behavior (`required` vs `optional`)
- REST config endpoints + hot reload

## Existing test suites to update
- `apps/backend/src/test/swarm-manager.test.ts`
- `apps/backend/src/test/swarm-tools.test.ts`
- `apps/backend/src/test/ws-server.test.ts`
- UI protocol/type handling tests where applicable

## Manual smoke checklist
1. Configure Slack in settings UI.
2. DM bot -> manager reply returns in DM.
3. Mention bot in channel -> threaded reply.
4. Regular channel chatter without mention -> no unnecessary reply.
5. Send Slack image/file (within limits) -> attachment reaches agent context.
6. Disable integration -> no Slack traffic routed.

---

## Rollout Recommendation
- Ship behind `enabled=false` default config.
- Land Phase 0 first (shared architecture), then Slack phases incrementally.
- After Slack stabilizes, align Telegram integration plan/implementation to the same channel-aware core.