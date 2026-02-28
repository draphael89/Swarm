export const RUNTIME_CONFIG_CHANNEL = 'middleman:get-runtime-config'
export const GET_STARTUP_SETTINGS_CHANNEL = 'middleman:get-startup-settings'
export const SET_STARTUP_SETTINGS_CHANNEL = 'middleman:set-startup-settings'

export interface MiddlemanRuntimeConfig {
  wsUrl: string
  apiUrl: string
  isElectron: boolean
}

export interface MiddlemanStartupSettings {
  openAtLogin: boolean
  supported: boolean
}

export interface MiddlemanRuntimeBridge extends MiddlemanRuntimeConfig {
  getStartupSettings: () => Promise<MiddlemanStartupSettings>
  setOpenAtLogin: (openAtLogin: boolean) => Promise<MiddlemanStartupSettings>
}
