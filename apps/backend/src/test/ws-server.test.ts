import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type { AgentDescriptor, RequestedDeliveryMode, SendMessageReceipt, SwarmConfig } from '../swarm/types.js'
import type { AgentRuntime } from '../swarm/agent-runtime.js'
import { SwarmWebSocketServer } from '../ws/server.js'
import type { ServerEvent } from '../protocol/ws-types.js'

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getPendingCount(): number {
    return 0
  }

  async sendMessage(_message: string, _delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as any)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: 'fake-delivery',
      acceptedMode: 'prompt',
    }
  }

  async terminate(): Promise<void> {}

  getCustomEntries(customType: string): unknown[] {
    const entries = this.sessionManager.getEntries()
    return entries
      .filter((entry) => entry.type === 'custom' && entry.customType === customType)
      .map((entry) => (entry.type === 'custom' ? entry.data : undefined))
      .filter((entry) => entry !== undefined)
  }

  appendCustomEntry(customType: string, data?: unknown): void {
    this.sessionManager.appendCustomEntry(customType, data)
  }
}

class TestSwarmManager extends SwarmManager {
  pickedDirectoryPath: string | null = null
  lastPickedDirectoryDefaultPath: string | undefined

  protected override async createRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<AgentRuntime> {
    return new FakeRuntime(descriptor) as unknown as AgentRuntime
  }

  override async pickDirectory(defaultPath?: string): Promise<string | null> {
    this.lastPickedDirectoryDefaultPath = defaultPath
    return this.pickedDirectoryPath
  }
}

async function getAvailablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Unable to allocate port')
  }

  const port = address.port
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })

  return port
}

async function makeTempConfig(port: number, allowNonManagerSubscriptions = false): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), 'swarm-ws-test-'))
  const dataDir = join(root, 'data')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const authDir = join(dataDir, 'auth')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')
  const repoArchetypesDir = join(root, '.swarm', 'archetypes')
  const memoryFile = join(dataDir, 'MEMORY.md')
  const repoMemorySkillFile = join(root, '.swarm', 'skills', 'memory', 'SKILL.md')

  await mkdir(swarmDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(authDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(managerAgentDir, { recursive: true })
  await mkdir(repoArchetypesDir, { recursive: true })

  return {
    host: '127.0.0.1',
    port,
    debug: false,
    allowNonManagerSubscriptions,
    managerId: 'manager',
    managerDisplayName: 'Manager',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, 'worktrees')],
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      sessionsDir,
      authDir,
      authFile: join(authDir, 'auth.json'),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      agentsStoreFile: join(swarmDir, 'agents.json'),
    },
  }
}

async function waitForEvent(
  events: ServerEvent[],
  predicate: (event: ServerEvent) => boolean,
  timeoutMs = 2000,
): Promise<ServerEvent> {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate)
    if (found) return found

    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for websocket event')
}

describe('SwarmWebSocketServer', () => {
  it('connect + subscribe + user_message yields manager feed events', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))

    await waitForEvent(events, (event) => event.type === 'ready')
    await waitForEvent(events, (event) => event.type === 'agents_snapshot')
    await waitForEvent(events, (event) => event.type === 'conversation_history')

    client.send(JSON.stringify({ type: 'user_message', text: 'hello manager' }))

    const userEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'hello manager',
    )

    expect(userEvent.type).toBe('conversation_message')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('accepts POST /api/reboot and signals the daemon pid asynchronously', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const daemonPid = 54321
    const repoHash = createHash('sha1').update(config.paths.rootDir).digest('hex').slice(0, 10)
    const pidFile = join(tmpdir(), `swarm-prod-daemon-${repoHash}.pid`)
    await writeFile(pidFile, `${daemonPid}\n`, 'utf8')

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
      })

      expect(response.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(killSpy).toHaveBeenCalledWith(daemonPid, 0)
      expect(killSpy).toHaveBeenCalledWith(daemonPid, 'SIGUSR1')
    } finally {
      killSpy.mockRestore()
      await rm(pidFile, { force: true })
      await server.stop()
    }
  })

  it('accepts attachment-only user messages and broadcasts attachments', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '',
        attachments: [
          {
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            fileName: 'diagram.png',
          },
        ],
      }),
    )

    const userEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_message' && event.source === 'user_input',
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.text).toBe('')
      expect(userEvent.attachments).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
        },
      ])
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('replays manager conversation history on reconnect', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsA: ServerEvent[] = []
    clientA.on('message', (raw) => {
      eventsA.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientA, 'open')
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(eventsA, (event) => event.type === 'conversation_history')

    clientA.send(JSON.stringify({ type: 'user_message', text: 'remember this' }))
    await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'remember this',
    )

    clientA.close()
    await once(clientA, 'close')

    const clientB = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsB: ServerEvent[] = []
    clientB.on('message', (raw) => {
      eventsB.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientB, 'open')
    clientB.send(JSON.stringify({ type: 'subscribe' }))

    const historyEvent = await waitForEvent(eventsB, (event) => event.type === 'conversation_history')
    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages.some((message) => message.text === 'remember this')).toBe(true)
    }

    clientB.close()
    await once(clientB, 'close')
    await server.stop()
  })

  it('handles /new via websocket by resetting manager session and clearing history', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsA: ServerEvent[] = []
    clientA.on('message', (raw) => {
      eventsA.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientA, 'open')
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(eventsA, (event) => event.type === 'conversation_history')

    clientA.send(JSON.stringify({ type: 'user_message', text: 'keep this' }))
    await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'keep this',
    )

    clientA.send(JSON.stringify({ type: 'user_message', text: '/new' }))
    const resetEvent = await waitForEvent(eventsA, (event) => event.type === 'conversation_reset')
    expect(resetEvent.type).toBe('conversation_reset')
    if (resetEvent.type === 'conversation_reset') {
      expect(resetEvent.reason).toBe('user_new_command')
      expect(resetEvent.agentId).toBe('manager')
    }

    expect(
      eventsA.some(
        (event) => event.type === 'conversation_message' && event.source === 'user_input' && event.text === '/new',
      ),
    ).toBe(false)

    clientA.close()
    await once(clientA, 'close')

    const clientB = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsB: ServerEvent[] = []
    clientB.on('message', (raw) => {
      eventsB.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientB, 'open')
    clientB.send(JSON.stringify({ type: 'subscribe' }))
    const historyEvent = await waitForEvent(eventsB, (event) => event.type === 'conversation_history')

    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages).toHaveLength(0)
    }

    clientB.close()
    await once(clientB, 'close')
    await server.stop()
  })

  it('supports worker subscriptions and direct user messaging to the selected worker', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker Thread' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: worker.agentId }))

    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === worker.agentId,
    )
    await waitForEvent(
      events,
      (event) => event.type === 'conversation_history' && event.agentId === worker.agentId,
    )

    client.send(JSON.stringify({ type: 'user_message', text: 'hello worker' }))

    const workerEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.agentId === worker.agentId &&
        event.source === 'user_input' &&
        event.text === 'hello worker',
    )

    expect(workerEvent.type).toBe('conversation_message')

    ;(manager as any).emitConversationLog({
      type: 'conversation_log',
      agentId: worker.agentId,
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'call-1',
      text: '{"command":"ls"}',
    })

    const logEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_log' &&
        event.agentId === worker.agentId &&
        event.kind === 'tool_execution_start' &&
        event.toolName === 'bash',
    )

    expect(logEvent.type).toBe('conversation_log')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('kills a worker via kill_agent command and emits updated status + snapshot events', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const worker = await manager.spawnAgent('manager', { agentId: 'Disposable Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))

    await waitForEvent(events, (event) => event.type === 'ready')
    await waitForEvent(events, (event) => event.type === 'agents_snapshot')

    client.send(JSON.stringify({ type: 'kill_agent', agentId: worker.agentId }))

    const statusEvent = await waitForEvent(
      events,
      (event) => event.type === 'agent_status' && event.agentId === worker.agentId && event.status === 'terminated',
    )
    expect(statusEvent.type).toBe('agent_status')

    const snapshotEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.agentId === worker.agentId && agent.status === 'terminated'),
    )
    expect(snapshotEvent.type).toBe('agents_snapshot')

    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates managers over websocket with model presets and broadcasts manager_created', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Review Manager',
        cwd: config.defaultCwd,
        model: 'opus-4.6',
      }),
    )

    const createdEvent = await waitForEvent(events, (event) => event.type === 'manager_created')
    expect(createdEvent.type).toBe('manager_created')
    if (createdEvent.type === 'manager_created') {
      expect(createdEvent.manager.role).toBe('manager')
      expect(createdEvent.manager.managerId).toBe(createdEvent.manager.agentId)
      expect(createdEvent.manager.model).toEqual({
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'xhigh',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects invalid create_manager model presets at websocket protocol validation time', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Invalid Manager',
        cwd: config.defaultCwd,
        model: 'gpt-4o',
      }),
    )

    const errorEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'error' &&
        event.code === 'INVALID_COMMAND' &&
        event.message.includes('create_manager.model must be one of codex-5.3|opus-4.6'),
    )

    expect(errorEvent.type).toBe('error')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('deletes managers over websocket and emits manager_deleted', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const secondary = await manager.createManager('manager', {
      name: 'Delete Me Manager',
      cwd: config.defaultCwd,
    })
    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Delete Me Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'delete_manager', managerId: secondary.agentId }))

    const deletedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_deleted' && event.managerId === secondary.agentId,
    )
    expect(deletedEvent.type).toBe('manager_deleted')
    if (deletedEvent.type === 'manager_deleted') {
      expect(deletedEvent.terminatedWorkerIds).toContain(ownedWorker.agentId)
    }

    expect(manager.listAgents().some((agent) => agent.agentId === secondary.agentId)).toBe(false)
    expect(manager.listAgents().some((agent) => agent.agentId === ownedWorker.agentId)).toBe(false)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports deleting the selected last manager and creating a replacement manager', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'delete_manager', managerId: 'manager' }))

    const deletedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_deleted' && event.managerId === 'manager',
    )
    expect(deletedEvent.type).toBe('manager_deleted')

    const emptySnapshot = await waitForEvent(
      events,
      (event) => event.type === 'agents_snapshot' && event.agents.length === 0,
    )
    expect(emptySnapshot.type).toBe('agents_snapshot')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Recovered Manager',
        cwd: config.defaultCwd,
      }),
    )

    const recreatedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_created' && event.manager.agentId === 'recovered-manager',
    )
    expect(recreatedEvent.type).toBe('manager_created')

    expect(manager.listAgents().some((agent) => agent.agentId === 'recovered-manager')).toBe(true)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('enforces strict ownership for kill_agent based on selected manager context', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const secondary = await manager.createManager('manager', {
      name: 'Owner Manager',
      cwd: config.defaultCwd,
    })
    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Owned Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'kill_agent', agentId: ownedWorker.agentId }))

    const denied = await waitForEvent(
      events,
      (event) => event.type === 'error' && event.code === 'KILL_AGENT_FAILED',
    )
    expect(denied.type).toBe('error')

    client.send(JSON.stringify({ type: 'subscribe', agentId: secondary.agentId }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === secondary.agentId,
    )

    client.send(JSON.stringify({ type: 'kill_agent', agentId: ownedWorker.agentId }))

    const statusEvent = await waitForEvent(
      events,
      (event) => event.type === 'agent_status' && event.agentId === ownedWorker.agentId && event.status === 'terminated',
    )
    expect(statusEvent.type).toBe('agent_status')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('/new resets the currently selected manager session only', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const secondary = await manager.createManager('manager', {
      name: 'Resettable Manager',
      cwd: config.defaultCwd,
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: secondary.agentId }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === secondary.agentId,
    )

    client.send(JSON.stringify({ type: 'user_message', text: '/new' }))

    const resetEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_reset' && event.agentId === secondary.agentId,
    )
    expect(resetEvent.type).toBe('conversation_reset')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports directory picker protocol commands', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const outsideDir = await mkdtemp(join(tmpdir(), 'ws-outside-allowlist-'))
    const rootValidation = await manager.validateDirectory(config.paths.rootDir)
    const expectedRoot = rootValidation.resolvedPath ?? config.paths.rootDir

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'list_directories', path: config.paths.rootDir }))

    const listed = await waitForEvent(events, (event) => event.type === 'directories_listed')
    expect(listed.type).toBe('directories_listed')
    if (listed.type === 'directories_listed') {
      expect(listed.roots).toEqual([])
      expect(listed.resolvedPath).toBe(expectedRoot)
    }

    client.send(JSON.stringify({ type: 'validate_directory', path: outsideDir }))

    const validated = await waitForEvent(
      events,
      (event) => event.type === 'directory_validated' && event.requestedPath === outsideDir,
    )
    expect(validated.type).toBe('directory_validated')
    if (validated.type === 'directory_validated') {
      expect(validated.valid).toBe(true)
      expect(validated.message).toBeUndefined()
      expect(validated.roots).toEqual([])
    }

    manager.pickedDirectoryPath = outsideDir
    client.send(JSON.stringify({ type: 'pick_directory', defaultPath: expectedRoot, requestId: 'pick-1' }))

    const picked = await waitForEvent(
      events,
      (event) => event.type === 'directory_picked' && event.requestId === 'pick-1',
    )
    expect(picked.type).toBe('directory_picked')
    if (picked.type === 'directory_picked') {
      expect(picked.path).toBe(outsideDir)
    }
    expect(manager.lastPickedDirectoryDefaultPath).toBe(expectedRoot)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects non-manager subscription with explicit error', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'worker-1' }))

    const errorEvent = await waitForEvent(events, (event) => event.type === 'error')
    expect(errorEvent.type).toBe('error')
    if (errorEvent.type === 'error') {
      expect(errorEvent.code).toBe('SUBSCRIPTION_NOT_SUPPORTED')
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })
})
