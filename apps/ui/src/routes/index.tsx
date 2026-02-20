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
import { ChatHeader } from '@/components/chat/ChatHeader'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList } from '@/components/chat/MessageList'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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

const DEFAULT_MANAGER_MODEL: ManagerModelPreset = 'codex-5.3'

interface SettingsEnvVariable {
  name: string
  description?: string
  required: boolean
  helpUrl?: string
  skillName: string
  isSet: boolean
  maskedValue?: string
}

export function IndexPage() {
  const wsUrl = import.meta.env.VITE_SWARM_WS_URL ?? 'ws://127.0.0.1:47187'
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

  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false)
  const [settingsEnvVariables, setSettingsEnvVariables] = useState<SettingsEnvVariable[]>([])
  const [settingsDraftByName, setSettingsDraftByName] = useState<Record<string, string>>({})
  const [settingsRevealByName, setSettingsRevealByName] = useState<Record<string, boolean>>({})
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsSuccessMessage, setSettingsSuccessMessage] = useState<string | null>(null)
  const [isLoadingSettings, setIsLoadingSettings] = useState(false)
  const [settingsSavingVarName, setSettingsSavingVarName] = useState<string | null>(null)
  const [settingsDeletingVarName, setSettingsDeletingVarName] = useState<string | null>(null)

  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [activeArtifact, setActiveArtifact] = useState<ArtifactReference | null>(null)
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

  useEffect(() => {
    setActiveArtifact(null)
  }, [activeAgentId])

  const handleSend = (text: string, attachments?: ConversationAttachment[]) => {
    if (!activeAgentId) return

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
    clientRef.current?.subscribeToAgent(agentId)
  }

  const handleDeleteAgent = (agentId: string) => {
    const agent = state.agents.find((entry) => entry.agentId === agentId)
    if (!agent || agent.role !== 'worker') return

    if (activeAgentId === agentId) {
      const remainingAgents = state.agents.filter((entry) => entry.agentId !== agentId)
      const fallbackAgentId = chooseFallbackAgentId(remainingAgents)
      if (fallbackAgentId) {
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

  const loadSettingsEnvVariables = useCallback(async () => {
    setIsLoadingSettings(true)
    setSettingsError(null)

    try {
      const response = await fetchSettingsEnvVariables(wsUrl)
      setSettingsEnvVariables(response)
    } catch (error) {
      setSettingsError(toErrorMessage(error))
    } finally {
      setIsLoadingSettings(false)
    }
  }, [wsUrl])

  useEffect(() => {
    if (!isSettingsDialogOpen) {
      return
    }

    void loadSettingsEnvVariables()
  }, [isSettingsDialogOpen, loadSettingsEnvVariables])

  const handleOpenSettingsDialog = () => {
    setSettingsError(null)
    setSettingsSuccessMessage(null)
    setIsSettingsDialogOpen(true)
  }

  const handleSaveSettingsVariable = async (variableName: string) => {
    const nextValue = settingsDraftByName[variableName]?.trim() ?? ''
    if (!nextValue) {
      setSettingsError(`Enter a value for ${variableName} before saving.`)
      return
    }

    setSettingsError(null)
    setSettingsSuccessMessage(null)
    setSettingsSavingVarName(variableName)

    try {
      await updateSettingsEnvVariables(wsUrl, { [variableName]: nextValue })
      setSettingsDraftByName((previous) => ({
        ...previous,
        [variableName]: '',
      }))
      setSettingsSuccessMessage(`Saved ${variableName}.`)
      await loadSettingsEnvVariables()
    } catch (error) {
      setSettingsError(toErrorMessage(error))
    } finally {
      setSettingsSavingVarName(null)
    }
  }

  const handleDeleteSettingsVariable = async (variableName: string) => {
    setSettingsError(null)
    setSettingsSuccessMessage(null)
    setSettingsDeletingVarName(variableName)

    try {
      await deleteSettingsEnvVariable(wsUrl, variableName)
      setSettingsDraftByName((previous) => ({
        ...previous,
        [variableName]: '',
      }))
      setSettingsSuccessMessage(`Removed ${variableName}.`)
      await loadSettingsEnvVariables()
    } catch (error) {
      setSettingsError(toErrorMessage(error))
    } finally {
      setSettingsDeletingVarName(null)
    }
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
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current += 1
    setIsDraggingFiles(true)
  }, [])

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false)
    }
  }, [])

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDraggingFiles(false)

    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length === 0) {
      return
    }

    void messageInputRef.current?.addFiles(files)
  }, [])

  return (
    <main className="h-screen bg-background text-foreground">
      <div className="flex h-screen w-full min-w-0 overflow-hidden bg-background">
        <AgentSidebar
          connected={state.connected}
          agents={state.agents}
          statuses={state.statuses}
          selectedAgentId={activeAgentId}
          onAddManager={handleOpenCreateManagerDialog}
          onSelectAgent={handleSelectAgent}
          onDeleteAgent={handleDeleteAgent}
          onDeleteManager={handleRequestDeleteManager}
          onOpenSettings={handleOpenSettingsDialog}
          onReboot={handleReboot}
        />

        <div
          className="relative flex min-w-0 flex-1 flex-col"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDraggingFiles ? (
            <div className="pointer-events-none absolute inset-2 z-50 rounded-lg border-2 border-dashed border-primary bg-primary/10" />
          ) : null}

          <ChatHeader
            connected={state.connected}
            activeAgentId={activeAgentId}
            activeAgentLabel={activeAgentLabel}
            activeAgentStatus={activeAgentStatus}
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
              <label htmlFor="manager-model" className="text-xs font-medium text-muted-foreground">Model</label>
              <select
                id="manager-model"
                value={newManagerModel}
                onChange={(event) => {
                  setNewManagerModel(event.target.value as ManagerModelPreset)
                  setCreateManagerError(null)
                }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isCreatingManager || isPickingDirectory}
              >
                {MANAGER_MODEL_PRESETS.map((modelPreset) => (
                  <option key={modelPreset} value={modelPreset}>
                    {modelPreset}
                  </option>
                ))}
              </select>
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

      <Dialog
        open={isSettingsDialogOpen}
        onOpenChange={(open) => {
          if (!open && (settingsSavingVarName || settingsDeletingVarName)) {
            return
          }

          if (!open) {
            setSettingsError(null)
            setSettingsSuccessMessage(null)
          }

          setIsSettingsDialogOpen(open)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Configure environment variables required by installed skills.</DialogDescription>
          </DialogHeader>

          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold">Environment Variables</h3>
              <p className="text-xs text-muted-foreground">
                Values are stored securely in your swarm data directory and never shown in plain text.
              </p>
            </div>

            {settingsError ? <p className="text-xs text-destructive">{settingsError}</p> : null}
            {settingsSuccessMessage ? <p className="text-xs text-emerald-600">{settingsSuccessMessage}</p> : null}

            {isLoadingSettings ? (
              <p className="text-xs text-muted-foreground">Loading environment variables...</p>
            ) : settingsEnvVariables.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                No skill-declared environment variables were found.
              </p>
            ) : (
              <ul className="space-y-3">
                {settingsEnvVariables.map((variable) => {
                  const isSaving = settingsSavingVarName === variable.name
                  const isDeleting = settingsDeletingVarName === variable.name
                  const draftValue = settingsDraftByName[variable.name] ?? ''
                  const isRevealed = settingsRevealByName[variable.name] === true

                  return (
                    <li key={`${variable.skillName}:${variable.name}`} className="rounded-lg border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{variable.name}</p>
                          <p className="text-xs text-muted-foreground">
                            Skill: <span className="font-medium text-foreground/80">{variable.skillName}</span>
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            variable.isSet ? 'bg-emerald-500/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600'
                          }`}
                        >
                          {variable.isSet ? 'Set' : 'Missing'}
                        </span>
                      </div>

                      {variable.description ? (
                        <p className="mt-2 text-xs text-muted-foreground">{variable.description}</p>
                      ) : null}

                      {variable.helpUrl ? (
                        <a
                          href={variable.helpUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-block text-xs text-primary underline-offset-2 hover:underline"
                        >
                          Get API key
                        </a>
                      ) : null}

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Input
                          type={isRevealed ? 'text' : 'password'}
                          placeholder={variable.isSet ? variable.maskedValue ?? '********' : 'Enter value'}
                          value={draftValue}
                          onChange={(event) => {
                            const nextValue = event.target.value
                            setSettingsDraftByName((previous) => ({
                              ...previous,
                              [variable.name]: nextValue,
                            }))
                            setSettingsError(null)
                            setSettingsSuccessMessage(null)
                          }}
                          className="min-w-[16rem] flex-1"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={isSaving || isDeleting}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSettingsRevealByName((previous) => ({
                              ...previous,
                              [variable.name]: !previous[variable.name],
                            }))
                          }}
                          disabled={isSaving || isDeleting}
                        >
                          {isRevealed ? 'Hide' : 'Show'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void handleSaveSettingsVariable(variable.name)}
                          disabled={!draftValue.trim() || isSaving || isDeleting}
                        >
                          {isSaving ? 'Saving...' : 'Save'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleDeleteSettingsVariable(variable.name)}
                          disabled={isSaving || isDeleting || !variable.isSet}
                        >
                          {isDeleting ? 'Removing...' : 'Remove'}
                        </Button>
                      </div>

                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {variable.required ? 'Required by this skill.' : 'Optional for this skill.'}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
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

async function requestDaemonReboot(wsUrl: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/reboot')
  const response = await fetch(endpoint, { method: 'POST' })

  if (!response.ok) {
    throw new Error(`Reboot request failed with status ${response.status}`)
  }
}

async function fetchSettingsEnvVariables(wsUrl: string): Promise<SettingsEnvVariable[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/env')
  const response = await fetch(endpoint)

  if (!response.ok) {
    throw new Error(`Settings request failed with status ${response.status}`)
  }

  const payload = (await response.json()) as { variables?: unknown }
  if (!payload || !Array.isArray(payload.variables)) {
    return []
  }

  return payload.variables.filter(isSettingsEnvVariable)
}

async function updateSettingsEnvVariables(wsUrl: string, values: Record<string, string>): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/env')
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ values }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Failed to save environment variable (status ${response.status})`)
  }
}

async function deleteSettingsEnvVariable(wsUrl: string, variableName: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/env/${encodeURIComponent(variableName)}`)
  const response = await fetch(endpoint, {
    method: 'DELETE',
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Failed to remove environment variable (status ${response.status})`)
  }
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

function isSettingsEnvVariable(value: unknown): value is SettingsEnvVariable {
  if (!value || typeof value !== 'object') {
    return false
  }

  const maybe = value as Partial<SettingsEnvVariable>

  if (typeof maybe.name !== 'string' || maybe.name.trim().length === 0) {
    return false
  }

  if (typeof maybe.skillName !== 'string' || maybe.skillName.trim().length === 0) {
    return false
  }

  if (typeof maybe.required !== 'boolean') {
    return false
  }

  if (typeof maybe.isSet !== 'boolean') {
    return false
  }

  if (maybe.description !== undefined && typeof maybe.description !== 'string') {
    return false
  }

  if (maybe.helpUrl !== undefined && typeof maybe.helpUrl !== 'string') {
    return false
  }

  if (maybe.maskedValue !== undefined && typeof maybe.maskedValue !== 'string') {
    return false
  }

  return true
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}
