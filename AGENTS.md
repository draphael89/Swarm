# Terry Local - Agent Notes

## What This Project Is
`terry-local` is a local-first agent manager inspired by Terragon. It runs:

1. A local Node daemon for agent orchestration and persistence.
2. A TanStack Start + Vite SPA for dashboard + chat UI.
3. Realtime updates over WebSocket.

The current dev workflow runs daemon + web app in one process on one port.

## Original Codebase Reference
This implementation is based on the original Terragon codebase, especially:

- `/Users/sawyerhood/terry-root/terragon/apps/www` (UI, styles, UX behavior)
- Dashboard + thread list + chat + promptbox surfaces and their dependency closure

When making UI changes in parity scope, treat Terragon `apps/www` as source-of-truth.

## Scope and Parity Expectations
In-scope parity target:

1. Dashboard layout and behavior.
2. Thread list/sidebar behavior.
3. Chat thread rendering + streaming behavior.
4. Prompt/composer interactions.
5. Styling/tokens/animations for these surfaces.

Parity means matching the original app’s visual structure and interaction states as closely as possible, not redesigning.

## Architecture (Current)

### Frontend
- SPA with TanStack Start + Vite.
- UI state uses Jotai for dashboard/chat domain state.
- Thread list/detail + optimistic updates are managed through Jotai-backed query/mutation hooks.

### Backend/Daemon
- HTTP + WS server in `src/daemon/*`.
- REST endpoints under `/api/*`.
- WS endpoint at `/ws`.
- Runtime adapters handle Claude + Codex execution and stream normalized events.
- Log replay/indexing is used for historical recovery/backfill.

### Contracts
Canonical shared contracts are in:

- `src/contracts/agent.ts`
- `src/contracts/rest.ts`
- `src/contracts/ws.ts`
- `src/contracts/provider-events.ts`

## Run and Test

### Dev (single process)
```bash
pnpm dev
```
Serves UI + API + WS from the same server/port (default `http://127.0.0.1:47322`).
Default ports:
- Dev (`pnpm dev`): `http://127.0.0.1:47322`
- Prod daemon (`pnpm daemon:start`): `http://127.0.0.1:47321`

### Useful checks
```bash
pnpm build
pnpm test
```

Health endpoint:
```bash
curl http://127.0.0.1:47322/api/health
```

## Shadcn UI

Use [shadcn/ui](https://ui.shadcn.com/) for shared UI primitives and new component additions.

Add components using the latest shadcn CLI:

```bash
pnpm dlx shadcn@latest add button
```

Prefer adding/updating generated UI components under `apps/ui/src/components/ui`.

## Important Implementation Notes

1. Root route now has an explicit `notFoundComponent` to avoid TanStack router fallback warnings.
2. Agent icon assets used by chat (`/agents/*`, `/ampcode.svg`) are expected in `public/`.
3. Thread detail responses are sanitized to avoid leaking internal fields.
4. Sending a message to an already running thread returns `409` instead of a generic server failure.

## Working Rules for Future Changes

1. Preserve parity-first behavior in dashboard/chat scope.
2. Prefer adapting boundaries (Next -> SPA/router/env shims) over redesigning component logic.
3. Keep canonical event flow deterministic (dedupe-aware) across SDK stream + log replay.
4. Keep Jotai as source of truth for migrated dashboard/chat state.
5. Validate changes with:
   - UI smoke check (dashboard, thread open, composer send/stop).
   - API/WS smoke check.
   - Build pass (`pnpm build`).
6. Before finishing any task, always run a full TypeScript typecheck and fix all reported errors:
   - `pnpm exec tsc --noEmit`
