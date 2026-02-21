# G Suite Skill Plan (gogcli, Simplified)

## Objective
Ship Google Workspace support in Swarm with minimal maintenance:

1. Install and use `gog` directly.
2. Add a built-in `gsuite` skill that is just `SKILL.md` docs (no wrapper scripts).
3. Run Google OAuth setup entirely from Swarm Settings UI.

This revision incorporates feedback to remove wrapper-tool complexity and treat `gog` as the primary interface.

---

## Decisions from Feedback

1. **No wrapper scripts in the skill**
   - Do not add `gmail-search.js`, `calendar-events.js`, etc.
   - Do not add a `gog-runner.js` abstraction.
   - The skill should document direct CLI usage (`gog --help`, `gog <group> --help`, `gog ... --json`).

2. **OAuth flow moves into Swarm Settings**
   - User flow in Settings:
     - Click **Connect Google**
     - Get auth URL
     - Paste redirect URL/auth code
     - Swarm completes OAuth and stores credentials for `gog`

3. **Keep phased rollout**
   - Read-only by default first.
   - Write-capable auth/usage only as explicit opt-in in later phase.

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
- Guidance to use `--account` or `GOG_ACCOUNT`.
- Reminder that read/write behavior is controlled by granted scopes.

Swarm manager wiring:
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

---

## OAuth in Settings UI (Primary User Flow)

Implement in `SettingsDialog.tsx` (modeled after existing OAuth UX patterns):

1. User provides:
   - Account email
   - OAuth client JSON (paste or upload)
   - Optional scope mode (read-only default)

2. User clicks **Connect Google**:
   - Backend first stores OAuth client:
     - `gog --json auth credentials -` (stdin JSON payload)
   - Backend starts auth URL generation:
     - `gog --json auth add <email> --services gmail,calendar,drive,docs --readonly --drive-scope readonly --remote --step 1`
   - UI shows returned `auth_url`.

3. User authorizes in browser and pastes redirect URL into Settings.

4. User clicks **Complete Connection**:
   - Backend runs:
     - `gog --json auth add <email> --services gmail,calendar,drive,docs --readonly --drive-scope readonly --remote --step 2 --auth-url '<redirect-url>'`
   - On success: token stored and status updates to connected.

5. Test button verifies:
   - `gog --json auth status --account <email>`
   - Optional lightweight API call (e.g. `gog --json gmail labels list --account <email>`)

---

## Storage Strategy in `SWARM_DATA_DIR`

Goal: keep `gog` state isolated to Swarm-managed storage.

Constraint from research:
- `gog` does not expose an explicit config-dir flag/env.

Plan:
- Build one helper that returns env overrides for every `gog` process:
  - `GOG_KEYRING_BACKEND=file`
  - `GOG_KEYRING_PASSWORD=<from Swarm secrets>`
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
- `oauth/start`: `{ email, services?, readonly?, driveScope?, forceConsent? }`
- `oauth/complete`: `{ email, authUrl, services?, readonly?, driveScope?, forceConsent? }`

---

## Phased Implementation

### Phase 0 — Foundation
- Add `gsuite` integration config/status scaffolding.
- Add `gog` detection and version checks in backend + Settings.
- Implement per-process env strategy for `SWARM_DATA_DIR` isolation.

### Phase 1 — Settings OAuth MVP
- Add G Suite section in Settings.
- Implement `oauth/credentials`, `oauth/start`, `oauth/complete`.
- Default to read-only scopes.
- Add connection test and status display.

### Phase 2 — Minimal Skill Enablement
- Add `apps/backend/src/swarm/skills/builtins/gsuite/SKILL.md` only.
- Wire skill metadata loading for `gsuite`.
- Ensure skill docs point agents to direct `gog` usage.

### Phase 3 — Hardening + Optional Write Opt-In
- Add explicit write-scope toggle in Settings (off by default).
- Improve error mapping for common OAuth/state/scope failures.
- Document operator troubleshooting (`state expired`, missing scopes, keyring password issues).

---

## Validation Checklist

1. Plan removes wrapper scripts and runner abstraction from skill scope.
2. OAuth flow is fully driven from Settings UI (URL generation + paste-back completion).
3. Commands map directly to actual `gog auth` behavior (`--remote --step 1/2`).
4. Storage behavior is documented with accurate path/keyring details.
5. `SWARM_DATA_DIR` strategy is explicit despite lack of native `gog` config-dir flag.
6. Phased rollout remains coherent and read-only first.
