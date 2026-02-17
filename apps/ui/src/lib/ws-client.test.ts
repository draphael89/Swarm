import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagerWsClient } from './ws-client'

type ListenerMap = Record<string, Array<(event?: any) => void>>

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sentPayloads: string[] = []
  readonly listeners: ListenerMap = {}

  readyState = FakeWebSocket.OPEN

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners[type] ??= []
    this.listeners[type].push(listener)
  }

  send(payload: string): void {
    this.sentPayloads.push(payload)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close')
  }

  emit(type: string, event?: any): void {
    const handlers = this.listeners[type] ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }
}

describe('ManagerWsClient', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalWindow = (globalThis as any).window

  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
    ;(globalThis as any).window = {}
    ;(globalThis as any).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as any).WebSocket = originalWebSocket
    ;(globalThis as any).window = originalWindow
  })

  it('subscribes on connect and sends user_message commands to the active agent', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    const snapshots: ReturnType<typeof client.getState>[] = []
    client.subscribe((state) => {
      snapshots.push(state)
    })

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()

    socket.emit('open')
    expect(socket.sentPayloads).toHaveLength(1)
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({ type: 'subscribe', agentId: 'manager' })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'ready',
        serverTime: new Date().toISOString(),
        subscribedAgentId: 'manager',
      }),
    })

    client.sendUserMessage('hello manager')

    expect(JSON.parse(socket.sentPayloads[1])).toEqual({
      type: 'user_message',
      text: 'hello manager',
      agentId: 'manager',
    })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_message',
        agentId: 'manager',
        role: 'assistant',
        text: 'hello from manager',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      }),
    })

    expect(snapshots.at(-1)?.messages.at(-1)?.text).toBe('hello from manager')

    client.destroy()
  })

  it('can switch subscriptions and route outgoing/incoming messages by selected agent', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')
    const snapshots: ReturnType<typeof client.getState>[] = []

    client.subscribe((state) => {
      snapshots.push(state)
    })

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    socket.emit('message', {
      data: JSON.stringify({
        type: 'ready',
        serverTime: new Date().toISOString(),
        subscribedAgentId: 'manager',
      }),
    })

    client.subscribeToAgent('worker-1')

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'subscribe',
      agentId: 'worker-1',
    })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'ready',
        serverTime: new Date().toISOString(),
        subscribedAgentId: 'worker-1',
      }),
    })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_history',
        agentId: 'worker-1',
        messages: [],
      }),
    })

    client.sendUserMessage('hello worker')

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'user_message',
      text: 'hello worker',
      agentId: 'worker-1',
    })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_message',
        agentId: 'manager',
        role: 'assistant',
        text: 'manager output',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      }),
    })

    expect(snapshots.at(-1)?.messages.some((message) => message.text === 'manager output')).toBe(false)

    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_message',
        agentId: 'worker-1',
        role: 'assistant',
        text: 'worker output',
        timestamp: new Date().toISOString(),
        source: 'system',
      }),
    })

    expect(snapshots.at(-1)?.messages.at(-1)?.text).toBe('worker output')
    expect(snapshots.at(-1)?.targetAgentId).toBe('worker-1')
    expect(snapshots.at(-1)?.subscribedAgentId).toBe('worker-1')

    client.destroy()
  })

  it('stores conversation_log events for the selected agent and ignores other threads', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    socket.emit('message', {
      data: JSON.stringify({
        type: 'ready',
        serverTime: new Date().toISOString(),
        subscribedAgentId: 'worker-1',
      }),
    })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_log',
        agentId: 'manager',
        timestamp: new Date().toISOString(),
        source: 'runtime_log',
        kind: 'tool_execution_start',
        toolName: 'read',
        toolCallId: 'call-1',
        text: '{"path":"README.md"}',
      }),
    })

    expect(client.getState().messages).toHaveLength(0)

    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_log',
        agentId: 'worker-1',
        timestamp: new Date().toISOString(),
        source: 'runtime_log',
        kind: 'tool_execution_end',
        toolName: 'read',
        toolCallId: 'call-1',
        text: '{"ok":true}',
        isError: false,
      }),
    })

    const lastMessage = client.getState().messages.at(-1)
    expect(lastMessage?.type).toBe('conversation_log')
    if (lastMessage?.type === 'conversation_log') {
      expect(lastMessage.kind).toBe('tool_execution_end')
      expect(lastMessage.toolName).toBe('read')
    }

    client.destroy()
  })

  it('sends explicit followUp delivery when requested', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'worker-1')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    socket.emit('message', {
      data: JSON.stringify({
        type: 'ready',
        serverTime: new Date().toISOString(),
        subscribedAgentId: 'worker-1',
      }),
    })

    client.sendUserMessage('queued update', { agentId: 'worker-1', delivery: 'followUp' })

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'user_message',
      text: 'queued update',
      agentId: 'worker-1',
      delivery: 'followUp',
    })

    client.destroy()
  })

  it('sends kill_agent command when deleting a sub-agent', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    socket.emit('message', {
      data: JSON.stringify({
        type: 'ready',
        serverTime: new Date().toISOString(),
        subscribedAgentId: 'manager',
      }),
    })

    client.deleteAgent('worker-2')

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '')).toEqual({
      type: 'kill_agent',
      agentId: 'worker-2',
    })

    client.destroy()
  })

  it('clears only the current thread messages on conversation_reset', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:47187', 'manager')
    const snapshots: ReturnType<typeof client.getState>[] = []

    client.subscribe((state) => {
      snapshots.push(state)
    })

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')

    socket.emit('message', {
      data: JSON.stringify({
        type: 'ready',
        serverTime: new Date().toISOString(),
        subscribedAgentId: 'manager',
      }),
    })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'agents_snapshot',
        agents: [
          {
            agentId: 'manager',
            displayName: 'Manager',
            role: 'manager',
            status: 'idle',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            cwd: '/tmp',
            model: {
              provider: 'openai-codex',
              modelId: 'gpt-5.3-codex',
              thinkingLevel: 'xhigh',
            },
            sessionFile: '/tmp/manager.jsonl',
          },
        ],
      }),
    })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'agent_status',
        agentId: 'manager',
        status: 'streaming',
        pendingCount: 2,
      }),
    })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_message',
        agentId: 'manager',
        role: 'assistant',
        text: 'working...',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      }),
    })

    socket.emit('message', {
      data: JSON.stringify({
        type: 'error',
        code: 'TEST_ERROR',
        message: 'transient error',
      }),
    })

    const beforeReset = snapshots.at(-1)
    expect(beforeReset?.messages.length).toBeGreaterThan(0)
    expect(beforeReset?.agents.length).toBeGreaterThan(0)
    expect(Object.keys(beforeReset?.statuses ?? {})).toContain('manager')
    expect(beforeReset?.lastError).toBe('transient error')

    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation_reset',
        agentId: 'manager',
        timestamp: new Date().toISOString(),
        reason: 'user_new_command',
      }),
    })

    const afterReset = snapshots.at(-1)
    expect(afterReset?.connected).toBe(true)
    expect(afterReset?.subscribedAgentId).toBe('manager')
    expect(afterReset?.messages).toHaveLength(0)
    expect(afterReset?.agents).toHaveLength(1)
    expect(Object.keys(afterReset?.statuses ?? {})).toContain('manager')
    expect(afterReset?.lastError).toBeNull()

    client.destroy()
  })
})
