import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getLegacyGlobalSchedulesFilePath,
  getMigrationMarkerPath,
  getScheduleFilePath,
  migrateLegacyGlobalSchedulesIfNeeded,
} from '../scheduler/schedule-storage.js'

describe('schedule-storage', () => {
  it('stores schedules under manager-scoped files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-schedules-path-'))
    expect(getScheduleFilePath(dataDir, 'release-manager')).toBe(
      join(dataDir, 'schedules', 'release-manager.json'),
    )
  })

  it('migrates legacy global schedules into the default manager file once', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-schedules-migration-'))
    const legacyPath = getLegacyGlobalSchedulesFilePath(dataDir)
    const defaultManagerFile = getScheduleFilePath(dataDir, 'manager')
    const migrationMarkerPath = getMigrationMarkerPath(dataDir)

    await writeFile(
      legacyPath,
      JSON.stringify(
        {
          schedules: [{ id: 'legacy', name: 'Legacy schedule' }],
        },
        null,
        2,
      ),
      'utf8',
    )

    await migrateLegacyGlobalSchedulesIfNeeded({
      dataDir,
      defaultManagerId: 'manager',
    })

    expect(JSON.parse(await readFile(defaultManagerFile, 'utf8'))).toEqual({
      schedules: [{ id: 'legacy', name: 'Legacy schedule' }],
    })

    const markerContent = await readFile(migrationMarkerPath, 'utf8')
    expect(markerContent).toContain('migrated legacy global schedules')

    // Running the migration again should be a no-op.
    await migrateLegacyGlobalSchedulesIfNeeded({
      dataDir,
      defaultManagerId: 'manager',
    })
    expect(JSON.parse(await readFile(defaultManagerFile, 'utf8'))).toEqual({
      schedules: [{ id: 'legacy', name: 'Legacy schedule' }],
    })
  })
})
