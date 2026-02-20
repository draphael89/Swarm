import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAgentRuntime } from '../swarm/codex-agent-runtime.js'
import type { AgentDescriptor } from '../swarm/types.js'

function makeDescriptor(baseDir: string): AgentDescriptor {
  return {
    agentId: 'codex-worker',
    displayName: 'Codex Worker',
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: baseDir,
    model: {
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    },
    sessionFile: join(baseDir, 'sessions', 'codex-worker.jsonl'),
  }
}

describe('CodexAgentRuntime', () => {
  it('returns a clear startup error when the codex CLI binary is missing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const previousCodexBin = process.env.CODEX_BIN
    process.env.CODEX_BIN = join(tempDir, 'missing-codex-binary')

    try {
      await expect(
        CodexAgentRuntime.create({
          descriptor,
          callbacks: {
            onStatusChange: async () => {},
          },
          systemPrompt: 'You are a test codex runtime.',
          tools: [],
        }),
      ).rejects.toThrow('Codex CLI is not installed or not available on PATH')
    } finally {
      if (previousCodexBin === undefined) {
        delete process.env.CODEX_BIN
      } else {
        process.env.CODEX_BIN = previousCodexBin
      }
    }
  })
})
