import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { AgentSidebar } from '@/components/chat/AgentSidebar'
import { ArtifactPanel } from '@/components/chat/ArtifactPanel'
import { ChatHeader, type ChannelView } from '@/components/chat/ChatHeader'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList } from '@/components/chat/MessageList'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { chooseFallbackAgentId } from '@/lib/agent-hierarchy'
import type { ArtifactReference } from '@/lib/artifacts'
import { ManagerWsClient, type ManagerWsState } from '@/lib/ws-client'
import {
  MANAGER_MODEL_PRESETS,
  type AgentDescriptor,
  type ConversationAttachment,
  type ManagerModelPreset,
} from '@/lib/ws-types'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

const DEFAULT_MANAGER_MODEL: ManagerModelPreset = 'pi-codex'
const DEFAULT_DEV_WS_URL = 'ws://127.0.0.1:47187'
const DEFAULT_MANAGER_AGENT_ID = 'opus-manager'
type ActiveView = 'chat' | 'settings'
type AppRouteState =
  | { view: 'chat'; agentId: string }
  | { view: 'settings' }

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function parseRouteStateFromPathname(pathname: string): AppRouteState {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname

  if (normalizedPath === '/settings') {
    return { view: 'settings' }
  }

  const agentMatch = normalizedPath.match(/^\/agent\/([^/]+)$/)
  if (agentMatch) {
    return {
      view: 'chat',
      agentId: decodePathSegment(agentMatch[1]),
    }
  }

  return {
    view: 'chat',
    agentId: DEFAULT_MANAGER_AGENT_ID,
  }
}

function toRoutePathname(routeState: AppRouteState): string {
  if (routeState.view === 'settings') {
    return '/settings'
  }

  const agentId = routeState.agentId.trim() || DEFAULT_MANAGER_AGENT_ID
  if (agentId === DEFAULT_MANAGER_AGENT_ID) {
    return '/'
  }

  return `/agent/${encodeURIComponent(agentId)}`
}

function getInitialRouteState(): AppRouteState {
  if (typeof window === 'undefined') {
    return { view: 'chat', agentId: DEFAULT_MANAGER_AGENT_ID }
  }

  return parseRouteStateFromPathname(window.location.pathname)
}

function resolveDefaultWsUrl(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_DEV_WS_URL
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = window.location.hostname
  const uiPort = Number(window.location.port) || (window.location.protocol === 'https:' ? 443 : 80)
  // Dev UI runs on 47188 -> backend 47187, prod UI runs on 47289 -> backend 47287.
  const wsPort = uiPort <= 47188 ? 47187 : 47287

  return `${protocol}//${hostname}:${wsPort}`
}

export function IndexPage() {
  const wsUrl = import.meta.env.VITE_SWARM_WS_URL ?? resolveDefaultWsUrl()
  const clientRef = useRef<ManagerWsClient | null>(null)
  const messageInputRef = useRef<MessageInputHandle | null>(null)

  const [state, setState] = useState<ManagerWsState>({
    connected: false,
    targetAgentId: null,
    subscribedAgentId: null,
    messages: [],
    agents: [],
    statuses: {},
    lastError: null,
    slackStatus: null,
    telegramStatus: null,
  })

  const [isCreateManagerDialogOpen, setIsCreateManagerDialogOpen] = useState(false)
  const [newManagerName, setNewManagerName] = useState('')
  const [newManagerCwd, setNewManagerCwd] = useState('')
  const [newManagerModel, setNewManagerModel] = useState<ManagerModelPreset>(DEFAULT_MANAGER_MODEL)
  const [createManagerError, setCreateManagerError] = useState<string | null>(null)
  const [isCreatingManager, setIsCreatingManager] = useState(false)
  const [isValidatingDirectory, setIsValidatingDirectory] = useState(false)

  const [browseError, setBrowseError] = useState<string | null>(null)
  const [isPickingDirectory, setIsPickingDirectory] = useState(false)

  const [managerToDelete, setManagerToDelete] = useState<AgentDescriptor | null>(null)
  const [deleteManagerError, setDeleteManagerError] = useState<string | null>(null)
  const [isDeletingManager, setIsDeletingManager] = useState(false)

  const [routeState, setRouteState] = useState<AppRouteState>(() => getInitialRouteState())
  const activeView: ActiveView = routeState.view

  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [activeArtifact, setActiveArtifact] = useState<ArtifactReference | null>(null)
  const [channelView, setChannelView] = useState<ChannelView>('web')
  const [isCompactingManager, setIsCompactingManager] = useState(false)
  const dragDepthRef = useRef(0)

  useEffect(() => {
    const client = new ManagerWsClient(wsUrl)
    clientRef.current = client
    setState(client.getState())

    const unsubscribe = client.subscribe((next) => {
      setState(next)
    })

    client.start()

    return () => {
      unsubscribe()
      if (clientRef.current === client) {
        clientRef.current = null
      }
      client.destroy()
    }
  }, [wsUrl])

  const activeAgentId = useMemo(() => {
    return state.targetAgentId ?? state.subscribedAgentId ?? chooseFallbackAgentId(state.agents)
  }, [state.agents, state.subscribedAgentId, state.targetAgentId])

  const activeAgent = useMemo(() => {
    if (!activeAgentId) return null
    return state.agents.find((agent) => agent.agentId === activeAgentId) ?? null
  }, [activeAgentId, state.agents])

  const activeAgentLabel = activeAgent?.displayName ?? activeAgentId ?? 'No active agent'
  const isActiveManager = activeAgent?.role === 'manager'

  const activeAgentStatus = useMemo(() => {
    if (!activeAgentId) return null

    const fromStatuses = state.statuses[activeAgentId]?.status
    if (fromStatuses) return fromStatuses

    return state.agents.find((agent) => agent.agentId === activeAgentId)?.status ?? null
  }, [activeAgentId, state.agents, state.statuses])

  const isLoading = activeAgentStatus === 'streaming'

  const visibleMessages = useMemo(() => {
    if (channelView === 'all') {
      return state.messages
    }

    return state.messages.filter((entry) => {
      if (entry.type !== 'conversation_message') {
        return true
      }

      return (entry.sourceContext?.channel ?? 'web') === 'web'
    })
  }, [channelView, state.messages])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handlePopState = () => {
      setRouteState(parseRouteStateFromPathname(window.location.pathname))
    }

    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])

  const navigateToRoute = useCallback((nextRouteState: AppRouteState, replace = false) => {
    const nextPathname = toRoutePathname(nextRouteState)
    const normalizedRouteState = parseRouteStateFromPathname(nextPathname)

    setRouteState(normalizedRouteState)

    if (typeof window === 'undefined') return
    if (window.location.pathname === nextPathname) return

    if (replace) {
      window.history.replaceState({}, '', nextPathname)
      return
    }

    window.history.pushState({}, '', nextPathname)
  }, [])

  useEffect(() => {
    setActiveArtifact(null)
  }, [activeAgentId])

  useEffect(() => {
    if (activeView === 'chat') return
    dragDepthRef.current = 0
    setIsDraggingFiles(false)
  }, [activeView])

  useEffect(() => {
    if (routeState.view !== 'chat') return

    const currentAgentId = state.targetAgentId ?? state.subscribedAgentId
    if (currentAgentId === routeState.agentId) return

    if (state.agents.some((agent) => agent.agentId === routeState.agentId)) {
      clientRef.current?.subscribeToAgent(routeState.agentId)
      return
    }

    if (state.agents.length === 0) return

    const fallbackAgentId = chooseFallbackAgentId(state.agents)
    if (!fallbackAgentId || fallbackAgentId === currentAgentId) return

    clientRef.current?.subscribeToAgent(fallbackAgentId)
    navigateToRoute({ view: 'chat', agentId: fallbackAgentId }, true)
  }, [
    navigateToRoute,
    routeState,
    state.agents,
    state.subscribedAgentId,
    state.targetAgentId,
  ])

  const handleCompactManager = useCallback(
    async (customInstructions?: string) => {
      if (!isActiveManager || !activeAgentId) return

      setIsCompactingManager(true)

      try {
        await requestManagerCompaction(wsUrl, activeAgentId, customInstructions)
        setState((previous) => ({
          ...previous,
          lastError: null,
        }))
      } catch (error) {
        setState((previous) => ({
          ...previous,
          lastError: `Failed to compact manager context: ${toErrorMessage(error)}`,
        }))
      } finally {
        setIsCompactingManager(false)
      }
    },
    [activeAgentId, isActiveManager, wsUrl],
  )

  const handleSend = (text: string, attachments?: ConversationAttachment[]) => {
    if (!activeAgentId) return

    const compactCommand =
      isActiveManager && (!attachments || attachments.length === 0)
        ? parseCompactSlashCommand(text)
        : null
    if (compactCommand) {
      void handleCompactManager(compactCommand.customInstructions)
      return
    }

    clientRef.current?.sendUserMessage(text, {
      agentId: activeAgentId,
      delivery: isActiveManager ? 'steer' : isLoading ? 'steer' : 'auto',
      attachments,
    })
  }

  const handleNewChat = () => {
    if (!isActiveManager || !activeAgentId) return
    clientRef.current?.sendUserMessage('/new', { agentId: activeAgentId, delivery: 'steer' })
  }

  const handleSelectAgent = (agentId: string) => {
    navigateToRoute({ view: 'chat', agentId })
    clientRef.current?.subscribeToAgent(agentId)
  }

  const handleDeleteAgent = (agentId: string) => {
    const agent = state.agents.find((entry) => entry.agentId === agentId)
    if (!agent || agent.role !== 'worker') return

    if (activeAgentId === agentId) {
      const remainingAgents = state.agents.filter((entry) => entry.agentId !== agentId)
      const fallbackAgentId = chooseFallbackAgentId(remainingAgents)
      if (fallbackAgentId) {
        navigateToRoute({ view: 'chat', agentId: fallbackAgentId })
        clientRef.current?.subscribeToAgent(fallbackAgentId)
      }
    }

    clientRef.current?.deleteAgent(agentId)
  }

  const handleReboot = useCallback(() => {
    void requestDaemonReboot(wsUrl).catch((error) => {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to request reboot: ${toErrorMessage(error)}`,
      }))
    })
  }, [wsUrl])

  const handleOpenSettingsPanel = () => {
    navigateToRoute({ view: 'settings' })
  }

  const handleRequestDeleteManager = (managerId: string) => {
    const manager = state.agents.find((agent) => agent.agentId === managerId && agent.role === 'manager')
    if (!manager) return

    setDeleteManagerError(null)
    setManagerToDelete(manager)
  }

  const handleConfirmDeleteManager = async () => {
    const manager = managerToDelete
    if (!manager || !clientRef.current) return

    setDeleteManagerError(null)
    setIsDeletingManager(true)

    try {
      await clientRef.current.deleteManager(manager.agentId)

      if (activeAgentId === manager.agentId) {
        const remainingAgents = state.agents.filter(
          (agent) => agent.agentId !== manager.agentId && agent.managerId !== manager.agentId,
        )
        const fallbackAgentId = chooseFallbackAgentId(remainingAgents)
        if (fallbackAgentId) {
          navigateToRoute({ view: 'chat', agentId: fallbackAgentId })
          clientRef.current.subscribeToAgent(fallbackAgentId)
        }
      }

      setManagerToDelete(null)
      setDeleteManagerError(null)
    } catch (error) {
      setDeleteManagerError(toErrorMessage(error))
    } finally {
      setIsDeletingManager(false)
    }
  }

  const handleOpenCreateManagerDialog = () => {
    const defaultCwd =
      activeAgent?.cwd ??
      state.agents.find((agent) => agent.role === 'manager')?.cwd ??
      ''

    setNewManagerName('')
    setNewManagerCwd(defaultCwd)
    setNewManagerModel(DEFAULT_MANAGER_MODEL)
    setBrowseError(null)
    setCreateManagerError(null)
    setIsCreateManagerDialogOpen(true)
  }

  const handleBrowseDirectory = async () => {
    const client = clientRef.current
    if (!client) return

    setBrowseError(null)
    setIsPickingDirectory(true)

    try {
      const pickedPath = await client.pickDirectory(newManagerCwd)
      if (!pickedPath) {
        return
      }

      setNewManagerCwd(pickedPath)
      setCreateManagerError(null)
    } catch (error) {
      setBrowseError(toErrorMessage(error))
    } finally {
      setIsPickingDirectory(false)
    }
  }

  const handleCreateManager = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const client = clientRef.current
    if (!client) return

    const name = newManagerName.trim()
    const cwd = newManagerCwd.trim()

    if (!name) {
      setCreateManagerError('Manager name is required.')
      return
    }

    if (!cwd) {
      setCreateManagerError('Manager working directory is required.')
      return
    }

    setCreateManagerError(null)
    setIsCreatingManager(true)

    try {
      setIsValidatingDirectory(true)
      const validation = await client.validateDirectory(cwd)
      setIsValidatingDirectory(false)

      if (!validation.valid) {
        setCreateManagerError(validation.message ?? 'Directory is not valid.')
        return
      }

      const manager = await client.createManager({
        name,
        cwd: validation.path || cwd,
        model: newManagerModel,
      })

      navigateToRoute({ view: 'chat', agentId: manager.agentId })
      client.subscribeToAgent(manager.agentId)
      setIsCreateManagerDialogOpen(false)
      setNewManagerName('')
      setNewManagerCwd('')
      setNewManagerModel(DEFAULT_MANAGER_MODEL)
      setBrowseError(null)
      setCreateManagerError(null)
    } catch (error) {
      setCreateManagerError(toErrorMessage(error))
    } finally {
      setIsValidatingDirectory(false)
      setIsCreatingManager(false)
    }
  }

  const handleSuggestionClick = (prompt: string) => {
    messageInputRef.current?.setInput(prompt)
  }

  const handleOpenArtifact = useCallback((artifact: ArtifactReference) => {
    setActiveArtifact(artifact)
  }, [])

  const handleCloseArtifact = useCallback(() => {
    setActiveArtifact(null)
  }, [])

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (activeView !== 'chat') return
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current += 1
    setIsDraggingFiles(true)
  }, [activeView])

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (activeView !== 'chat') return
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [activeView])

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (activeView !== 'chat') return
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false)
    }
  }, [activeView])

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (activeView !== 'chat') return
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDraggingFiles(false)

    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length === 0) {
      return
    }

    void messageInputRef.current?.addFiles(files)
  }, [activeView])

  return (
    <main className="h-screen bg-background text-foreground">
      <div className="flex h-screen w-full min-w-0 overflow-hidden bg-background">
        <AgentSidebar
          connected={state.connected}
          agents={state.agents}
          statuses={state.statuses}
          selectedAgentId={activeAgentId}
          isSettingsActive={activeView === 'settings'}
          onAddManager={handleOpenCreateManagerDialog}
          onSelectAgent={handleSelectAgent}
          onDeleteAgent={handleDeleteAgent}
          onDeleteManager={handleRequestDeleteManager}
          onOpenSettings={handleOpenSettingsPanel}
          onReboot={handleReboot}
        />

        <div
          className="relative flex min-w-0 flex-1 flex-col"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {activeView === 'chat' && isDraggingFiles ? (
            <div className="pointer-events-none absolute inset-2 z-50 rounded-lg border-2 border-dashed border-primary bg-primary/10" />
          ) : null}

          {activeView === 'settings' ? (
            <SettingsPanel
              wsUrl={wsUrl}
              managers={state.agents.filter((agent) => agent.role === 'manager')}
              slackStatus={state.slackStatus}
              telegramStatus={state.telegramStatus}
              onBack={() =>
                navigateToRoute({
                  view: 'chat',
                  agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                })
              }
            />
          ) : (
            <>
              <ChatHeader
                connected={state.connected}
                activeAgentId={activeAgentId}
                activeAgentLabel={activeAgentLabel}
                activeAgentStatus={activeAgentStatus}
                channelView={channelView}
                onChannelViewChange={setChannelView}
                showCompact={isActiveManager}
                compactInProgress={isCompactingManager}
                onCompact={() => void handleCompactManager()}
                showNewChat={isActiveManager}
                onNewChat={handleNewChat}
              />

              {state.lastError ? (
                <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {state.lastError}
                </div>
              ) : null}

              <MessageList
                messages={visibleMessages}
                isLoading={isLoading}
                onSuggestionClick={handleSuggestionClick}
                onArtifactClick={handleOpenArtifact}
              />

              <MessageInput
                ref={messageInputRef}
                onSend={handleSend}
                isLoading={isLoading}
                disabled={!state.connected || !activeAgentId}
                allowWhileLoading
                agentLabel={activeAgentLabel}
              />
            </>
          )}
        </div>
      </div>

      <ArtifactPanel
        artifact={activeArtifact}
        wsUrl={wsUrl}
        onClose={handleCloseArtifact}
        onArtifactClick={handleOpenArtifact}
      />

      <Dialog
        open={isCreateManagerDialogOpen}
        onOpenChange={(open) => {
          if (!open && isCreatingManager) return
          setIsCreateManagerDialogOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create manager</DialogTitle>
            <DialogDescription>Create a new manager with a name and working directory.</DialogDescription>
          </DialogHeader>

          <form className="space-y-4" onSubmit={handleCreateManager}>
            <div className="space-y-2">
              <Label htmlFor="manager-name" className="text-xs font-medium text-muted-foreground">
                Name
              </Label>
              <Input
                id="manager-name"
                placeholder="release-manager"
                value={newManagerName}
                onChange={(event) => setNewManagerName(event.target.value)}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="manager-cwd" className="text-xs font-medium text-muted-foreground">
                Working directory
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="manager-cwd"
                  placeholder="/path/to/project"
                  value={newManagerCwd}
                  onChange={(event) => {
                    setNewManagerCwd(event.target.value)
                    setCreateManagerError(null)
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleBrowseDirectory()}
                  disabled={isPickingDirectory || isCreatingManager}
                >
                  {isPickingDirectory ? 'Browsing...' : 'Browse'}
                </Button>
              </div>

              {browseError ? (
                <p className="text-xs text-destructive">{browseError}</p>
              ) : null}

              <p className="text-[11px] text-muted-foreground">
                Use Browse to open the native folder picker, or enter a path manually.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="manager-model" className="text-xs font-medium text-muted-foreground">
                Model
              </Label>
              <Select
                value={newManagerModel}
                onValueChange={(value) => {
                  setNewManagerModel(value as ManagerModelPreset)
                  setCreateManagerError(null)
                }}
                disabled={isCreatingManager || isPickingDirectory}
              >
                <SelectTrigger id="manager-model" className="w-full">
                  <SelectValue placeholder="Select model preset" />
                </SelectTrigger>
                <SelectContent>
                  {MANAGER_MODEL_PRESETS.map((modelPreset) => (
                    <SelectItem key={modelPreset} value={modelPreset}>
                      {modelPreset}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {createManagerError ? (
              <p className="text-xs text-destructive">{createManagerError}</p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateManagerDialogOpen(false)}
                disabled={isCreatingManager}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isCreatingManager || isPickingDirectory}>
                {isCreatingManager
                  ? isValidatingDirectory
                    ? 'Validating...'
                    : 'Creating...'
                  : 'Create manager'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <OverlayDialog
        open={Boolean(managerToDelete)}
        title="Delete manager"
        description={
          managerToDelete
            ? `Delete ${managerToDelete.agentId} and its nested workers? This cannot be undone.`
            : undefined
        }
        onClose={() => {
          if (isDeletingManager) return
          setManagerToDelete(null)
          setDeleteManagerError(null)
        }}
      >
        <div className="space-y-4">
          {deleteManagerError ? (
            <p className="text-xs text-destructive">{deleteManagerError}</p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setManagerToDelete(null)
                setDeleteManagerError(null)
              }}
              disabled={isDeletingManager}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleConfirmDeleteManager()}
              disabled={isDeletingManager}
            >
              {isDeletingManager ? 'Deleting...' : 'Delete manager'}
            </Button>
          </div>
        </div>
      </OverlayDialog>
    </main>
  )
}

interface OverlayDialogProps {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
}

function OverlayDialog({ open, title, description, onClose, children }: OverlayDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-xl p-4">
        <DialogHeader className="mb-4">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {children}
      </DialogContent>
    </Dialog>
  )
}

async function requestDaemonReboot(wsUrl: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/reboot')
  const response = await fetch(endpoint, { method: 'POST' })

  if (!response.ok) {
    throw new Error(`Reboot request failed with status ${response.status}`)
  }
}

async function requestManagerCompaction(
  wsUrl: string,
  agentId: string,
  customInstructions?: string,
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/agents/${encodeURIComponent(agentId)}/compact`)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(
      customInstructions && customInstructions.trim().length > 0
        ? { customInstructions: customInstructions.trim() }
        : {},
    ),
  })

  if (!response.ok) {
    let errorMessage: string | undefined
    try {
      const payload = (await response.json()) as { error?: unknown }
      if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
        errorMessage = payload.error.trim()
      }
    } catch {
      // Ignore JSON parsing errors and fall back to status-based error text.
    }

    throw new Error(errorMessage ?? `Compaction request failed with status ${response.status}`)
  }
}

function parseCompactSlashCommand(text: string): { customInstructions?: string } | null {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i)
  if (!match) {
    return null
  }

  const customInstructions = match[1]?.trim()
  if (!customInstructions) {
    return {}
  }

  return { customInstructions }
}

function resolveApiEndpoint(wsUrl: string, path: string): string {
  try {
    const parsed = new URL(wsUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = path
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return path
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}
