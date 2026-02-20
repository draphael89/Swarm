# Cron Scheduling Plan for Swarm

## Objective
Add first-class scheduled task support to Swarm so users can request time-based work in natural language, including:
- "At 5pm today, do X"
- "Every Monday morning at 9am, run Y"
- "Tomorrow at noon, remind me about Z"

The feature should be local-first, durable across daemon restarts, and integrated with the existing manager/worker architecture.

---

## Desired Outcomes

1. Users can create one-shot and recurring schedules from normal chat messages.
2. Scheduled tasks survive restarts/reboots and execute reliably.
3. Triggered schedules route through the manager agent (not a side-channel bypass).
4. Users can view, pause, resume, run-now, edit, and delete schedules in UI.
5. Timezone behavior is explicit and predictable.

---

## Current Architecture Constraints (As-Is)

- Persistence is currently file-based under `${SWARM_DATA_DIR}` (`agents.json`, `secrets.json`, integration config JSON).
- Runtime is a single local Node process.
- User input enters via `SwarmManager.handleUserMessage(...)` and manager replies through `speak_to_user`.
- Channel routing already exists (`web` + `slack` with explicit target semantics).
- Settings and integrations are exposed via `/api/*` endpoints and surfaced in `SettingsDialog`.

This strongly favors a local persisted scheduler service in backend, with manager-triggered execution.

---

## Research Summary and Recommendations

## 1) Persistence: file-based vs SQLite

### Option A: file-based JSON in `~/.swarm/`
- Pros:
  - Matches current storage patterns.
  - No native deps or migration complexity.
  - Easy backup/inspection.
- Cons:
  - Full-file rewrite updates.
  - Harder concurrent mutation if multi-process ever appears.
  - Querying and run-history analytics are manual.

### Option B: SQLite
- Pros:
  - Better indexing and query ergonomics (`next_run_at`, status filters, history joins).
  - Stronger consistency guarantees and atomic updates.
  - Easier long-term scaling.
- Cons:
  - New dependency and migration path.
  - More operational surface than existing backend patterns.

### Recommendation
Use a storage abstraction immediately, but ship **JSON file storage first** for v1:
- `ScheduleStore` interface.
- `JsonScheduleStore` implementation backed by atomic rename writes.
- Keep an explicit migration path to `SqliteScheduleStore` if schedule volume or analytics needs grow.

Proposed files in `${SWARM_DATA_DIR}/swarm/`:
- `schedules.json` (canonical schedule definitions + runtime cursors)
- `schedule-runs.jsonl` (append-only execution history)

---

## 2) Runtime scheduling: node-cron vs node-schedule vs custom loop

### node-cron
- Good for cron expressions only.
- Weak fit for one-shot tasks and catch-up semantics.
- Persistence/replay still must be custom.

### node-schedule
- Supports both cron and one-shot `Date` triggers.
- Better than node-cron for mixed workloads.
- Still in-memory scheduling only; restart recovery remains custom.

### Custom scheduler loop (`setTimeout` + persisted cursors)
- Full control over restart catch-up, idempotency keys, and backoff.
- Can unify one-shot + recurring scheduling under one state machine.
- Slightly more code to own.

### Recommendation
Use a **custom scheduling engine** with a single timer and persisted schedule state:
- Compute `nextRunAt` for each active schedule.
- Sleep until earliest due timestamp.
- On wake, claim due schedules, execute, persist results, compute next occurrence.
- Use `cron-parser` for recurrence computation rather than reimplementing cron math.

This avoids external scheduler behavior surprises and keeps reboot semantics deterministic.

---

## 3) Manager integration model

Scheduled tasks should trigger manager work through existing pathways, not bypass them.

### Trigger path
On due execution:
1. Scheduler creates a manager-visible payload with schedule metadata.
2. Scheduler calls `swarmManager.handleUserMessage(...)` with:
   - `targetAgentId = schedule.targetManagerId`
   - `sourceContext = schedule.replyTarget` (default from originating channel)
   - `text` prefixed with a metadata line, e.g.:

```text
[scheduleContext] {"scheduleId":"sched_...","occurrence":"2026-02-20T17:00:00.000Z","kind":"once"}
Do X
```

This preserves current manager behavior and channel-aware reply routing.

### Manager tooling additions
Add manager-only tools in `swarm-tools.ts`:
- `schedule_task`
- `list_scheduled_tasks`
- `update_scheduled_task`
- `cancel_scheduled_task`
- optional: `run_scheduled_task_now`

Manager prompt update (`manager.md`):
- If schedule intent is detected, prefer `schedule_task`.
- If scheduling details are ambiguous (time/date/timezone), ask a follow-up question.
- For non-web targets, keep explicit `speak_to_user.target` behavior unchanged.

---

## 4) Natural language -> cron/date parsing

### Parsing strategy
Use a two-step approach:

1. **Manager interpretation (primary):**
   - Manager translates natural language to structured schedule input via `schedule_task` tool parameters.
   - This leverages existing conversational context and clarification behavior.

2. **Backend validation (authoritative):**
   - Validate one-shot timestamps and recurrence rules before persistence.
   - Validate cron expressions with `cron-parser`.
   - Normalize to canonical UTC + timezone representation.

### Optional helper parser
For future UI quick-create or deterministic parsing support:
- Add `chrono-node` for one-shot date/time extraction from free text.
- Keep recurring language conversion conservative; if unclear, require confirmation.

### Canonical internal representations
- One-shot: exact `runAtUtc` + `timezone` for display.
- Recurring: `cron` + `timezone` + optional `startAtUtc`/`endAtUtc`.

---

## 5) UI for viewing/managing schedules

Add a **Scheduled Tasks** section in settings (or a dedicated route if it grows):

### List view
- Columns:
  - Name / instruction preview
  - Type (`once` / `recurring`)
  - Next run
  - Timezone
  - Target manager
  - Status (`active`, `paused`, `completed`, `failed`)
- Filters: active/paused/completed, manager, channel.

### Row actions
- Pause / Resume
- Run now
- Edit
- Delete

### Create/Edit dialog
- Natural language input + parsed preview
- Explicit fields:
  - date/time or cron
  - timezone
  - target manager
  - reply target (web/slack metadata)
  - missed-run policy

### UX notes
- Reuse shadcn components already used in settings.
- Confirmations should show normalized schedule summary:
  - "Every Monday at 9:00 AM America/Los_Angeles"
  - next run timestamp in local format.

---

## 6) Persistence/recovery across reboots

### Boot behavior
On backend boot:
1. Load schedules from store.
2. Recompute due/next state for active schedules.
3. Recover any `running` schedules to safe state (`pending` + retry guard).
4. Start scheduler loop.

### Missed-run policy
Per schedule, persist policy:
- `skip` (default for old one-shot reminders)
- `run_immediately` (default for many recurring automation tasks)
- `run_once_if_missed` (catch up one occurrence only)

### Idempotency
Each occurrence gets a deterministic key (`scheduleId + scheduledAtUtc`).
If reboot happens around trigger time, dedupe by occurrence key before dispatching to manager.

---

## 7) Timezone handling

### Rules
- Store timezone as IANA string (`America/Los_Angeles`).
- Store trigger instants in UTC for execution.
- Compute next occurrence using cron parser timezone support.
- Display both local user time and schedule timezone in UI.

### Defaults
- Default timezone on schedule creation:
  - from originating client/channel metadata when available,
  - fallback to daemon timezone.

### DST behavior
Define explicit semantics:
- Non-existent local times (spring forward): skip to next valid occurrence.
- Repeated local times (fall back): run once at earliest matching instant.

Document these semantics in UI help text.

---

## 8) One-shot vs recurring model

Use a single schedule envelope with discriminated `kind`:

- `kind: "once"`
  - fields: `runAtUtc`
  - auto-transitions to `completed` after successful dispatch.

- `kind: "recurring"`
  - fields: `cron`, `timezone`, optional bounds
  - remains `active` until paused/cancelled/endAt reached.

Common state machine:
- `active` -> `running` -> `active` (recurring)
- `active` -> `running` -> `completed` (one-shot)
- `active` <-> `paused`
- any -> `failed` (with retry/backoff metadata)
- any -> `cancelled`

---

## Proposed Data Model (v1)

```ts
interface ScheduledTask {
  id: string;
  name?: string;
  instruction: string;
  kind: "once" | "recurring";
  status: "active" | "paused" | "running" | "completed" | "failed" | "cancelled";
  timezone: string;
  targetManagerId: string;
  replyTarget: {
    channel: "web" | "slack";
    channelId?: string;
    userId?: string;
    threadTs?: string;
  };
  runAtUtc?: string;           // once
  cron?: string;               // recurring
  startAtUtc?: string;
  endAtUtc?: string;
  nextRunAtUtc?: string;
  lastRunAtUtc?: string;
  lastOutcome?: "success" | "error" | "skipped";
  lastError?: string;
  missedRunPolicy: "skip" | "run_immediately" | "run_once_if_missed";
  createdAt: string;
  updatedAt: string;
  createdBy?: {
    sourceChannel: "web" | "slack";
    userId?: string;
  };
}
```

`ScheduleRunRecord` (JSONL) should include occurrence key, timestamps, and execution result.

---

## Backend File/Module Plan

New backend module:
`apps/backend/src/scheduling/`

- `schedule-types.ts`
- `schedule-store.ts` (interface)
- `schedule-store-json.ts`
- `schedule-engine.ts`
- `schedule-parser.ts` (cron/date validation)
- `schedule-service.ts` (lifecycle + manager dispatch)
- `schedule-status.ts` (optional WS event snapshots)

Integration points:
- `apps/backend/src/index.ts` (start/stop `ScheduleService`)
- `apps/backend/src/ws/server.ts` (REST endpoints)
- `apps/backend/src/protocol/ws-types.ts` and `apps/ui/src/lib/ws-types.ts` (new schedule events)
- `apps/backend/src/swarm/swarm-tools.ts` (manager schedule tools)
- `apps/backend/src/swarm/archetypes/builtins/manager.md` (policy updates)

---

## API and WS Contract Plan

### REST endpoints
- `GET /api/schedules`
- `POST /api/schedules`
- `PUT /api/schedules/:id`
- `DELETE /api/schedules/:id`
- `POST /api/schedules/:id/pause`
- `POST /api/schedules/:id/resume`
- `POST /api/schedules/:id/run`
- optional: `POST /api/schedules/parse`

### WebSocket events (optional but recommended)
- `schedule_snapshot`
- `schedule_updated`
- `schedule_run`

This allows real-time UI updates without polling.

---

## Implementation Phases

### Phase 0 — Contracts and design guardrails
- Define schedule types and storage abstraction.
- Define tool schemas for manager schedule operations.
- Add manager prompt guidance for scheduling/clarification.

### Phase 1 — JSON store + scheduler core
- Implement JSON schedule store with atomic writes.
- Implement scheduler loop with `nextRunAtUtc` evaluation.
- Add reboot recovery and missed-run policy handling.

### Phase 2 — Manager dispatch integration
- Wire schedule triggers into `handleUserMessage`.
- Add metadata line format (`[scheduleContext] ...`).
- Add idempotency key checks and run logs.

### Phase 3 — API + UI management
- Add schedule CRUD/pause/resume/run endpoints.
- Add Scheduled Tasks UI section with list/actions.
- Add create/edit dialog with normalized preview.

### Phase 4 — Natural language quality
- Add strict validation and ambiguity checks.
- Optional helper parser support for UI quick-create.
- Improve manager confirmation messages.

### Phase 5 — Hardening
- Fake-timer integration tests for recurrence and DST boundaries.
- Restart/recovery tests.
- Error/retry/backoff tuning and observability.

---

## Validation Checklist

- One-shot creation from chat works and persists.
- Recurring creation from chat works and computes next run correctly.
- Manager receives scheduled triggers with clear metadata context.
- Replies route correctly to the intended channel target.
- Schedules survive daemon restart and continue with correct next run.
- Missed-run policies behave as configured.
- UI can list/edit/pause/resume/delete/run tasks.
- Timezone + DST behavior matches documented semantics.

---

## Example Acceptance Scenarios

1. User says: "At 5pm today, do X."
   - Manager creates `kind=once` schedule in user timezone.
   - At due time, manager receives scheduled task and executes X.

2. User says: "Every Monday morning at 9am, run Y."
   - Manager creates `kind=recurring` with cron + timezone.
   - Scheduler dispatches weekly with stable DST behavior.

3. User says: "Tomorrow at noon, remind me about Z."
   - Manager creates reminder schedule and confirms normalized time.
   - Reminder is delivered after restart if daemon was briefly down.

---

## Risks and Open Questions

1. Should schedule-triggered messages always require explicit `speak_to_user.target` for Slack, or should scheduler inject strict reply target defaults?
2. Do we need per-schedule concurrency limits (skip if prior run still active)?
3. Should recurring schedules catch up multiple missed runs or only one?
4. Is a dedicated schedules page preferable to Settings section once schedule count grows?

Proposed default answers for v1:
- Keep explicit target behavior unchanged (manager remains source-of-truth).
- Skip overlapping runs by default, log as skipped.
- Catch up at most one missed recurring occurrence.
- Start in Settings; move to dedicated page later if needed.
