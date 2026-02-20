# G Suite Skill Plan (gogcli)

## Objective
Give Swarm first-class Google Workspace access (Gmail, Calendar, Drive, Docs) through a built-in skill that wraps `gogcli`, with secure auth handling, explicit scope control, and a phased rollout that starts read-only.

This plan follows the same documentation style as `docs/plans/telegram-integration.md` and follows the built-in skill shape used by `apps/backend/src/swarm/skills/builtins/brave-search/`.

---

## Research Summary (gogcli)

Source reviewed:
- https://github.com/steipete/gogcli
- `README.md` via:
  - `curl -sL https://raw.githubusercontent.com/steipete/gogcli/main/README.md | head -300`

Key findings relevant to Swarm integration:

1. `gogcli` already supports the exact surfaces we need:
   - Gmail (`search`, message/thread read, `send`)
   - Calendar (`events`, `search`, `create`, `update`, `delete`, `freebusy`)
   - Drive (`ls`, `search`, `get`, `upload`, `download`)
   - Docs (`info`, `cat`, `create`, `update`, `export`)

2. Auth model is compatible with Swarm:
   - OAuth desktop credentials (`gog auth credentials <json>`)
   - Per-account auth (`gog auth add <email>`)
   - Optional Workspace service-account + domain-wide delegation (`gog auth service-account set`)

3. Security features we can directly leverage:
   - Least-privilege auth flags (`--services`, `--readonly`, `--drive-scope`)
   - Secure keyring backends (`auto`, `keychain`, `file`)
   - Command allowlist (`GOG_ENABLE_COMMANDS`)
   - Token auto-refresh after initial authorization

4. Installation options from README:
   - Homebrew: `brew install steipete/tap/gogcli`
   - AUR package (Linux/Arch)
   - Build from source (`make`)
   - No npm-based installation path is documented

---

## Scope and Non-Goals

### In scope
- Built-in G Suite skill in Swarm for Gmail, Calendar, Drive, Docs.
- Settings UI section for G Suite credential setup and health checks.
- Read-only tools first, write tools second.
- OAuth and optional Workspace service-account paths.

### Out of scope (initial)
- Google Chat/Classroom/Keep/Forms/Apps Script integration.
- Background webhook/watch pipelines (e.g., Gmail push watch).
- Broad autonomous email/event mutation without explicit guardrails.

---

## Architecture Overview

### 1) Built-in skill (agent-facing)
Add a new built-in skill folder mirroring brave-search:

`apps/backend/src/swarm/skills/builtins/gsuite/`

Proposed contents:
- `SKILL.md`
- `package.json`
- `lib/gog-runner.js` (shared command runner + validation)
- `gmail-search.js`
- `gmail-thread-get.js`
- `calendar-events.js`
- `calendar-search.js`
- `drive-search.js`
- `drive-get.js`
- `docs-info.js`
- `docs-cat.js`
- `doctor.js` (binary/auth health check)

Write-phase scripts added later:
- `gmail-send.js`
- `calendar-create.js`
- `calendar-update.js`
- `drive-upload.js`
- `docs-create.js`
- `docs-update.js`

### 2) Integration service (app-facing setup + auth orchestration)
Add a G Suite backend integration module similar to Slack’s service model:

`apps/backend/src/integrations/gsuite/`

Proposed files:
- `gsuite-config.ts` (persisted non-secret config)
- `gsuite-types.ts`
- `gsuite-status.ts` (connection + auth health event)
- `gsuite-install.ts` (detect version/path, install strategy checks)
- `gsuite-auth.ts` (OAuth + service account setup flows)
- `gsuite-integration.ts` (service lifecycle + test helpers)
- `index.ts`

### 3) Wiring points
- `apps/backend/src/index.ts`: create/start/stop `GSuiteIntegrationService`.
- `apps/backend/src/ws/server.ts`: add `/api/integrations/gsuite*` endpoints.
- `apps/backend/src/swarm/swarm-manager.ts`: include built-in G Suite skill in `reloadSkillMetadata()` (same way brave-search is wired).
- `apps/ui/src/components/chat/SettingsDialog.tsx`: add G Suite settings section.
- `apps/ui/src/lib/ws-types.ts`: add optional `gsuite_status` event type.

---

## Credential Setup Plan

### 1) OAuth setup (individual account)

1. Create Google Cloud OAuth Desktop credentials.
2. Enable APIs: Gmail, Calendar, Drive, Docs.
3. Store OAuth client JSON via backend setup action that runs:
   - `gog auth credentials <path-to-oauth-client.json>`
4. Run account authorization:
   - Preferred local flow: `gog auth add <email>`
   - Headless flow support in UI (recommended for daemon hosts):
     - step 1: `gog auth add <email> --services gmail,calendar,drive,docs --readonly --drive-scope readonly --remote --step 1`
     - step 2: `gog auth add <email> --services gmail,calendar,drive,docs --readonly --drive-scope readonly --remote --step 2 --auth-url '<redirect-url>'`

### 2) Service account setup (Workspace admin option)

Optional enterprise path for domain-wide delegation:

1. Workspace admin creates service account and enables domain-wide delegation.
2. Admin allowlists required OAuth scopes in Admin Console.
3. Store service account key via setup action that runs:
   - `gog auth service-account set <impersonated-user-email> --key <path-to-service-account.json>`
4. Verify precedence/health:
   - `gog --account <email> auth status`

### 3) Token + secret storage

- Let `gogcli` own refresh token lifecycle (auto-refresh built-in).
- Store sensitive setup artifacts in Swarm secret storage (`secrets.json`) and write temporary credential files into `SWARM_DATA_DIR/integrations/gsuite/` with strict file permissions.
- Recommended keyring backend for unattended daemon runs:
  - `file` backend + `GOG_KEYRING_PASSWORD` in Swarm secrets.
- Local macOS interactive users may use Keychain backend if preferred.

### 4) Scope policy

Default read-only auth profile for Phase 1:
- `--services gmail,calendar,drive,docs`
- `--readonly`
- `--drive-scope readonly`

Write profile for Phase 2 (explicit opt-in in settings):
- remove `--readonly`
- set Drive scope to `full` or `file` based on user choice

---

## Settings UI Integration (SettingsDialog)

Add a new **G Suite** section to `SettingsDialog.tsx` with Slack-style ergonomics.

### Fields and controls
- Enable G Suite integration toggle.
- `gog` binary status:
  - detected path
  - version
  - install hint if missing
- Auth mode selector:
  - OAuth (default)
  - Service account (Workspace)
- OAuth setup:
  - account email
  - OAuth client JSON upload/paste
  - “Start auth” button (returns auth URL for remote flow)
  - callback URL input + “Complete auth” button
- Service account setup:
  - impersonated user email
  - service-account JSON upload/paste
  - “Configure service account” button
- Scope profile selector:
  - Read-only (recommended)
  - Write-enabled
  - Drive scope: `readonly` / `file` / `full`
- Command allowlist preview (`gmail,calendar,drive,docs,auth,time`).
- “Test connection” button.
- “Save settings” and “Disable integration” buttons.
- Status badge (`disabled`, `ready`, `auth_required`, `error`).

### Backend endpoints
- `GET /api/integrations/gsuite`
- `PUT /api/integrations/gsuite`
- `DELETE /api/integrations/gsuite`
- `POST /api/integrations/gsuite/test`
- `POST /api/integrations/gsuite/auth/start` (returns auth URL)
- `POST /api/integrations/gsuite/auth/complete` (consumes redirect URL)

---

## Skill Structure (Brave-Search Pattern)

`SKILL.md` frontmatter pattern (example):

```md
---
name: gsuite
description: Gmail, Calendar, Drive, and Docs access via gogcli.
env:
  - name: GOG_ACCOUNT
    description: Default Google account email or alias
    required: true
  - name: GOG_KEYRING_PASSWORD
    description: Required when keyring backend is file
    required: false
  - name: GOG_KEYRING_BACKEND
    description: auto|keychain|file
    required: false
  - name: GOG_ENABLE_COMMANDS
    description: Top-level command allowlist
    required: false
---
```

Design notes:
- Keep scripts small and single-purpose (same style as brave-search scripts).
- Force JSON output for deterministic parsing: add `--json` in wrappers.
- Shared runner validates args and blocks shell injection (no raw shell string eval).
- Return concise, agent-friendly markdown summaries with raw JSON fallback when needed.

---

## Tools to Expose

### Phase 1: read-only toolset
- Gmail:
  - `gmail_search` → `gog gmail search ... --json`
  - `gmail_thread_get` → `gog gmail thread get <threadId> --json`
- Calendar:
  - `calendar_events` → `gog calendar events ... --json`
  - `calendar_search` → `gog calendar search ... --json`
  - `calendar_freebusy` → `gog calendar freebusy ... --json`
- Drive:
  - `drive_search` → `gog drive search ... --json`
  - `drive_get` → `gog drive get <fileId> --json`
  - `drive_download` (read/export only)
- Docs:
  - `docs_info` → `gog docs info <docId> --json`
  - `docs_cat` → `gog docs cat <docId>`

### Phase 2: write toolset (explicit opt-in)
- Gmail:
  - `gmail_send`
  - `gmail_draft_create`
- Calendar:
  - `calendar_create_event`
  - `calendar_update_event`
  - `calendar_delete_event`
- Drive:
  - `drive_upload`
  - `drive_copy`
- Docs:
  - `docs_create`
  - `docs_update`

### Write-operation guardrails
- Require `writeEnabled=true` in config.
- Add confirmation prompts for destructive actions (`delete`, broad updates).
- Optional recipient/domain allowlist for outgoing mail.

---

## Installation Strategy (Binary / npm / Go)

### Recommendation
Use a pinned `gog` binary managed by host setup, with health checks in Settings.

### Supported paths
1. Homebrew (preferred on macOS hosts):
   - `brew install steipete/tap/gogcli`
2. Build from source (fallback / Linux):
   - clone repo + `make`
3. npm:
   - no npm install path documented in gogcli README (treat as unsupported)

### Runtime checks
- At startup/test, run:
  - `gog --version`
  - `gog auth status --account <configured-account>`
- Surface actionable errors in Settings UI.

---

## Security Plan

1. Least privilege by default:
   - Phase 1 read-only scopes.
   - No write commands enabled until explicit opt-in.

2. Secret handling:
   - Credential JSON and keyring password stored via Swarm secrets store.
   - API responses only return masked values and `has*` booleans.

3. Token refresh:
   - Rely on `gog` auto-refresh.
   - Add periodic `auth list --check` health signal.

4. Command surface restriction:
   - Set `GOG_ENABLE_COMMANDS` to minimum required commands.
   - Validate and whitelist wrapper args per tool.

5. Auditability:
   - Log command category + outcome, never raw tokens/secret payloads.

---

## Phased Implementation

### Phase 0 — Spike + install detection
- Add G Suite integration service skeleton.
- Implement binary/version detection and install guidance.
- Define persisted config shape + status events.

### Phase 1 — Credential UX + read-only auth
- Add SettingsDialog G Suite section.
- Implement OAuth credential storage + remote step1/step2 flow.
- Implement optional service-account setup.
- Persist auth mode/scope profile.

### Phase 2 — Built-in skill scaffolding
- Add `apps/backend/src/swarm/skills/builtins/gsuite/`.
- Add `SKILL.md` frontmatter and JS runner utilities.
- Wire built-in skill path in `SwarmManager.reloadSkillMetadata()`.

### Phase 3 — Read-only tools (MVP ship)
- Ship Gmail/Calendar/Drive/Docs read tools.
- Add unit tests for arg validation and parsing.
- Validate from real account in smoke test.

### Phase 4 — Write tools (gated)
- Add send/create/update/delete wrappers.
- Add write enable toggle + warning copy in Settings.
- Add confirmation requirements for destructive actions.

### Phase 5 — Hardening + docs
- Retry/backoff for transient API failures.
- Better error mapping (auth/scopes/quota/rate-limit).
- Add operator runbook and troubleshooting section.

---

## Validation Checklist

- Plan covers OAuth + service-account credential setup.
- SettingsDialog includes a dedicated G Suite credential section.
- Skill structure follows brave-search pattern (`SKILL.md` + JS wrappers).
- Tool matrix includes required read and write operations.
- Installation strategy addresses binary + source build and clarifies npm unsupported.
- Security model covers scope minimization, secret storage, and token refresh.
- Rollout is phased with read-only first and write second.
