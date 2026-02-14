import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { MANAGER_SYSTEM_PROMPT } from '../swarm/prompts/manager-system-prompt.js'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type { AgentDescriptor, RequestedDeliveryMode, SendMessageReceipt, SwarmConfig } from '../swarm/types.js'
import type { AgentRuntime } from '../swarm/agent-runtime.js'

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager
  terminateCalls: Array<{ abort?: boolean } | undefined> = []
  sendCalls: Array<{ message: string; delivery: RequestedDeliveryMode }> = []
  nextDeliveryId = 0
  busy = false

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getPendingCount(): number {
    return this.busy ? 1 : 0
  }

  async sendMessage(message: string, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery })
    this.nextDeliveryId += 1
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as any)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: `delivery-${this.nextDeliveryId}`,
      acceptedMode: this.busy ? 'steer' : 'prompt',
    }
  }

  async terminate(options?: { abort?: boolean }): Promise<void> {
    this.terminateCalls.push(options)
  }

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
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()
  readonly createdRuntimeIds: string[] = []
  readonly systemPromptByAgentId = new Map<string, string>()

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
  ): Promise<AgentRuntime> {
    const runtime = new FakeRuntime(descriptor)
    this.createdRuntimeIds.push(descriptor.agentId)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
    return runtime as unknown as AgentRuntime
  }
}

async function makeTempConfig(port = 8790): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), 'swarm-manager-test-'))
  const dataDir = join(root, 'data')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const authDir = join(dataDir, 'auth')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')

  await mkdir(swarmDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(authDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(managerAgentDir, { recursive: true })

  return {
    host: '127.0.0.1',
    port,
    debug: false,
    allowNonManagerSubscriptions: false,
    managerId: 'manager',
    managerDisplayName: 'Manager',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    defaultCwd: root,
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      sessionsDir,
      authDir,
      authFile: join(authDir, 'auth.json'),
      agentDir,
      managerAgentDir,
      managerSystemPromptFile: join(managerAgentDir, 'SYSTEM.md'),
      managerAppendSystemPromptFile: join(managerAgentDir, 'APPEND_SYSTEM.md'),
      agentsStoreFile: join(swarmDir, 'agents.json'),
    },
  }
}

describe('SwarmManager', () => {
  it('boots with exactly one running manager runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    const agents = manager.listAgents()
    expect(agents).toHaveLength(1)
    expect(agents[0].agentId).toBe('manager')
    expect(agents[0].role).toBe('manager')
    expect(manager.createdRuntimeIds).toEqual(['manager'])
  })

  it('creates manager SYSTEM.md when missing', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    const systemPromptOnDisk = await readFile(config.paths.managerSystemPromptFile, 'utf8')
    expect(systemPromptOnDisk).toContain('Operating stance (delegation-first):')
    expect(systemPromptOnDisk).toContain('User-facing output MUST go through speak_to_user.')
  })

  it('uses manager and default worker prompts with explicit visibility guidance', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const managerPrompt = manager.systemPromptByAgentId.get('manager')
    expect(managerPrompt).toBe(MANAGER_SYSTEM_PROMPT)
    expect(managerPrompt).toContain('End users only see two things')
    expect(managerPrompt).toContain('prefixed with "SYSTEM:"')

    const worker = await manager.spawnAgent('manager', { name: 'Prompt Worker' })
    const workerPrompt = manager.systemPromptByAgentId.get(worker.agentId)

    expect(workerPrompt).toBeDefined()
    expect(workerPrompt).toContain('End users only see messages they send and manager speak_to_user outputs.')
    expect(workerPrompt).toContain('Incoming messages prefixed with "SYSTEM:"')
  })

  it('spawns unique semantic agent ids on collisions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const first = await manager.spawnAgent('manager', { name: 'Code Scout' })
    const second = await manager.spawnAgent('manager', { name: 'Code Scout' })

    expect(first.agentId).toBe('code-scout')
    expect(second.agentId).toBe('code-scout-2')
  })

  it('SYSTEM-prefixes worker initial messages (internal manager->worker input)', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const worker = await manager.spawnAgent('manager', {
      name: 'Kickoff Worker',
      initialMessage: 'start implementation',
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: start implementation')
  })

  it('enforces manager-only spawn and kill permissions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const worker = await manager.spawnAgent('manager', { name: 'Worker' })

    await expect(manager.spawnAgent(worker.agentId, { name: 'Nope' })).rejects.toThrow('Only manager can spawn agents')
    await expect(manager.killAgent(worker.agentId, worker.agentId)).rejects.toThrow('Only manager can kill agents')
  })

  it('returns fire-and-forget receipt and prefixes internal inter-agent deliveries', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const worker = await manager.spawnAgent('manager', { name: 'Messenger' })

    const receipt = await manager.sendMessage('manager', worker.agentId, 'hi worker', 'auto')

    expect(receipt.targetAgentId).toBe(worker.agentId)
    expect(receipt.deliveryId).toBe('delivery-1')
    expect(receipt.acceptedMode).toBe('prompt')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: hi worker')
  })

  it('sends manager user input as steer delivery without SYSTEM prefixing', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    await manager.handleUserMessage('interrupt current plan')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.delivery).toBe('steer')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('interrupt current plan')
  })

  it('does not SYSTEM-prefix direct user messages routed to a worker', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const worker = await manager.spawnAgent('manager', { name: 'User Routed Worker' })

    await manager.handleUserMessage('hello worker', { targetAgentId: worker.agentId })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('hello worker')
  })

  it('does not double-prefix internal messages that already start with SYSTEM:', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const worker = await manager.spawnAgent('manager', { name: 'Already Tagged Worker' })

    await manager.sendMessage('manager', worker.agentId, 'SYSTEM: pre-tagged', 'auto')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: pre-tagged')
  })

  it('accepts busy-runtime messages as steer regardless of requested delivery', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const worker = await manager.spawnAgent('manager', { name: 'Busy Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()
    runtime!.busy = true

    const autoReceipt = await manager.sendMessage('manager', worker.agentId, 'queued auto', 'auto')
    const followUpReceipt = await manager.sendMessage('manager', worker.agentId, 'queued followup', 'followUp')
    const steerReceipt = await manager.sendMessage('manager', worker.agentId, 'queued steer', 'steer')

    expect(autoReceipt.acceptedMode).toBe('steer')
    expect(followUpReceipt.acceptedMode).toBe('steer')
    expect(steerReceipt.acceptedMode).toBe('steer')
  })

  it('kills a busy runtime with abort then marks descriptor terminated', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const worker = await manager.spawnAgent('manager', { name: 'Killable Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()

    await manager.killAgent('manager', worker.agentId)

    expect(runtime!.terminateCalls).toEqual([{ abort: true }])
    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')
  })

  it('marks workers as stopped_on_restart and restores only manager runtime', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-a',
          displayName: 'Worker A',
          role: 'worker',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-a.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const agents = manager.listAgents()
    const worker = agents.find((agent) => agent.agentId === 'worker-a')

    expect(worker?.status).toBe('stopped_on_restart')
    expect(manager.createdRuntimeIds).toEqual(['manager'])
  })

  it('persists manager conversation history to disk and reloads it on restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await firstBoot.boot()

    await firstBoot.handleUserMessage('persist this')
    await firstBoot.publishToUser('manager', 'saved reply', 'speak_to_user')

    const secondBoot = new TestSwarmManager(config)
    await secondBoot.boot()

    const history = secondBoot.getConversationHistory('manager')
    expect(history.some((message) => message.text === 'persist this' && message.source === 'user_input')).toBe(true)
    expect(history.some((message) => message.text === 'saved reply' && message.source === 'speak_to_user')).toBe(true)
  })

  it('resetManagerSession recreates manager runtime and clears manager history', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    await manager.handleUserMessage('before reset')
    expect(manager.getConversationHistory('manager').some((message) => message.text === 'before reset')).toBe(true)

    const firstRuntime = manager.runtimeByAgentId.get('manager')
    expect(firstRuntime).toBeDefined()

    await manager.resetManagerSession('api_reset')

    expect(firstRuntime!.terminateCalls).toEqual([{ abort: true }])
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(2)
    expect(manager.getConversationHistory('manager')).toHaveLength(0)

    const rebooted = new TestSwarmManager(config)
    await rebooted.boot()
    expect(rebooted.getConversationHistory('manager')).toHaveLength(0)
  })
})
