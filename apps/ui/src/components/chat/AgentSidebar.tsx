import { CircleDashed, Plus, Trash2 } from 'lucide-react'
import { buildManagerTreeRows } from '@/lib/agent-hierarchy'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus } from '@/lib/ws-types'

interface AgentSidebarProps {
  connected: boolean
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number }>
  selectedAgentId: string | null
  onAddManager: () => void
  onSelectAgent: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onDeleteManager: (managerId: string) => void
}

function isWorkingStatus(status: AgentStatus): boolean {
  return status === 'streaming'
}

export function AgentSidebar({
  connected,
  agents,
  statuses,
  selectedAgentId,
  onAddManager,
  onSelectAgent,
  onDeleteAgent,
  onDeleteManager,
}: AgentSidebarProps) {
  const { managerRows, orphanWorkers } = buildManagerTreeRows(agents)

  return (
    <aside className="w-48 shrink-0 bg-muted/20 sm:w-56 md:w-64 lg:w-72">
      <div className="px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Agents</p>
          <button
            type="button"
            onClick={onAddManager}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            title="Add manager"
            aria-label="Add manager"
          >
            <Plus aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        <h2 className="mt-1 text-sm font-semibold">Active swarm members</h2>
        <p className="mt-1 text-xs text-muted-foreground">{connected ? 'Live updates' : 'Reconnecting...'}</p>
      </div>

      <div className="max-h-[calc(100vh-88px)] overflow-y-auto p-2">
        {managerRows.length === 0 ? (
          <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
            No active agents.
          </p>
        ) : (
          <ul className="space-y-1">
            {managerRows.map(({ manager, workers }) => {
              const managerLiveStatus = statuses[manager.agentId]?.status ?? manager.status
              const managerIsWorking = isWorkingStatus(managerLiveStatus)
              const managerIsSelected = selectedAgentId === manager.agentId

              return (
                <li key={manager.agentId} className="space-y-1">
                  <div className="group relative">
                    <button
                      type="button"
                      onClick={() => onSelectAgent(manager.agentId)}
                      className={cn(
                        'w-full rounded-md px-2 py-1.5 pr-9 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        managerIsSelected ? 'bg-primary/10' : 'hover:bg-accent/60',
                      )}
                    >
                      <div className="flex items-center gap-2 text-xs">
                        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                          {managerIsWorking ? <CircleDashed aria-hidden="true" className="size-3 animate-spin" /> : <span aria-hidden="true" className="size-3" />}
                          <span className="sr-only">{managerIsWorking ? 'Working' : 'Idle'}</span>
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold">
                          {manager.agentId}
                        </span>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => onDeleteManager(manager.agentId)}
                      aria-label={`Delete manager ${manager.agentId}`}
                      className={cn(
                        'absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/70 transition',
                        'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                        'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                      )}
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </button>
                  </div>

                  {workers.length > 0 ? (
                    <ul className="space-y-1 pl-2">
                      {workers.map((worker) => {
                        const workerLiveStatus = statuses[worker.agentId]?.status ?? worker.status
                        const workerIsWorking = isWorkingStatus(workerLiveStatus)
                        const workerIsSelected = selectedAgentId === worker.agentId

                        return (
                          <li key={worker.agentId}>
                            <div className="group relative">
                              <button
                                type="button"
                                onClick={() => onSelectAgent(worker.agentId)}
                                className={cn(
                                  'w-full rounded-md px-2 py-1.5 pr-9 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                                  workerIsSelected ? 'bg-primary/10' : 'hover:bg-accent/60',
                                )}
                              >
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                                    {workerIsWorking ? <CircleDashed aria-hidden="true" className="size-3 animate-spin" /> : <span aria-hidden="true" className="size-3" />}
                                    <span className="sr-only">{workerIsWorking ? 'Working' : 'Idle'}</span>
                                  </span>
                                  <span aria-hidden="true" className="shrink-0 text-[10px] text-muted-foreground/70">↳</span>
                                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                                    {worker.agentId}
                                  </span>
                                </div>
                              </button>

                              <button
                                type="button"
                                onClick={() => onDeleteAgent(worker.agentId)}
                                aria-label={`Delete ${worker.agentId}`}
                                className={cn(
                                  'absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/70 transition',
                                  'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                                  'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                                )}
                              >
                                <Trash2 aria-hidden="true" className="size-3.5" />
                              </button>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                </li>
              )
            })}

            {orphanWorkers.length > 0 ? (
              <li>
                <p className="px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-muted-foreground/80">Unassigned workers</p>
                <ul className="space-y-1 pl-2">
                  {orphanWorkers.map((worker) => {
                    const workerLiveStatus = statuses[worker.agentId]?.status ?? worker.status
                    const workerIsWorking = isWorkingStatus(workerLiveStatus)
                    const workerIsSelected = selectedAgentId === worker.agentId

                    return (
                      <li key={worker.agentId}>
                        <div className="group relative">
                          <button
                            type="button"
                            onClick={() => onSelectAgent(worker.agentId)}
                            className={cn(
                              'w-full rounded-md px-2 py-1.5 pr-9 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                              workerIsSelected ? 'bg-primary/10' : 'hover:bg-accent/60',
                            )}
                          >
                            <div className="flex items-center gap-2 text-xs">
                              <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                                {workerIsWorking ? <CircleDashed aria-hidden="true" className="size-3 animate-spin" /> : <span aria-hidden="true" className="size-3" />}
                                <span className="sr-only">{workerIsWorking ? 'Working' : 'Idle'}</span>
                              </span>
                              <span aria-hidden="true" className="shrink-0 text-[10px] text-muted-foreground/70">↳</span>
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                                {worker.agentId}
                              </span>
                            </div>
                          </button>

                          <button
                            type="button"
                            onClick={() => onDeleteAgent(worker.agentId)}
                            aria-label={`Delete ${worker.agentId}`}
                            className={cn(
                              'absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/70 transition',
                              'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                              'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                            )}
                          >
                            <Trash2 aria-hidden="true" className="size-3.5" />
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </aside>
  )
}
