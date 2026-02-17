import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { AgentSidebar } from '@/components/chat/AgentSidebar'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList } from '@/components/chat/MessageList'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { chooseFallbackAgentId, getPrimaryManagerId } from '@/lib/agent-hierarchy'
import { ManagerWsClient, type ManagerWsState } from '@/lib/ws-client'
import type { AgentDescriptor } from '@/lib/ws-types'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

function IndexPage() {
  const wsUrl = import.meta.env.VITE_SWARM_WS_URL ?? 'ws://127.0.0.1:47187'
  const clientRef = useRef<ManagerWsClient | null>(null)
  const messageInputRef = useRef<MessageInputHandle | null>(null)

  const [state, setState] = useState<ManagerWsState>({
    connected: false,
    targetAgentId: 'manager',
    subscribedAgentId: null,
    messages: [],
    agents: [],
    statuses: {},
    lastError: null,
  })

  const [isCreateManagerDialogOpen, setIsCreateManagerDialogOpen] = useState(false)
  const [newManagerName, setNewManagerName] = useState('')
  const [newManagerCwd, setNewManagerCwd] = useState('')
  const [createManagerError, setCreateManagerError] = useState<string | null>(null)
  const [isCreatingManager, setIsCreatingManager] = useState(false)
  const [isValidatingDirectory, setIsValidatingDirectory] = useState(false)

  const [browsePath, setBrowsePath] = useState('')
  const [browseDirectories, setBrowseDirectories] = useState<string[]>([])
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [isBrowsingDirectories, setIsBrowsingDirectories] = useState(false)

  const [managerToDelete, setManagerToDelete] = useState<AgentDescriptor | null>(null)
  const [deleteManagerError, setDeleteManagerError] = useState<string | null>(null)
  const [isDeletingManager, setIsDeletingManager] = useState(false)

  useEffect(() => {
    const client = new ManagerWsClient(wsUrl, 'manager')
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

  const primaryManagerId = useMemo(() => getPrimaryManagerId(state.agents), [state.agents])

  const activeAgentId = state.targetAgentId ?? state.subscribedAgentId ?? primaryManagerId ?? 'manager'

  const activeAgent = useMemo(() => {
    return state.agents.find((agent) => agent.agentId === activeAgentId) ?? null
  }, [activeAgentId, state.agents])

  const activeAgentLabel = activeAgent?.displayName ?? activeAgentId
  const isActiveManager = activeAgent?.role === 'manager' || (!activeAgent && activeAgentId === 'manager')

  const isLoading = useMemo(() => {
    const fromStatuses = state.statuses[activeAgentId]?.status
    if (fromStatuses) return fromStatuses === 'streaming'

    const fromAgents = state.agents.find((agent) => agent.agentId === activeAgentId)?.status
    return fromAgents === 'streaming'
  }, [activeAgentId, state.agents, state.statuses])

  const handleSend = (text: string) => {
    clientRef.current?.sendUserMessage(text, {
      agentId: activeAgentId,
      delivery: isActiveManager ? 'steer' : isLoading ? 'steer' : 'auto',
    })
  }

  const handleNewChat = () => {
    if (!isActiveManager) return
    clientRef.current?.sendUserMessage('/new', { agentId: activeAgentId, delivery: 'steer' })
  }

  const handleSelectAgent = (agentId: string) => {
    clientRef.current?.subscribeToAgent(agentId)
  }

  const handleDeleteAgent = (agentId: string) => {
    const agent = state.agents.find((entry) => entry.agentId === agentId)
    if (!agent || agent.role !== 'worker') return

    if (activeAgentId === agentId) {
      const remainingAgents = state.agents.filter((entry) => entry.agentId !== agentId)
      const fallbackAgentId = chooseFallbackAgentId(remainingAgents, primaryManagerId)
      if (fallbackAgentId) {
        clientRef.current?.subscribeToAgent(fallbackAgentId)
      }
    }

    clientRef.current?.deleteAgent(agentId)
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
        const fallbackAgentId = chooseFallbackAgentId(remainingAgents, primaryManagerId)
        if (fallbackAgentId) {
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
    setBrowsePath(defaultCwd)
    setBrowseDirectories([])
    setBrowseError(null)
    setCreateManagerError(null)
    setIsCreateManagerDialogOpen(true)
  }

  const handleBrowseDirectory = async (nextPath?: string) => {
    if (!clientRef.current) return

    setBrowseError(null)
    setIsBrowsingDirectories(true)

    try {
      const targetPath = (nextPath ?? newManagerCwd).trim() || undefined
      const listed = await clientRef.current.listDirectories(targetPath)
      setBrowsePath(listed.path)
      setBrowseDirectories([...new Set(listed.directories)])
    } catch (error) {
      setBrowseError(toErrorMessage(error))
    } finally {
      setIsBrowsingDirectories(false)
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
      })

      client.subscribeToAgent(manager.agentId)
      setIsCreateManagerDialogOpen(false)
      setNewManagerName('')
      setNewManagerCwd('')
      setBrowseDirectories([])
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

  const parentBrowsePath = getParentDirectory(browsePath)

  return (
    <main className="h-screen bg-background text-foreground">
      <div className="flex h-screen w-full min-w-0 overflow-hidden border-x border-border/60 bg-background shadow-sm">
        <AgentSidebar
          connected={state.connected}
          agents={state.agents}
          statuses={state.statuses}
          selectedAgentId={activeAgentId}
          primaryManagerId={primaryManagerId}
          onAddManager={handleOpenCreateManagerDialog}
          onSelectAgent={handleSelectAgent}
          onDeleteAgent={handleDeleteAgent}
          onDeleteManager={handleRequestDeleteManager}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <ChatHeader
            connected={state.connected}
            activeAgentId={activeAgentId}
            activeAgentLabel={`${activeAgentLabel} Chat`}
            showNewChat={isActiveManager}
            onNewChat={handleNewChat}
          />

          {state.lastError ? (
            <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {state.lastError}
            </div>
          ) : null}

          <MessageList
            messages={state.messages}
            isLoading={isLoading}
            activeAgentLabel={activeAgentLabel}
            onSuggestionClick={handleSuggestionClick}
          />

          <MessageInput
            ref={messageInputRef}
            onSend={handleSend}
            isLoading={isLoading}
            disabled={!state.connected}
            allowWhileLoading
            agentLabel={activeAgentLabel}
          />
        </div>
      </div>

      <OverlayDialog
        open={isCreateManagerDialogOpen}
        title="Create manager"
        description="Create a new manager with a name and working directory."
        onClose={() => {
          if (isCreatingManager) return
          setIsCreateManagerDialogOpen(false)
        }}
      >
        <form className="space-y-4" onSubmit={handleCreateManager}>
          <div className="space-y-2">
            <label htmlFor="manager-name" className="text-xs font-medium text-muted-foreground">Name</label>
            <Input
              id="manager-name"
              placeholder="release-manager"
              value={newManagerName}
              onChange={(event) => setNewManagerName(event.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="manager-cwd" className="text-xs font-medium text-muted-foreground">Working directory</label>
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
                disabled={isBrowsingDirectories || isCreatingManager}
              >
                {isBrowsingDirectories ? 'Browsing...' : 'Browse'}
              </Button>
            </div>

            {browseError ? (
              <p className="text-xs text-destructive">{browseError}</p>
            ) : null}

            {browsePath || browseDirectories.length > 0 ? (
              <div className="rounded-md border border-border/70 bg-muted/20 p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-muted-foreground">{browsePath || 'Directory browser'}</span>
                  <div className="flex items-center gap-2">
                    {parentBrowsePath ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => void handleBrowseDirectory(parentBrowsePath)}
                        disabled={isBrowsingDirectories}
                      >
                        Up
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => void handleBrowseDirectory(browsePath)}
                      disabled={isBrowsingDirectories}
                    >
                      Refresh
                    </Button>
                  </div>
                </div>

                {browseDirectories.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    {isBrowsingDirectories ? 'Loading directories…' : 'No child directories found.'}
                  </p>
                ) : (
                  <ul className="max-h-40 space-y-1 overflow-y-auto">
                    {browseDirectories.map((directoryPath) => (
                      <li key={directoryPath} className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setNewManagerCwd(directoryPath)
                            setCreateManagerError(null)
                          }}
                          className="min-w-0 flex-1 truncate rounded-sm px-2 py-1 text-left text-xs transition hover:bg-accent/70"
                          title={directoryPath}
                        >
                          {getPathName(directoryPath)}
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => void handleBrowseDirectory(directoryPath)}
                          disabled={isBrowsingDirectories}
                        >
                          Open
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
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
            <Button type="submit" disabled={isCreatingManager || isBrowsingDirectories}>
              {isCreatingManager
                ? isValidatingDirectory
                  ? 'Validating...'
                  : 'Creating...'
                : 'Create manager'}
            </Button>
          </div>
        </form>
      </OverlayDialog>

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
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-lg border border-border bg-background p-4 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onClose}>
            Close
          </Button>
        </div>

        {children}
      </div>
    </div>
  )
}

function getParentDirectory(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed) return null

  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized || normalized === '/') return null

  if (/^[A-Za-z]:$/.test(normalized)) {
    return null
  }

  const slashIndex = normalized.lastIndexOf('/')
  if (slashIndex <= 0) {
    return normalized.endsWith(':') ? null : '/'
  }

  return normalized.slice(0, slashIndex)
}

function getPathName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized) return path
  const segments = normalized.split('/')
  return segments.at(-1) || normalized
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}
