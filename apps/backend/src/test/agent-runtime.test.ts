import { describe, expect, it } from 'vitest'
import { AgentRuntime } from '../swarm/agent-runtime.js'
import type { AgentDescriptor } from '../swarm/types.js'

class FakeSession {
  isStreaming = false
  promptCalls: string[] = []
  promptImageCounts: number[] = []
  followUpCalls: string[] = []
  steerCalls: string[] = []
  steerImageCounts: number[] = []
  userMessageCalls: Array<string | Array<{ type: string }>> = []
  abortCalls = 0
  disposeCalls = 0
  listener: ((event: any) => void) | undefined

  async prompt(message: string, options?: { images?: Array<{ type: string }> }): Promise<void> {
    this.promptCalls.push(message)
    this.promptImageCounts.push(options?.images?.length ?? 0)
  }

  async followUp(message: string): Promise<void> {
    this.followUpCalls.push(message)
  }

  async steer(message: string, images?: Array<{ type: string }>): Promise<void> {
    this.steerCalls.push(message)
    this.steerImageCounts.push(images?.length ?? 0)
  }

  async sendUserMessage(content: string | Array<{ type: string }>): Promise<void> {
    this.userMessageCalls.push(content)
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
    managerId: 'manager',
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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

describe('AgentRuntime', () => {
  it('queues steer for all messages when runtime is busy', async () => {
    const session = new FakeSession()

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    session.isStreaming = true

    const autoReceipt = await runtime.sendMessage('auto message')
    const followUpReceipt = await runtime.sendMessage('explicit followup', 'followUp')
    const steerReceipt = await runtime.sendMessage('steer message', 'steer')

    expect(autoReceipt.acceptedMode).toBe('steer')
    expect(followUpReceipt.acceptedMode).toBe('steer')
    expect(steerReceipt.acceptedMode).toBe('steer')
    expect(session.followUpCalls).toEqual([])
    expect(session.steerCalls).toEqual(['auto message', 'explicit followup', 'steer message'])
  })

  it('queues steer while prompt dispatch is in progress', async () => {
    const session = new FakeSession()
    const deferred = createDeferred()

    session.prompt = async (message: string): Promise<void> => {
      session.promptCalls.push(message)
      await deferred.promise
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    const first = await runtime.sendMessage('first prompt')
    const second = await runtime.sendMessage('queued auto')
    const third = await runtime.sendMessage('queued followup', 'followUp')

    expect(first.acceptedMode).toBe('prompt')
    expect(second.acceptedMode).toBe('steer')
    expect(third.acceptedMode).toBe('steer')
    expect(session.promptCalls).toEqual(['first prompt'])
    expect(session.followUpCalls).toEqual([])
    expect(session.steerCalls).toEqual(['queued auto', 'queued followup'])

    deferred.resolve()
    await Promise.resolve()
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

  it('passes image attachments through prompt options when text is present', async () => {
    const session = new FakeSession()

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await runtime.sendMessage({
      text: 'describe this image',
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
    })

    expect(session.promptCalls).toEqual(['describe this image'])
    expect(session.promptImageCounts).toEqual([1])
    expect(session.userMessageCalls).toHaveLength(0)
  })

  it('uses sendUserMessage for image-only prompts', async () => {
    const session = new FakeSession()

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
      },
    })

    await runtime.sendMessage({
      text: '',
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
    })

    expect(session.promptCalls).toHaveLength(0)
    expect(session.userMessageCalls).toHaveLength(1)
    expect(Array.isArray(session.userMessageCalls[0])).toBe(true)
  })

  it('surfaces prompt failures, resets status to idle, and invokes onAgentEnd', async () => {
    const session = new FakeSession()
    const statuses: string[] = []
    const runtimeErrors: Array<{ phase: string; message: string }> = []
    let agentEndCalls = 0

    session.prompt = async (): Promise<void> => {
      session.emit({ type: 'agent_start' })
      throw new Error('provider outage')
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: (_agentId, status) => {
          statuses.push(status)
        },
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push({
            phase: error.phase,
            message: error.message,
          })
        },
        onAgentEnd: () => {
          agentEndCalls += 1
        },
      },
    })

    const receipt = await runtime.sendMessage('trigger failure')
    expect(receipt.acceptedMode).toBe('prompt')

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeErrors).toEqual([
      expect.objectContaining({
        phase: 'prompt_dispatch',
        message: 'provider outage',
      }),
    ])
    expect(statuses).toContain('streaming')
    expect(statuses).toContain('idle')
    expect(runtime.getStatus()).toBe('idle')
    expect(agentEndCalls).toBe(1)
  })

  it('reports compaction-related prompt failures with compaction phase', async () => {
    const session = new FakeSession()
    const phases: string[] = []

    session.prompt = async (): Promise<void> => {
      throw new Error('auto compaction failed while preparing prompt')
    }

    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(),
      session: session as any,
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => {
          phases.push(error.phase)
        },
      },
    })

    await runtime.sendMessage('trigger compaction failure')
    await Promise.resolve()
    await Promise.resolve()

    expect(phases.at(-1)).toBe('compaction')
    expect(runtime.getStatus()).toBe('idle')
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
