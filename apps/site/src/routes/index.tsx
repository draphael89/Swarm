import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: LandingPage })

const features = [
  {
    title: 'Parallel Execution',
    description:
      'Spawn multiple workers at once. Codex handles backend, Opus handles UI — all running simultaneously in isolated git worktrees.',
  },
  {
    title: 'Agentic Merge Queue',
    description:
      'A dedicated merger agent serializes all completed work into main. One integration point, no conflicts, no babysitting.',
  },
  {
    title: 'Persistent Memory',
    description:
      'Your manager remembers preferences, routing decisions, and project context across sessions. The knowledge compounds over time.',
  },
  {
    title: 'Event-Driven Manager',
    description:
      'The manager is never blocked. It dispatches work, handles status updates, and steers agents — all without waiting on any single worker.',
  },
  {
    title: 'Multi-Model Teams',
    description:
      'Route tasks to the right model. Codex App for backend features, Opus for UI polish, Codex for code generation. Your manager picks.',
  },
  {
    title: 'Voice or Text',
    description:
      'Dump a list of tasks via text or voice. The manager breaks it down, parallelizes what it can, and sequences the rest.',
  },
  {
    title: 'Works for Real Code',
    description:
      'Not just vibe coding. Git worktrees, proper branch isolation, automated merges — production-grade workflows out of the box.',
  },
  {
    title: 'Local-First & Open Source',
    description:
      'Self-hosted daemon on your machine. Apache 2.0 licensed. Your code and API keys never leave localhost.',
  },
]

const flow = [
  {
    num: '01',
    title: 'Create a manager',
    description:
      'One persistent manager per project. Point it at a repo, pick a model, and give it context about how you like to work.',
  },
  {
    num: '02',
    title: 'Describe what needs to be done',
    description:
      'Tell the manager your tasks — a feature, a bug, a refactor. It plans the work and spins up workers in git worktree branches.',
  },
  {
    num: '03',
    title: 'Workers execute in parallel',
    description:
      'Each worker gets a scoped task and an isolated branch. Codex for code, Opus for UI. They implement, validate, and report back.',
  },
  {
    num: '04',
    title: 'Merger handles integration',
    description:
      'A dedicated merger agent reviews completed work and merges to main. One serialization point — no merge conflicts, no manual rebasing.',
  },
]

const quickStartCommands = [
  'git clone https://github.com/SawyerHood/swarm.git',
  'cd swarm',
  'pnpm install',
  'pnpm dev',
]

function LandingPage() {
  return (
    <div className="min-h-screen bg-page text-ink">
      <div className="mx-auto max-w-[68rem] px-6 sm:px-10 lg:px-16">
        {/* ── Nav ── */}
        <nav className="reveal flex items-center justify-between py-7">
          <a
            href="#"
            className="font-display text-[1.15rem] tracking-[-0.01em] no-underline"
          >
            Swarm
          </a>
          <a
            href="https://github.com/SawyerHood/swarm"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-muted no-underline transition-colors duration-300 hover:text-ink"
          >
            GitHub
          </a>
        </nav>

        {/* ── Hero ── */}
        <section className="pb-20 pt-24 sm:pt-32 lg:pt-40">
          <h1 className="reveal-1 font-display max-w-[52rem] text-[clamp(2.4rem,5.6vw,4.2rem)] font-normal italic leading-[1.1] tracking-[-0.025em]">
            Stop managing your agents.{' '}
            <span className="text-muted">Hire a middle manager.</span>
          </h1>

          <p className="reveal-2 mt-8 max-w-xl text-[1.05rem] leading-[1.7] text-muted">
            You&rsquo;re not an IC anymore. You spend your day doing project
            management — dispatching tasks, checking status, rebasing branches.
            Swarm gives you a persistent AI manager that handles the
            coordination so you can focus on direction.
          </p>

          <div className="reveal-3 mt-10 flex items-center gap-8">
            <a
              href="#quick-start"
              className="text-[13px] font-medium underline decoration-accent decoration-[1.5px] underline-offset-[5px] transition-colors duration-300 hover:text-accent"
            >
              Get started
            </a>
            <a
              href="https://github.com/SawyerHood/swarm"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] text-muted no-underline transition-colors duration-300 hover:text-ink"
            >
              View source &rarr;
            </a>
          </div>
        </section>

        <Rule />

        {/* ── At a glance ── */}
        <section className="grid grid-cols-2 gap-y-7 py-12 sm:grid-cols-4">
          {(
            [
              ['Role', 'Middle management'],
              ['Runtimes', 'Claude, Codex, Codex App'],
              ['Channels', 'Web, Slack, Telegram'],
              ['License', 'Apache 2.0'],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <p className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase">
                {label}
              </p>
              <p className="mt-2 text-[13px]">{value}</p>
            </div>
          ))}
        </section>

        <Rule />

        {/* ── The pitch ── */}
        <section className="py-20 sm:py-24">
          <SectionLabel>The problem</SectionLabel>

          <div className="mt-8 max-w-2xl space-y-5">
            <p className="text-[1.05rem] leading-[1.7] text-muted">
              AI agents are good at focused work — writing code, fixing bugs,
              refactoring modules. But someone still has to play project manager.
              You&rsquo;re the one creating branches, assigning tasks, watching
              terminals, merging PRs, and context-switching between five
              different agent sessions.
            </p>
            <p className="text-[1.05rem] leading-[1.7] text-ink">
              Swarm introduces a layer of middle management. One persistent
              manager per project. You tell it what needs to get done — it
              dispatches workers, tracks progress, and handles the merge queue.
              You stay informed, not involved.
            </p>
          </div>
        </section>

        <Rule />

        {/* ── How it works ── */}
        <section className="py-20 sm:py-24">
          <SectionLabel>How it works</SectionLabel>

          <div className="mt-12 grid gap-10 sm:grid-cols-2 sm:gap-x-20 sm:gap-y-14">
            {flow.map((step) => (
              <div key={step.num}>
                <span className="font-display block text-[2.8rem] font-normal italic leading-none text-rule">
                  {step.num}
                </span>
                <h3 className="mt-5 text-[15px] font-medium">{step.title}</h3>
                <p className="mt-2 text-[13px] leading-[1.7] text-muted">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        <Rule />

        {/* ── Features ── */}
        <section className="py-20 sm:py-24">
          <SectionLabel>Capabilities</SectionLabel>

          <div className="mt-12 grid gap-x-20 sm:grid-cols-2">
            {features.map((feature, i) => (
              <div
                key={feature.title}
                className="border-t border-rule py-6"
              >
                <div className="flex gap-5">
                  <span className="font-display mt-px text-[13px] tabular-nums text-muted/60">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h3 className="text-[14px] font-medium leading-snug">
                      {feature.title}
                    </h3>
                    <p className="mt-1.5 text-[13px] leading-[1.7] text-muted">
                      {feature.description}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <Rule />

        {/* ── Quick start ── */}
        <section id="quick-start" className="py-20 sm:py-24">
          <SectionLabel>Quick start</SectionLabel>

          <div className="mt-12 overflow-hidden rounded-xl bg-ink">
            <pre className="overflow-x-auto p-6 text-[13px] leading-[1.9] text-page/70">
              <code>
                {quickStartCommands
                  .map((c) => `$ ${c}`)
                  .join('\n')}
              </code>
            </pre>
          </div>
          <p className="mt-5 text-[13px] text-muted">
            Opens at{' '}
            <span className="text-ink">localhost:47188</span>. Create a
            manager, point it at a repo, and start delegating. All data stays
            local.
          </p>
        </section>

        <Rule />

        {/* ── Footer ── */}
        <footer className="flex flex-wrap items-center justify-between gap-4 py-8 text-[12px] text-muted">
          <span>Swarm — The middle manager your agents deserve</span>
          <div className="flex gap-6">
            {(
              [
                ['GitHub', 'https://github.com/SawyerHood/swarm'],
                ['License', 'https://github.com/SawyerHood/swarm/blob/main/LICENSE'],
                ['Docs', 'https://github.com/SawyerHood/swarm/tree/main/docs'],
              ] as const
            ).map(([label, href]) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline transition-colors duration-300 hover:text-ink"
              >
                {label}
              </a>
            ))}
          </div>
        </footer>
      </div>
    </div>
  )
}

function Rule() {
  return <hr className="border-rule" />
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase">
      {children}
    </p>
  )
}
