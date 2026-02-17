import type {
  AgentDescriptor,
  AgentStatus,
  ClientCommand,
  ConversationEntry,
  ConversationMessageEvent,
  ServerEvent,
} from './ws-types'

const INITIAL_CONNECT_DELAY_MS = 50
const RECONNECT_MS = 1200

export interface ManagerWsState {
  connected: boolean
  targetAgentId: string | null
  subscribedAgentId: string | null
  messages: ConversationEntry[]
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number }>
  lastError: string | null
}

type Listener = (state: ManagerWsState) => void

const initialState: ManagerWsState = {
  connected: false,
  targetAgentId: 'manager',
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
    options?: { agentId?: string; delivery?: 'auto' | 'followUp' | 'steer' },
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
        this.updateState({ agents: event.agents })
        break

      case 'error':
        this.updateState({ lastError: event.message })
        this.pushSystemMessage(`${event.code}: ${event.message}`)
        break
    }
  }

  private pushSystemMessage(text: string): void {
    const message: ConversationMessageEvent = {
      type: 'conversation_message',
      agentId: this.state.targetAgentId ?? 'manager',
      role: 'system',
      text,
      timestamp: new Date().toISOString(),
      source: 'system',
    }

    const messages = [...this.state.messages, message].slice(-500)
    this.updateState({ messages })
  }

  private send(command: ClientCommand): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(command))
  }

  private updateState(patch: Partial<ManagerWsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }
}
