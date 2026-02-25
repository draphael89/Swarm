import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: LandingPage })

const features = [
  {
    title: 'Delegation & Oversight',
    description:
      'Swarm plans work and delegates to focused AI workers in isolated worktrees. You stay informed, not involved.',
  },
  {
    title: 'Multi-Model Teams',
    description:
      'Mix Claude Opus, Codex, and Codex App Server. Swarm assigns each worker based on their strengths.',
  },
  {
    title: 'Live Status Reports',
    description:
      'Watch every message, tool call, and decision stream in real time. Transparent middle management.',
  },
  {
    title: 'Deliverables & Scheduling',
    description:
      'Track generated files, follow references, and automate recurring tasks with built-in cron.',
  },
  {
    title: 'Multi-Channel Updates',
    description:
      'Get reports via web dashboard, Slack, or Telegram. Same orchestration, your preferred inbox.',
  },
  {
    title: 'Built-In Skills',
    description:
      'Web search, browser automation, G Suite workflows, image generation, and persistent memory.',
  },
  {
    title: 'Isolated Workspaces',
    description:
      'Each manager keeps its own memory, integrations, and schedules. No cross-contamination between projects.',
  },
  {
    title: 'Local-First + Open Source',
    description:
      'Self-hosted by default, Apache 2.0 licensed. Your data never leaves your machine.',
  },
]

const flow = [
  {
    num: '01',
    title: 'Brief',
    description:
      'Tell Swarm what you need. It plans the work and picks the right agents for the job.',
  },
  {
    num: '02',
    title: 'Delegate',
    description:
      'Swarm assigns scoped tasks to workers, monitors progress, and streams updates back to you.',
  },
  {
    num: '03',
    title: 'Report',
    description:
      'Results, artifacts, and context are stored locally. Ready for your review.',
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
            The middle manager{' '}
            <span className="text-muted">for your AI agents.</span>
          </h1>

          <p className="reveal-2 mt-8 max-w-xl text-[1.05rem] leading-[1.7] text-muted">
            You set the direction. Swarm handles delegation, coordination,
            and status updates. Your AI workers do the actual work — on your
            machine, under your control.
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

        {/* ── How it works ── */}
        <section className="py-20 sm:py-24">
          <SectionLabel>How it works</SectionLabel>

          <div className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-16">
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
            <span className="text-ink">localhost:47188</span>. All data stays
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
