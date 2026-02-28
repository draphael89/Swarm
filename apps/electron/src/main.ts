import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  startMiddlemanBackend,
  type BootstrapOptions,
  type BootstrapResult,
} from '@middleman/backend/bootstrap'
import {
  GET_STARTUP_SETTINGS_CHANNEL,
  RUNTIME_CONFIG_CHANNEL,
  SET_STARTUP_SETTINGS_CHANNEL,
  type MiddlemanRuntimeConfig,
  type MiddlemanStartupSettings,
} from './runtime-config.js'

const DEFAULT_ELECTRON_DEV_URL = 'http://127.0.0.1:47188'
const APP_PROTOCOL = 'app'
const APP_RENDERER_ENTRY_URL = 'app://renderer/index.html'
const APP_RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

let backendHandle: BootstrapResult | null = null
let runtimeConfig: MiddlemanRuntimeConfig | null = null
let isShuttingDown = false
let appProtocolRegistered = false
let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
let activeAgentsListener: (() => void) | null = null
let fatalHandlersRegistered = false

if (!process.env.VITEST) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ])
}

function resolveElectronDevUrl(): string {
  return process.env.ELECTRON_DEV_URL?.trim() || DEFAULT_ELECTRON_DEV_URL
}

function registerRuntimeConfigChannel(config: MiddlemanRuntimeConfig): void {
  ipcMain.handle(RUNTIME_CONFIG_CHANNEL, () => config)
  ipcMain.handle(GET_STARTUP_SETTINGS_CHANNEL, () => readStartupSettings())
  ipcMain.handle(SET_STARTUP_SETTINGS_CHANNEL, (_event, openAtLogin: boolean) =>
    writeStartupSettings(openAtLogin)
  )
}

function removeIpcHandlers(): void {
  ipcMain.removeHandler(RUNTIME_CONFIG_CHANNEL)
  ipcMain.removeHandler(GET_STARTUP_SETTINGS_CHANNEL)
  ipcMain.removeHandler(SET_STARTUP_SETTINGS_CHANNEL)
}

async function createMainWindow(): Promise<BrowserWindow> {
  if (!runtimeConfig) {
    throw new Error('Runtime config is not available. Start backend before creating BrowserWindow.')
  }

  const preloadPath = resolve(dirname(fileURLToPath(import.meta.url)), 'preload.js')
  const window = new BrowserWindow({
    width: 1400,
    height: 920,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow = window
  window.on('closed', () => {
    mainWindow = null
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedMainWindowNavigation(targetUrl)) {
      return
    }

    event.preventDefault()
  })

  if (app.isPackaged) {
    registerPackagedRendererProtocol()
    await window.loadURL(APP_RENDERER_ENTRY_URL)
    return window
  }

  await window.loadURL(resolveElectronDevUrl())
  return window
}

function resolvePackagedUiDistDir(): string {
  const envOverride = process.env.MIDDLEMAN_ELECTRON_UI_DIST?.trim()
  const importDir = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : null
  const candidates = [
    envOverride ? resolve(envOverride) : undefined,
    resolve(importDir, '../../ui/dist'),
    resolve(app.getAppPath(), 'apps/ui/dist'),
    resourcesPath ? resolve(resourcesPath, 'apps/ui/dist') : undefined,
    resourcesPath ? resolve(resourcesPath, 'ui/dist') : undefined,
  ].filter((value): value is string => typeof value === 'string')

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'index.html'))) {
      return candidate
    }
  }

  throw new Error(
    'Could not locate packaged UI dist folder. Set MIDDLEMAN_ELECTRON_UI_DIST to the built renderer path.'
  )
}

export function resolveRendererAssetPath(uiDistDir: string, pathname: string): string | null {
  const requestedPath = pathname === '/' ? '/index.html' : pathname
  const absolutePath = resolve(uiDistDir, `.${requestedPath}`)
  const isInsideUiDist =
    absolutePath === uiDistDir || absolutePath.startsWith(`${uiDistDir}${sep}`)

  if (!isInsideUiDist) {
    return null
  }

  if (existsSync(absolutePath)) {
    return absolutePath
  }

  if (extname(absolutePath).length === 0) {
    return resolve(uiDistDir, 'index.html')
  }

  return null
}

async function fetchRendererFileWithSecurityHeaders(filePath: string): Promise<Response> {
  const response = await net.fetch(pathToFileURL(filePath).toString())
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', APP_RENDERER_CSP)
  headers.set('X-Content-Type-Options', 'nosniff')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function registerPackagedRendererProtocol(): void {
  if (appProtocolRegistered) {
    return
  }

  const uiDistDir = resolvePackagedUiDistDir()
  protocol.handle(APP_PROTOCOL, async (request) => {
    const requestUrl = new URL(request.url)
    if (requestUrl.hostname !== 'renderer') {
      return new Response('Forbidden', { status: 403 })
    }
    const pathname = decodeURIComponent(requestUrl.pathname)
    const assetPath = resolveRendererAssetPath(uiDistDir, pathname)
    if (!assetPath) {
      return new Response('Not Found', { status: 404 })
    }

    return fetchRendererFileWithSecurityHeaders(assetPath)
  })

  appProtocolRegistered = true
}

function isAllowedMainWindowNavigation(targetUrl: string): boolean {
  if (targetUrl === 'about:blank') {
    return true
  }

  try {
    const parsed = new URL(targetUrl)
    if (app.isPackaged) {
      return parsed.protocol === 'app:' && parsed.hostname === 'renderer'
    }

    const allowedOrigin = new URL(resolveElectronDevUrl()).origin
    return parsed.origin === allowedOrigin
  } catch {
    return false
  }
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  return 'code' in error && (error as { code?: string }).code === 'EADDRINUSE'
}

function resolveBootstrapOptionsForCurrentMode(portOverride?: number): BootstrapOptions {
  const options: BootstrapOptions = {}
  if (app.isPackaged) {
    options.rootDir = app.getAppPath()
  }
  if (typeof portOverride === 'number') {
    options.port = portOverride
  }
  return options
}

function readStartupSettings(): MiddlemanStartupSettings {
  const supported = process.platform === 'darwin' || process.platform === 'win32'
  if (!supported) {
    return {
      openAtLogin: false,
      supported: false,
    }
  }

  const { openAtLogin } = app.getLoginItemSettings()
  return {
    openAtLogin,
    supported: true,
  }
}

function writeStartupSettings(openAtLogin: boolean): MiddlemanStartupSettings {
  const current = readStartupSettings()
  if (!current.supported) {
    return current
  }

  app.setLoginItemSettings({ openAtLogin })
  return readStartupSettings()
}

function resolveTrayIconPath(): string | null {
  const envOverride = process.env.MIDDLEMAN_ELECTRON_TRAY_ICON?.trim()
  const importDir = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : null
  const candidates = [
    envOverride ? resolve(envOverride) : undefined,
    resolve(importDir, '../../ui/public/logo192.png'),
    resolve(importDir, '../../ui/dist/logo192.png'),
    resolve(app.getAppPath(), 'apps/ui/dist/logo192.png'),
    resourcesPath ? resolve(resourcesPath, 'apps/ui/dist/logo192.png') : undefined,
    resourcesPath ? resolve(resourcesPath, 'ui/dist/logo192.png') : undefined,
  ].filter((value): value is string => typeof value === 'string')

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

function readActiveAgentCountFromBackend(): number {
  if (!backendHandle) {
    return 0
  }

  const rawAgents = backendHandle.swarmManager.listAgents()
  return rawAgents.filter((agent) => agent.status === 'streaming').length
}

function updateActivityBadge(activeAgentCount: number): void {
  if (process.platform === 'darwin') {
    app.dock.setBadge(activeAgentCount > 0 ? String(activeAgentCount) : '')
  }
}

function updateTrayStatus(): void {
  if (!tray) {
    return
  }

  const activeAgentCount = readActiveAgentCountFromBackend()
  const statusLabel =
    activeAgentCount > 0
      ? `${activeAgentCount} active agent${activeAgentCount === 1 ? '' : 's'}`
      : 'Idle'

  tray.setToolTip(`Middleman: ${statusLabel}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Status: ${statusLabel}`, enabled: false },
      {
        label: 'Show Middleman',
        click: () => {
          if (!mainWindow) {
            void createMainWindow().catch((error) => {
              console.error(error)
            })
            return
          }

          if (mainWindow.isMinimized()) {
            mainWindow.restore()
          }
          mainWindow.show()
          mainWindow.focus()
        },
      },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ])
  )

  updateActivityBadge(activeAgentCount)
}

function ensureTray(): void {
  if (tray) {
    updateTrayStatus()
    return
  }

  const trayIconPath = resolveTrayIconPath()
  if (!trayIconPath) {
    return
  }

  const trayImage = nativeImage.createFromPath(trayIconPath)
  if (trayImage.isEmpty()) {
    return
  }

  tray = new Tray(trayImage)
  tray.on('click', () => {
    if (!mainWindow) {
      return
    }

    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  updateTrayStatus()
}

function bindAgentActivityListeners(): void {
  if (!backendHandle) {
    return
  }

  const refresh = () => {
    updateTrayStatus()
  }

  backendHandle.swarmManager.on('agents_snapshot', refresh)
  activeAgentsListener = () => {
    backendHandle?.swarmManager.off('agents_snapshot', refresh)
  }

  refresh()
}

function unbindAgentActivityListeners(): void {
  if (!activeAgentsListener) {
    return
  }

  activeAgentsListener()
  activeAgentsListener = null
}

async function checkForUpdatesInBackground(): Promise<void> {
  if (!app.isPackaged || process.env.MIDDLEMAN_DISABLE_AUTO_UPDATE === '1') {
    return
  }

  try {
    const { autoUpdater } = await import('electron-updater')
    await autoUpdater.checkForUpdatesAndNotify()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Auto-update check skipped: ${message}`)
  }
}

async function handleFatalMainError(error: unknown): Promise<void> {
  console.error(error)

  if (isShuttingDown) {
    return
  }

  isShuttingDown = true
  await shutdownElectronMain().catch((shutdownError) => {
    console.error(shutdownError)
  })
  app.exit(1)
}

function registerFatalErrorHandlers(): void {
  if (fatalHandlersRegistered) {
    return
  }

  process.on('uncaughtException', (error) => {
    void handleFatalMainError(error)
  })
  process.on('unhandledRejection', (reason) => {
    void handleFatalMainError(reason)
  })
  fatalHandlersRegistered = true
}

export async function bootElectronMain(): Promise<void> {
  let didStartBackend = false

  try {
    const initialBootstrapOptions = resolveBootstrapOptionsForCurrentMode()
    try {
      backendHandle = await startMiddlemanBackend(initialBootstrapOptions)
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error
      }

      backendHandle = await startMiddlemanBackend(resolveBootstrapOptionsForCurrentMode(0))
    }
    didStartBackend = true

    runtimeConfig = {
      wsUrl: backendHandle.wsUrl,
      apiUrl: backendHandle.httpUrl,
      isElectron: true,
    }

    removeIpcHandlers()
    registerRuntimeConfigChannel(runtimeConfig)
    ensureTray()
    bindAgentActivityListeners()
    await createMainWindow()
    void checkForUpdatesInBackground()
  } catch (error) {
    removeIpcHandlers()
    unbindAgentActivityListeners()

    if (didStartBackend && backendHandle) {
      await backendHandle.stop().catch(() => undefined)
      backendHandle = null
      runtimeConfig = null
    }

    throw error
  }
}

export async function shutdownElectronMain(): Promise<void> {
  removeIpcHandlers()
  unbindAgentActivityListeners()

  if (appProtocolRegistered) {
    protocol.unhandle(APP_PROTOCOL)
    appProtocolRegistered = false
  }

  if (tray) {
    tray.destroy()
    tray = null
  }

  if (process.platform === 'darwin') {
    app.dock.setBadge('')
  }

  if (!backendHandle) {
    return
  }

  await backendHandle.stop()
  backendHandle = null
  runtimeConfig = null
}

export function registerElectronLifecycle(): void {
  registerFatalErrorHandlers()

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow().catch((error) => {
        console.error(error)
      })
    }
  })

  app.on('before-quit', (event) => {
    if (isShuttingDown) {
      return
    }

    event.preventDefault()
    isShuttingDown = true
    void shutdownElectronMain()
      .catch((error) => {
        console.error(error)
      })
      .finally(() => {
        app.quit()
      })
  })

  void app
    .whenReady()
    .then(() => bootElectronMain())
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}

if (!process.env.VITEST) {
  registerElectronLifecycle()
}
