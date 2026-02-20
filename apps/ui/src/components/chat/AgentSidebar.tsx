import { ChevronDown, ChevronRight, CircleDashed, RotateCcw, SquarePen, Trash2, UserStar } from 'lucide-react'
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
  onReboot: () => void
}

type AgentLiveStatus = {
  status: AgentStatus
  pendingCount: number
}

function getAgentLiveStatus(
  agent: AgentDescriptor,
  statuses: Record<string, { status: AgentStatus; pendingCount: number }>,
): AgentLiveStatus {
  const live = statuses[agent.agentId]
  return {
    status: live?.status ?? agent.status,
    pendingCount: live?.pendingCount ?? 0,
  }
}

function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  const lower = provider.toLowerCase()

  if (lower.includes('anthropic') || lower.includes('claude')) {
    return (
      <img
        src="/agents/claude-logo.svg"
        alt=""
        aria-hidden="true"
        className={className}
      />
    )
  }

  if (!lower.includes('openai')) {
    return <span className={cn('inline-block size-1.5 rounded-full bg-current', className)} aria-hidden="true" />
  }

  return (
    <svg
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
}

function AgentActivitySlot({
  isActive,
  isSelected,
}: {
  isActive: boolean
  isSelected: boolean
}) {
  if (!isActive) {
    return <span className="inline-block size-3 shrink-0" aria-hidden="true" />
  }

  return (
    <CircleDashed
      className={cn(
        'size-3 shrink-0 animate-spin',
        isSelected ? 'text-sidebar-accent-foreground/80' : 'text-muted-foreground',
      )}
      aria-label="Active"
    />
  )
}

function AgentRow({
  agent,
  liveStatus,
  isSelected,
  onSelect,
  className,
  nameClassName,
}: {
  agent: AgentDescriptor
  liveStatus: AgentLiveStatus
  isSelected: boolean
  onSelect: () => void
  className: string
  nameClassName?: string
}) {
  const title = agent.displayName || agent.agentId
  const isActive = liveStatus.status === 'streaming'

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
        isSelected
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
        className,
      )}
      title={title}
    >
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <AgentActivitySlot isActive={isActive} isSelected={isSelected} />
        <span className={cn('min-w-0 flex-1 truncate text-sm leading-5', nameClassName)}>{title}</span>
        <ProviderIcon provider={agent.model.provider} className="size-3 shrink-0 opacity-80" />
      </div>
    </button>
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
  onReboot,
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
    <aside className="flex w-[20rem] min-w-[20rem] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="mb-2 flex h-[62px] shrink-0 items-center gap-2 border-b border-sidebar-border px-2">
        <button
          type="button"
          onClick={onAddManager}
          className="flex flex-1 items-center gap-2 rounded-md p-2 text-sm transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
          title="Create manager"
          aria-label="Add manager"
        >
          <SquarePen aria-hidden="true" className="h-4 w-4" />
          <span>New Manager</span>
        </button>
        <div className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground">
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              connected ? 'bg-emerald-500' : 'bg-amber-500',
            )}
            title={connected ? 'Connected' : 'Reconnecting'}
          />
          <span className="hidden xl:inline">{connected ? 'Live' : 'Retrying'}</span>
        </div>
      </div>

      <div className="px-3 pb-1">
        <h2 className="text-xs font-semibold text-muted-foreground">Agents</h2>
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 pb-2 [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border [&::-webkit-scrollbar-thumb:hover]:bg-sidebar-border/80"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--sidebar-border) transparent',
        }}
      >
        {managerRows.length === 0 ? (
          <p className="rounded-md bg-sidebar-accent/50 px-3 py-4 text-center text-xs text-muted-foreground">
            No active agents.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {managerRows.map(({ manager, workers }) => {
              const managerLiveStatus = getAgentLiveStatus(manager, statuses)
              const managerIsSelected = selectedAgentId === manager.agentId
              const managerIsCollapsed = collapsedManagerIds.has(manager.agentId)

              return (
                <li key={manager.agentId}>
                  <div className="group relative">
                    <AgentRow
                      agent={manager}
                      liveStatus={managerLiveStatus}
                      isSelected={managerIsSelected}
                      onSelect={() => onSelectAgent(manager.agentId)}
                      nameClassName="font-semibold"
                      className="py-1.5 pl-7 pr-8"
                    />

                    <button
                      type="button"
                      onClick={() => toggleManagerCollapsed(manager.agentId)}
                      aria-label={`${managerIsCollapsed ? 'Expand' : 'Collapse'} manager ${manager.agentId}`}
                      aria-expanded={!managerIsCollapsed}
                      className={cn(
                        'absolute left-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition',
                        'hover:text-sidebar-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      )}
                    >
                      <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                        {managerIsCollapsed ? (
                          <>
                            <UserStar
                              aria-hidden="true"
                              className="size-3.5 opacity-70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                            />
                            <ChevronRight
                              aria-hidden="true"
                              className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-within:opacity-70"
                            />
                          </>
                        ) : (
                          <>
                            <UserStar
                              aria-hidden="true"
                              className="size-3.5 opacity-70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                            />
                            <ChevronDown
                              aria-hidden="true"
                              className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-within:opacity-70"
                            />
                          </>
                        )}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onDeleteManager(manager.agentId)}
                      aria-label={`Delete manager ${manager.agentId}`}
                      className={cn(
                        'absolute right-1 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/50 transition',
                        'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                        'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      )}
                    >
                      <Trash2 aria-hidden="true" className="size-3" />
                    </button>
                  </div>

                  {workers.length > 0 && !managerIsCollapsed ? (
                    <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-sidebar-border/80 pl-0">
                      {workers.map((worker) => {
                        const workerLiveStatus = getAgentLiveStatus(worker, statuses)
                        const workerIsSelected = selectedAgentId === worker.agentId

                        return (
                          <li key={worker.agentId}>
                            <div className="group relative">
                              <AgentRow
                                agent={worker}
                                liveStatus={workerLiveStatus}
                                isSelected={workerIsSelected}
                                onSelect={() => onSelectAgent(worker.agentId)}
                                nameClassName="font-normal"
                                className="py-1.5 pl-3 pr-8"
                              />

                              <button
                                type="button"
                                onClick={() => onDeleteAgent(worker.agentId)}
                                aria-label={`Delete ${worker.agentId}`}
                                className={cn(
                                  'absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/50 transition',
                                  'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                                  'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
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
                <p className="mb-1 px-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
                  Unassigned
                </p>
                <ul className="space-y-0.5">
                  {orphanWorkers.map((worker) => {
                    const workerLiveStatus = getAgentLiveStatus(worker, statuses)
                    const workerIsSelected = selectedAgentId === worker.agentId

                    return (
                      <li key={worker.agentId}>
                        <div className="group relative">
                          <AgentRow
                            agent={worker}
                            liveStatus={workerLiveStatus}
                            isSelected={workerIsSelected}
                            onSelect={() => onSelectAgent(worker.agentId)}
                            nameClassName="font-normal"
                            className="py-1.5 pl-7 pr-8"
                          />

                          <button
                            type="button"
                            onClick={() => onDeleteAgent(worker.agentId)}
                            aria-label={`Delete ${worker.agentId}`}
                            className={cn(
                              'absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/50 transition',
                              'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                              'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
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

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <button
          type="button"
          onClick={onReboot}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          <span>Reboot</span>
        </button>
      </div>
    </aside>
  )
}
