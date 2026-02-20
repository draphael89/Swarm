# Codex App Server Integration Plan for Swarm

## Objective
Integrate **OpenAI Codex App Server** as an alternate runtime so Swarm can run Codex-based agents alongside existing pi-based agents.

Target outcomes:
- Codex agents appear in the existing UI agent list/sidebar
- Users can message Codex agents and receive replies
- Manager can delegate to Codex workers (including code tasks)
- Codex workers can report back to manager through Swarm tools (`send_message_to_agent`)

---

## Research Sources

1. OpenAI docs: https://developers.openai.com/codex/app-server/
2. Codex OSS repo: `~/codex`
   - `codex-rs/app-server/README.md`
   - `codex-rs/app-server/src/*`
   - `codex-rs/app-server-protocol/src/protocol/*`
   - `codex-rs/app-server-protocol/schema/typescript/*`
   - `codex-rs/app-server/tests/suite/v2/*`
3. Current Swarm architecture:
   - `apps/backend/src/swarm/agent-runtime.ts`
   - `apps/backend/src/swarm/swarm-manager.ts`
   - `apps/backend/src/swarm/swarm-tools.ts`
   - `apps/backend/src/swarm/model-presets.ts`
   - `apps/backend/src/swarm/types.ts`
   - `apps/backend/src/ws/server.ts`
   - `apps/ui/src/lib/ws-types.ts`

---

## Current Swarm Runtime Architecture (As-Is)

Swarm currently assumes pi `AgentSession` runtime for all agents:

- `SwarmManager.createRuntimeForDescriptor()` always calls pi `createAgentSession(...)`
- `AgentRuntime` wraps `AgentSession` and provides:
  - `sendMessage(string | RuntimeUserMessage, delivery)`
  - `terminate({abort})`
  - queueing/steering behavior while streaming
  - status transitions (`idle`/`streaming`/`terminated`)
- Conversation persistence is tied to `SessionManager` custom entries in `descriptor.sessionFile`
- Tool injection happens via `buildSwarmTools(...)` passed as pi `customTools`
- Model preset system only supports `codex-5.3` and `opus-4.6`

This means there is no runtime boundary yet; “runtime” is effectively “pi session.”

---

## Codex App Server API Surface (What matters for Swarm)

## 1) Transport & Handshake
- Preferred transport for integration: **stdio JSONL** (`codex app-server`)
- WebSocket exists but is explicitly experimental/unsupported for prod
- Required startup flow:
  1. `initialize` request (`clientInfo`, optional capabilities)
  2. `initialized` notification
- Requests before initialize fail with `Not initialized`
- Duplicate initialize fails with `Already initialized`

## 2) Conversation Lifecycle
- `thread/start` -> new thread
- `thread/resume` -> resume persisted thread
- `thread/fork`, `thread/list`, `thread/read`, `thread/archive`, `thread/unarchive`
- `turn/start` -> begin generation
- `turn/steer` -> append input to active turn
- `turn/interrupt` -> cancel active turn

Core event stream:
- `turn/started`, `turn/completed`
- `item/started`, `item/completed`
- `item/agentMessage/delta` and other item-specific deltas

## 3) Server-Initiated Requests (important)
Codex can request input from client:
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`
- `item/tool/call` (dynamic tools, experimental)
- `account/chatgptAuthTokens/refresh` (external auth mode)

## 4) Auth Surface
- `account/read`
- `account/login/start`:
  - `apiKey`
  - `chatgpt` (browser flow)
  - `chatgptAuthTokens` (experimental/external token mode)
- `account/logout`
- `account/rateLimits/read`
- notifications: `account/updated`, `account/login/completed`, `account/rateLimits/updated`

## 5) Streaming/Error Semantics
- Incremental text is notification-based (`item/agentMessage/delta`)
- Turn terminal state is authoritative via `turn/completed` status:
  - `completed` | `interrupted` | `failed`
- Overload behavior (notably WebSocket ingress): JSON-RPC error code `-32001` (“Server overloaded; retry later.”)

---

## Proposed Runtime Adapter Design

## A. Introduce runtime abstraction in Swarm
Create a runtime interface used by `SwarmManager` instead of concrete `AgentRuntime` class.

Suggested shape:
- `sendMessage(...)`
- `terminate(...)`
- `getPendingCount()`
- `appendCustomEntry(...)`
- optional: `getStatus()`

Then have two implementations:
1. **PiAgentRuntime** (existing behavior, current `agent-runtime.ts` logic)
2. **CodexAgentRuntime** (new app-server based adapter)

This keeps SwarmManager orchestration unchanged while enabling runtime routing.

## B. CodexAgentRuntime internals
1. Spawn `codex app-server` child process (stdio)
2. JSON-RPC client with:
   - request id tracking
   - pending promise map
   - notification dispatcher
   - server-request handler
3. Handshake (`initialize` + `initialized`)
4. Thread bootstrap:
   - resume known thread if persisted
   - else start new thread
5. Message delivery:
   - idle -> `turn/start`
   - streaming/busy -> `turn/steer`
6. Status mapping to Swarm `AgentStatus`
7. Persist thread metadata + conversation entries via same `SessionManager` custom-entry path used today (for compatibility with existing history reload logic)

---

## Integration Points in Swarm

## 1) `apps/backend/src/swarm/swarm-manager.ts`
- Replace concrete runtime map type with interface
- Runtime factory branch:
  - pi runtime for existing presets/providers
  - codex runtime for new codex preset/runtime kind
- Keep existing lifecycle behavior (`restoreRuntimesForBoot`, `terminateDescriptor`, status emits)

## 2) `apps/backend/src/swarm/agent-runtime.ts`
- Either:
  - rename to `pi-agent-runtime.ts`, or
  - keep file but mark as pi implementation

## 3) New files (recommended)
- `apps/backend/src/swarm/runtime-types.ts` (runtime interface)
- `apps/backend/src/swarm/codex-jsonrpc-client.ts`
- `apps/backend/src/swarm/codex-agent-runtime.ts`
- `apps/backend/src/swarm/codex-tool-bridge.ts` (dynamic tools + approvals handling)

## 4) `apps/backend/src/swarm/model-presets.ts` + `types.ts`
- Add preset: `codex`
- Keep existing `codex-5.3`, `opus-4.6`
- Add runtime-aware descriptor mapping (see below)

## 5) `apps/backend/src/swarm/swarm-tools.ts`
- Expand allowed spawn model schema to include `codex`
- Keep manager/worker tool behavior identical

## 6) WS + UI contracts
- `apps/backend/src/ws/server.ts`: preset validation auto-updates via preset set
- `apps/ui/src/lib/ws-types.ts`: add `codex` to `MANAGER_MODEL_PRESETS`
- `apps/ui/src/routes/index.tsx`: model selector includes `codex`
- Existing sidebar/chat behavior should work without structural changes

---

## Model Preset Strategy

Add a new preset with runtime meaning:

- `codex-5.3` -> existing pi runtime path (current behavior)
- `opus-4.6` -> existing pi runtime path
- `codex` -> **Codex App Server runtime path**

Recommended descriptor mapping for `codex`:
- `provider: "openai-codex-app-server"`
- `modelId: "default"` (or resolved default from `model/list` at runtime)
- `thinkingLevel`: preserved field for compatibility (not authoritative for codex runtime)

This avoids ambiguity with current pi codex preset and allows mixed deployments.

---

## Tool Compatibility Plan

Swarm tool parity requirement for manager delegation:
- `list_agents`
- `send_message_to_agent`
- manager-only: `spawn_agent`, `kill_agent`, `speak_to_user`

### How to expose tools in Codex runtime
Use Codex **dynamic tools** (experimental):
- Pass `dynamicTools` in `thread/start` (JSON Schema derived from existing TypeBox tool schemas)
- Handle server request `item/tool/call` and execute corresponding Swarm tool handler
- Return `DynamicToolCallResponse` with `inputText` content items

This enables Codex workers to call `send_message_to_agent`, which is required for manager<->worker workflow in current Swarm design.

---

## Message/Event Mapping

Swarm UI expects Swarm conversation events, not raw Codex notifications.

Recommended mapping in Codex runtime adapter:

- `turn/started` -> runtime status `streaming`
- `turn/completed` -> runtime status `idle`

- `item/started` (userMessage) -> synthetic `message_start`(role=user)
- `item/completed` (userMessage) -> synthetic `message_end`(role=user)

- `item/started` (agentMessage) -> synthetic `message_start`(assistant)
- `item/agentMessage/delta` -> synthetic `message_update`(assistant)
- `item/completed` (agentMessage) -> synthetic `message_end`(assistant)

- `item/started` tool-like items (`commandExecution`, `fileChange`, etc.)
  -> `tool_execution_start`
- delta notifications (`item/commandExecution/outputDelta`, `item/fileChange/outputDelta`)
  -> `tool_execution_update`
- `item/completed` tool-like items
  -> `tool_execution_end` (set `isError` for failed/declined states)

This preserves current SwarmManager conversation capture logic and UI rendering behavior.

---

## Auth Plan

## Phase 1 (pragmatic)
- Require pre-authenticated Codex environment:
  - existing Codex login state in `CODEX_HOME` **or**
  - API key flow via `account/login/start` if key configured in backend env
- Validate with `account/read` during runtime startup
- Fail fast with clear error if auth is missing

## Phase 2
- Expose backend/UI auth controls for Codex runtime:
  - trigger `account/login/start` (`chatgpt` mode) and surface `authUrl`
  - show `account/updated` state
  - optionally support external token mode (`chatgptAuthTokens`, experimental)

Important: set meaningful `clientInfo.name` for compliance logs.

---

## Streaming & Delivery Semantics

Current Swarm behavior for busy agents already favors steering.

For Codex runtime:
- Maintain same external semantics:
  - if idle: `acceptedMode=prompt`, use `turn/start`
  - if active: `acceptedMode=steer`, use `turn/steer`
- Keep existing pending-delivery accounting behavior
- `followUp` remains compatible with current Swarm behavior (currently coerced to steer while active)

---

## Known Limitations / Risks

1. **Dynamic tools are experimental** in Codex API; protocol may change.
2. **WebSocket transport is experimental**; use stdio.
3. Codex approval flows can block turns; phase-1 should explicitly set non-blocking approval policy or deterministically handle approval requests.
4. Codex event richness is higher than current Swarm UI schema; initial integration will flatten to existing message/log model.
5. Runtime process management complexity (child process crashes, reconnect/resume).
6. Potential contention if many codex app-server processes share one `CODEX_HOME` state DB.

---

## Implementation Phases

## Phase 0 — Runtime abstraction prep
- Introduce runtime interface in backend
- Wrap existing pi runtime as implementation
- No behavior changes

## Phase 1 — Codex runtime MVP (chat only)
- Add JSON-RPC stdio client + handshake
- thread start/resume + turn start/steer/interrupt
- basic status mapping
- basic assistant/user message mapping
- agents visible + messageable in UI

Acceptance: user can chat directly with a codex agent.

## Phase 2 — Tool bridge for delegation
- Implement dynamic tools adapter for Swarm tools
- Handle `item/tool/call` requests
- Ensure codex worker can call `send_message_to_agent`

Acceptance: Claude manager can delegate tasks to codex worker and receive reports.

## Phase 3 — Presets + contract plumbing
- Add `codex` preset across backend+UI
- Update spawn/create validation + tests
- preserve `codex-5.3` and `opus-4.6`

Acceptance: create manager / spawn worker with model `codex` from UI and tools.

## Phase 4 — Auth hardening
- Add startup auth checks (`account/read`)
- optional API-key login call path
- better user-facing error messages for auth failures

## Phase 5 — Robustness + observability
- crash/restart handling
- overload/backoff handling for retryable errors
- structured debug logs for JSON-RPC traffic (redacted)
- better recovery on boot (`thread/resume` fallback to `thread/start`)

---

## Test Plan

Backend unit/integration:
- runtime factory selects correct runtime by preset/provider
- codex handshake sequence
- thread resume/start logic
- sendMessage idle vs active (`turn/start` vs `turn/steer`)
- event mapping -> Swarm conversation events
- dynamic tool request execution path (`item/tool/call`)
- approval request behavior
- process crash handling

Contract/UI tests:
- model preset unions include `codex`
- create-manager dialog shows `codex`
- ws command validation accepts `codex`

Repo checks before merge:
- `pnpm test`
- `pnpm build`
- `pnpm exec tsc --noEmit`

---

## Recommendation

Proceed with phased implementation, prioritizing:
1) runtime abstraction,
2) codex runtime MVP,
3) dynamic tools bridge.

That order gets visible Codex agents quickly while still unlocking manager-to-codex delegation in a controlled next step.