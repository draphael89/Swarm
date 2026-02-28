import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startMiddlemanBackend } from '../bootstrap.js'

const createdPaths: string[] = []

afterEach(async () => {
  while (createdPaths.length > 0) {
    const path = createdPaths.pop()
    if (!path) {
      continue
    }

    await rm(path, { recursive: true, force: true })
  }
})

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

describe('startMiddlemanBackend', () => {
  it('loads host and port from envPath before config creation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'middleman-bootstrap-data-'))
    const envRoot = await mkdtemp(join(tmpdir(), 'middleman-bootstrap-env-'))
    createdPaths.push(dataDir, envRoot)

    const port = await getAvailablePort()
    const envPath = join(envRoot, '.env')
    await writeFile(envPath, `MIDDLEMAN_HOST=127.0.0.1\nMIDDLEMAN_PORT=${port}\n`, 'utf8')

    const previousHost = process.env.MIDDLEMAN_HOST
    const previousPort = process.env.MIDDLEMAN_PORT
    delete process.env.MIDDLEMAN_HOST
    delete process.env.MIDDLEMAN_PORT

    const backend = await startMiddlemanBackend({
      envPath,
      dataDir,
    })

    try {
      expect(backend.host).toBe('127.0.0.1')
      expect(backend.port).toBe(port)
      expect(backend.wsUrl).toBe(`ws://127.0.0.1:${port}`)
    } finally {
      await backend.stop()

      if (previousHost === undefined) {
        delete process.env.MIDDLEMAN_HOST
      } else {
        process.env.MIDDLEMAN_HOST = previousHost
      }

      if (previousPort === undefined) {
        delete process.env.MIDDLEMAN_PORT
      } else {
        process.env.MIDDLEMAN_PORT = previousPort
      }
    }
  })

  it('returns the actual bound port when started with port 0', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'middleman-bootstrap-data-'))
    createdPaths.push(dataDir)

    const backend = await startMiddlemanBackend({
      dataDir,
      host: '127.0.0.1',
      port: 0,
    })

    try {
      expect(backend.host).toBe('127.0.0.1')
      expect(backend.port).toBeGreaterThan(0)
      expect(backend.port).not.toBe(0)
      expect(backend.wsUrl).toBe(`ws://127.0.0.1:${backend.port}`)
      expect(backend.httpUrl).toBe(`http://127.0.0.1:${backend.port}`)
    } finally {
      await backend.stop()
    }
  })
})
