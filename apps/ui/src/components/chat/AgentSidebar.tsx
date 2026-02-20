import { ChevronDown, ChevronRight, CircleDashed, RotateCcw, Settings, SquarePen, Trash2, UserStar } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { buildManagerTreeRows } from '@/lib/agent-hierarchy'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, AgentStatus, ManagerModelPreset } from '@/lib/ws-types'

interface AgentSidebarProps {
  connected: boolean
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number }>
  selectedAgentId: string | null
  onAddManager: () => void
  onSelectAgent: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onDeleteManager: (managerId: string) => void
  onOpenSettings: () => void
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

const OPUS_MODEL_ID_ALIASES = new Set(['claude-opus-4-6', 'claude-opus-4.6'])
const CODEX_APP_MODEL_ID_ALIASES = new Set(['default', 'codex-app', 'codex-app-server'])

function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  const provider = agent.model.provider.trim().toLowerCase()
  const modelId = agent.model.modelId.trim().toLowerCase()

  if (provider === 'openai-codex' && modelId === 'gpt-5.3-codex') {
    return 'pi-codex'
  }

  if (provider === 'anthropic' && OPUS_MODEL_ID_ALIASES.has(modelId)) {
    return 'pi-opus'
  }

  if (provider === 'openai-codex-app-server' && CODEX_APP_MODEL_ID_ALIASES.has(modelId)) {
    return 'codex-app'
  }

  return undefined
}

function RuntimeIcon({ agent, className }: { agent: AgentDescriptor; className?: string }) {
  const provider = agent.model.provider.toLowerCase()
  const preset = inferModelPreset(agent)

  if (preset === 'pi-codex' || preset === 'pi-opus') {
    return <img src="/pi-logo.svg" alt="" aria-hidden="true" className={cn('dark:invert', className)} />
  }

  if (preset === 'codex-app' || provider.includes('openai')) {
    return <img src="/agents/codex-logo.svg" alt="" aria-hidden="true" className={cn('dark:invert', className)} />
  }

  if (provider.includes('anthropic') || provider.includes('claude')) {
    return <img src="/agents/claude-logo.svg" alt="" aria-hidden="true" className={className} />
  }

  return <span className={cn('inline-block size-1.5 rounded-full bg-current', className)} aria-hidden="true" />
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
  const preset = inferModelPreset(agent)
  const modelLabel = preset ?? agent.model.modelId
  const modelDescription = `${agent.model.provider}/${agent.model.modelId}`

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onSelect}
      className={cn(
        'h-auto w-full justify-start rounded-md p-0 text-left text-sm font-normal transition-colors',
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

        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-1 inline-flex shrink-0 items-center gap-1">
                <span
                  className={cn(
                    'inline-flex size-5 items-center justify-center rounded-sm border border-sidebar-border/80 bg-sidebar-accent/40',
                    isSelected ? 'border-sidebar-ring/60 bg-sidebar-accent-foreground/10' : '',
                  )}
                >
                  <RuntimeIcon agent={agent} className="size-3.5 shrink-0 object-contain opacity-90" />
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    'w-[4.25rem] justify-center truncate border-sidebar-border/80 bg-transparent px-1.5 py-0 text-[9px] font-medium leading-4',
                    isSelected ? 'text-sidebar-accent-foreground/75' : 'text-muted-foreground',
                  )}
                >
                  {modelLabel}
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
              <p className="font-medium">{modelLabel}</p>
              <p className="opacity-80">{modelDescription}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </Button>
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
  onOpenSettings,
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
        <Button
          type="button"
          variant="ghost"
          onClick={onAddManager}
          className="h-auto flex-1 items-center justify-start gap-2 rounded-md p-2 text-sm font-normal transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-sidebar-ring/60"
          title="Create manager"
          aria-label="Add manager"
        >
          <SquarePen aria-hidden="true" className="h-4 w-4" />
          <span>New Manager</span>
        </Button>
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

      <ScrollArea
        className={cn(
          'flex-1',
          '[&>[data-slot=scroll-area-scrollbar]]:w-2',
          '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-sidebar-border',
          'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-sidebar-border/80',
        )}
      >
        <div className="px-2 pb-2 [color-scheme:light] dark:[color-scheme:dark]">
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

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleManagerCollapsed(manager.agentId)}
                      aria-label={`${managerIsCollapsed ? 'Expand' : 'Collapse'} manager ${manager.agentId}`}
                      aria-expanded={!managerIsCollapsed}
                      className={cn(
                        'absolute left-1 top-1/2 size-5 -translate-y-1/2 rounded p-0 text-muted-foreground/70 transition',
                        'hover:text-sidebar-foreground',
                        'focus-visible:ring-sidebar-ring/60',
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
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onDeleteManager(manager.agentId)}
                      aria-label={`Delete manager ${manager.agentId}`}
                      className={cn(
                        'absolute right-1 top-1/2 size-6 -translate-y-1/2 rounded p-0 text-muted-foreground/50 transition',
                        'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                        'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                        'focus-visible:ring-sidebar-ring/60',
                      )}
                    >
                      <Trash2 aria-hidden="true" className="size-3" />
                    </Button>
                  </div>

                  {workers.length > 0 && !managerIsCollapsed ? (
                    <ul className="mt-0.5 space-y-0.5">
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
                                className="py-1.5 pl-11 pr-8"
                              />

                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => onDeleteAgent(worker.agentId)}
                                aria-label={`Delete ${worker.agentId}`}
                                className={cn(
                                  'absolute right-1 top-1/2 size-5 -translate-y-1/2 rounded p-0 text-muted-foreground/50 transition',
                                  'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                                  'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                                  'focus-visible:ring-sidebar-ring/60',
                                )}
                              >
                                <Trash2 aria-hidden="true" className="size-3" />
                              </Button>
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

                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => onDeleteAgent(worker.agentId)}
                            aria-label={`Delete ${worker.agentId}`}
                            className={cn(
                              'absolute right-1 top-1/2 size-5 -translate-y-1/2 rounded p-0 text-muted-foreground/50 transition',
                              'opacity-0 hover:bg-destructive/10 hover:text-destructive',
                              'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                              'focus-visible:ring-sidebar-ring/60',
                            )}
                          >
                            <Trash2 aria-hidden="true" className="size-3" />
                          </Button>
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
      </ScrollArea>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <div className="space-y-1">
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenSettings}
            className="h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-sm font-normal text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring/60"
          >
            <Settings aria-hidden="true" className="size-4" />
            <span>Settings</span>
          </Button>

          <Button
            type="button"
            variant="ghost"
            onClick={onReboot}
            className="h-auto w-full justify-start gap-2 rounded-md px-2 py-2 text-sm font-normal text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring/60"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            <span>Reboot</span>
          </Button>
        </div>
      </div>
    </aside>
  )
}
