import type { AgentDescriptor, AgentStatus, ClientCommand, ServerEvent } from './ws-types'

const INITIAL_CONNECT_DELAY_MS = 50
const RECONNECT_MS = 1200

export interface ManagerWsState {
  connected: boolean
  subscribedAgentId: string | null
  messages: Array<Extract<ServerEvent, { type: 'conversation_message' }>>
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number }>
  lastError: string | null
}

type Listener = (state: ManagerWsState) => void

const initialState: ManagerWsState = {
  connected: false,
  subscribedAgentId: null,
  messages: [],
  agents: [],
  statuses: {},
  lastError: null,
}

export class ManagerWsClient {
  private readonly url: string
  private readonly targetAgentId: string

  private socket: WebSocket | null = null
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private destroyed = false

  private state: ManagerWsState = { ...initialState }
  private readonly listeners = new Set<Listener>()

  constructor(url: string, targetAgentId = 'manager') {
    this.url = url
    this.targetAgentId = targetAgentId
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

  sendUserMessage(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: 'WebSocket is disconnected. Reconnecting...'
      })
      return
    }

    this.send({
      type: 'user_message',
      text: trimmed
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
        agentId: this.targetAgentId,
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
          subscribedAgentId: event.subscribedAgentId,
          lastError: null,
        })
        break

      case 'conversation_message': {
        const messages = [...this.state.messages, event].slice(-500)
        this.updateState({ messages })
        break
      }

      case 'conversation_history':
        this.updateState({ messages: mergeConversationMessages(event.messages, this.state.messages).slice(-500) })
        break

      case 'conversation_reset':
        this.updateState({
          messages: [],
          agents: [],
          statuses: {},
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
    const message: Extract<ServerEvent, { type: 'conversation_message' }> = {
      type: 'conversation_message',
      agentId: 'manager',
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

function mergeConversationMessages(
  fromHistory: Array<Extract<ServerEvent, { type: 'conversation_message' }>>,
  existing: Array<Extract<ServerEvent, { type: 'conversation_message' }>>,
): Array<Extract<ServerEvent, { type: 'conversation_message' }>> {
  const merged: Array<Extract<ServerEvent, { type: 'conversation_message' }>> = []
  const seen = new Set<string>()

  const add = (message: Extract<ServerEvent, { type: 'conversation_message' }>) => {
    const key = `${message.timestamp}|${message.agentId}|${message.role}|${message.source}|${message.text}`
    if (seen.has(key)) return
    seen.add(key)
    merged.push(message)
  }

  for (const message of fromHistory) add(message)
  for (const message of existing) add(message)

  merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return merged
}
