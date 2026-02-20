import { describe, expect, it } from 'vitest'
import {
  normalizeArtifactShortcodes,
  parseArtifactReference,
  toSwarmFileHref,
  toVscodeInsidersHref,
} from './artifacts'

describe('artifacts helpers', () => {
  it('normalizes [artifact:path] shortcodes into swarm-file links', () => {
    const normalized = normalizeArtifactShortcodes('See [artifact:/tmp/test.md] for details.')

    expect(normalized).toBe('See [artifact:/tmp/test.md](swarm-file:///tmp/test.md) for details.')
  })

  it('parses swarm-file links into artifact references', () => {
    const artifact = parseArtifactReference('swarm-file:///Users/example/project/README.md')

    expect(artifact).toEqual({
      path: '/Users/example/project/README.md',
      fileName: 'README.md',
      href: 'swarm-file:///Users/example/project/README.md',
    })
  })

  it('parses vscode insiders file links into artifact references', () => {
    const artifact = parseArtifactReference('vscode-insiders://file//Users/example/project/SWARM.md')

    expect(artifact).toEqual({
      path: '/Users/example/project/SWARM.md',
      fileName: 'SWARM.md',
      href: 'vscode-insiders://file//Users/example/project/SWARM.md',
    })
  })

  it('builds artifact href helpers', () => {
    expect(toSwarmFileHref('/tmp/my notes.md')).toBe('swarm-file:///tmp/my%20notes.md')
    expect(toVscodeInsidersHref('/tmp/my notes.md')).toBe('vscode-insiders://file/tmp/my%20notes.md')
  })
})
