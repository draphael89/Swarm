# Electron Migration ExecPlan (Embedded Backend, WebSocket-Preserving)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` will be updated as work proceeds.

This repository does not include a local `PLANS.md`; this plan follows the global contract in `/Users/davidraphael/.codex/PLANS.md`.

## Purpose / Big Picture

Ship Middleman as a desktop Electron application without breaking existing browser-based development (`pnpm dev`) or changing the canonical WebSocket protocol.

User-visible outcomes after completion:
- A new Electron desktop app launches the existing backend orchestration in-process and opens the existing UI renderer.
- Development mode remains fast: UI still runs with Vite, while Electron connects to the same backend contract.
- Core desktop flow is validated in development mode first; production packaging is a follow-up wave once runtime seams are stable.

## Progress

- [x] (2026-02-27 23:55Z) Gathered architecture context from backend entrypoint, config, WebSocket server, and UI transport.
- [x] (2026-02-27 23:56Z) Drafted first-principles migration plan with contract-complete wave definitions.
- [x] (2026-02-27 23:58Z) Ran static contract check and resolved placeholder-token rejection in plan wording.
- [x] (2026-02-28 00:00Z) Ran Gate Pass 1 once; gate runtime returned schema-mismatch blocked output, but raw critique yielded actionable plan fixes applied below.
- [ ] Pass Gate Pass 1 critique loop (blocked by gate runtime JSON extraction failure; wrapper exits 33 while raw critiques are available).
- [ ] Pass Gate Pass 2 binary approval (not reachable because Pass 1 wrapper cannot emit parseable JSON in this environment).
- [x] (2026-02-28 06:03Z) Implemented Wave 1: backend bootstrap extraction, config overrides, dotenv ordering, and backend export contracts.
- [x] (2026-02-28 06:03Z) Implemented Wave 2: `apps/electron` package scaffold with main/preload runtime wiring and tests.
- [x] (2026-02-28 06:03Z) Implemented Wave 3: renderer endpoint precedence via `window.middlemanRuntime` plus docs/scripts updates.
- [x] (2026-02-28 06:07Z) Completed packaged renderer path: Electron now serves built UI assets over `app://` protocol instead of throwing in packaged mode.
- [x] (2026-02-28 06:04Z) Ran backend + electron test/typecheck validations and stored artifacts under run directory.
- [x] (2026-02-28 06:26Z) Added packaging workflows (`electron:dist*`, GitHub release workflow) and validated unsigned local distribution artifacts.
- [x] (2026-02-28 06:28Z) Added startup setting, tray status, and crash-handling hardening with test coverage.
- [x] (2026-02-28 06:29Z) Produced closeout validation run summary and retrospective notes.

## Surprises & Discoveries

- Observation: `apps/backend/src/index.ts` currently owns full lifecycle orchestration (manager boot, scheduler sync, integration registry, WebSocket server, signal handling) as a script-style entrypoint.
  Evidence: `apps/backend/src/index.ts`.
- Observation: UI transport is already cleanly centralized in `apps/ui/src/lib/ws-client.ts` and `apps/ui/src/lib/api-endpoint.ts`, so endpoint injection can be localized.
  Evidence: those files.
- Observation: Root `package.json` has an explicit `workspaces` array, so `apps/electron` must be added there even though `pnpm-workspace.yaml` already includes `apps/*`.
  Evidence: root `package.json` and `pnpm-workspace.yaml`.
- Observation: Current `resolveDefaultWsUrl()` derives ports from `window.location`, which is insufficient for Electron `file://` or custom-protocol contexts.
  Evidence: `apps/ui/src/routes/index.tsx`.

## Decision Log

- Decision: Choose embedded-backend Electron architecture (single Electron main process importing backend bootstrap, backend still exposing localhost HTTP+WS).
  Rationale: Preserves protocol and browser dev flow while removing child-process zombie risk from fork-wrapper architecture.
  Date/Author: 2026-02-27 / Codex
- Decision: Defer IPC-transport rewrite; keep WebSocket protocol unchanged.
  Rationale: Current message volumes and architecture do not justify high-risk IPC migration now.
  Date/Author: 2026-02-27 / Codex
- Decision: Implement in dependency waves with TDD for bootstrap extraction and endpoint resolution seams.
  Rationale: Enables deterministic rollout and faster root-cause isolation if regression appears.
  Date/Author: 2026-02-27 / Codex
- Decision: Define a strict backend bootstrap API that returns bound port and never calls `process.exit()`.
  Rationale: Electron main process must control lifecycle and derive runtime endpoints from actual bound address.
  Date/Author: 2026-02-28 / Codex
- Decision: Use preload `contextBridge` contract `window.middlemanRuntime` for renderer endpoint injection.
  Rationale: `contextIsolation: true` and `nodeIntegration: false` require a typed preload boundary.
  Date/Author: 2026-02-28 / Codex
- Decision: Use ESM + tsx for Electron dev and `tsc` output for Electron build, with workspace dependencies bundled by Electron runtime.
  Rationale: Matches current backend tooling patterns and avoids introducing a second build stack.
  Date/Author: 2026-02-28 / Codex
- Decision: Minimum Electron major version is 28; implementation target is current stable major above that floor.
  Rationale: ESM main-process compatibility is required for this monorepo and is reliable in Electron 28+.
  Date/Author: 2026-02-28 / Codex
- Decision: Electron package uses precompiled TypeScript for dev and runtime (`main: dist/main.js`) rather than direct tsx execution.
  Rationale: Avoids ambiguous Electron+tsx loader behavior and makes startup deterministic.
  Date/Author: 2026-02-28 / Codex
- Decision: Preload runs with `sandbox: false`, `contextIsolation: true`, and `nodeIntegration: false`.
  Rationale: Keeps renderer isolation while allowing a simple ESM preload build from TypeScript without extra bundlers.
  Date/Author: 2026-02-28 / Codex

## Outcomes & Retrospective

- Added `apps/backend/src/bootstrap.ts` and rewired backend startup so Electron can import and manage lifecycle without process-level exits.
- Extended `createConfig` with overrides for root/data/host/port and exported root detection for bootstrap dotenv ordering.
- Added `apps/electron` app package with runtime-config IPC channel, preload context bridge exposure, and Vitest coverage for main/preload behavior.
- Added packaged renderer loading via `app://renderer/index.html` with `protocol.handle` static asset serving and SPA route fallback.
- Updated UI route URL resolution to prefer Electron runtime URLs while preserving env and location fallbacks.
- Added root workspace/scripts for Electron (`electron:dev`, `electron:build`) and README usage docs.
- Added `electron-builder` packaging config plus release workflow for macOS/Windows/Linux artifact builds.
- Added Electron-native system integrations (tray status, launch-at-login setting, auto-update check, fatal-error shutdown path).
- Validation status: backend, UI, and Electron suites pass; distribution directory build passes when signing auto-discovery is disabled (`CSC_IDENTITY_AUTO_DISCOVERY=false`) on developer machines with ambiguous local identities.

## Context and Orientation

Core files and boundaries:
- Backend bootstrap currently in `apps/backend/src/index.ts`.
- Backend transport in `apps/backend/src/ws/server.ts`.
- Backend config in `apps/backend/src/config.ts`.
- UI WebSocket client in `apps/ui/src/lib/ws-client.ts`.
- UI API endpoint derivation in `apps/ui/src/lib/api-endpoint.ts`.
- Root scripts in `package.json`.

Non-obvious terms:
- Embedded backend: Electron main process imports backend services directly instead of spawning `node dist/index.js`.
- Transport-preserving migration: renderer still communicates via WebSocket/HTTP endpoints exactly as browser mode does.

## Plan Contract

```yaml
scope_in:
  - "Extract backend lifecycle into importable bootstrap API with explicit start/stop semantics and config overrides."
  - "Add Electron app package that starts backend bootstrap and opens UI in BrowserWindow."
  - "Preserve existing WebSocket + HTTP contracts between renderer and backend."
  - "Add root scripts for electron development workflows, including workspace registration for apps/electron."
scope_out:
  - "Replacing renderer/backend transport with Electron IPC."
  - "Shipping production installers, code-signing, or electron-builder distribution artifacts in this change."
  - "Shipping auto-update, tray, login-item, or deep OS integrations in this change."
  - "Redesigning existing dashboard/chat/settings UX."
risk_class: medium
evidence_required:
  - "/Users/davidraphael/.codex/runs/electron-20260227-235356/gate-pass1.json"
  - "/Users/davidraphael/.codex/runs/electron-20260227-235356/gate-pass2.json"
  - "/Users/davidraphael/.codex/runs/electron-20260227-235356/validation/backend-tests.txt"
  - "/Users/davidraphael/.codex/runs/electron-20260227-235356/validation/typecheck.txt"
  - "/Users/davidraphael/.codex/runs/electron-20260227-235356/validation/electron-tests.txt"
non_goals:
  - "No protocol schema changes in packages/protocol."
  - "No breaking changes to pnpm dev or pnpm prod browser flows."
acceptance_scenario_ids:
  - "EL-001"
  - "EL-002"
  - "EL-003"
  - "EL-004"
validation_commands:
  - "pnpm --filter @middleman/backend test"
  - "pnpm --filter @middleman/backend exec tsc -p tsconfig.build.json --noEmit"
  - "pnpm --filter @middleman/ui exec tsc --noEmit"
  - "pnpm --filter @middleman/electron exec tsc --noEmit"
  - "pnpm --filter @middleman/electron test"
artifact_paths:
  - "/Users/davidraphael/Desktop/middleman/docs/plans/2026-02-27-electron-embedded-app-plan.md"
  - "/Users/davidraphael/.codex/runs/electron-20260227-235356/gate-pass1.md"
  - "/Users/davidraphael/.codex/runs/electron-20260227-235356/gate-pass2.md"
  - "/Users/davidraphael/.codex/runs/electron-20260227-235356/swarm-live.log"
wave_exit_criteria:
  - "Wave 1: bootstrap extraction merged with passing backend tests and typed API contract (bound port + stop handle)."
  - "Wave 2: Electron package launches in dev mode and reaches backend endpoint through preload wiring."
  - "Wave 3: root scripts and docs verified; typecheck passes repo-wide."
idempotence_recovery:
  - "All waves can be rerun safely; each wave uses additive file creation and explicit start/stop cleanup."
  - "If Electron boot fails, fallback is existing pnpm dev/prod flow unaffected by retained index entrypoint wrapper."
worker_cards:
  - id: W1-bootstrap
    goal: "Refactor backend script entrypoint into importable lifecycle module with explicit shutdown and configurable host paths."
    owner_paths:
      - "apps/backend/src/index.ts"
      - "apps/backend/src/bootstrap.ts"
      - "apps/backend/src/test/**"
    forbidden_paths:
      - "apps/ui/**"
      - "apps/electron/**"
    dependencies: []
    validation_cmds:
      - "pnpm --filter @middleman/backend test"
    done_definition:
      - "Backend can be started/stopped via exported API and existing CLI entrypoint remains functional."
      - "Bootstrap API returns the bound backend port and a Promise-based stop handle."
      - "Bootstrap does not register process signal handlers and does not call process.exit(); caller owns termination policy."
      - "Bootstrap accepts overrides for rootDir/dataDir/envPath (or an equivalent prebuilt config path) for Electron packaged runtime."
      - "Bootstrap exports concrete TypeScript interfaces for options and result handles."
      - "Backend package exports `./bootstrap` subpath so Electron can import `@middleman/backend/bootstrap`."
      - "Backend package exports field is explicit: root and `./bootstrap` map to dist JS and dist declaration files."
      - "Bootstrap startup failures trigger reverse-order cleanup of already-started services before rethrowing."
      - "Bootstrap loads dotenv before calling createConfig(overrides), and thin index wrapper does not load dotenv."
      - "Tests cover env-based host/port configuration through bootstrap when no explicit overrides are provided."
      - "New or updated tests fail before and pass after refactor."
    expected_artifacts:
      - "/Users/davidraphael/.codex/runs/electron-20260227-235356/validation/backend-tests.txt"
  - id: W2-electron-shell
    goal: "Create Electron app package that boots backend lifecycle and loads UI in development mode."
    owner_paths:
      - "apps/electron/**"
      - "package.json"
    forbidden_paths:
      - "apps/ui/src/components/**"
      - "packages/protocol/**"
    dependencies:
      - "W1-bootstrap"
    validation_cmds:
      - "pnpm --filter @middleman/electron test"
    done_definition:
      - "Electron main process starts backend via bootstrap API, opens BrowserWindow, and shuts backend down on quit."
      - "Electron preload boundary exists with context isolation enabled."
      - "Electron module/build strategy is explicit: `main` points to `dist/main.js`, dev script runs `tsc --watch` plus electron process."
      - "Root package.json workspaces array includes apps/electron."
      - "`apps/electron/package.json` declares `@middleman/backend: workspace:*`."
      - "BrowserWindow security policy is explicit: `sandbox: false`, `contextIsolation: true`, `nodeIntegration: false`."
      - "Electron tests use mocked `electron` module APIs under Vitest node environment."
      - "Main/preload runtime config transport is explicit via `ipcMain.handle` and `ipcRenderer.invoke` channel."
      - "Renderer loading uses `app.isPackaged` plus `ELECTRON_DEV_URL` env override."
    expected_artifacts:
      - "/Users/davidraphael/.codex/runs/electron-20260227-235356/validation/electron-tests.txt"
  - id: W3-renderer-wiring
    goal: "Ensure renderer endpoint resolution works for Electron without regressing browser mode."
    owner_paths:
      - "apps/ui/src/lib/**"
      - "apps/ui/src/routes/index.tsx"
      - "apps/electron/**"
      - "README.md"
    forbidden_paths:
      - "apps/backend/src/swarm/**"
      - "packages/protocol/**"
    dependencies:
      - "W2-electron-shell"
    validation_cmds:
      - "pnpm --filter @middleman/backend exec tsc -p tsconfig.build.json --noEmit"
      - "pnpm --filter @middleman/ui test"
      - "pnpm --filter @middleman/ui exec tsc --noEmit"
      - "pnpm --filter @middleman/electron exec tsc --noEmit"
    done_definition:
      - "Renderer consumes Electron-provided WS/API URLs via `window.middlemanRuntime` and existing environment/location fallback behavior still works in browser mode."
      - "Developer docs include Electron run/build instructions."
      - "UI window typing for `middlemanRuntime` is declared in `apps/ui/src/electron-env.d.ts` and included by ui tsconfig."
      - "UI tests include additive coverage for `window.middlemanRuntime` precedence and existing browser fallback."
    expected_artifacts:
      - "/Users/davidraphael/.codex/runs/electron-20260227-235356/validation/typecheck.txt"
```

## Plan of Work

Wave 1 (Backend bootstrap seam):
1. Introduce a new bootstrap module that owns creation/start/shutdown of:
   - `SwarmManager`
   - per-manager `CronSchedulerService` instances
   - `IntegrationRegistryService`
   - `SwarmWebSocketServer`
2. Define explicit API contract:
   - `startMiddlemanBackend(options?)` returns a promise containing config, host, port, wsUrl, httpUrl, and stop()
   - `stop()` resolves after scheduler, integrations, and server shutdown; does not call `process.exit()`.
   - `apps/backend/src/bootstrap.ts` exports:
     - `interface BootstrapOptions { rootDir?: string; dataDir?: string; envPath?: string | null; host?: string; port?: number }`
     - `interface BootstrapResult { host: string; port: number; wsUrl: string; httpUrl: string; stop(): async function returning void }`
     - `function startMiddlemanBackend(options?: BootstrapOptions): Promise of BootstrapResult`
   - Config override mechanism is parameterized: `createConfig(overrides?)` is extended so bootstrap passes explicit overrides (no environment-variable shim).
     - when overrides.rootDir exists, skip detectRootDir and use it directly.
     - when overrides.dataDir exists, use it instead of homedir default.
     - when overrides.host/port exist, use them instead of env defaults.
   - Backend package export strategy:
     - expose bootstrap module via backend package subpath export.
     - explicit `exports` field:
       - `.` maps to `./dist/index.js` and `./dist/index.d.ts`
       - `./bootstrap` maps to `./dist/bootstrap.js` and `./dist/bootstrap.d.ts`
   - Startup error policy:
     - `startMiddlemanBackend()` throws errors.
     - partial-startup failures perform reverse-order teardown for already-started services before rethrowing.
   - Dotenv rules:
     - explicit envPath string loads that file with `override: false`
     - envPath null disables dotenv loading
     - undefined envPath attempts `rootDir/.env` when file exists
     - load dotenv before calling `createConfig(overrides)`.
3. Keep `apps/backend/src/index.ts` as a thin executable wrapper that calls bootstrap, registers signals, and preserves current CLI behavior.
4. Add/adjust tests validating lifecycle contract and manager-id scheduler sync behavior.

Wave 2 (Electron shell baseline):
1. Add `apps/electron` package with:
   - `src/main.ts` Electron main process
   - `src/preload.ts` secure bridge for renderer runtime values
   - build config and scripts (`dev`, `build`, `test`, `start`)
   - pinned package version for `electron` (28+)
   - workspace dependencies:
     - `@middleman/backend: workspace:*`
   - deterministic launch settings:
     - `package.json` `main` field set to `dist/main.js`
     - `dev` script uses initial compile then coordinated watch+launch:
       - `pnpm --filter @middleman/backend build && tsc -p tsconfig.json && concurrently "pnpm --filter @middleman/backend exec tsc -p tsconfig.build.json -w --preserveWatchOutput" "tsc -w -p tsconfig.json --preserveWatchOutput" "electron ."`
   - test files:
     - `src/test/main.test.ts` verifies startup and before-quit shutdown wiring
     - `src/test/preload.test.ts` verifies `contextBridge.exposeInMainWorld` contract
   - test strategy:
     - Vitest node environment with `vi.mock("electron", ...)` stubs for `app`, `BrowserWindow`, and `contextBridge`.
2. In `main.ts`, start backend bootstrap first, then create `BrowserWindow` with secure defaults (`contextIsolation`, `nodeIntegration: false`, preload enabled).
   - explicitly set `sandbox: false` in webPreferences and document rationale.
3. Expose runtime contract through preload:
   - `window.middlemanRuntime = { wsUrl: string, apiUrl: string }`
   - use IPC bridge:
     - main registers `ipcMain.handle("middleman:get-runtime-config", () => ({ wsUrl, apiUrl }))`
     - preload retrieves via `ipcRenderer.invoke("middleman:get-runtime-config")` before calling `contextBridge.exposeInMainWorld`
4. Implement development renderer resolution:
   - branch with `app.isPackaged`.
   - in dev mode: load URL from `ELECTRON_DEV_URL` env var or fallback `http://127.0.0.1:47188`.
   - in packaged mode: throw a descriptive deferred-scope error in this migration.
5. Update root `package.json` workspaces to include `apps/electron`.
6. Packaged-mode backend path strategy:
   - Electron main passes explicit `rootDir` and `dataDir` to bootstrap.
   - If packaged `rootDir` is not a repo root, bootstrap uses user-home defaults for safe working directory behavior.
   - Repo-local optional paths (`repoArchetypesDir`, `repoMemorySkillFile`) are skipped when missing.

Wave 3 (Renderer wiring and docs):
1. Add renderer-side endpoint discovery with explicit precedence:
   - `window.middlemanRuntime.wsUrl`
   - `VITE_MIDDLEMAN_WS_URL`
   - existing location-derived fallback
2. Update API endpoint derivation to prefer `window.middlemanRuntime.apiUrl` for Electron.
3. Add `apps/ui/src/electron-env.d.ts` with `window.middlemanRuntime` declaration and ensure inclusion by `apps/ui/tsconfig.json`.
4. Add root scripts for Electron development/build orchestration.
5. Update README with Electron usage and constraints.

## Concrete Steps

1. Add failing tests for bootstrap extraction seams.
2. Extend `apps/backend/src/config.ts` so `createConfig(overrides?)` accepts parameterized overrides for rootDir, dataDir, host, and port.
3. Extract dotenv handling from backend entrypoint into bootstrap with documented `envPath` behavior (`string`, `null`, `undefined` modes).
   - enforce ordering: dotenv loads before `createConfig(overrides)` executes.
4. Implement `apps/backend/src/bootstrap.ts` with exported `BootstrapOptions` / `BootstrapResult` interfaces and lifecycle start/stop function.
   - include partial-startup failure cleanup with reverse teardown and rethrow behavior.
5. Rewrite `apps/backend/src/index.ts` as a thin wrapper that calls bootstrap and owns signal handlers/process exit behavior.
   - thin wrapper does not call dotenv; bootstrap is the only dotenv owner.
6. Run `pnpm --filter @middleman/backend test`.
7. Scaffold `apps/electron` package and Electron main/preload runtime.
   - set `main` in package.json to `dist/main.js`.
   - add explicit dev command wiring for initial compile + tsc watch + electron launch via concurrently.
   - add Vitest tests with mocked `electron` module APIs.
8. Add root scripts, package-level scripts, and root workspace entry for `apps/electron`.
   - root Electron dev script ensures backend build dependency is satisfied before launching Electron dev loop.
9. Update renderer endpoint resolution logic with Electron preload contract fallback path.
   - add UI unit tests for runtime endpoint precedence and browser fallback behavior.
10. Run:
   - `pnpm --filter @middleman/electron test`
   - `pnpm --filter @middleman/ui test`
   - `pnpm --filter @middleman/backend exec tsc -p tsconfig.build.json --noEmit`
   - `pnpm --filter @middleman/ui exec tsc --noEmit`
   - `pnpm --filter @middleman/electron exec tsc --noEmit`
11. Perform manual smoke:
   - Launch Electron dev mode.
   - Verify manager list loads, chat send works, settings request works.

## Validation and Acceptance

Acceptance scenarios:
- EL-001: Running Electron dev starts backend and opens UI with successful `ready` event.
- EL-002: Closing Electron cleanly stops backend listeners and scheduler instances.
- EL-003: Existing `pnpm dev` still works in browser mode with unchanged WebSocket protocol.
- EL-004: Electron package tests pass and typechecks without errors.

Validation commands:
- `pnpm --filter @middleman/backend test`
- `pnpm --filter @middleman/electron test`
- `pnpm --filter @middleman/ui test`
- `pnpm --filter @middleman/backend exec tsc -p tsconfig.build.json --noEmit`
- `pnpm --filter @middleman/ui exec tsc --noEmit`
- `pnpm --filter @middleman/electron exec tsc --noEmit`

## Idempotence and Recovery

- Backend bootstrap extraction is wrapped in additive files and can be retried without data migration.
- If Electron startup fails, backend CLI entrypoint remains intact, so operational fallback is immediate (`pnpm dev`).
- If ws port conflict occurs, configure `MIDDLEMAN_PORT` in Electron bootstrap env and rerun.
- Known deferred gap: `SwarmManager` runtime teardown beyond current server/scheduler/integration shutdown remains unchanged in this migration.
- Known near-term follow-up: if runtime leaks appear in Electron teardown tests, add explicit `SwarmManager.shutdown()` in this migration instead of deferring.

## Artifacts and Notes

- Plan file: `/Users/davidraphael/Desktop/middleman/docs/plans/2026-02-27-electron-embedded-app-plan.md`
- Run root: `/Users/davidraphael/.codex/runs/electron-20260227-235356/`
- Gate artifacts:
  - `/Users/davidraphael/.codex/runs/electron-20260227-235356/gate-pass1.json`
  - `/Users/davidraphael/.codex/runs/electron-20260227-235356/gate-pass1.md`
  - `/Users/davidraphael/.codex/runs/electron-20260227-235356/gate-pass2.json`
  - `/Users/davidraphael/.codex/runs/electron-20260227-235356/gate-pass2.md`
- Validation logs:
  - `/Users/davidraphael/.codex/runs/electron-20260227-235356/validation/backend-tests.txt`
  - `/Users/davidraphael/.codex/runs/electron-20260227-235356/validation/electron-tests.txt`
  - `/Users/davidraphael/.codex/runs/electron-20260227-235356/validation/typecheck.txt`

## Interfaces and Dependencies

- Backend lifecycle API (new): imported by Electron main and backend CLI entrypoint.
  - `interface BootstrapOptions { rootDir?: string; dataDir?: string; envPath?: string | null; host?: string; port?: number }`
  - `interface BootstrapResult { host: string; port: number; wsUrl: string; httpUrl: string; stop(): async function returning void }`
  - `startMiddlemanBackend(options?: BootstrapOptions): Promise of BootstrapResult`
  - `createConfig(overrides?)` is extended and called from bootstrap to apply rootDir/dataDir/envPath/host/port overrides.
  - If `overrides.rootDir` is present, `detectRootDir()` is bypassed.
  - If `overrides.dataDir` is present, homedir default is bypassed.
  - `startMiddlemanBackend` throws on startup failures after executing cleanup for partially started services.
  - `startMiddlemanBackend` loads dotenv first, then calls `createConfig(overrides)`.
  - Backend package explicit exports map:
    - `.` -> import `./dist/index.js`, types `./dist/index.d.ts`
    - `./bootstrap` -> import `./dist/bootstrap.js`, types `./dist/bootstrap.d.ts`
  - Never calls `process.exit()` and never installs process signal handlers.
- Renderer preload contract (new):
  - `window.middlemanRuntime.wsUrl: string`
  - `window.middlemanRuntime.apiUrl: string`
  - Fallback chain for web mode remains `VITE_MIDDLEMAN_WS_URL` then location-derived heuristic.
  - IPC channel name: `middleman:get-runtime-config`.
  - Preload fetches runtime URLs via `ipcRenderer.invoke` and exposes them through contextBridge.
  - Main process dev URL source: `ELECTRON_DEV_URL` with fallback `http://127.0.0.1:47188`.
  - Main process renderer branch: use `app.isPackaged`.
  - BrowserWindow webPreferences explicitly set `sandbox: false`, `contextIsolation: true`, `nodeIntegration: false`.
- UI type declaration path:
  - `apps/ui/src/electron-env.d.ts` augments `Window` with optional `middlemanRuntime`.
- Existing protocol interfaces remain unchanged in `packages/protocol/*`.
- Electron dependencies to add in `apps/electron` package:
  - `electron`
  - `@middleman/backend` workspace dependency
  - `concurrently` for dev script orchestration
  - `vitest` for main/preload unit tests
  - TypeScript tooling compatible with repository conventions.
