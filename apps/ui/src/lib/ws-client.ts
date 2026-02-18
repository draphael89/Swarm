import { chooseFallbackAgentId } from './agent-hierarchy'
import type {
  AgentDescriptor,
  AgentStatus,
  ClientCommand,
  ConversationEntry,
  ConversationMessageEvent,
  DeliveryMode,
  ServerEvent,
} from './ws-types'

const INITIAL_CONNECT_DELAY_MS = 50
const RECONNECT_MS = 1200
const REQUEST_TIMEOUT_MS = 10_000

export interface ManagerWsState {
  connected: boolean
  targetAgentId: string | null
  subscribedAgentId: string | null
  messages: ConversationEntry[]
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number }>
  lastError: string | null
}

export interface DirectoriesListedResult {
  path: string
  directories: string[]
}

export interface DirectoryValidationResult {
  path: string
  valid: boolean
  message: string | null
}

type Listener = (state: ManagerWsState) => void

interface PendingRequest<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const initialState: ManagerWsState = {
  connected: false,
  targetAgentId: null,
  subscribedAgentId: null,
  messages: [],
  agents: [],
  statuses: {},
  lastError: null,
}

export class ManagerWsClient {
  private readonly url: string
  private desiredAgentId: string

  private socket: WebSocket | null = null
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private destroyed = false

  private state: ManagerWsState
  private readonly listeners = new Set<Listener>()

  private requestCounter = 0
  private readonly pendingCreateManagerRequests = new Map<string, PendingRequest<AgentDescriptor>>()
  private readonly pendingDeleteManagerRequests = new Map<string, PendingRequest<{ managerId: string }>>()
  private readonly pendingListDirectoriesRequests = new Map<string, PendingRequest<DirectoriesListedResult>>()
  private readonly pendingValidateDirectoryRequests = new Map<string, PendingRequest<DirectoryValidationResult>>()
  private readonly pendingPickDirectoryRequests = new Map<string, PendingRequest<string | null>>()

  constructor(url: string, initialAgentId = 'manager') {
    this.url = url
    this.desiredAgentId = initialAgentId
    this.state = {
      ...initialState,
      targetAgentId: initialAgentId,
    }
  }

  getState(): ManagerWsState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)

    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.started || this.destroyed || typeof window === 'undefined') {
      return
    }

    this.started = true
    this.scheduleConnect(INITIAL_CONNECT_DELAY_MS)
  }

  destroy(): void {
    this.destroyed = true
    this.started = false

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }

    this.rejectAllPendingRequests('Client destroyed before request completed.')

    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
  }

  subscribeToAgent(agentId: string): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    this.desiredAgentId = trimmed
    this.updateState({
      targetAgentId: trimmed,
      messages: [],
      lastError: null,
    })

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.send({
      type: 'subscribe',
      agentId: trimmed,
    })
  }

  sendUserMessage(
    text: string,
    options?: { agentId?: string; delivery?: DeliveryMode },
  ): void {
    const trimmed = text.trim()
    if (!trimmed) return

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: 'WebSocket is disconnected. Reconnecting...'
      })
      return
    }

    const agentId =
      options?.agentId ?? this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId

    if (!agentId) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (
      !options?.agentId &&
      !this.state.targetAgentId &&
      !this.state.subscribedAgentId &&
      this.state.agents.length === 0
    ) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (this.state.agents.length > 0 && !this.state.agents.some((agent) => agent.agentId === agentId)) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    this.send({
      type: 'user_message',
      text: trimmed,
      agentId,
      delivery: options?.delivery,
    })
  }

  deleteAgent(agentId: string): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: 'WebSocket is disconnected. Reconnecting...'
      })
      return
    }

    this.send({
      type: 'kill_agent',
      agentId: trimmed,
    })
  }

  async createManager(input: { name: string; cwd: string }): Promise<AgentDescriptor> {
    const name = input.name.trim()
    const cwd = input.cwd.trim()

    if (!name) {
      throw new Error('Manager name is required.')
    }

    if (!cwd) {
      throw new Error('Manager working directory is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('create_manager')

    return new Promise<AgentDescriptor>((resolve, reject) => {
      this.trackPendingRequest(this.pendingCreateManagerRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'create_manager',
        name,
        cwd,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(this.pendingCreateManagerRequests, requestId, new Error('WebSocket is disconnected. Reconnecting...'))
      }
    })
  }

  async deleteManager(managerId: string): Promise<{ managerId: string }> {
    const trimmed = managerId.trim()
    if (!trimmed) {
      throw new Error('Manager id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('delete_manager')

    return new Promise<{ managerId: string }>((resolve, reject) => {
      this.trackPendingRequest(this.pendingDeleteManagerRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'delete_manager',
        managerId: trimmed,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(this.pendingDeleteManagerRequests, requestId, new Error('WebSocket is disconnected. Reconnecting...'))
      }
    })
  }

  async listDirectories(path?: string): Promise<DirectoriesListedResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('list_directories')

    return new Promise<DirectoriesListedResult>((resolve, reject) => {
      this.trackPendingRequest(this.pendingListDirectoriesRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'list_directories',
        path: path?.trim() || undefined,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(this.pendingListDirectoriesRequests, requestId, new Error('WebSocket is disconnected. Reconnecting...'))
      }
    })
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    const trimmed = path.trim()
    if (!trimmed) {
      throw new Error('Directory path is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('validate_directory')

    return new Promise<DirectoryValidationResult>((resolve, reject) => {
      this.trackPendingRequest(this.pendingValidateDirectoryRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'validate_directory',
        path: trimmed,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(
          this.pendingValidateDirectoryRequests,
          requestId,
          new Error('WebSocket is disconnected. Reconnecting...'),
        )
      }
    })
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('pick_directory')

    return new Promise<string | null>((resolve, reject) => {
      this.trackPendingRequest(this.pendingPickDirectoryRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'pick_directory',
        defaultPath: defaultPath?.trim() || undefined,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(
          this.pendingPickDirectoryRequests,
          requestId,
          new Error('WebSocket is disconnected. Reconnecting...'),
        )
      }
    })
  }

  private connect(): void {
    if (this.destroyed) return

    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.addEventListener('open', () => {
      this.updateState({
        connected: true,
        lastError: null,
      })

      this.send({
        type: 'subscribe',
        agentId: this.desiredAgentId,
      })
    })

    socket.addEventListener('message', (event) => {
      this.handleServerEvent(event.data)
    })

    socket.addEventListener('close', () => {
      this.updateState({
        connected: false,
        subscribedAgentId: null,
      })

      this.rejectAllPendingRequests('WebSocket disconnected before request completed.')
      this.scheduleConnect(RECONNECT_MS)
    })

    socket.addEventListener('error', () => {
      this.updateState({
        connected: false,
        lastError: 'WebSocket connection error',
      })
    })
  }

  private scheduleConnect(delayMs: number): void {
    if (this.destroyed || !this.started || this.connectTimer) {
      return
    }

    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined
      if (!this.destroyed && this.started) {
        this.connect()
      }
    }, delayMs)
  }

  private handleServerEvent(raw: unknown): void {
    let event: ServerEvent
    try {
      event = JSON.parse(String(raw)) as ServerEvent
    } catch {
      this.pushSystemMessage('Received invalid JSON event from backend.')
      return
    }

    switch (event.type) {
      case 'ready':
        this.updateState({
          connected: true,
          targetAgentId: event.subscribedAgentId,
          subscribedAgentId: event.subscribedAgentId,
          lastError: null,
        })
        break

      case 'conversation_message':
      case 'conversation_log': {
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        const messages = [...this.state.messages, event].slice(-500)
        this.updateState({ messages })
        break
      }

      case 'conversation_history':
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        this.updateState({ messages: event.messages.slice(-500) })
        break

      case 'conversation_reset':
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        this.updateState({
          messages: [],
          lastError: null,
        })
        break

      case 'agent_status': {
        const statuses = {
          ...this.state.statuses,
          [event.agentId]: {
            status: event.status,
            pendingCount: event.pendingCount,
          },
        }
        this.updateState({ statuses })
        break
      }

      case 'agents_snapshot':
        this.applyAgentsSnapshot(event.agents)
        break

      case 'manager_created': {
        this.applyManagerCreated(event.manager)
        this.resolvePendingRequest(
          this.pendingCreateManagerRequests,
          event.requestId,
          event.manager,
        )
        break
      }

      case 'manager_deleted': {
        this.applyManagerDeleted(event.managerId)
        this.resolvePendingRequest(
          this.pendingDeleteManagerRequests,
          event.requestId,
          { managerId: event.managerId },
        )
        break
      }

      case 'directories_listed': {
        this.resolvePendingRequest(
          this.pendingListDirectoriesRequests,
          event.requestId,
          {
            path: event.path,
            directories: event.directories,
          },
        )
        break
      }

      case 'directory_validated': {
        this.resolvePendingRequest(
          this.pendingValidateDirectoryRequests,
          event.requestId,
          {
            path: event.path,
            valid: event.valid,
            message: event.message ?? null,
          },
        )
        break
      }

      case 'directory_picked': {
        this.resolvePendingRequest(
          this.pendingPickDirectoryRequests,
          event.requestId,
          event.path ?? null,
        )
        break
      }

      case 'error':
        this.updateState({ lastError: event.message })
        this.pushSystemMessage(`${event.code}: ${event.message}`)
        this.rejectPendingFromError(event.code, event.message, event.requestId)
        break
    }
  }

  private applyAgentsSnapshot(agents: AgentDescriptor[]): void {
    const liveAgentIds = new Set(agents.map((agent) => agent.agentId))
    const statuses = Object.fromEntries(
      Object.entries(this.state.statuses).filter(([agentId]) => liveAgentIds.has(agentId)),
    )

    const fallbackTarget = chooseFallbackAgentId(
      agents,
      this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId,
    )
    const targetChanged = fallbackTarget !== this.state.targetAgentId
    const nextSubscribedAgentId =
      this.state.subscribedAgentId && liveAgentIds.has(this.state.subscribedAgentId)
        ? this.state.subscribedAgentId
        : fallbackTarget ?? null

    const patch: Partial<ManagerWsState> = {
      agents,
      statuses,
    }

    if (targetChanged) {
      patch.targetAgentId = fallbackTarget
      patch.messages = []
    }

    if (nextSubscribedAgentId !== this.state.subscribedAgentId) {
      patch.subscribedAgentId = nextSubscribedAgentId
    }

    if (fallbackTarget) {
      this.desiredAgentId = fallbackTarget
    }

    this.updateState(patch)

    if (targetChanged && fallbackTarget && this.socket?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'subscribe',
        agentId: fallbackTarget,
      })
    }
  }

  private applyManagerCreated(manager: AgentDescriptor): void {
    const nextAgents = [
      ...this.state.agents.filter((agent) => agent.agentId !== manager.agentId),
      manager,
    ]
    this.applyAgentsSnapshot(nextAgents)
  }

  private applyManagerDeleted(managerId: string): void {
    const nextAgents = this.state.agents.filter(
      (agent) => agent.agentId !== managerId && agent.managerId !== managerId,
    )
    this.applyAgentsSnapshot(nextAgents)
  }

  private pushSystemMessage(text: string): void {
    const message: ConversationMessageEvent = {
      type: 'conversation_message',
      agentId: (this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId) || 'system',
      role: 'system',
      text,
      timestamp: new Date().toISOString(),
      source: 'system',
    }

    const messages = [...this.state.messages, message].slice(-500)
    this.updateState({ messages })
  }

  private send(command: ClientCommand): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(command))
    return true
  }

  private updateState(patch: Partial<ManagerWsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1
    return `${prefix}-${Date.now()}-${this.requestCounter}`
  }

  private trackPendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string,
    resolve: (value: T) => void,
    reject: (error: Error) => void,
  ): void {
    const timeout = setTimeout(() => {
      this.rejectPendingRequest(
        pendingMap,
        requestId,
        new Error('Request timed out waiting for backend response.'),
      )
    }, REQUEST_TIMEOUT_MS)

    pendingMap.set(requestId, {
      resolve,
      reject,
      timeout,
    })
  }

  private resolvePendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string | undefined,
    value: T,
  ): void {
    const resolvedById = requestId ? this.finalizePendingById(pendingMap, requestId, value) : false
    if (resolvedById) return

    this.resolveOldestPendingRequest(pendingMap, value)
  }

  private rejectPendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string,
    error: Error,
  ): void {
    const pending = pendingMap.get(requestId)
    if (!pending) return

    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.reject(error)
  }

  private finalizePendingById<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string,
    value: T,
  ): boolean {
    const pending = pendingMap.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.resolve(value)
    return true
  }

  private resolveOldestPendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    value: T,
  ): boolean {
    const first = pendingMap.entries().next()
    if (first.done) return false

    const [requestId, pending] = first.value
    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.resolve(value)
    return true
  }

  private rejectOldestPendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    error: Error,
  ): boolean {
    const first = pendingMap.entries().next()
    if (first.done) return false

    const [requestId, pending] = first.value
    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.reject(error)
    return true
  }

  private rejectPendingFromError(code: string, message: string, requestId?: string): void {
    const fullError = new Error(`${code}: ${message}`)

    if (requestId) {
      const resolvedById =
        this.rejectPendingByRequestId(this.pendingCreateManagerRequests, requestId, fullError) ||
        this.rejectPendingByRequestId(this.pendingDeleteManagerRequests, requestId, fullError) ||
        this.rejectPendingByRequestId(this.pendingListDirectoriesRequests, requestId, fullError) ||
        this.rejectPendingByRequestId(this.pendingValidateDirectoryRequests, requestId, fullError) ||
        this.rejectPendingByRequestId(this.pendingPickDirectoryRequests, requestId, fullError)

      if (resolvedById) {
        return
      }
    }

    const loweredCode = code.toLowerCase()

    if (loweredCode.includes('create_manager')) {
      if (this.rejectOldestPendingRequest(this.pendingCreateManagerRequests, fullError)) return
    }

    if (loweredCode.includes('delete_manager')) {
      if (this.rejectOldestPendingRequest(this.pendingDeleteManagerRequests, fullError)) return
    }

    if (loweredCode.includes('list_directories')) {
      if (this.rejectOldestPendingRequest(this.pendingListDirectoriesRequests, fullError)) return
    }

    if (loweredCode.includes('validate_directory')) {
      if (this.rejectOldestPendingRequest(this.pendingValidateDirectoryRequests, fullError)) return
    }

    if (loweredCode.includes('pick_directory')) {
      if (this.rejectOldestPendingRequest(this.pendingPickDirectoryRequests, fullError)) return
    }

    const totalPending =
      this.pendingCreateManagerRequests.size +
      this.pendingDeleteManagerRequests.size +
      this.pendingListDirectoriesRequests.size +
      this.pendingValidateDirectoryRequests.size +
      this.pendingPickDirectoryRequests.size

    if (totalPending !== 1) {
      return
    }

    this.rejectOldestPendingRequest(this.pendingCreateManagerRequests, fullError)
    this.rejectOldestPendingRequest(this.pendingDeleteManagerRequests, fullError)
    this.rejectOldestPendingRequest(this.pendingListDirectoriesRequests, fullError)
    this.rejectOldestPendingRequest(this.pendingValidateDirectoryRequests, fullError)
    this.rejectOldestPendingRequest(this.pendingPickDirectoryRequests, fullError)
  }

  private rejectPendingByRequestId<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string,
    error: Error,
  ): boolean {
    const pending = pendingMap.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.reject(error)
    return true
  }

  private rejectAllPendingRequests(reason: string): void {
    const error = new Error(reason)

    this.rejectPendingMap(this.pendingCreateManagerRequests, error)
    this.rejectPendingMap(this.pendingDeleteManagerRequests, error)
    this.rejectPendingMap(this.pendingListDirectoriesRequests, error)
    this.rejectPendingMap(this.pendingValidateDirectoryRequests, error)
    this.rejectPendingMap(this.pendingPickDirectoryRequests, error)
  }

  private rejectPendingMap<T>(pendingMap: Map<string, PendingRequest<T>>, error: Error): void {
    for (const [requestId, pending] of [...pendingMap.entries()]) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      pendingMap.delete(requestId)
    }
  }
}
