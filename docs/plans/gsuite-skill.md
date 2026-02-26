# G Suite Skill Plan (gogcli, Read+Write in v1)

## Objective
Ship Google Workspace support in Middleman with minimal maintenance:

1. Install and use `gog` directly.
2. Add a built-in `gsuite` skill that is just `SKILL.md` docs (no wrapper scripts).
3. Run Google OAuth setup entirely from Middleman Settings UI.
4. Enable both read and write operations from day one in v1.

This revision keeps the simplified `gog` approach and removes the earlier phased read-only-first model.

---

## Decisions from Feedback

1. **No wrapper scripts in the skill**
   - Do not add `gmail-search.js`, `calendar-events.js`, etc.
   - Do not add a `gog-runner.js` abstraction.
   - The skill should document direct CLI usage (`gog --help`, `gog <group> --help`, `gog ... --json`).

2. **OAuth flow moves into Middleman Settings**
   - User flow in Settings:
     - Click **Connect Google**
     - Get auth URL
     - Paste redirect URL/auth code
     - Middleman completes OAuth and stores credentials for `gog`

3. **Read + write in v1 (no read-only phase)**
   - v1 must support both read and write workflows immediately.
   - Required v1 write capabilities:
     - Gmail send
     - Calendar event create/update
     - Drive file upload
   - Scope and UX should still make write actions explicit and visible to the user.

---

## Research Summary (gogcli Auth + Storage)

Sources reviewed:
- `docs/plans/gsuite-skill.md` (previous draft)
- `https://github.com/steipete/gogcli` README
- `gogcli` source files:
  - `internal/cmd/auth.go`
  - `internal/googleauth/manual_state.go`
  - `internal/config/paths.go`
  - `internal/secrets/store.go`
  - `docs/spec.md`

Key findings:

1. **OAuth client credentials command**
   - `gog auth credentials <credentials.json|->`
   - `-` is supported and reads from stdin, which is ideal for Settings JSON paste/upload.

2. **Remote/headless OAuth flow is already exactly what Settings needs**
   - Step 1:
     - `gog --json auth add <email> ... --remote --step 1`
     - Returns JSON with `auth_url` and `state_reused`.
   - Step 2:
     - `gog --json auth add <email> ... --remote --step 2 --auth-url '<redirect-url>'`
     - Requires `state` in redirect URL and stores refresh token on success.
   - Manual OAuth state file:
     - `oauth-manual-state-<state>.json`
     - TTL is 10 minutes.

3. **Where `gog` stores data**
   - Base dir is `$(os.UserConfigDir())/gogcli/`
   - Files include:
     - `config.json`
     - `credentials.json` / `credentials-<client>.json`
     - `sa-<base64(email)>.json` (service account key)
     - `oauth-manual-state-<state>.json` (temporary state)
   - Refresh tokens are in keyring:
     - OS keychain backend by default (`auto`)
     - or encrypted file backend under `.../gogcli/keyring/` when forced to `file`

4. **Custom credential/config path support**
   - There is no dedicated `gog` flag/env like `--config-dir` or `GOG_CONFIG_DIR`.
   - Path is derived from `os.UserConfigDir()` (platform conventions).
   - Practical control is via process env for each `gog` invocation:
     - Linux: `XDG_CONFIG_HOME`
     - Windows: `APPDATA`
     - macOS: `HOME` (for `~/Library/Application Support/...`)

5. **Useful env flags**
   - `GOG_KEYRING_BACKEND`
   - `GOG_KEYRING_PASSWORD`
   - `GOG_ACCOUNT`
   - `GOG_CLIENT`
   - `GOG_ENABLE_COMMANDS`

---

## Proposed Architecture

### 1) Minimal built-in skill (docs only)

Add:
- `apps/backend/src/swarm/skills/builtins/gsuite/SKILL.md`

Do not add scripts/package for command wrappers.

`SKILL.md` should contain:
- Setup prerequisites (`gog` install + OAuth completed in Settings).
- Command discovery (`gog --help`, `GOG_HELP=full gog --help`, `gog <group> --help`).
- Practical examples for Gmail/Calendar/Drive/Docs with `--json`.
- Explicit write examples in v1: Gmail send, Calendar event create, Drive upload.
- Guidance to use `--account` or `GOG_ACCOUNT`.

Middleman manager wiring:
- Extend `reloadSkillMetadata()` to include `gsuite` SKILL path (same pattern as `memory` and `brave-search`).

### 2) Backend integration service (Settings + command bridge)

Add integration module:
- `apps/backend/src/integrations/gsuite/`
  - `gsuite-config.ts`
  - `gsuite-types.ts`
  - `gsuite-status.ts`
  - `gsuite-integration.ts`
  - `gsuite-gog.ts` (typed command executor, not wrappers)

Behavior:
- Backend executes `gog` directly with argv arrays.
- All Settings actions map to real `gog` commands.
- No shell wrapper scripts in skills folder.
- v1 endpoints support both read and write-ready scopes immediately.

---

## OAuth in Settings UI (Primary User Flow)

Implement in `SettingsDialog.tsx` (modeled after existing OAuth UX patterns):

1. User provides:
   - Account email
   - OAuth client JSON (paste or upload)

2. User clicks **Connect Google**:
   - Backend first stores OAuth client:
     - `gog --json auth credentials -` (stdin JSON payload)
   - Backend starts auth URL generation:
     - `gog --json auth add <email> --services gmail,calendar,drive,docs --remote --step 1`
   - UI shows returned `auth_url`.

3. User authorizes in browser and pastes redirect URL into Settings.

4. User clicks **Complete Connection**:
   - Backend runs:
     - `gog --json auth add <email> --services gmail,calendar,drive,docs --remote --step 2 --auth-url '<redirect-url>'`
   - On success: token stored and status updates to connected.

5. Test button verifies:
   - `gog --json auth status --account <email>`
   - Optional lightweight API calls, including write checks in safe mode.

---

## Storage Strategy in `SWARM_DATA_DIR`

Goal: keep `gog` state isolated to Middleman-managed storage.

Constraint from research:
- `gog` does not expose an explicit config-dir flag/env.

Plan:
- Build one helper that returns env overrides for every `gog` process:
  - `GOG_KEYRING_BACKEND=file`
  - `GOG_KEYRING_PASSWORD=<from Middleman secrets>`
  - Platform-specific config root override:
    - Linux: `XDG_CONFIG_HOME=${SWARM_DATA_DIR}/integrations/gsuite/config-home`
    - macOS: `HOME=${SWARM_DATA_DIR}/integrations/gsuite/home`
    - Windows: `APPDATA=${SWARM_DATA_DIR}\\integrations\\gsuite\\appdata`

Notes:
- For macOS, forcing file backend avoids login-keychain coupling when `HOME` is redirected.
- After setup, read resolved path via `gog --json auth status --account <email>` and assert it points under `SWARM_DATA_DIR`.

---

## API Surface

Add REST endpoints:

- `GET /api/integrations/gsuite`
- `PUT /api/integrations/gsuite`
- `DELETE /api/integrations/gsuite`
- `POST /api/integrations/gsuite/oauth/credentials`
- `POST /api/integrations/gsuite/oauth/start`
- `POST /api/integrations/gsuite/oauth/complete`
- `POST /api/integrations/gsuite/test`

Payload expectations:
- `oauth/credentials`: `{ oauthClientJson, clientName? }`
- `oauth/start`: `{ email, services?, forceConsent? }`
- `oauth/complete`: `{ email, authUrl, services?, forceConsent? }`

---

## Implementation Plan

### Phase 0 — Foundation
- Add `gsuite` integration config/status scaffolding.
- Add `gog` detection and version checks in backend + Settings.
- Implement per-process env strategy for `SWARM_DATA_DIR` isolation.

### Phase 1 — v1 Shipping Scope (Read + Write)
- Add G Suite section in Settings.
- Implement `oauth/credentials`, `oauth/start`, `oauth/complete`.
- Add connection test and status display.
- Expose v1 operations with read + write expectations:
  - Gmail read + send
  - Calendar read + create/update
  - Drive read + upload

### Phase 2 — Hardening
- Improve error mapping for common OAuth/state/scope failures.
- Add clearer warnings/confirmations for write-impact operations.
- Document operator troubleshooting (`state expired`, missing scopes, keyring password issues).

---

## Validation Checklist

1. Plan removes wrapper scripts and runner abstraction from skill scope.
2. OAuth flow is fully driven from Settings UI (URL generation + paste-back completion).
3. Commands map directly to actual `gog auth` behavior (`--remote --step 1/2`).
4. Storage behavior is documented with accurate path/keyring details.
5. `SWARM_DATA_DIR` strategy is explicit despite lack of native `gog` config-dir flag.
6. v1 scope explicitly includes read + write support (Gmail send, Calendar create/update, Drive upload).
