import {
  ArrowRight,
  Brain,
  GitBranch,
  Layers,
  MessageSquare,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface LandingPageProps {
  onCreateManager: () => void
}

const FEATURES = [
  {
    icon: Users,
    title: 'Parallel execution',
    description:
      'Workers run simultaneously across tasks. Dump a batch of work and watch it fan out.',
  },
  {
    icon: GitBranch,
    title: 'Agentic merge queue',
    description:
      'A dedicated merger agent serializes changes into main — no conflicts, no babysitting.',
  },
  {
    icon: Brain,
    title: 'Persistent memory',
    description:
      'Managers remember your preferences, decisions, and context across sessions. They compound over time.',
  },
  {
    icon: Zap,
    title: 'Event-driven, never blocked',
    description:
      'Managers react to worker updates as they stream in. No polling, no waiting.',
  },
] as const

const STEPS = [
  {
    step: '01',
    title: 'Create a manager',
    description: 'Point it at a project directory. Pick a model. That\'s your delegation target.',
  },
  {
    step: '02',
    title: 'Tell it what to do',
    description: 'Describe tasks in plain language. Drop a list of ten things — it breaks them up and parallelizes.',
  },
  {
    step: '03',
    title: 'Workers handle the rest',
    description: 'Spawned agents write code, run tests, merge changes. You review the output, not the process.',
  },
] as const

function PulseRing({ className }: { className?: string }) {
  return (
    <span className={cn('absolute rounded-full border border-primary/20', className)} />
  )
}

export function LandingPage({ onCreateManager }: LandingPageProps) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-12 md:py-20">
        {/* ─── Hero ─── */}
        <section className="flex flex-col items-center text-center">
          <div className="relative mb-8 flex size-20 items-center justify-center">
            <PulseRing className="size-20 animate-ping opacity-20 [animation-duration:3s]" />
            <PulseRing className="size-14 animate-ping opacity-15 [animation-duration:3s] [animation-delay:400ms]" />
            <div className="relative z-10 flex size-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10">
              <Layers className="size-7 text-primary" strokeWidth={1.5} />
            </div>
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Stop managing your agents.
          </h1>
          <p className="mt-2 text-xl font-medium text-primary sm:text-2xl">
            Hire a middle manager.
          </p>

          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground">
            Swarm is a local-first orchestration platform. You talk to one manager per project —
            it dispatches workers, parallelizes tasks, and handles the grunt work so you don't have
            to context-switch all day.
          </p>

          <Button
            size="lg"
            className="mt-8 gap-2 rounded-full px-6 text-base"
            onClick={onCreateManager}
          >
            <Sparkles className="size-4" />
            Create your first manager
            <ArrowRight className="size-4" />
          </Button>
        </section>

        {/* ─── How it works ─── */}
        <section className="mt-20">
          <h2 className="mb-8 text-center text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            How it works
          </h2>

          <div className="grid gap-6 sm:grid-cols-3">
            {STEPS.map(({ step, title, description }) => (
              <div key={step} className="relative rounded-xl border border-border/60 bg-card/50 p-5">
                <span className="mb-3 block font-mono text-xs font-bold text-primary/70">
                  {step}
                </span>
                <h3 className="mb-1.5 text-sm font-semibold text-foreground">{title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ─── Features ─── */}
        <section className="mt-20">
          <h2 className="mb-8 text-center text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Built for real work
          </h2>

          <div className="grid gap-5 sm:grid-cols-2">
            {FEATURES.map(({ icon: Icon, title, description }) => (
              <div
                key={title}
                className="flex gap-4 rounded-xl border border-border/60 bg-card/50 p-5"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
                  <Icon className="size-4.5 text-primary" strokeWidth={1.5} />
                </div>
                <div className="min-w-0">
                  <h3 className="mb-1 text-sm font-semibold text-foreground">{title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ─── Bottom CTA ─── */}
        <section className="mt-20 flex flex-col items-center pb-8 text-center">
          <MessageSquare className="mb-4 size-6 text-muted-foreground/50" strokeWidth={1.5} />
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
            One conversation. Parallel execution. Persistent memory that compounds over time.
            Works for vibe coding and production workflows alike.
          </p>
          <Button
            variant="outline"
            className="mt-5 gap-2 rounded-full"
            onClick={onCreateManager}
          >
            Get started
            <ArrowRight className="size-3.5" />
          </Button>
        </section>
      </div>
    </div>
  )
}
