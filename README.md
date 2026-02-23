# Swarm 🐝

Local-first multi-agent orchestration with a real-time web UI.

## What is Swarm?

Swarm is a local-first agent manager built around a manager/worker orchestration model.

- A Node.js backend runs managers and workers, routes messages, and persists sessions.
- A TanStack Start + Vite web app provides dashboard, chat, settings, and artifacts.
- Real-time state and streaming updates flow over WebSocket.
- Multi-channel delivery is supported across web, Slack, and Telegram.
- A common setup is running a Claude Opus manager that delegates coding tasks to Codex/Opus workers.

## Features

- Multi-agent orchestration (manager + workers)
- Web UI with real-time streaming
- Slack & Telegram integration
- Built-in skills (memory, web search, cron scheduling, browser, image generation, G Suite)
- File attachments (drag/drop/paste)
- Artifact panel for file references
- Dark mode
- OAuth login flows
- Manual context compaction
- URL-based navigation
- Tailscale remote access support

## Architecture

Swarm is a `pnpm` monorepo with two primary apps:

- `apps/backend`: Node.js orchestration backend (HTTP + WebSocket) with runtime adapters for Claude/Codex.
- `apps/ui`: TanStack Start SPA (Vite + React) for the dashboard/chat/settings experience.

Core flow:

1. Backend boots `SwarmManager`, restores persisted agents/sessions, loads skills/archetypes.
2. UI connects over WebSocket and subscribes to a manager/agent stream.
3. Messages, tool events, statuses, and integration events stream in real time.
4. Runtime adapters handle provider-specific execution (`pi-codex`, `pi-opus`, `codex-app`).

## Quick Start

### Prerequisites

- Node.js 20+
- `pnpm` (repo uses `pnpm@10.8.0`)

### Install

```bash
git clone https://github.com/SawyerHood/swarm.git
cd swarm
pnpm install
cp .env.example .env # optional
```

### Run in development

```bash
pnpm dev
```

Default dev endpoints:

- UI: `http://127.0.0.1:47188`
- Backend (HTTP + WS): `http://127.0.0.1:47187` / `ws://127.0.0.1:47187`

### Run in production

```bash
pnpm prod
```

Default prod endpoints:

- UI preview: `http://127.0.0.1:47289`
- Backend (HTTP + WS): `http://127.0.0.1:47287` / `ws://127.0.0.1:47287`

### Run with persistent daemon (optional)

```bash
pnpm prod:daemon
# later, trigger a restart
pnpm prod:restart
```

## Configuration

Swarm reads environment from `.env` (repo root), plus runtime-configured secrets stored in the Swarm data directory.

### Common environment variables

- `SWARM_HOST` (default: `127.0.0.1`): backend bind host; also used by UI host scripts.
- `SWARM_PORT` (default: `47187`): backend HTTP/WS port.
- `SWARM_DATA_DIR` (default: `~/.swarm-dev` in dev, `~/.swarm` in prod): persistent state root.
- `SWARM_AUTH_FILE` (default: `$SWARM_DATA_DIR/auth/auth.json`): auth credential store.
- `SWARM_ROOT_DIR`: override repository root resolution.
- `SWARM_DEFAULT_CWD`: default working directory for new agents.
- `SWARM_CWD_ALLOWLIST_ROOTS`: comma-separated extra allowed CWD roots.
- `SWARM_MODEL_PROVIDER`, `SWARM_MODEL_ID`, `SWARM_THINKING_LEVEL`: default model descriptor overrides.
- `VITE_SWARM_WS_URL`: force UI WebSocket URL (optional; usually auto-derived).
- `SWARM_PROD_DAEMON_COMMAND`: command used by `pnpm prod:daemon`.

### `.env` example

```bash
# Optional host override (useful for remote access / Tailscale)
SWARM_HOST=127.0.0.1

# Optional skill fallback (can also be set in Settings → Environment Variables)
BRAVE_API_KEY=your-brave-api-key-here
```

### Auth setup

Use **Settings → Authentication** in the UI to configure Anthropic/OpenAI credentials or start OAuth login flows. Credentials are stored locally in `SWARM_AUTH_FILE`.

### Tailscale / remote access

Set `SWARM_HOST` to a reachable interface (for example `0.0.0.0` or a Tailscale IP), then open UI/backend ports on that host.

## Skills

Swarm injects built-in `SKILL.md` instructions into agent runtime context at startup. Skills can be overridden per-repo via `.swarm/skills/<skill-name>/SKILL.md`.

Built-in skills:

- `memory`: persistent memory workflow (`$SWARM_DATA_DIR/memory/<agentId>.md`, runtime alias: `$SWARM_MEMORY_FILE`)
- `brave-search`: Brave Search API web research + content extraction
- `cron-scheduling`: persistent schedule creation/list/remove via cron
- `gsuite`: Google Workspace workflows through `gog` CLI
- `agent-browser`: interactive browser automation via `agent-browser` CLI
- `image-generation`: image generation workflows

Skill-declared env vars appear in **Settings → Environment Variables** and are stored locally for runtime use.

## Integrations

### Slack

1. Create/configure a Slack app (Socket Mode), then collect:
- App token (`xapp-...`)
- Bot token (`xoxb-...`)
2. Open **Settings → Slack integration**.
3. Enable integration, paste tokens, choose target manager, and configure channel/listen options.
4. Click **Test connection**, then **Save Slack settings**.

Config is persisted at `$SWARM_DATA_DIR/integrations/managers/<manager-id>/slack.json`.

### Telegram

1. Create a bot with BotFather and copy the bot token.
2. Open **Settings → Telegram integration**.
3. Enable integration, set bot token, target manager, and optional user allowlist.
4. Click **Test connection**, then **Save Telegram settings**.

Config is persisted at `$SWARM_DATA_DIR/integrations/managers/<manager-id>/telegram.json`.

## Development

```bash
pnpm dev            # backend + ui
pnpm dev:backend    # backend only
pnpm dev:ui         # ui only
pnpm build          # build all workspaces
pnpm test           # run backend + ui tests
pnpm exec tsc --noEmit
```

## Project Structure

```text
swarm/
├── AGENTS.md
├── SWARM.md
├── package.json
├── apps/
│   ├── backend/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── ws/server.ts
│   │       ├── swarm/
│   │       │   ├── swarm-manager.ts
│   │       │   ├── agent-runtime.ts
│   │       │   ├── codex-agent-runtime.ts
│   │       │   ├── archetypes/
│   │       │   └── skills/builtins/
│   │       └── integrations/
│   │           ├── slack/
│   │           ├── telegram/
│   │           └── gsuite/
│   └── ui/
│       └── src/
│           ├── routes/index.tsx
│           ├── components/chat/
│           └── lib/
├── docs/
│   ├── codebase-overview.md
│   └── plans/
└── scripts/
    ├── prod-daemon.mjs
    └── prod-daemon-restart.mjs
```
