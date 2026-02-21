---
name: cron-scheduling
description: Create, list, and remove persistent scheduled tasks using cron expressions.
---

# Cron Scheduling

Use this skill when the user asks to schedule, reschedule, or cancel reminders/tasks for later.

Before creating a schedule, confirm:
- exact schedule timing (cron expression),
- timezone (IANA, for example `America/Los_Angeles`),
- task message content.

If the request is ambiguous, ask a follow-up question before adding a schedule.

## Storage

Schedules are stored at:
- `${SWARM_DATA_DIR}/schedules.json`

## Commands

Run the scheduler CLI from the repository root:

```bash
node apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js add \
  --name "Daily standup reminder" \
  --cron "0 9 * * 1-5" \
  --message "Remind me about the daily standup" \
  --timezone "America/Los_Angeles"
```

One-shot schedule (fires once at the next matching cron time):

```bash
node apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js add \
  --name "One-time deployment check" \
  --cron "30 14 * * *" \
  --message "Check deployment status" \
  --timezone "America/Los_Angeles" \
  --one-shot
```

Remove a schedule:

```bash
node apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js remove --id "<schedule-id>"
```

List schedules:

```bash
node apps/backend/src/swarm/skills/builtins/cron-scheduling/schedule.js list
```

## Output

All commands return JSON:
- Success: `{ "ok": true, ... }`
- Failure: `{ "ok": false, "error": "..." }`

