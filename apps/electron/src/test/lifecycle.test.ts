import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BootstrapResult } from '@middleman/backend/bootstrap'

type AppListener = (event?: { preventDefault?: () => void }) => void

const listeners = new Map<string, AppListener[]>()

const appMock = {
  isPackaged: false,
  whenReady: vi.fn<() => Promise<void>>(),
  on: vi.fn<(eventName: string, listener: AppListener) => void>(),
  quit: vi.fn(),
  exit: vi.fn(),
  getAppPath: vi.fn(() => '/app'),
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
  setLoginItemSettings: vi.fn(),
  dock: {
    setBadge: vi.fn(),
  },
}

const browserWindowCtor = vi.fn().mockImplementation(() => ({
  on: vi.fn(),
  loadURL: vi.fn().mockResolvedValue(undefined),
  webContents: {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  },
}))
;(browserWindowCtor as unknown as { getAllWindows: () => unknown[] }).getAllWindows = vi.fn(() => [])

const ipcHandleMock = vi.fn()
const ipcRemoveHandlerMock = vi.fn()
const traySetToolTipMock = vi.fn()
const traySetContextMenuMock = vi.fn()
const trayOnMock = vi.fn()
const trayDestroyMock = vi.fn()
const trayCtorMock = vi.fn().mockImplementation(() => ({
  setToolTip: traySetToolTipMock,
  setContextMenu: traySetContextMenuMock,
  on: trayOnMock,
  destroy: trayDestroyMock,
}))
const menuBuildFromTemplateMock = vi.fn(() => ({}))
const nativeImageCreateFromPathMock = vi.fn(() => ({
  isEmpty: () => true,
}))

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowCtor,
  Menu: {
    buildFromTemplate: menuBuildFromTemplateMock,
  },
  Tray: trayCtorMock,
  nativeImage: {
    createFromPath: nativeImageCreateFromPathMock,
  },
  ipcMain: {
    handle: ipcHandleMock,
    removeHandler: ipcRemoveHandlerMock,
  },
  net: {
    fetch: vi.fn().mockResolvedValue(new Response()),
  },
  protocol: {
    handle: vi.fn(),
    unhandle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
  },
}))

const stopMock = vi.fn<() => Promise<void>>()
const startBackendMock = vi.fn<() => Promise<BootstrapResult>>()
const swarmManagerMock = {
  on: vi.fn(),
  off: vi.fn(),
  listAgents: vi.fn(() => []),
}

vi.mock('@middleman/backend/bootstrap', () => ({
  startMiddlemanBackend: startBackendMock,
}))

describe('registerElectronLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    listeners.clear()

    appMock.isPackaged = false
    appMock.whenReady.mockResolvedValue(undefined)
    appMock.on.mockImplementation((eventName, listener) => {
      const existing = listeners.get(eventName) ?? []
      existing.push(listener)
      listeners.set(eventName, existing)
    })

    stopMock.mockResolvedValue(undefined)
    startBackendMock.mockResolvedValue({
      config: {} as BootstrapResult['config'],
      host: '127.0.0.1',
      port: 47187,
      wsUrl: 'ws://127.0.0.1:47187',
      httpUrl: 'http://127.0.0.1:47187',
      swarmManager: swarmManagerMock as unknown as BootstrapResult['swarmManager'],
      stop: stopMock,
    })
  })

  it('registers lifecycle listeners and boots backend when app is ready', async () => {
    const { registerElectronLifecycle } = await import('../main.js')

    registerElectronLifecycle()
    await Promise.resolve()

    expect(appMock.on).toHaveBeenCalledWith('window-all-closed', expect.any(Function))
    expect(appMock.on).toHaveBeenCalledWith('activate', expect.any(Function))
    expect(appMock.on).toHaveBeenCalledWith('before-quit', expect.any(Function))
    expect(startBackendMock).toHaveBeenCalledWith({})
  })

  it('prevents default quit, shuts down once, and then quits', async () => {
    const { registerElectronLifecycle } = await import('../main.js')

    registerElectronLifecycle()
    await Promise.resolve()
    await Promise.resolve()

    expect(startBackendMock).toHaveBeenCalledTimes(1)

    const beforeQuitHandlers = listeners.get('before-quit') ?? []
    expect(beforeQuitHandlers).toHaveLength(1)

    const preventDefault = vi.fn()
    beforeQuitHandlers[0]?.({ preventDefault })
    await Promise.resolve()
    await Promise.resolve()

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledTimes(1)

    beforeQuitHandlers[0]?.({ preventDefault })
    await Promise.resolve()

    expect(stopMock).toHaveBeenCalledTimes(1)
  })
})
