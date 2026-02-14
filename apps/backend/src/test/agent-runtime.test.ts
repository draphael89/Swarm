import { describe, expect, it } from 'vitest'
import { AgentRuntime } from '../swarm/agent-runtime.js'
import type { AgentDescriptor } from '../swarm/types.js'

class FakeSession {
  isStreaming = false
  promptCalls: string[] = []
  followUpCalls: string[] = []
  steerCalls: string[] = []
  abortCalls = 0
  disposeCalls = 0
  listener: ((event: any) => void) | undefined

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message)
  }

  async followUp(message: string): Promise<void> {
    this.followUpCalls.push(message)
  }

  async steer(message: string): Promise<void> {
    this.steerCalls.push(message)
  }

  async abort(): Promise<void> {
    this.abortCalls += 1
  }

  dispose(): void {
    this.disposeCalls += 1
  }

  subscribe(listener: (event: any) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  emit(event: any): void {
    this.listener?.(event)
  }
}

function makeDescriptor(): AgentDescriptor {
  return {
    agentId: 'worker',
    displayName: 'Worker',
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: '/tmp/project/worker.jsonl',
  }
}

describe('AgentRuntime', () => {
  it('queues followUp by default when busy and steer when requested', async () => {
    const session = new FakeSession()

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    session.isStreaming = true

    const followUpReceipt = await runtime.sendMessage('auto message')
    const steerReceipt = await runtime.sendMessage('steer message', 'steer')

    expect(followUpReceipt.acceptedMode).toBe('followUp')
    expect(steerReceipt.acceptedMode).toBe('steer')
    expect(session.followUpCalls).toEqual(['auto message'])
    expect(session.steerCalls).toEqual(['steer message'])
  })

  it('consumes pending queue when queued user message starts', async () => {
    const session = new FakeSession()
    const statuses: number[] = []

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: (_agentId, _status, pendingCount) => {
          statuses.push(pendingCount)
        },
      },
    })

    session.isStreaming = true
    await runtime.sendMessage('queued one', 'auto')
    expect(runtime.getPendingCount()).toBe(1)

    session.emit({
      type: 'message_start',
      message: {
        role: 'user',
        content: 'queued one',
      },
    })

    expect(runtime.getPendingCount()).toBe(0)
    expect(statuses.at(-1)).toBe(0)
  })

  it('terminates by aborting active session and marking status terminated', async () => {
    const session = new FakeSession()

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await runtime.terminate({ abort: true })

    expect(session.abortCalls).toBe(1)
    expect(session.disposeCalls).toBe(1)
    expect(runtime.getStatus()).toBe('terminated')
  })
})
