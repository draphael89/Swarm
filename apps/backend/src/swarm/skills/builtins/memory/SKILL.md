---
name: memory
description: Update persistent swarm memory in ${SWARM_DATA_DIR}/MEMORY.md for explicit remember/update/forget requests, and for internal auto-memory reflections when that mode is enabled.
---

# Persistent Memory Workflow

Use this skill when:
- the user explicitly asks to remember something for later,
- the user explicitly asks to update previously remembered facts/preferences,
- the user explicitly asks to forget/remove stored memory entries, or
- auto-memory mode is enabled and you receive an internal reflection task to persist durable facts.

Do not write memory for normal one-off requests when auto-memory mode is off.

## File location
- Persistent memory file: `${SWARM_DATA_DIR}/MEMORY.md`.
- In this runtime, use the exact MEMORY.md path shown in your loaded context.

## Steps
1. Read current MEMORY.md with `read` before changing it.
2. Apply minimal edits:
   - prefer `edit` for targeted changes,
   - use `write` only for full rewrites.
3. Keep entries concise, factual, and durable.
4. If a line limit is provided in prompt/context, keep MEMORY.md within that limit by pruning stale or low-value entries.
5. Never store secrets (passwords, API keys, tokens, private keys) or highly sensitive personal data.
6. If the request is ambiguous, ask a clarifying question before writing.
7. After updating memory:
   - manager on explicit user remember/update/forget requests: confirm the update to the user via `speak_to_user`,
   - manager on internal auto-memory reflection tasks: do not call `speak_to_user` unless explicitly instructed,
   - worker: report the update back to the manager via `send_message_to_agent`.
