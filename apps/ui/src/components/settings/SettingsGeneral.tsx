import { useCallback, useEffect, useState } from 'react'
import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
} from '@/lib/theme'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

interface SettingsGeneralProps {
  wsUrl: string
}

export function SettingsGeneral({ wsUrl }: SettingsGeneralProps) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readStoredThemePreference(),
  )
  const [supportsLaunchAtLogin, setSupportsLaunchAtLogin] = useState(false)
  const [openAtLogin, setOpenAtLogin] = useState(false)
  const [isUpdatingLaunchAtLogin, setIsUpdatingLaunchAtLogin] = useState(false)

  useEffect(() => {
    setThemePreference(readStoredThemePreference())
  }, [])

  useEffect(() => {
    const runtime = window.middlemanRuntime
    if (!runtime?.isElectron) {
      setSupportsLaunchAtLogin(false)
      setOpenAtLogin(false)
      return
    }

    let isCancelled = false
    void runtime
      .getStartupSettings()
      .then((settings) => {
        if (isCancelled) {
          return
        }

        setSupportsLaunchAtLogin(settings.supported)
        setOpenAtLogin(settings.openAtLogin)
      })
      .catch(() => {
        if (isCancelled) {
          return
        }

        setSupportsLaunchAtLogin(false)
        setOpenAtLogin(false)
      })

    return () => {
      isCancelled = true
    }
  }, [])

  const handleThemePreferenceChange = useCallback((nextPreference: ThemePreference) => {
    setThemePreference(nextPreference)
    applyThemePreference(nextPreference)
  }, [])

  const handleOpenAtLoginChange = useCallback((nextValue: boolean) => {
    const runtime = window.middlemanRuntime
    if (!runtime?.isElectron || !supportsLaunchAtLogin) {
      return
    }

    setIsUpdatingLaunchAtLogin(true)
    void runtime
      .setOpenAtLogin(nextValue)
      .then((settings) => {
        setSupportsLaunchAtLogin(settings.supported)
        setOpenAtLogin(settings.openAtLogin)
      })
      .catch(() => {
        setOpenAtLogin((previous) => previous)
      })
      .finally(() => {
        setIsUpdatingLaunchAtLogin(false)
      })
  }, [supportsLaunchAtLogin])

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="Appearance"
        description="Customize how the app looks"
      >
        <SettingsWithCTA
          label="Theme"
          description="Choose between light, dark, or system theme"
        >
          <Select
            value={themePreference}
            onValueChange={(value) => {
              if (value === 'light' || value === 'dark' || value === 'auto') {
                handleThemePreferenceChange(value)
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="Select theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">
                <span className="inline-flex items-center gap-2">
                  <Sun className="size-3.5" />
                  Light
                </span>
              </SelectItem>
              <SelectItem value="dark">
                <span className="inline-flex items-center gap-2">
                  <Moon className="size-3.5" />
                  Dark
                </span>
              </SelectItem>
              <SelectItem value="auto">
                <span className="inline-flex items-center gap-2">
                  <Monitor className="size-3.5" />
                  System
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="System"
        description="Manage the Middleman daemon"
      >
        {supportsLaunchAtLogin ? (
          <SettingsWithCTA
            label="Launch at login"
            description="Start Middleman automatically when you sign in."
          >
            <Switch
              checked={openAtLogin}
              disabled={isUpdatingLaunchAtLogin}
              onCheckedChange={handleOpenAtLoginChange}
              aria-label="Launch Middleman at login"
            />
          </SettingsWithCTA>
        ) : null}

        <SettingsWithCTA
          label="Reboot"
          description="Restart the Middleman daemon and all agents"
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const endpoint = resolveApiEndpoint(wsUrl, '/api/reboot')
              void fetch(endpoint, { method: 'POST' }).catch(() => {})
            }}
          >
            <RotateCcw className="size-3.5 mr-1.5" />
            Reboot
          </Button>
        </SettingsWithCTA>
      </SettingsSection>
    </div>
  )
}
