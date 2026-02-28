import { beforeEach, describe, expect, it, vi } from 'vitest'

const exposeInMainWorldMock = vi.fn()
const invokeMock = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: exposeInMainWorldMock,
  },
  ipcRenderer: {
    invoke: invokeMock,
  },
}))

describe('preload runtime config bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('invokes runtime config channel and exposes middlemanRuntime', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'middleman:get-runtime-config') {
        return {
          wsUrl: 'ws://127.0.0.1:47187',
          apiUrl: 'http://127.0.0.1:47187',
          isElectron: true,
        }
      }

      if (channel === 'middleman:get-startup-settings') {
        return {
          openAtLogin: false,
          supported: true,
        }
      }

      if (channel === 'middleman:set-startup-settings') {
        return {
          openAtLogin: true,
          supported: true,
        }
      }

      return null
    })

    await import('../preload.js')
    await Promise.resolve()

    expect(invokeMock).toHaveBeenCalledWith('middleman:get-runtime-config')
    const exposedRuntime = exposeInMainWorldMock.mock.calls[0]?.[1] as {
      wsUrl: string
      apiUrl: string
      isElectron: boolean
      getStartupSettings: () => Promise<{ openAtLogin: boolean; supported: boolean }>
      setOpenAtLogin: (openAtLogin: boolean) => Promise<{ openAtLogin: boolean; supported: boolean }>
    }
    expect(exposedRuntime.wsUrl).toBe('ws://127.0.0.1:47187')
    expect(exposedRuntime.apiUrl).toBe('http://127.0.0.1:47187')
    expect(exposedRuntime.isElectron).toBe(true)

    const startupSettings = await exposedRuntime.getStartupSettings()
    expect(invokeMock).toHaveBeenCalledWith('middleman:get-startup-settings')
    expect(startupSettings).toEqual({
      openAtLogin: false,
      supported: true,
    })

    const updatedStartupSettings = await exposedRuntime.setOpenAtLogin(true)
    expect(invokeMock).toHaveBeenCalledWith('middleman:set-startup-settings', true)
    expect(updatedStartupSettings).toEqual({
      openAtLogin: true,
      supported: true,
    })
  })

  it('exposes safe runtime defaults when the bridge fails', async () => {
    invokeMock.mockRejectedValue(new Error('boom'))

    await import('../preload.js')
    await Promise.resolve()

    const exposedRuntime = exposeInMainWorldMock.mock.calls[0]?.[1] as {
      wsUrl: string
      apiUrl: string
      isElectron: boolean
      getStartupSettings: () => Promise<{ openAtLogin: boolean; supported: boolean }>
      setOpenAtLogin: (openAtLogin: boolean) => Promise<{ openAtLogin: boolean; supported: boolean }>
    }
    expect(exposedRuntime.wsUrl).toBe('')
    expect(exposedRuntime.apiUrl).toBe('')
    expect(exposedRuntime.isElectron).toBe(false)
    await expect(exposedRuntime.getStartupSettings()).resolves.toEqual({
      openAtLogin: false,
      supported: false,
    })
  })
})
