# Per-Manager Slack/Telegram Integration Plan

## 1. Problem statement
Current Slack and Telegram integrations are singleton services with singleton config files (`integrations/slack.json`, `integrations/telegram.json`). They can point inbound traffic at one `targetManagerId`, but there is still only one bot/app token set per provider for the whole swarm.

That limits multi-manager usage:
- different managers cannot safely use different Slack/Telegram bots;
- channel/chat isolation is weak (global credentials with one shared listener);
- outbound `speak_to_user` cannot reliably choose between multiple provider credentials for the same manager.

## 2. Proposed data model
Use manager-scoped integration profiles, not global provider config.

Suggested storage:
- `~/.middleman*/integrations/managers/<managerId>/slack.json`
- `~/.middleman*/integrations/managers/<managerId>/telegram.json`

Profile shape (per provider):
- `enabled`
- `profileId` (stable id for routing/outbound affinity)
- provider settings (`listen`, `response`, `polling`, `attachments`, etc.)
- credentials (initially inline for parity with current behavior, or moved to secrets store in follow-up)

Protocol additions:
- extend `MessageSourceContext` and `MessageTargetContext` with `integrationProfileId` (and optionally `providerAccountId`, e.g. Slack `teamId`) so replies can bind to the correct connection.

Tradeoff:
- file-per-manager keeps lifecycle simple and avoids bloating `agents.json`, but requires a reconciliation layer when managers are created/deleted.

## 3. Routing changes
Introduce an `IntegrationRegistryService` that owns all active provider connections.

Responsibilities:
- load manager profile files;
- start/stop one connection per enabled profile;
- dispatch inbound events to `swarmManager.handleUserMessage(...)` with:
  - resolved `targetAgentId` (manager id),
  - `sourceContext` including `integrationProfileId`.

Routing rules:
- default: inbound event is handled by the manager that owns the active profile instance;
- optional advanced mode: allow explicit channel/chat route tables under a manager profile;
- guardrail: reject overlapping route rules at save-time (avoid duplicate delivery).

## 4. Outbound delivery
Replace per-provider singleton delivery bridges with registry-aware delivery dispatch.

For `conversation_message` events (`source = speak_to_user/system`):
- resolve provider target from `sourceContext.channel` and `event.agentId`;
- prefer `sourceContext.integrationProfileId` for reply affinity;
- if explicit `speak_to_user.target.integrationProfileId` is present, use it;
- if no profile id is available:
  - if manager has exactly one enabled profile for that provider, use it;
  - otherwise return a clear error (ambiguous target) instead of guessing.

This ensures a manager’s outbound messages use that manager’s credentials, not a global singleton client.

## 5. Settings UI changes
Current Settings has global Slack/Telegram sections. Move to manager-scoped settings.

Recommended UX:
- add manager picker at top of Integrations settings (default to selected manager in sidebar);
- show Slack + Telegram config/status for that manager only;
- show per-manager connection badges (connected/error/disabled);
- if channel/chat route tables are supported, add an advanced routing editor.

API shape:
- `GET/PUT/DELETE /api/managers/:managerId/integrations/slack`
- `GET/PUT/DELETE /api/managers/:managerId/integrations/telegram`
- keep test/list endpoints under the same manager-scoped prefix.

## 6. Migration path
1. Add registry and manager-scoped endpoints behind compatibility mode.
2. On first boot with no manager-scoped files:
- import existing global `slack.json`/`telegram.json` into default manager (`config.managerId`);
- preserve behavior (same manager, same credentials, same routing).
3. Keep legacy global endpoints temporarily as aliases to default-manager profiles.
4. Add one-time migration marker file to avoid repeated imports.
5. After UI ships, deprecate legacy endpoints and global config files.

## 7. Open questions
- Should v1 allow multiple profiles per provider per manager, or exactly one profile per provider per manager?
- If two managers intentionally share one Slack bot token, do we support shared-connection fanout + route rules, or require unique tokens?
- Where should credentials live long-term: profile files (parity/simple) or secrets store (cleaner security boundary)?
- On manager delete, should integration profiles be hard-deleted, disabled, or retained for reuse?
- Should `speak_to_user` require explicit `integrationProfileId` for non-web sends when multiple profiles are enabled?
- Do we need per-profile rate-limit/backoff telemetry in WS status events before rollout?
