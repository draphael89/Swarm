# Agent Browser Skill Integration Plan for Middleman

## Objective
Give Middleman agents reliable web-browsing automation by integrating Vercel Labs `agent-browser`, while preserving Middleman's existing skill-driven architecture and keeping security controls explicit.

---

## 1) What agent-browser provides

Research confirms `agent-browser` is a **browser automation CLI** with a local daemon, not an MCP server.

### Core capabilities
- Page navigation + interaction:
  - `open`, `click`, `fill`, `type`, `press`, `hover`, `select`, `check`, `upload`, `drag`
- AI-friendly page understanding:
  - `snapshot` with stable refs (`@e1`, `@e2`) for deterministic interactions
  - `snapshot -i --json` for machine-readable output
- Extraction + capture:
  - `get text/html/value/attr/title/url`
  - `screenshot` (including `--annotate`), `pdf`
- Workflow/verification:
  - `wait`, `find role|text|label...`, `diff snapshot`, `diff screenshot`, `diff url`
- Stateful and parallel browsing:
  - `--session`, `--session-name`, `--profile`, `state save/load/list`
- Advanced operation:
  - CDP attach (`--cdp`, `--auto-connect`), network routing, tabs/windows/frames, trace/profiler, optional stream server

### Architecture
- Native Rust CLI binary for fast command parsing.
- Node daemon manages Playwright browser lifecycle and session sockets.
- Node fallback is supported when native path is unavailable.
- Includes an upstream `skills/agent-browser/SKILL.md` designed for AI coding assistants.

### Exposure model
- Primary interface: CLI (`agent-browser ...`).
- Internal daemon protocol: local JSON messages over Unix socket/TCP.
- Optional TypeScript API is documented (`BrowserManager`), but the stable integration surface for Middleman should be CLI.

### MCP status
- No MCP server entrypoint found in repo structure, README, or package scripts.
- Recommendation: treat `agent-browser` as **CLI + daemon tooling**, not MCP.

---

## 2) Integration approach

## Recommendation (v1)
Integrate as a **built-in skill + CLI usage** first.

Why this is the best first step:
1. Middleman agents already have shell execution.
2. `agent-browser` is already optimized for agent workflows (snapshot/ref loop, JSON mode).
3. Minimal backend risk versus building a new protocol bridge.
4. Keeps parity with current built-in skill pattern (`memory`/`brave-search`).

### Does this require deeper integration now?
No for MVP.

Agents can immediately use:
- `agent-browser ...` (if globally installed), or
- `npx agent-browser ...` (fallback, slower)

### When deeper integration becomes worthwhile
- Need one-click install/health checks in Settings UI
- Need policy enforcement (allow/deny domains, disable file://)
- Need first-class live browser preview embedding in Middleman UI

---

## 3) Installation model

### Runtime requirements
- Node.js + npm/npx available on host.
- `agent-browser` installed (global or project-level).
- Chromium installed via:
  - `agent-browser install`
  - Linux: `agent-browser install --with-deps` if required.

### Installation options
1. Global (recommended for Middleman host):
   - `npm install -g agent-browser`
   - `agent-browser install`
2. No-install fallback:
   - `npx agent-browser install`
   - `npx agent-browser open example.com`
3. macOS Homebrew:
   - `brew install agent-browser`
   - `agent-browser install`

### Operational note
- Global install gives fastest startup (native binary path).
- `npx` works but adds Node wrapper overhead.

---

## 4) Skill structure in Middleman (brave-search-aligned)

### Files to add
- `apps/backend/src/swarm/skills/builtins/agent-browser/SKILL.md`

### Optional repo override support (recommended)
Mirror existing brave-search pattern:
- Repo override path: `.swarm/skills/agent-browser/SKILL.md`
- Built-in fallback path in backend source

### Backend wiring changes
Update `apps/backend/src/swarm/swarm-manager.ts`:
1. Add constants for built-in + fallback + repo override paths.
2. Add `resolveAgentBrowserSkillPath()`.
3. Include agent-browser in `reloadSkillMetadata()`.

This automatically enables:
- Skill injection into runtime context
- Env var declarations surfaced in Settings → Environment Variables

### Frontmatter env strategy
No required env vars for local browsing baseline.
Optional env declarations to expose in Settings:
- `AGENT_BROWSER_PROVIDER`
- `AGENT_BROWSER_PROXY`
- `AGENT_BROWSER_PROXY_BYPASS`
- `BROWSERBASE_API_KEY`
- `BROWSERBASE_PROJECT_ID`
- `BROWSER_USE_API_KEY`
- `KERNEL_API_KEY`

Keep these `required: false` to avoid blocking users who only need local Chromium.

---

## 5) Commands/tools agents would get

The skill should teach a default safe workflow and a concise command set.

### Core workflow
1. `agent-browser open <url>`
2. `agent-browser snapshot -i --json`
3. `agent-browser click @eN` / `fill @eN "..."`
4. Re-snapshot after page changes
5. `agent-browser close`

### High-value command groups for Middleman docs
- Navigation/state: `open`, `back`, `forward`, `reload`, `close`, `tab`, `session`
- Interaction: `click`, `fill`, `type`, `select`, `check`, `upload`, `press`, `find ...`
- Extraction: `get text`, `get url`, `get title`, `snapshot --json`
- Capture/debug: `screenshot --annotate`, `pdf`, `diff snapshot`, `diff screenshot`
- Stability: `wait --load networkidle`, `wait --url`, `wait --fn`

---

## 6) Settings UI/config needs

### MVP
No new dedicated UI panel required.

Use current Settings env variable UI via skill frontmatter declarations.

### Recommended defaults
- Keep headless by default.
- Do not set global proxy/provider by default.
- Encourage per-project `agent-browser.json` for local defaults where needed.

### Later UI enhancement (phase 3+)
Add a Browser integration card with:
- Install/health checks (`agent-browser --version`, browser installed status)
- Optional toggles for headed mode and proxy
- Provider selector and keyed credential fields

---

## 7) Security considerations

`agent-browser` expands agent reach to arbitrary websites and authenticated sessions. Guardrails should be explicit.

### Risks
1. Data exfiltration from browsing untrusted sites.
2. Accidental credential persistence in profiles/state files.
3. Local file exposure if `--allow-file-access` is used.
4. Remote browser provider traffic leaving local machine.
5. Misuse of CDP endpoints or live input stream.

### Built-in safeguards already present upstream
- Local daemon socket directory created with restricted permissions.
- Stream server binds to localhost and validates origin.
- Initial HTTP-like socket payloads are rejected (cross-origin hardening).
- Header scoping support to avoid cross-origin auth leakage patterns.

### Middleman policy recommendations
1. Skill guidance: avoid login/auth flows unless explicitly requested.
2. Default to ephemeral sessions; only use `--profile`/`--session-name` when needed.
3. Treat `--allow-file-access`, `--cdp`, and cloud providers as explicit advanced modes.
4. Add optional domain allowlist/blocklist wrapper in a hardening phase.
5. Ensure agents close sessions after task completion (`agent-browser close`).

---

## 8) Phased implementation

### Phase 1 — Skill MVP (fast path)
1. Add built-in `agent-browser` SKILL doc.
2. Wire skill loading in `swarm-manager.ts`.
3. Add minimal tests that metadata/env declarations load.
4. Add usage examples (snapshot/ref loop, close discipline).

### Phase 2 — Install + DX hardening
1. Document host installation in repo docs.
2. Add operator health checklist (binary present + Chromium installed).
3. Add troubleshooting section for Linux deps and slow page timeouts.

### Phase 3 — Settings integration polish
1. Optional Browser card in Settings for status checks.
2. Surface optional provider/proxy vars with clear descriptions.
3. Add safe defaults and warning copy for advanced flags.

### Phase 4 — Security + advanced UX
1. Optional safe wrapper for domain policies.
2. Optional UI support for live stream preview.
3. Optional run logs/artifact attachment for screenshots and diffs.

---

## Suggested acceptance criteria
1. Agents can execute end-to-end browse workflow using `agent-browser` commands from skill instructions.
2. Skill appears in runtime context and env vars appear in Settings when declared.
3. Default setup works locally with no required external API keys.
4. Security caveats and explicit advanced-mode guidance are documented.
5. Installation and troubleshooting docs are enough for first-time setup on macOS/Linux.

---

## Research sources
- https://github.com/vercel-labs/agent-browser
- https://raw.githubusercontent.com/vercel-labs/agent-browser/main/README.md
- https://raw.githubusercontent.com/vercel-labs/agent-browser/main/package.json
- https://api.github.com/repos/vercel-labs/agent-browser/contents/
- https://api.github.com/repos/vercel-labs/agent-browser/git/trees/main?recursive=1
- https://raw.githubusercontent.com/vercel-labs/agent-browser/main/src/daemon.ts
- https://raw.githubusercontent.com/vercel-labs/agent-browser/main/src/stream-server.ts
- https://raw.githubusercontent.com/vercel-labs/agent-browser/main/skills/agent-browser/SKILL.md
- Middleman reference skill: `apps/backend/src/swarm/skills/builtins/brave-search/SKILL.md`
