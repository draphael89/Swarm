import { ChevronRight, CircleDot, Cpu, Plus, Trash2, Users, Wifi, WifiOff } from 'lucide-react'
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

function StatusDot({ working, className }: { working: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'relative flex size-2 shrink-0',
        className,
      )}
    >
      {working ? (
        <>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </>
      ) : (
        <span className="relative inline-flex size-2 rounded-full bg-muted-foreground/40" />
      )}
    </span>
  )
}

function AgentRow({
  agent,
  isSelected,
  isWorking,
  isManager,
  isWorker,
  pendingCount,
  onSelect,
  onDelete,
}: {
  agent: AgentDescriptor
  isSelected: boolean
  isWorking: boolean
  isManager: boolean
  isWorker: boolean
  pendingCount: number
  onSelect: () => void
  onDelete: () => void
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 pr-9 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          isWorker && 'pl-3',
          isSelected
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
        )}
      >
        <StatusDot working={isWorking} />

        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn(
            'truncate text-[13px] leading-tight',
            isManager ? 'font-semibold' : 'font-medium',
            isSelected && 'text-sidebar-foreground',
          )}>
            {agent.agentId}
          </span>
          <span className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
            {isManager ? 'Manager' : 'Worker'}
            {isWorking ? ' · Working' : ''}
            {pendingCount > 0 ? ` · ${pendingCount} pending` : ''}
          </span>
        </div>
      </button>

      <button
        type="button"
        onClick={onDelete}
        aria-label={isManager ? `Delete manager ${agent.agentId}` : `Delete ${agent.agentId}`}
        className={cn(
          'absolute right-1.5 top-1/2 -translate-y-1/2',
          'inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 transition',
          'opacity-0 hover:bg-destructive/10 hover:text-destructive',
          'group-hover:opacity-100 group-focus-within:opacity-100',
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        )}
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </div>
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

  const activeCount = agents.filter((a) => a.status === 'idle' || a.status === 'streaming').length
  const workingCount = Object.values(statuses).filter((s) => isWorkingStatus(s.status)).length

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar sm:w-64 md:w-72">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Users className="size-4 shrink-0 text-sidebar-foreground/70" />
          <h2 className="truncate text-sm font-semibold text-sidebar-foreground">Agents</h2>
        </div>
        <button
          type="button"
          onClick={onAddManager}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md transition',
            'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          )}
          title="Add manager"
          aria-label="Add manager"
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 border-b border-sidebar-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          {connected ? (
            <Wifi className="size-3 text-emerald-500" />
          ) : (
            <WifiOff className="size-3 text-amber-500" />
          )}
          <span className="text-[11px] text-muted-foreground">
            {connected ? 'Live' : 'Reconnecting'}
          </span>
        </div>
        {activeCount > 0 && (
          <div className="flex items-center gap-1.5">
            <Cpu className="size-3 text-muted-foreground/70" />
            <span className="text-[11px] text-muted-foreground">
              {activeCount} active{workingCount > 0 ? ` · ${workingCount} working` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {managerRows.length === 0 && orphanWorkers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="flex items-center justify-center size-12 rounded-xl bg-sidebar-accent mb-3">
              <Users className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-sidebar-foreground">No active agents</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a manager to get started
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {managerRows.map(({ manager, workers }) => {
              const managerLiveStatus = statuses[manager.agentId]?.status ?? manager.status
              const managerPendingCount = statuses[manager.agentId]?.pendingCount ?? 0
              const managerIsWorking = isWorkingStatus(managerLiveStatus)
              const managerIsSelected = selectedAgentId === manager.agentId
              const managerIsCollapsed = collapsedManagerIds.has(manager.agentId)

              return (
                <div key={manager.agentId}>
                  {/* Manager row with inline chevron */}
                  <div className="relative">
                    {workers.length > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleManagerCollapsed(manager.agentId)}
                        aria-label={`${managerIsCollapsed ? 'Expand' : 'Collapse'} manager ${manager.agentId}`}
                        aria-expanded={!managerIsCollapsed}
                        className={cn(
                          'absolute left-0 top-0 z-10 inline-flex size-7 items-center justify-center rounded-md transition',
                          'text-muted-foreground/60 hover:text-sidebar-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                        )}
                        style={{ top: '50%', transform: 'translateY(-50%)' }}
                      >
                        <ChevronRight
                          aria-hidden="true"
                          className={cn('size-3.5 transition-transform duration-150', !managerIsCollapsed && 'rotate-90')}
                        />
                      </button>
                    )}

                    <div className={workers.length > 0 ? 'pl-5' : ''}>
                      <AgentRow
                        agent={manager}
                        isSelected={managerIsSelected}
                        isWorking={managerIsWorking}
                        isManager
                        isWorker={false}
                        pendingCount={managerPendingCount}
                        onSelect={() => onSelectAgent(manager.agentId)}
                        onDelete={() => onDeleteManager(manager.agentId)}
                      />
                    </div>
                  </div>

                  {/* Workers */}
                  {workers.length > 0 && !managerIsCollapsed && (
                    <div className="ml-4 mt-0.5 space-y-0.5 border-l border-sidebar-border pl-2">
                      {workers.map((worker) => {
                        const workerLiveStatus = statuses[worker.agentId]?.status ?? worker.status
                        const workerPendingCount = statuses[worker.agentId]?.pendingCount ?? 0
                        const workerIsWorking = isWorkingStatus(workerLiveStatus)
                        const workerIsSelected = selectedAgentId === worker.agentId

                        return (
                          <AgentRow
                            key={worker.agentId}
                            agent={worker}
                            isSelected={workerIsSelected}
                            isWorking={workerIsWorking}
                            isManager={false}
                            isWorker
                            pendingCount={workerPendingCount}
                            onSelect={() => onSelectAgent(worker.agentId)}
                            onDelete={() => onDeleteAgent(worker.agentId)}
                          />
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Orphan workers section */}
            {orphanWorkers.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <CircleDot className="size-3 text-muted-foreground/50" />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                    Unassigned
                  </span>
                </div>
                <div className="space-y-0.5">
                  {orphanWorkers.map((worker) => {
                    const workerLiveStatus = statuses[worker.agentId]?.status ?? worker.status
                    const workerPendingCount = statuses[worker.agentId]?.pendingCount ?? 0
                    const workerIsWorking = isWorkingStatus(workerLiveStatus)
                    const workerIsSelected = selectedAgentId === worker.agentId

                    return (
                      <AgentRow
                        key={worker.agentId}
                        agent={worker}
                        isSelected={workerIsSelected}
                        isWorking={workerIsWorking}
                        isManager={false}
                        isWorker={false}
                        pendingCount={workerPendingCount}
                        onSelect={() => onSelectAgent(worker.agentId)}
                        onDelete={() => onDeleteAgent(worker.agentId)}
                      />
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
