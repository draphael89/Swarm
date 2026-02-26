# Cron Scheduling Plan (Skill + File Architecture)

## Objective
Ship durable cron/one-shot scheduling with minimal overhead by using:
1. A built-in skill (patterned after `brave-search`) that the manager uses.
2. One CLI script that performs `add`, `remove`, and `list` directly against a JSON file.
3. A backend scheduler loop that reads that file and triggers manager messages when tasks fire.

This keeps scheduling local-first, reboot-safe, and aligned with existing manager flow without adding new swarm tools or schedule REST/WS APIs in v1.

---

## Key Decision
Replace the prior multi-tool + API-heavy design with a single skill + file contract:
- Manager controls schedules by running one script.
- Script is the only CRUD interface.
- Daemon executes schedules independently by reading the same persisted file.

---

## Scope (v1)
In scope:
1. One-shot and recurring schedules.
2. Persistence across daemon restarts/reboots.
3. Timezone-aware scheduling with explicit DST semantics.
4. Dispatch through manager as if a user message arrived.

Out of scope:
1. New schedule-specific tools in `swarm-tools.ts`.
2. New `/api/schedules` endpoints.
3. Dedicated schedules UI page (can be added later).

---

## Architecture Overview
1. User asks manager to schedule something.
2. Manager uses cron skill instructions and runs `schedule.js add ...`.
3. Script writes schedule record into `${SWARM_DATA_DIR}/schedules.json` (default `~/.middleman/schedules.json`).
4. Scheduler service in backend watches/polls that file, computes due work, and dispatches when ready.
5. Dispatch path calls `SwarmManager.handleUserMessage(...)` with schedule metadata so execution behaves like normal user input.
6. Manager replies through existing channel routing (`web`/`slack`) unchanged.

---

## Built-In Skill Design
Add new built-in skill folder:
- `apps/backend/src/swarm/skills/builtins/cron-scheduler/SKILL.md`
- `apps/backend/src/swarm/skills/builtins/cron-scheduler/schedule.js`
- `apps/backend/src/swarm/skills/builtins/cron-scheduler/package.json` (if script deps are needed)

Follow the `brave-search` pattern:
1. `SKILL.md` explains when to use it and exact CLI examples.
2. Manager is instructed to ask follow-up questions when schedule intent is ambiguous.
3. Skill is included in `reloadSkillMetadata()` alongside `memory` and `brave-search`.

---

## CLI Contract (Single Script)
Script operations:
1. `add` adds a one-shot or recurring schedule.
2. `remove` deletes a schedule by id.
3. `list` returns all schedules.

Suggested command style:
```bash
./schedule.js add --json '{"instruction":"Remind me to deploy","kind":"once","runAt":"2026-02-21T17:00:00","timezone":"America/Los_Angeles"}'
./schedule.js add --json '{"instruction":"Weekly status report","kind":"recurring","cron":"0 9 * * 1","timezone":"America/Los_Angeles"}'
./schedule.js remove --id sched_abc123
./schedule.js list
```

Rules:
1. Script is authoritative for file mutation.
2. Output is machine-readable JSON (success/error + payload).
3. Writes use atomic temp-file + rename to avoid partial files.

---

## Schedule File Format
Path:
- `${SWARM_DATA_DIR}/schedules.json`
- Default example: `~/.middleman/schedules.json`

Proposed structure:
```ts
interface ScheduleFile {
  version: 1;
  schedules: ScheduledTask[];
}

interface ScheduledTask {
  id: string;
  instruction: string;
  kind: "once" | "recurring";
  timezone: string; // IANA, e.g. America/Los_Angeles
  runAtUtc?: string; // once
  cron?: string; // recurring
  nextRunAtUtc?: string;
  status: "active" | "paused" | "completed" | "cancelled";
  missedRunPolicy: "skip" | "run_immediately" | "run_once_if_missed";
  targetManagerId: string;
  sourceContext?: {
    channel: "web" | "slack";
    userId?: string;
    channelId?: string;
    threadTs?: string;
  };
  lastFiredAtUtc?: string;
  createdAt: string;
  updatedAt: string;
}
```

Notes:
1. One-shot schedules transition to `completed` after successful dispatch.
2. Recurring schedules remain `active` until removed/cancelled.

---

## Scheduler Service (Backend)
Add lightweight scheduler service in backend runtime:
1. Load file on boot and build in-memory next-run view.
2. Watch file changes with `fs.watch` plus periodic polling fallback (for reliability).
3. On timer wake, evaluate due schedules and dispatch each due occurrence once.
4. Recompute `nextRunAtUtc`, persist updates, and continue.

No CRUD APIs are required because manager uses the script.

---

## Dispatch Path (As User Message)
When a task fires:
1. Scheduler builds a context prefix, for example:
```text
[scheduleContext] {"scheduleId":"sched_abc123","kind":"recurring","scheduledFor":"2026-02-23T17:00:00.000Z"}
<instruction>
```
2. Scheduler calls `swarmManager.handleUserMessage(...)` with:
   - `targetAgentId = task.targetManagerId`
   - `sourceContext = task.sourceContext` (if present)
   - `text = prefixed instruction`

Result: manager behavior, tool use, and channel reply semantics stay consistent with normal conversation flow.

---

## Timezone, Recurrence, and DST
Rules:
1. Persist timezone as IANA string.
2. Store execution instants in UTC (`runAtUtc`, `nextRunAtUtc`).
3. For recurring jobs, compute next run with timezone-aware cron parsing.

DST semantics:
1. Spring-forward missing local time: skip to next valid occurrence.
2. Fall-back repeated hour: run once at earliest valid instant.

Defaults:
1. Timezone defaults from source context when available.
2. Fallback timezone is daemon local timezone.

---

## Reboot and Missed-Run Behavior
On daemon startup:
1. Read `schedules.json`.
2. Recompute due state and `nextRunAtUtc`.
3. Apply `missedRunPolicy` for schedules that should have fired while down.

Missed-run defaults:
1. `once`: `run_once_if_missed`.
2. `recurring`: `run_once_if_missed` (catch up at most one occurrence).

Idempotency:
1. Use occurrence key `scheduleId + scheduledForUtc`.
2. If key already matches `lastFiredAtUtc`/last occurrence marker, skip duplicate dispatch.

---

## Implementation Plan
### Phase 1: Skill + Script
1. Add built-in `cron-scheduler` skill docs and CLI script.
2. Support `add`, `remove`, `list`.
3. Validate payloads and cron/timezone fields in script.

### Phase 2: Backend Scheduler
1. Add scheduler service module and wire into backend start/stop lifecycle.
2. Watch/poll file, execute due jobs, update file atomically.
3. Dispatch to manager through `handleUserMessage(...)`.

### Phase 3: Manager Prompt and Confirmation
1. Update manager guidance to use cron skill for scheduling requests.
2. Require clarification when date/time/timezone is ambiguous.
3. Confirm normalized schedule details back to user.

---

## Validation Checklist
1. `add` writes valid one-shot schedule and `list` shows it.
2. `add` writes valid recurring schedule and computes `nextRunAtUtc`.
3. `remove` deletes by id and scheduler no longer fires it.
4. One-shot task fires once, then marks `completed`.
5. Recurring task fires repeatedly with correct timezone/DST handling.
6. Restart daemon; schedules are still present and continue correctly.
7. Fired tasks appear to manager as normal user-message flow with schedule metadata.

---

## Risks and Mitigations
1. Concurrent script writes vs scheduler updates.
   - Mitigation: atomic rename writes and single-file lock discipline.
2. Ambiguous natural-language schedule requests.
   - Mitigation: manager must confirm structured time + timezone before `add`.
3. Duplicate firing around restart boundaries.
   - Mitigation: occurrence idempotency key and last-fired markers.
