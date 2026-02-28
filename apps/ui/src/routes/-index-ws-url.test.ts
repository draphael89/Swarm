import { describe, expect, it } from 'vitest'
import { resolveWsUrl } from './index'

describe('resolveWsUrl', () => {
  it('prefers Electron runtime URL when present', () => {
    const resolved = resolveWsUrl({
      electronWsUrl: 'ws://127.0.0.1:50001',
      envWsUrl: 'ws://127.0.0.1:47187',
      defaultWsUrl: 'ws://127.0.0.1:40000',
    })

    expect(resolved).toBe('ws://127.0.0.1:50001')
  })

  it('falls back to env URL when Electron runtime URL is missing', () => {
    const resolved = resolveWsUrl({
      envWsUrl: 'ws://127.0.0.1:47187',
      defaultWsUrl: 'ws://127.0.0.1:40000',
    })

    expect(resolved).toBe('ws://127.0.0.1:47187')
  })

  it('trims env URL and falls back to default when env URL is blank', () => {
    const trimmedResolved = resolveWsUrl({
      envWsUrl: '   ws://127.0.0.1:49000   ',
      defaultWsUrl: 'ws://127.0.0.1:40000',
    })
    expect(trimmedResolved).toBe('ws://127.0.0.1:49000')

    const blankResolved = resolveWsUrl({
      envWsUrl: '   ',
      defaultWsUrl: 'ws://127.0.0.1:40000',
    })
    expect(blankResolved).toBe('ws://127.0.0.1:40000')
  })

  it('falls back to default URL when neither Electron nor env URLs are provided', () => {
    const resolved = resolveWsUrl({
      defaultWsUrl: 'ws://127.0.0.1:40000',
    })

    expect(resolved).toBe('ws://127.0.0.1:40000')
  })
})
