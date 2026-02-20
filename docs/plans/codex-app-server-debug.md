# Codex App Server Runtime — Debug Notes & Investigation Plan

## The Problem

Codex App Server workers connect, create worktrees, and appear to execute tasks — but at least one worker reported a commit hash (`d2310c0`) that **doesn't exist**. No files were actually written, no commits were made. The worker reported success with fabricated evidence.

This is the "phantom completion" bug.

---

## What We Know Works

1. **Process spawn** — `codex app-server --listen stdio://` spawns correctly
2. **JSON-RPC handshake** — `initialize` + `initialized` completes
3. **Auth** — `account/read` + `account/login/start` (API key flow) works
4. **Thread bootstrap** — `thread/start` returns a valid thread ID
5. **Turn start** — `turn/start` fires, `turn/started` notification received
6. **Message streaming** — `item/agentMessage/delta` events arrive with text content
7. **Turn completion** — `turn/completed` notification fires
8. **Dynamic tools** — tool schemas are passed in `thread/start`, and `item/tool/call` requests arrive for `send_message_to_agent`, `list_agents`, etc.
9. **Tool bridge** — `CodexToolBridge.handleToolCall()` executes and returns results

## What We Suspect Doesn't Work

1. **Actual file writes** — Commands like `write_file`, `edit_file` may not be executing, OR their results aren't persisting
2. **Shell command execution** — `git commit`, `git add`, etc. may not actually run, or may run in a sandboxed/ephemeral context
3. **The model may be hallucinating tool results** — Codex might be generating plausible-looking output (commit hashes, file paths) without actually executing the commands

---

## Architecture of the Runtime

### Files
- `apps/backend/src/swarm/codex-agent-runtime.ts` — Main runtime adapter
- `apps/backend/src/swarm/codex-jsonrpc-client.ts` — JSON-RPC stdio transport
- `apps/backend/src/swarm/codex-tool-bridge.ts` — Dynamic tool bridge (Swarm tools → Codex)

### How It Works

```
Swarm Manager
    ↓ sendMessage()
CodexAgentRuntime
    ↓ turn/start (JSON-RPC)
codex app-server (child process, stdio)
    ↓ LLM generates response + tool calls
    ↓ item/commandExecution/requestApproval → auto-accepted
    ↓ item/fileChange/requestApproval → auto-accepted
    ↓ item/tool/call (dynamic tools) → CodexToolBridge
    ↓ item/agentMessage/delta → streaming text
    ↓ turn/completed
CodexAgentRuntime → emits Swarm events → UI
```

### Key Config
```typescript
const CODEX_SANDBOX_MODE = "danger-full-access";

// Thread config
sandboxMode: "danger-full-access"
threadConfig: { sandbox_mode: "danger-full-access" }
turnSandboxPolicy: { type: "dangerFullAccess" }
approvalPolicy: "never"  // auto-approve everything
```

### Approval Handling
All approval requests are auto-accepted:
```typescript
case "item/commandExecution/requestApproval":
  return { decision: "accept" };

case "item/fileChange/requestApproval":
  return { decision: "accept" };
```

---

## Investigation Areas

### 1. Are Commands Actually Executing?

**Hypothesis:** Commands may be getting approval but not actually running, or running in a wrong directory.

**How to test:**
- Add logging to `handleNotification` for `item/started` and `item/completed` events where `type === "commandExecution"` or `type === "fileChange"`
- Log the full `item` payload including `status`, `exitCode`, `command`, `cwd`
- Check: does `item/completed` for commandExecution show `status: "completed"` with `exitCode: 0`?
- Check: is the `cwd` correct (the worktree path, not the repo root)?

**Where to add logging:**
```typescript
// In handleItemEvent(), log the full item for tool-like items:
if (isToolLikeThreadItem(item.type)) {
  console.error(`[codex-debug] ${stage} ${item.type}:`, JSON.stringify(item, null, 2));
}
```

### 2. Is the CWD Correct?

**Hypothesis:** The Codex process may be operating in the wrong directory.

**Key points:**
- `thread/start` receives `cwd: this.descriptor.cwd`
- `turn/start` also receives `cwd: this.descriptor.cwd`
- The descriptor CWD is set at spawn time — check that it's the worktree path, not `~/swarm`

**How to test:**
- Log `this.descriptor.cwd` at thread start and turn start
- Have the Codex agent run `pwd` and check the output in `item/commandExecution/outputDelta`

### 3. Is the Sandbox Actually `dangerFullAccess`?

**Hypothesis:** The sandbox settings might not be taking effect, leaving the agent in read-only mode.

**How to test:**
- Log the full `thread/start` request payload
- Check the Codex app-server stderr for sandbox mode confirmation
- Try a simple write test: have the agent create a file and verify it exists

**Key concern:** There are THREE places sandbox is configured:
```typescript
sandboxMode: "danger-full-access"           // thread/start.sandbox
threadConfig: { sandbox_mode: "danger-full-access" }  // thread/start.config
turnSandboxPolicy: { type: "dangerFullAccess" }       // turn/start.sandboxPolicy
```
These may conflict or one may override another. The Codex protocol docs show `sandboxPolicy` on `turn/start` as the authoritative sandbox control.

### 4. Dynamic Tools vs Native Tools

**Hypothesis:** The Codex agent might be using its native tools (read/write/bash) for file operations, but those might not work the same as dynamic tools.

**Key distinction:**
- **Dynamic tools** (Swarm tools like `send_message_to_agent`) — handled via `item/tool/call` server request → our `CodexToolBridge`
- **Native tools** (file read/write, shell commands) — handled internally by Codex runtime, we only see `item/commandExecution` and `item/fileChange` notifications

For native tool execution:
- We auto-approve via `requestApproval` handlers
- We see `outputDelta` events with stdout/stderr
- We see `item/completed` with final status

**Question:** Are the native tools actually executing after approval? Or is approval just a formality and execution is blocked by something else (permissions, sandbox, missing binary)?

### 5. Is the Model Hallucinating?

**Hypothesis:** The Codex model might generate text claiming it committed files, but never actually called any tools.

**How to test:**
- Check if `item/started` events with `type: "commandExecution"` or `type: "fileChange"` are even being received
- If NO tool-like items appear, the model is generating text without executing commands
- If tool items DO appear but have `status: "failed"`, there's an execution error

### 6. Thread Persistence / Resume Issues

**Hypothesis:** On resume, the thread might lose its system prompt or tool definitions.

**How to test:**
- Log the full `thread/resume` request and response
- Check if `developerInstructions` is included in resume
- Check if dynamic tools survive resume

---

## Recommended Debug Steps (Priority Order)

### Step 1: Add Comprehensive Logging
Add stderr logging to `codex-agent-runtime.ts`:
- Log ALL notifications with full payload (temporarily)
- Log ALL server requests and our responses
- Log thread/turn lifecycle events
- Log the descriptor.cwd at each stage

### Step 2: Manual Test with Simple Task
Send a Codex App worker a dead-simple task:
```
Create a file called /tmp/codex-test.txt with the content "hello world"
```
Then check:
- Did `item/commandExecution` or `item/fileChange` events appear?
- Did `requestApproval` fire?
- Does `/tmp/codex-test.txt` exist after?

### Step 3: Check Codex Binary Version & Capabilities
```bash
codex --version
codex app-server --help
```
Verify the installed Codex binary supports:
- `danger-full-access` sandbox mode
- Dynamic tools
- The approval flow we're using

### Step 4: Standalone Codex Test
Test Codex outside of Swarm to isolate the issue:
```bash
echo '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1.0.0"},"capabilities":{"experimentalApi":true}}}' | codex app-server --listen stdio://
```
Then manually send thread/start + turn/start and observe behavior.

### Step 5: Compare with Pi Runtime
The Pi runtime (which works) uses `AgentSession` from `@mariozechner/pi-coding-agent`. Compare:
- How does Pi execute shell commands?
- How does Pi handle file writes?
- Is there a fundamental difference in how commands are dispatched?

---

## Reference Files

| File | Purpose |
|------|---------|
| `apps/backend/src/swarm/codex-agent-runtime.ts` | Main runtime — start here |
| `apps/backend/src/swarm/codex-jsonrpc-client.ts` | JSON-RPC transport layer |
| `apps/backend/src/swarm/codex-tool-bridge.ts` | Dynamic tool bridge |
| `apps/backend/src/swarm/runtime-types.ts` | Runtime interface contract |
| `apps/backend/src/swarm/swarm-manager.ts` | Where runtimes are created |
| `apps/backend/src/swarm/model-presets.ts` | Preset → runtime mapping |
| `~/codex/codex-rs/app-server/README.md` | Codex app-server docs |
| `~/codex/codex-rs/app-server-protocol/schema/typescript/v2/` | Protocol types |
| `~/codex/codex-rs/app-server/tests/suite/v2/` | Test fixtures |
| `docs/plans/codex-integration.md` | Original integration plan |

## Environment

- `CODEX_BIN` — path to codex binary (falls back to `codex` on PATH)
- `CODEX_API_KEY` / `OPENAI_API_KEY` — auth for Codex
- Codex home: `~/.codex` (default)

---

## TL;DR

The Codex App Server runtime adapter is architecturally sound — it handles handshake, threads, turns, streaming, dynamic tools, and approval flows. The bug is almost certainly in one of:

1. **Native tool execution not actually happening** after approval (sandbox/permission issue)
2. **CWD mismatch** — commands running in wrong directory
3. **Model hallucination** — agent generates "I committed X" text without calling tools
4. **Sandbox config conflict** — three overlapping sandbox settings may not all take effect

Start with comprehensive logging (Step 1) and a simple write test (Step 2) to narrow it down fast.
