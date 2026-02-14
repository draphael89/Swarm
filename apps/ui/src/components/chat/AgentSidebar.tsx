import { CircleDashed } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus } from '@/lib/ws-types'

interface AgentSidebarProps {
  connected: boolean
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number }>
  selectedAgentId: string
  onSelectAgent: (agentId: string) => void
}

function isWorkingStatus(status: AgentStatus): boolean {
  return status === 'streaming'
}

export function AgentSidebar({ connected, agents, statuses, selectedAgentId, onSelectAgent }: AgentSidebarProps) {
  const activeAgents = [...agents]
    .filter((agent) => agent.status === 'idle' || agent.status === 'streaming')
    .sort((a, b) => {
      if (a.role === 'manager' && b.role !== 'manager') return -1
      if (b.role === 'manager' && a.role !== 'manager') return 1
      return a.createdAt.localeCompare(b.createdAt)
    })

  return (
    <aside className="w-48 shrink-0 border-r border-border/70 bg-muted/20 sm:w-56 md:w-64 lg:w-72">
      <div className="border-b border-border/70 px-3 py-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Agents</p>
        <h2 className="mt-1 text-sm font-semibold">Active swarm members</h2>
        <p className="mt-1 text-xs text-muted-foreground">{connected ? 'Live updates' : 'Reconnecting...'}</p>
      </div>

      <div className="max-h-[calc(100vh-88px)] overflow-y-auto p-2">
        {activeAgents.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/80 p-3 text-xs text-muted-foreground">
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
                <li key={agent.agentId} className={cn(isWorker && 'pl-4')}>
                  <button
                    type="button"
                    onClick={() => onSelectAgent(agent.agentId)}
                    className={cn(
                      'w-full rounded-md border px-2 py-1.5 text-left transition-colors',
                      isSelected
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-transparent hover:border-border hover:bg-accent/60',
                    )}
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                        {isWorking ? <CircleDashed aria-hidden="true" className="size-3 animate-spin" /> : <span aria-hidden="true" className="size-3" />}
                        <span className="sr-only">{isWorking ? 'Working' : 'Idle'}</span>
                      </span>
                      <span className="truncate font-mono text-[11px]">{agent.agentId}</span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
