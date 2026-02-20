import { ChevronRight, CircleDashed, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
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

function StatusDot({ isWorking }: { isWorking: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {isWorking ? (
        <>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </>
      ) : (
        <span className="relative inline-flex size-2 rounded-full bg-muted-foreground/30" />
      )}
      <span className="sr-only">{isWorking ? 'Working' : 'Idle'}</span>
    </span>
  )
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
  const [collapsedManagerIds, setCollapsedManagerIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const managerIds = new Set(managerRows.map(({ manager }) => manager.agentId))

    setCollapsedManagerIds((previous) => {
      let hasRemovedManagers = false
      const next = new Set<string>()

      for (const managerId of previous) {
        if (managerIds.has(managerId)) {
          next.add(managerId)
          continue
        }

        hasRemovedManagers = true
      }

      return hasRemovedManagers ? next : previous
    })
  }, [managerRows])

  const toggleManagerCollapsed = (managerId: string) => {
    setCollapsedManagerIds((previous) => {
      const next = new Set(previous)

      if (next.has(managerId)) {
        next.delete(managerId)
      } else {
        next.add(managerId)
      }

      return next
    })
  }

  return (
    <aside className="flex w-48 shrink-0 flex-col border-r border-border/60 bg-muted/30 sm:w-56 md:w-64 lg:w-72">
      {/* Sidebar header — height matches ChatHeader via h-[53px] */}
      <div className="flex h-[53px] shrink-0 items-center justify-between border-b border-border/60 px-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Agents</h2>
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              connected ? 'bg-emerald-500' : 'bg-amber-500',
            )}
            title={connected ? 'Connected' : 'Reconnecting'}
          />
        </div>
        <button
          type="button"
          onClick={onAddManager}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          title="Add manager"
          aria-label="Add manager"
        >
          <Plus aria-hidden="true" className="size-3.5" />
        </button>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {managerRows.length === 0 ? (
          <p className="rounded-md bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
            No active agents.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {managerRows.map(({ manager, workers }) => {
              const managerLiveStatus = statuses[manager.agentId]?.status ?? manager.status
              const managerIsWorking = isWorkingStatus(managerLiveStatus)
              const managerIsSelected = selectedAgentId === manager.agentId
              const managerIsCollapsed = collapsedManagerIds.has(manager.agentId)

              return (
                <li key={manager.agentId}>
                  {/* Manager row */}
                  <div className="group relative">
                    <button
                      type="button"
                      onClick={() => onSelectAgent(manager.agentId)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md py-1.5 pl-7 pr-8 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        managerIsSelected
                          ? 'bg-accent text-accent-foreground'
                          : 'text-foreground/80 hover:bg-accent/50',
                      )}
                    >
                      <StatusDot isWorking={managerIsWorking} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium">
                        {manager.agentId}
                      </span>
                    </button>

                    {/* Collapse chevron */}
                    <button
                      type="button"
                      onClick={() => toggleManagerCollapsed(manager.agentId)}
                      aria-label={`${managerIsCollapsed ? 'Expand' : 'Collapse'} manager ${manager.agentId}`}
                      aria-expanded={!managerIsCollapsed}
                      className={cn(
                        'absolute left-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition',
                        'hover:text-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                      )}
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={cn('size-3 transition-transform', !managerIsCollapsed && 'rotate-90')}
                      />
                    </button>

                    {/* Delete button */}
                    <button
                      type="button"
                      onClick={() => onDeleteManager(manager.agentId)}
                      aria-label={`Delete manager ${manager.agentId}`}
                      className={cn(
                        'absolute right-1 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/50 transition',
                        'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                        'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                      )}
                    >
                      <Trash2 aria-hidden="true" className="size-3" />
                    </button>
                  </div>

                  {/* Worker rows */}
                  {workers.length > 0 && !managerIsCollapsed ? (
                    <ul className="mt-0.5 space-y-0.5 border-l border-border/40 ml-[13px] pl-0">
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
                                  'flex w-full items-center gap-2 rounded-md py-1 pl-3 pr-8 text-left transition-colors',
                                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                                  workerIsSelected
                                    ? 'bg-accent text-accent-foreground'
                                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                                )}
                              >
                                <StatusDot isWorking={workerIsWorking} />
                                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                                  {worker.agentId}
                                </span>
                              </button>

                              <button
                                type="button"
                                onClick={() => onDeleteAgent(worker.agentId)}
                                aria-label={`Delete ${worker.agentId}`}
                                className={cn(
                                  'absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/50 transition',
                                  'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                                  'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                                )}
                              >
                                <Trash2 aria-hidden="true" className="size-3" />
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
              <li className="mt-3">
                <p className="mb-1 px-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">Unassigned</p>
                <ul className="space-y-0.5">
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
                              'flex w-full items-center gap-2 rounded-md py-1 pl-3 pr-8 text-left transition-colors',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                              workerIsSelected
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                            )}
                          >
                            <StatusDot isWorking={workerIsWorking} />
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                              {worker.agentId}
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={() => onDeleteAgent(worker.agentId)}
                            aria-label={`Delete ${worker.agentId}`}
                            className={cn(
                              'absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/50 transition',
                              'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                              'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                            )}
                          >
                            <Trash2 aria-hidden="true" className="size-3" />
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
