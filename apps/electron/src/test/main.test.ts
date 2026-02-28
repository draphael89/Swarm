import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BootstrapResult } from '@middleman/backend/bootstrap'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const appMock = {
  isPackaged: false,
  whenReady: vi.fn<() => Promise<void>>(),
  on: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
  getAppPath: vi.fn(() => '/app'),
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
  setLoginItemSettings: vi.fn(),
  dock: {
    setBadge: vi.fn(),
  },
}

const loadURLMock = vi.fn<(_: string) => Promise<void>>()
const windowOnMock = vi.fn()
const webContentsOnMock = vi.fn()
const setWindowOpenHandlerMock = vi.fn()
const browserWindowCtor = vi.fn().mockImplementation(() => ({
  on: windowOnMock,
  loadURL: loadURLMock,
  webContents: {
    on: webContentsOnMock,
    setWindowOpenHandler: setWindowOpenHandlerMock,
  },
}))
;(browserWindowCtor as unknown as { getAllWindows: () => unknown[] }).getAllWindows = vi.fn(() => [])

const ipcHandleMock = vi.fn()
const ipcRemoveHandlerMock = vi.fn()
const protocolHandleMock = vi.fn()
const protocolUnhandleMock = vi.fn()
const protocolRegisterSchemesAsPrivilegedMock = vi.fn()
const netFetchMock = vi.fn()
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
  protocol: {
    handle: protocolHandleMock,
    unhandle: protocolUnhandleMock,
    registerSchemesAsPrivileged: protocolRegisterSchemesAsPrivilegedMock,
  },
  net: {
    fetch: netFetchMock,
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

describe('bootElectronMain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    appMock.isPackaged = false
    appMock.getAppPath.mockReturnValue('/app')
    loadURLMock.mockResolvedValue(undefined)
    windowOnMock.mockReturnValue(undefined)
    webContentsOnMock.mockReturnValue(undefined)
    setWindowOpenHandlerMock.mockReturnValue(undefined)
    stopMock.mockResolvedValue(undefined)
    protocolHandleMock.mockReturnValue(undefined)
    protocolUnhandleMock.mockReturnValue(undefined)
    protocolRegisterSchemesAsPrivilegedMock.mockReturnValue(undefined)
    nativeImageCreateFromPathMock.mockReturnValue({
      isEmpty: () => true,
    })
    netFetchMock.mockResolvedValue(new Response())
    delete process.env.MIDDLEMAN_ELECTRON_UI_DIST
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

  it('starts backend, registers runtime channel, and loads dev URL', async () => {
    const { bootElectronMain } = await import('../main.js')

    await bootElectronMain()

    expect(startBackendMock).toHaveBeenCalledWith({})
    expect(ipcHandleMock).toHaveBeenCalledWith('middleman:get-runtime-config', expect.any(Function))
    expect(browserWindowCtor).toHaveBeenCalledOnce()
    expect(setWindowOpenHandlerMock).toHaveBeenCalledWith(expect.any(Function))
    expect(webContentsOnMock).toHaveBeenCalledWith('will-navigate', expect.any(Function))
    expect(loadURLMock).toHaveBeenCalledWith('http://127.0.0.1:47188')
  })

  it('shuts down backend and removes runtime channel', async () => {
    const { bootElectronMain, shutdownElectronMain } = await import('../main.js')

    await bootElectronMain()
    await shutdownElectronMain()

    expect(ipcRemoveHandlerMock).toHaveBeenCalledWith('middleman:get-runtime-config')
    expect(stopMock).toHaveBeenCalledTimes(1)
  })

  it('loads packaged renderer via app protocol when packaged', async () => {
    appMock.isPackaged = true
    const uiDistDir = mkdtempSync(join(tmpdir(), 'middleman-electron-ui-'))
    writeFileSync(join(uiDistDir, 'index.html'), '<!doctype html><html></html>', 'utf8')
    process.env.MIDDLEMAN_ELECTRON_UI_DIST = uiDistDir

    const { bootElectronMain } = await import('../main.js')
    await bootElectronMain()

    expect(startBackendMock).toHaveBeenCalledWith({ rootDir: '/app' })
    expect(protocolHandleMock).toHaveBeenCalledWith('app', expect.any(Function))
    expect(loadURLMock).toHaveBeenCalledWith('app://renderer/index.html')
  })

  it('retries once with an ephemeral port when the configured port is already in use', async () => {
    const eaddrInUseError = Object.assign(new Error('already in use'), { code: 'EADDRINUSE' })
    startBackendMock.mockRejectedValueOnce(eaddrInUseError).mockResolvedValueOnce({
      config: {} as BootstrapResult['config'],
      host: '127.0.0.1',
      port: 56123,
      wsUrl: 'ws://127.0.0.1:56123',
      httpUrl: 'http://127.0.0.1:56123',
      swarmManager: swarmManagerMock as unknown as BootstrapResult['swarmManager'],
      stop: stopMock,
    })

    const { bootElectronMain } = await import('../main.js')
    await bootElectronMain()

    expect(startBackendMock).toHaveBeenNthCalledWith(1, {})
    expect(startBackendMock).toHaveBeenNthCalledWith(2, { port: 0 })
    expect(loadURLMock).toHaveBeenCalledWith('http://127.0.0.1:47188')
  })

  it('blocks unexpected main-window navigations', async () => {
    const { bootElectronMain } = await import('../main.js')
    await bootElectronMain()

    const navigateHandler = webContentsOnMock.mock.calls.find(
      (call) => call[0] === 'will-navigate',
    )?.[1] as ((event: { preventDefault: () => void }, url: string) => void) | undefined
    expect(navigateHandler).toBeTruthy()

    const blockedEvent = { preventDefault: vi.fn() }
    navigateHandler!(blockedEvent, 'https://example.com')
    expect(blockedEvent.preventDefault).toHaveBeenCalledTimes(1)

    const allowedEvent = { preventDefault: vi.fn() }
    navigateHandler!(allowedEvent, 'http://127.0.0.1:47188/chat')
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('returns 403 for app protocol hosts other than renderer', async () => {
    appMock.isPackaged = true
    const uiDistDir = mkdtempSync(join(tmpdir(), 'middleman-electron-ui-'))
    writeFileSync(join(uiDistDir, 'index.html'), '<!doctype html><html></html>', 'utf8')
    process.env.MIDDLEMAN_ELECTRON_UI_DIST = uiDistDir

    const { bootElectronMain } = await import('../main.js')
    await bootElectronMain()

    const protocolHandler = protocolHandleMock.mock.calls[0]?.[1] as
      | ((request: { url: string }) => Promise<Response>)
      | undefined
    expect(protocolHandler).toBeTruthy()

    const forbidden = await protocolHandler!({ url: 'app://not-renderer/index.html' })
    expect(forbidden.status).toBe(403)
  })

  it('rejects path traversal outside the packaged renderer directory', async () => {
    const uiDistDir = mkdtempSync(join(tmpdir(), 'middleman-electron-ui-'))
    writeFileSync(join(uiDistDir, 'index.html'), '<!doctype html><html></html>', 'utf8')

    const { resolveRendererAssetPath } = await import('../main.js')

    expect(resolveRendererAssetPath(uiDistDir, '/index.html')).toBe(join(uiDistDir, 'index.html'))
    expect(resolveRendererAssetPath(uiDistDir, '/../secrets.txt')).toBeNull()
  })
})
