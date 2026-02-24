import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConfig } from '../config.js'

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'SWARM_ROOT_DIR',
  'SWARM_DATA_DIR',
  'SWARM_AUTH_FILE',
  'SWARM_HOST',
  'SWARM_PORT',
  'SWARM_DEBUG',
  'SWARM_ALLOW_NON_MANAGER_SUBSCRIPTIONS',
  'SWARM_MANAGER_ID',
  'SWARM_DEFAULT_CWD',
  'SWARM_MODEL_PROVIDER',
  'SWARM_MODEL_ID',
  'SWARM_THINKING_LEVEL',
  'SWARM_CWD_ALLOWLIST_ROOTS',
] as const

async function withEnv(overrides: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>>, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>()

  for (const key of MANAGED_ENV_KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    await run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('createConfig', () => {
  it('defaults dev data dir to ~/.swarm-dev', async () => {
    await withEnv({}, () => {
      const config = createConfig()

      expect(config.paths.dataDir).toBe(resolve(homedir(), '.swarm-dev'))
      expect(config.paths.swarmDir).toBe(resolve(homedir(), '.swarm-dev', 'swarm'))
      expect(config.paths.sessionsDir).toBe(resolve(homedir(), '.swarm-dev', 'sessions'))
      expect(config.paths.uploadsDir).toBe(resolve(homedir(), '.swarm-dev', 'uploads'))
      expect(config.paths.authDir).toBe(resolve(homedir(), '.swarm-dev', 'auth'))
      expect(config.paths.authFile).toBe(resolve(homedir(), '.swarm-dev', 'auth', 'auth.json'))
      expect(config.paths.managerAgentDir).toBe(resolve(homedir(), '.swarm-dev', 'agent', 'manager'))
      expect(config.paths.repoArchetypesDir).toBe(resolve(config.paths.rootDir, '.swarm', 'archetypes'))
      expect(config.paths.memoryDir).toBe(resolve(homedir(), '.swarm-dev', 'memory'))
      expect(config.paths.memoryFile).toBe(resolve(homedir(), '.swarm-dev', 'memory', 'manager.md'))
      expect(config.paths.repoMemorySkillFile).toBe(resolve(config.paths.rootDir, '.swarm', 'skills', 'memory', 'SKILL.md'))
      expect(config.paths.secretsFile).toBe(resolve(homedir(), '.swarm-dev', 'secrets.json'))
      expect(config.paths.schedulesFile).toBe(resolve(homedir(), '.swarm-dev', 'schedules', 'manager.json'))
      expect(config.managerId).toBeUndefined()
      expect(config.cwdAllowlistRoots).toContain(config.paths.rootDir)
      expect(config.cwdAllowlistRoots).toContain(resolve(homedir(), 'worktrees'))
    })
  })

  it('defaults production data dir to ~/.swarm', async () => {
    await withEnv({ NODE_ENV: 'production' }, () => {
      const config = createConfig()

      expect(config.paths.dataDir).toBe(resolve(homedir(), '.swarm'))
      expect(config.paths.managerAgentDir).toBe(resolve(homedir(), '.swarm', 'agent', 'manager'))
      expect(config.paths.uploadsDir).toBe(resolve(homedir(), '.swarm', 'uploads'))
      expect(config.paths.authFile).toBe(resolve(homedir(), '.swarm', 'auth', 'auth.json'))
      expect(config.paths.repoArchetypesDir).toBe(resolve(config.paths.rootDir, '.swarm', 'archetypes'))
      expect(config.paths.memoryDir).toBe(resolve(homedir(), '.swarm', 'memory'))
      expect(config.paths.memoryFile).toBe(resolve(homedir(), '.swarm', 'memory', 'manager.md'))
      expect(config.paths.repoMemorySkillFile).toBe(resolve(config.paths.rootDir, '.swarm', 'skills', 'memory', 'SKILL.md'))
      expect(config.paths.agentsStoreFile).toBe(resolve(homedir(), '.swarm', 'swarm', 'agents.json'))
      expect(config.paths.secretsFile).toBe(resolve(homedir(), '.swarm', 'secrets.json'))
      expect(config.paths.schedulesFile).toBe(resolve(homedir(), '.swarm', 'schedules', 'manager.json'))
    })
  })

  it('respects SWARM_DATA_DIR override for relative paths', async () => {
    await withEnv({ SWARM_ROOT_DIR: '/tmp/swarm-root', SWARM_DATA_DIR: 'custom-data' }, () => {
      const config = createConfig()

      expect(config.paths.dataDir).toBe('/tmp/swarm-root/custom-data')
    })
  })

  it('respects SWARM_DATA_DIR override for absolute paths', async () => {
    await withEnv({ SWARM_DATA_DIR: '/tmp/swarm-absolute' }, () => {
      const config = createConfig()

      expect(config.paths.dataDir).toBe('/tmp/swarm-absolute')
    })
  })

  it('expands SWARM_DATA_DIR when using ~', async () => {
    await withEnv({ SWARM_DATA_DIR: '~/.swarm-custom' }, () => {
      const config = createConfig()

      expect(config.paths.dataDir).toBe(resolve(homedir(), '.swarm-custom'))
    })
  })

  it('extends cwd allowlist roots from SWARM_CWD_ALLOWLIST_ROOTS', async () => {
    await withEnv({ SWARM_CWD_ALLOWLIST_ROOTS: './sandbox,/tmp/custom-root' }, () => {
      const config = createConfig()

      expect(config.cwdAllowlistRoots).toContain(resolve(config.paths.rootDir, 'sandbox'))
      expect(config.cwdAllowlistRoots).toContain(resolve('/tmp/custom-root'))
    })
  })

  it('respects SWARM_MANAGER_ID when provided', async () => {
    await withEnv({ SWARM_MANAGER_ID: 'opus-manager' }, () => {
      const config = createConfig()
      expect(config.managerId).toBe('opus-manager')
      expect(config.paths.memoryFile).toBe(resolve(homedir(), '.swarm-dev', 'memory', 'opus-manager.md'))
      expect(config.paths.schedulesFile).toBe(resolve(homedir(), '.swarm-dev', 'schedules', 'opus-manager.json'))
    })
  })
})
