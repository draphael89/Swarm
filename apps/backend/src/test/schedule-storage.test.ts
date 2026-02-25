import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'

describe('schedule-storage', () => {
  it('stores schedules under manager-scoped files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-schedules-path-'))
    expect(getScheduleFilePath(dataDir, 'release-manager')).toBe(
      join(dataDir, 'schedules', 'release-manager.json'),
    )
  })
})
