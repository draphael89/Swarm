import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: LandingPage })

const features = [
  {
    title: 'Manager + Worker Orchestration',
    description:
      'A manager agent plans work and delegates coding tasks to focused worker agents in isolated worktrees.',
  },
  {
    title: 'Multi-Model Runtime',
    description:
      'Mix Claude Opus, Codex, and Codex App Server workers in one flow with model-specific strengths.',
  },
  {
    title: 'Realtime Streaming UI',
    description:
      'Watch messages, tool calls, statuses, and artifacts stream live in a purpose-built web interface.',
  },
  {
    title: 'Artifacts and Schedules',
    description:
      'Track generated files, follow references, and automate recurring tasks with built-in cron scheduling.',
  },
  {
    title: 'Multi-Channel Delivery',
    description:
      'Operate from the web dashboard, Slack, or Telegram without changing your manager orchestration model.',
  },
  {
    title: 'Built-In Skills',
    description:
      'Use web search, browser automation, G Suite workflows, image generation, and persistent memory skills.',
  },
  {
    title: 'Per-Manager Isolation',
    description:
      'Each manager keeps dedicated memory, integrations, schedules, and runtime state for cleaner operations.',
  },
  {
    title: 'Local-First + Open Source',
    description:
      'Self-hosted by default, Apache 2.0 licensed, and designed so your data stays on your own machine.',
  },
]

const flow = [
  {
    step: '1',
    title: 'Define objective',
    description:
      'Start with a manager agent that receives your goal and chooses the best execution strategy.',
  },
  {
    step: '2',
    title: 'Delegate in parallel',
    description:
      'The manager spins up workers, assigns scoped tasks, and routes progress updates in real time.',
  },
  {
    step: '3',
    title: 'Merge + persist',
    description:
      'Outputs, artifacts, memory, and schedules are stored locally with per-manager isolation.',
  },
]

const channels = ['Web UI', 'Slack', 'Telegram']
const runtimes = ['Claude Opus', 'Codex', 'Codex App Server']
const skills = [
  'Web Search',
  'Browser Automation',
  'G Suite',
  'Image Generation',
  'Cron Scheduling',
  'Persistent Memory',
]

const quickStartCommands = [
  'git clone https://github.com/SawyerHood/swarm.git',
  'cd swarm',
  'pnpm install',
  'pnpm dev',
]

const footerLinks = [
  {
    label: 'GitHub',
    href: 'https://github.com/SawyerHood/swarm',
  },
  {
    label: 'License',
    href: 'https://github.com/SawyerHood/swarm/blob/main/LICENSE',
  },
  {
    label: 'Docs',
    href: 'https://github.com/SawyerHood/swarm/tree/main/docs',
  },
]

function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#07090f] text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_16%,rgba(251,191,36,0.24),transparent_28%),radial-gradient(circle_at_82%_0%,rgba(56,189,248,0.16),transparent_34%),linear-gradient(180deg,#07090f_0%,#0b1020_45%,#07090f_100%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-50 grid-surface" />

      <div className="relative mx-auto max-w-6xl px-6 pb-14 pt-8 sm:px-8 lg:px-10">
        <header className="fade-up">
          <nav className="glass-card flex items-center justify-between rounded-2xl px-4 py-3 sm:px-5">
            <a href="#top" className="flex items-center gap-3 no-underline">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-amber-300/20 text-lg leading-none ring-1 ring-amber-200/35">
                🐝
              </span>
              <span className="text-sm font-semibold tracking-[0.16em] text-zinc-100 uppercase">Swarm</span>
            </a>

            <a
              href="https://github.com/SawyerHood/swarm"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-zinc-300/20 bg-zinc-50/5 px-4 py-2 text-xs font-medium tracking-wide text-zinc-200 no-underline transition hover:border-amber-200/45 hover:bg-amber-300/12 hover:text-white"
            >
              View on GitHub
            </a>
          </nav>
        </header>

        <main className="pb-8 pt-14 md:pt-20">
          <section id="top" className="grid gap-12 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
            <div className="space-y-8">
              <p className="fade-up-delay-1 inline-flex items-center gap-2 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1 text-[11px] font-medium tracking-[0.16em] text-emerald-100 uppercase">
                Open Source • Local First • Apache 2.0
              </p>

              <div className="space-y-5">
                <h1 className="fade-up-delay-1 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl lg:text-[3.4rem] lg:leading-[1.03]">
                  Orchestrate AI agents locally, with real-time control.
                </h1>

                <p className="fade-up-delay-2 max-w-2xl text-base leading-relaxed text-zinc-300 sm:text-lg">
                  Swarm is an open-source, local-first orchestration system where a manager agent delegates work to specialized workers. Run multi-model teams, stream every event live, and keep your data on your own machine.
                </p>
              </div>

              <div className="fade-up-delay-2 flex flex-wrap items-center gap-3">
                <a
                  href="https://github.com/SawyerHood/swarm"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-xl bg-amber-300 px-5 py-2.5 text-sm font-semibold text-zinc-950 no-underline transition hover:bg-amber-200"
                >
                  Star on GitHub
                </a>
                <a
                  href="#quick-start"
                  className="rounded-xl border border-zinc-200/25 bg-zinc-100/5 px-5 py-2.5 text-sm font-medium text-zinc-100 no-underline transition hover:border-zinc-100/40 hover:bg-zinc-100/10"
                >
                  Quick Start
                </a>
              </div>
            </div>

            <aside className="fade-up-delay-2 glass-card rounded-3xl p-6 sm:p-7">
              <p className="text-xs font-semibold tracking-[0.16em] text-zinc-300 uppercase">At a glance</p>

              <dl className="mt-5 space-y-3 text-sm text-zinc-200">
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-zinc-400">Orchestration</dt>
                  <dd className="text-right">Manager + delegated workers</dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-zinc-400">Runtimes</dt>
                  <dd className="text-right">Claude Opus, Codex, Codex App</dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-zinc-400">Channels</dt>
                  <dd className="text-right">Web UI, Slack, Telegram</dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-zinc-400">Deployment</dt>
                  <dd className="text-right">Self-hosted on your machine</dd>
                </div>
              </dl>

              <p className="mt-5 rounded-xl border border-zinc-200/12 bg-zinc-100/5 px-3 py-2 text-xs leading-relaxed text-zinc-300">
                Every manager maintains isolated memory, integrations, and schedules, so long-running operations stay clean and predictable.
              </p>
            </aside>
          </section>

          <section id="features" className="mt-24 md:mt-28">
            <SectionHeading
              eyebrow="Features"
              title="Everything needed to run agent teams"
              description="Swarm combines orchestration, runtime flexibility, and integrated tools so you can manage complex workflows without giving up local control."
            />

            <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {features.map((feature) => (
                <article
                  key={feature.title}
                  className="glass-card rounded-2xl p-5 transition hover:-translate-y-0.5 hover:border-zinc-100/35"
                >
                  <h3 className="text-sm font-semibold text-zinc-100">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-300">{feature.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section id="architecture" className="mt-24 grid gap-10 lg:mt-28 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
            <div>
              <SectionHeading
                eyebrow="How It Works"
                title="One manager, many focused workers"
                description="Swarm is designed for deterministic orchestration: clear delegation, streaming visibility, and local persistence."
              />

              <ol className="mt-8 space-y-5">
                {flow.map((item) => (
                  <li key={item.step} className="glass-card rounded-2xl p-5">
                    <div className="flex items-start gap-4">
                      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-300/20 text-xs font-semibold text-sky-100 ring-1 ring-sky-200/40">
                        {item.step}
                      </span>
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-100">{item.title}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-300">{item.description}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="glass-card rounded-3xl p-6 sm:p-7">
              <h3 className="text-base font-semibold text-zinc-100">Runtime topology</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-300">
                Mix providers and channels without changing your orchestration model. Swarm keeps the execution graph observable from one place.
              </p>

              <div className="mt-6 space-y-5">
                <StackRow label="Runtimes" items={runtimes} tone="amber" />
                <StackRow label="Channels" items={channels} tone="sky" />
                <StackRow label="Skills" items={skills} tone="emerald" />
              </div>
            </div>
          </section>

          <section id="quick-start" className="mt-24 lg:mt-28">
            <SectionHeading
              eyebrow="Getting Started"
              title="Launch Swarm in under a minute"
              description="Run the full stack locally. The UI streams from the backend over WebSocket, and all runtime data stays on your machine."
            />

            <div className="mt-10 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="glass-card rounded-2xl p-5 sm:p-6">
                <p className="text-xs font-medium tracking-[0.14em] text-zinc-300 uppercase">Terminal</p>
                <pre className="mt-4 overflow-x-auto rounded-xl border border-zinc-100/15 bg-black/35 p-4 text-[13px] leading-6 text-zinc-100">
                  <code>
                    {quickStartCommands.map((command) => `$ ${command}`).join('\n')}
                  </code>
                </pre>
                <p className="mt-4 text-xs leading-relaxed text-zinc-400">
                  Default dev endpoints: UI <span className="text-zinc-200">http://127.0.0.1:47188</span> and backend <span className="text-zinc-200">ws://127.0.0.1:47187</span>.
                </p>
              </div>

              <div className="glass-card rounded-2xl p-5 sm:p-6">
                <p className="text-sm font-semibold text-zinc-100">After boot</p>
                <ul className="mt-4 space-y-3 text-sm text-zinc-300">
                  <li>1. Create or select a manager agent.</li>
                  <li>2. Send a task and watch worker delegation stream live.</li>
                  <li>3. Review artifacts and schedules in the same UI.</li>
                </ul>
                <a
                  href="https://github.com/SawyerHood/swarm"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-6 inline-flex rounded-lg border border-zinc-100/30 px-4 py-2 text-xs font-semibold tracking-wide text-zinc-100 no-underline transition hover:border-amber-200/45 hover:bg-amber-300/12"
                >
                  Explore repository
                </a>
              </div>
            </div>
          </section>
        </main>

        <footer className="mt-10 border-t border-zinc-200/15 pt-6 pb-2 text-xs text-zinc-400">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>Swarm 🐝 • Local-first orchestration for multi-agent systems.</p>

            <div className="flex flex-wrap items-center gap-3">
              {footerLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-300 no-underline transition hover:text-amber-200"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}

interface SectionHeadingProps {
  eyebrow: string
  title: string
  description: string
}

function SectionHeading({ eyebrow, title, description }: SectionHeadingProps) {
  return (
    <div className="max-w-3xl">
      <p className="text-xs font-semibold tracking-[0.16em] text-zinc-300 uppercase">{eyebrow}</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h2>
      <p className="mt-3 text-sm leading-relaxed text-zinc-300 sm:text-base">{description}</p>
    </div>
  )
}

interface StackRowProps {
  label: string
  items: string[]
  tone: 'amber' | 'sky' | 'emerald'
}

const rowToneClassByTone: Record<StackRowProps['tone'], string> = {
  amber: 'border-amber-200/30 bg-amber-300/12 text-amber-50',
  sky: 'border-sky-200/30 bg-sky-300/12 text-sky-50',
  emerald: 'border-emerald-200/30 bg-emerald-300/12 text-emerald-50',
}

function StackRow({ label, items, tone }: StackRowProps) {
  const toneClassName = rowToneClassByTone[tone]

  return (
    <div>
      <p className="text-xs font-semibold tracking-[0.16em] text-zinc-400 uppercase">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.map((item) => (
          <span
            key={item}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${toneClassName}`}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  )
}
