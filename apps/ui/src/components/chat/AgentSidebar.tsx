import { CircleDashed, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus } from '@/lib/ws-types'

interface AgentSidebarProps {
  connected: boolean
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number }>
  selectedAgentId: string
  onSelectAgent: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
}

function isWorkingStatus(status: AgentStatus): boolean {
  return status === 'streaming'
}

export function AgentSidebar({
  connected,
  agents,
  statuses,
  selectedAgentId,
  onSelectAgent,
  onDeleteAgent,
}: AgentSidebarProps) {
  const activeAgents = [...agents]
    .filter((agent) => agent.status === 'idle' || agent.status === 'streaming')
    .sort((a, b) => {
      if (a.role === 'manager' && b.role !== 'manager') return -1
      if (b.role === 'manager' && a.role !== 'manager') return 1
      return a.createdAt.localeCompare(b.createdAt)
    })

  return (
    <aside className="w-48 shrink-0 bg-muted/20 sm:w-56 md:w-64 lg:w-72">
      <div className="px-3 py-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Agents</p>
        <h2 className="mt-1 text-sm font-semibold">Active swarm members</h2>
        <p className="mt-1 text-xs text-muted-foreground">{connected ? 'Live updates' : 'Reconnecting...'}</p>
      </div>

      <div className="max-h-[calc(100vh-88px)] overflow-y-auto p-2">
        {activeAgents.length === 0 ? (
          <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
            No active agents.
          </p>
        ) : (
          <ul className="space-y-1">
            {activeAgents.map((agent) => {
              const liveStatus = statuses[agent.agentId]?.status ?? agent.status
              const isWorking = isWorkingStatus(liveStatus)
              const isSelected = selectedAgentId === agent.agentId
              const isWorker = agent.role === 'worker'

              return (
                <li key={agent.agentId}>
                  <div className="group relative">
                    <button
                      type="button"
                      onClick={() => onSelectAgent(agent.agentId)}
                      className={cn(
                        'w-full rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        isWorker && 'pr-9',
                        isSelected ? 'bg-primary/10' : 'hover:bg-accent/60',
                      )}
                    >
                      <div className="flex items-center gap-2 text-xs">
                        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                          {isWorking ? <CircleDashed aria-hidden="true" className="size-3 animate-spin" /> : <span aria-hidden="true" className="size-3" />}
                          <span className="sr-only">{isWorking ? 'Working' : 'Idle'}</span>
                        </span>
                        {isWorker ? <span aria-hidden="true" className="shrink-0 text-[10px] text-muted-foreground/70">↳</span> : null}
                        <span className={cn('min-w-0 flex-1 truncate font-mono text-[11px]', isWorker ? 'text-muted-foreground' : 'font-semibold')}>
                          {agent.agentId}
                        </span>
                      </div>
                    </button>

                    {isWorker ? (
                      <button
                        type="button"
                        onClick={() => onDeleteAgent(agent.agentId)}
                        aria-label={`Delete ${agent.agentId}`}
                        className={cn(
                          'absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/70 transition',
                          'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                          'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        )}
                      >
                        <Trash2 aria-hidden="true" className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
