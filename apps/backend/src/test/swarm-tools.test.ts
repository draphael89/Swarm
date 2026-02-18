import { describe, expect, it } from 'vitest'
import { buildSwarmTools, type SwarmToolHost } from '../swarm/swarm-tools.js'
import type { AgentDescriptor, SendMessageReceipt, SpawnAgentInput } from '../swarm/types.js'

function makeManagerDescriptor(): AgentDescriptor {
  return {
    agentId: 'manager',
    displayName: 'manager',
    role: 'manager',
    managerId: 'manager',
    archetypeId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/swarm',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    },
    sessionFile: '/tmp/swarm/manager.jsonl',
  }
}

function makeWorkerDescriptor(agentId: string): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/swarm',
    model: {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    },
    sessionFile: `/tmp/swarm/${agentId}.jsonl`,
  }
}

function makeHost(spawnImpl: (callerAgentId: string, input: SpawnAgentInput) => Promise<AgentDescriptor>): SwarmToolHost {
  return {
    listAgents(): AgentDescriptor[] {
      return [makeManagerDescriptor()]
    },
    spawnAgent: spawnImpl,
    async killAgent(): Promise<void> {},
    async sendMessage(): Promise<SendMessageReceipt> {
      return {
        targetAgentId: 'worker',
        deliveryId: 'delivery-1',
        acceptedMode: 'prompt',
      }
    },
    async publishToUser(): Promise<void> {},
  }
}

describe('buildSwarmTools', () => {
  it('propagates spawn_agent model preset to host.spawnAgent', async () => {
    let receivedInput: SpawnAgentInput | undefined

    const host = makeHost(async (_callerAgentId, input) => {
      receivedInput = input
      return makeWorkerDescriptor('worker-opus')
    })

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    const result = await spawnTool!.execute(
      'tool-call',
      {
        agentId: 'Worker Opus',
        model: 'opus-4.6',
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(receivedInput?.model).toBe('opus-4.6')
    expect(result.details).toMatchObject({
      agentId: 'worker-opus',
      model: {
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'xhigh',
      },
    })
  })

  it('rejects invalid spawn_agent model presets with a clear error', async () => {
    const host = makeHost(async () => makeWorkerDescriptor('worker'))

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    await expect(
      spawnTool!.execute(
        'tool-call',
        {
          agentId: 'Worker Invalid',
          model: 'not-allowed-model',
        } as any,
        undefined,
        undefined,
        undefined as any,
      ),
    ).rejects.toThrow('spawn_agent.model must be one of codex-5.3|opus-4.6')
  })
})
