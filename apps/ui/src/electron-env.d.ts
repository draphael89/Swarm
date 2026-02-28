interface MiddlemanRuntime {
  wsUrl: string
  apiUrl: string
  isElectron: boolean
  getStartupSettings: () => Promise<{
    openAtLogin: boolean
    supported: boolean
  }>
  setOpenAtLogin: (openAtLogin: boolean) => Promise<{
    openAtLogin: boolean
    supported: boolean
  }>
}

interface Window {
  middlemanRuntime?: MiddlemanRuntime
}
