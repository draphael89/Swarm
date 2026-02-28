import { contextBridge, ipcRenderer } from 'electron'
import {
  GET_STARTUP_SETTINGS_CHANNEL,
  RUNTIME_CONFIG_CHANNEL,
  SET_STARTUP_SETTINGS_CHANNEL,
  type MiddlemanRuntimeBridge,
  type MiddlemanRuntimeConfig,
  type MiddlemanStartupSettings,
} from './runtime-config.js'

async function exposeRuntimeConfig(): Promise<void> {
  const runtimeConfig = (await ipcRenderer.invoke(RUNTIME_CONFIG_CHANNEL)) as MiddlemanRuntimeConfig
  const bridge: MiddlemanRuntimeBridge = {
    ...runtimeConfig,
    getStartupSettings: async () =>
      (await ipcRenderer.invoke(GET_STARTUP_SETTINGS_CHANNEL)) as MiddlemanStartupSettings,
    setOpenAtLogin: async (openAtLogin: boolean) =>
      (await ipcRenderer.invoke(SET_STARTUP_SETTINGS_CHANNEL, openAtLogin)) as MiddlemanStartupSettings,
  }
  contextBridge.exposeInMainWorld('middlemanRuntime', bridge)
}

void exposeRuntimeConfig().catch((error) => {
  console.error('Failed to expose middleman runtime config:', error)
  contextBridge.exposeInMainWorld('middlemanRuntime', {
    wsUrl: '',
    apiUrl: '',
    isElectron: false,
    getStartupSettings: async () =>
      ({
        openAtLogin: false,
        supported: false,
      }) satisfies MiddlemanStartupSettings,
    setOpenAtLogin: async () =>
      ({
        openAtLogin: false,
        supported: false,
      }) satisfies MiddlemanStartupSettings,
  } satisfies MiddlemanRuntimeBridge)
})
