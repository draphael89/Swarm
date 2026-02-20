import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  MessageSquare,
  Plug,
  Save,
  TestTube2,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, SlackStatusEvent } from '@/lib/ws-types'

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface SettingsEnvVariable {
  name: string
  description?: string
  required: boolean
  helpUrl?: string
  skillName: string
  isSet: boolean
  maskedValue?: string
}

interface SlackSettingsConfig {
  enabled: boolean
  mode: 'socket'
  appToken: string | null
  botToken: string | null
  hasAppToken: boolean
  hasBotToken: boolean
  targetManagerId: string
  listen: {
    dm: boolean
    channelIds: string[]
    includePrivateChannels: boolean
  }
  response: {
    respondInThread: boolean
    replyBroadcast: boolean
    wakeWords: string[]
  }
  attachments: {
    maxFileBytes: number
    allowImages: boolean
    allowText: boolean
    allowBinary: boolean
  }
}

interface SlackChannelDescriptor {
  id: string
  name: string
  isPrivate: boolean
  isMember: boolean
}

interface SlackDraft {
  enabled: boolean
  appToken: string
  botToken: string
  targetManagerId: string
  listenDm: boolean
  channelIds: string[]
  includePrivateChannels: boolean
  respondInThread: boolean
  replyBroadcast: boolean
  wakeWords: string
  maxFileBytes: string
  allowImages: boolean
  allowText: boolean
  allowBinary: boolean
}

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  wsUrl: string
  managers: AgentDescriptor[]
  slackStatus?: SlackStatusEvent | null
}

/* ------------------------------------------------------------------ */
/*  API helpers                                                       */
/* ------------------------------------------------------------------ */

function resolveApiEndpoint(wsUrl: string, path: string): string {
  try {
    const parsed = new URL(wsUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = path
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return path
  }
}

function isSettingsEnvVariable(value: unknown): value is SettingsEnvVariable {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SettingsEnvVariable>
  return (
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    typeof v.skillName === 'string' &&
    v.skillName.trim().length > 0 &&
    typeof v.required === 'boolean' &&
    typeof v.isSet === 'boolean'
  )
}

function isSlackSettingsConfig(value: unknown): value is SlackSettingsConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<SlackSettingsConfig>

  return (
    typeof config.enabled === 'boolean' &&
    config.mode === 'socket' &&
    typeof config.hasAppToken === 'boolean' &&
    typeof config.hasBotToken === 'boolean' &&
    typeof config.targetManagerId === 'string' &&
    Boolean(config.listen) &&
    Boolean(config.response) &&
    Boolean(config.attachments)
  )
}

function isSlackChannelDescriptor(value: unknown): value is SlackChannelDescriptor {
  if (!value || typeof value !== 'object') return false
  const channel = value as Partial<SlackChannelDescriptor>
  return (
    typeof channel.id === 'string' &&
    channel.id.trim().length > 0 &&
    typeof channel.name === 'string' &&
    channel.name.trim().length > 0 &&
    typeof channel.isPrivate === 'boolean' &&
    typeof channel.isMember === 'boolean'
  )
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message
    }
  } catch {
    // Ignore JSON parsing failures and fall back to raw body.
  }

  try {
    const text = await response.text()
    if (text.trim().length > 0) {
      return text
    }
  } catch {
    // Ignore text parsing failures.
  }

  return `Request failed (${response.status})`
}

async function fetchSettingsEnvVariables(wsUrl: string): Promise<SettingsEnvVariable[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/env')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { variables?: unknown }
  if (!payload || !Array.isArray(payload.variables)) return []
  return payload.variables.filter(isSettingsEnvVariable)
}

async function updateSettingsEnvVariables(wsUrl: string, values: Record<string, string>): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/env')
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
}

async function deleteSettingsEnvVariable(wsUrl: string, variableName: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/env/${encodeURIComponent(variableName)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
}

async function fetchSlackSettings(wsUrl: string): Promise<{ config: SlackSettingsConfig; status: SlackStatusEvent | null }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/slack')
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as {
    config?: unknown
    status?: SlackStatusEvent
  }

  if (!isSlackSettingsConfig(payload.config)) {
    throw new Error('Invalid Slack settings response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status ?? null,
  }
}

async function updateSlackSettings(wsUrl: string, patch: Record<string, unknown>): Promise<{ config: SlackSettingsConfig; status: SlackStatusEvent | null }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/slack')
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as {
    config?: unknown
    status?: SlackStatusEvent
  }

  if (!isSlackSettingsConfig(payload.config)) {
    throw new Error('Invalid Slack settings response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status ?? null,
  }
}

async function disableSlackSettings(wsUrl: string): Promise<{ config: SlackSettingsConfig; status: SlackStatusEvent | null }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/slack')
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as {
    config?: unknown
    status?: SlackStatusEvent
  }

  if (!isSlackSettingsConfig(payload.config)) {
    throw new Error('Invalid Slack settings response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status ?? null,
  }
}

async function testSlackConnection(wsUrl: string, patch?: Record<string, unknown>): Promise<{ teamName?: string; teamId?: string; botUserId?: string }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/slack/test')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch ?? {}),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as {
    result?: {
      teamName?: string
      teamId?: string
      botUserId?: string
    }
  }

  return payload.result ?? {}
}

async function fetchSlackChannels(wsUrl: string, includePrivateChannels: boolean): Promise<SlackChannelDescriptor[]> {
  const endpoint = new URL(resolveApiEndpoint(wsUrl, '/api/integrations/slack/channels'))
  endpoint.searchParams.set('includePrivateChannels', includePrivateChannels ? 'true' : 'false')

  const response = await fetch(endpoint.toString())
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as { channels?: unknown }
  if (!Array.isArray(payload.channels)) {
    return []
  }

  return payload.channels.filter(isSlackChannelDescriptor)
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function StatusBadge({ isSet }: { isSet: boolean }) {
  if (isSet) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      >
        <Check className="size-3" />
        Set
      </Badge>
    )
  }

  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle className="size-3" />
      Missing
    </Badge>
  )
}

function SlackConnectionBadge({ status }: { status: SlackStatusEvent | null }) {
  const state = status?.state ?? 'disabled'

  const className =
    state === 'connected'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : state === 'connecting'
        ? 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400'
        : state === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border/50 bg-muted/50 text-muted-foreground'

  return (
    <Badge variant="outline" className={cn('capitalize', className)}>
      {state}
    </Badge>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex items-start gap-2 rounded-md border border-border/70 p-2">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        {description ? <span className="block text-[11px] text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  )
}

function EnvVariableRow({
  variable,
  draftValue,
  isRevealed,
  isSaving,
  isDeleting,
  onDraftChange,
  onToggleReveal,
  onSave,
  onDelete,
}: {
  variable: SettingsEnvVariable
  draftValue: string
  isRevealed: boolean
  isSaving: boolean
  isDeleting: boolean
  onDraftChange: (value: string) => void
  onToggleReveal: () => void
  onSave: () => void
  onDelete: () => void
}) {
  const busy = isSaving || isDeleting

  return (
    <div className="rounded-lg border border-border bg-card/50 p-4 transition-colors hover:bg-card/80">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <code className="text-[13px] font-semibold text-foreground">{variable.name}</code>
            <StatusBadge isSet={variable.isSet} />
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Required by</span>
            <Badge variant="secondary" className="px-1.5 py-0 text-[11px] font-medium">
              {variable.skillName}
            </Badge>
            {!variable.required && (
              <span className="text-[11px] italic text-muted-foreground/70">· optional</span>
            )}
          </div>
        </div>

        {variable.helpUrl ? (
          <a
            href={variable.helpUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Get key
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>

      {variable.description ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{variable.description}</p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={isRevealed ? 'text' : 'password'}
            placeholder={variable.isSet ? (variable.maskedValue ?? '••••••••') : 'Enter value…'}
            value={draftValue}
            onChange={(event) => onDraftChange(event.target.value)}
            className="pr-9 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <button
            type="button"
            onClick={onToggleReveal}
            disabled={busy}
            className={cn(
              'absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground/60 transition-colors',
              'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
            title={isRevealed ? 'Hide value' : 'Show value'}
          >
            {isRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={!draftValue.trim() || busy}
          className="gap-1.5"
        >
          {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          {isSaving ? 'Saving' : 'Save'}
        </Button>

        {variable.isSet ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            className="gap-1.5 text-muted-foreground hover:text-destructive"
          >
            {isDeleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            {isDeleting ? 'Removing' : 'Remove'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main dialog                                                       */
/* ------------------------------------------------------------------ */

export function SettingsDialog({ open, onOpenChange, wsUrl, managers, slackStatus }: SettingsDialogProps) {
  const [envVariables, setEnvVariables] = useState<SettingsEnvVariable[]>([])
  const [draftByName, setDraftByName] = useState<Record<string, string>>({})
  const [revealByName, setRevealByName] = useState<Record<string, boolean>>({})

  const [slackConfig, setSlackConfig] = useState<SlackSettingsConfig | null>(null)
  const [slackDraft, setSlackDraft] = useState<SlackDraft | null>(null)
  const [slackChannels, setSlackChannels] = useState<SlackChannelDescriptor[]>([])
  const [slackStatusFromApi, setSlackStatusFromApi] = useState<SlackStatusEvent | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [slackError, setSlackError] = useState<string | null>(null)
  const [slackSuccess, setSlackSuccess] = useState<string | null>(null)

  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingSlack, setIsLoadingSlack] = useState(false)
  const [savingVar, setSavingVar] = useState<string | null>(null)
  const [deletingVar, setDeletingVar] = useState<string | null>(null)
  const [isSavingSlack, setIsSavingSlack] = useState(false)
  const [isTestingSlack, setIsTestingSlack] = useState(false)
  const [isDisablingSlack, setIsDisablingSlack] = useState(false)
  const [isLoadingChannels, setIsLoadingChannels] = useState(false)

  const effectiveSlackStatus = slackStatus ?? slackStatusFromApi
  const managerOptions = useMemo(() => managers.filter((agent) => agent.role === 'manager'), [managers])

  const loadVariables = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await fetchSettingsEnvVariables(wsUrl)
      setEnvVariables(result)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setIsLoading(false)
    }
  }, [wsUrl])

  const loadSlack = useCallback(async () => {
    setIsLoadingSlack(true)
    setSlackError(null)

    try {
      const result = await fetchSlackSettings(wsUrl)
      setSlackConfig(result.config)
      setSlackDraft(toSlackDraft(result.config))
      setSlackStatusFromApi(result.status)
    } catch (err) {
      setSlackError(toErrorMessage(err))
    } finally {
      setIsLoadingSlack(false)
    }
  }, [wsUrl])

  useEffect(() => {
    if (!open) return
    void Promise.all([loadVariables(), loadSlack()])
  }, [open, loadVariables, loadSlack])

  const handleOpenChange = (next: boolean) => {
    if (!next && (savingVar || deletingVar || isSavingSlack || isTestingSlack || isDisablingSlack)) return
    if (!next) {
      setError(null)
      setSuccess(null)
      setSlackError(null)
      setSlackSuccess(null)
    }
    onOpenChange(next)
  }

  const handleSave = async (variableName: string) => {
    const value = draftByName[variableName]?.trim() ?? ''
    if (!value) {
      setError(`Enter a value for ${variableName} before saving.`)
      return
    }

    setError(null)
    setSuccess(null)
    setSavingVar(variableName)

    try {
      await updateSettingsEnvVariables(wsUrl, { [variableName]: value })
      setDraftByName((prev) => ({ ...prev, [variableName]: '' }))
      setSuccess(`${variableName} saved successfully.`)
      await loadVariables()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setSavingVar(null)
    }
  }

  const handleDelete = async (variableName: string) => {
    setError(null)
    setSuccess(null)
    setDeletingVar(variableName)

    try {
      await deleteSettingsEnvVariable(wsUrl, variableName)
      setDraftByName((prev) => ({ ...prev, [variableName]: '' }))
      setSuccess(`${variableName} removed.`)
      await loadVariables()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setDeletingVar(null)
    }
  }

  const handleSaveSlack = async () => {
    if (!slackDraft) {
      return
    }

    setSlackError(null)
    setSlackSuccess(null)
    setIsSavingSlack(true)

    try {
      const updated = await updateSlackSettings(wsUrl, buildSlackPatch(slackDraft))
      setSlackConfig(updated.config)
      setSlackDraft(toSlackDraft(updated.config))
      setSlackStatusFromApi(updated.status)
      setSlackSuccess('Slack settings saved.')
    } catch (error) {
      setSlackError(toErrorMessage(error))
    } finally {
      setIsSavingSlack(false)
    }
  }

  const handleTestSlack = async () => {
    if (!slackDraft) {
      return
    }

    setSlackError(null)
    setSlackSuccess(null)
    setIsTestingSlack(true)

    const patch: Record<string, unknown> = {}
    if (slackDraft.appToken.trim()) {
      patch.appToken = slackDraft.appToken.trim()
    }
    if (slackDraft.botToken.trim()) {
      patch.botToken = slackDraft.botToken.trim()
    }

    try {
      const result = await testSlackConnection(wsUrl, Object.keys(patch).length > 0 ? patch : undefined)
      const workspace = result.teamName ?? result.teamId ?? 'Slack workspace'
      const identity = result.botUserId ? ` as ${result.botUserId}` : ''
      setSlackSuccess(`Connected to ${workspace}${identity}.`)
      await loadSlack()
    } catch (error) {
      setSlackError(toErrorMessage(error))
    } finally {
      setIsTestingSlack(false)
    }
  }

  const handleDisableSlack = async () => {
    setSlackError(null)
    setSlackSuccess(null)
    setIsDisablingSlack(true)

    try {
      const disabled = await disableSlackSettings(wsUrl)
      setSlackConfig(disabled.config)
      setSlackDraft(toSlackDraft(disabled.config))
      setSlackStatusFromApi(disabled.status)
      setSlackSuccess('Slack integration disabled.')
    } catch (error) {
      setSlackError(toErrorMessage(error))
    } finally {
      setIsDisablingSlack(false)
    }
  }

  const handleLoadChannels = async () => {
    if (!slackDraft) {
      return
    }

    setSlackError(null)
    setIsLoadingChannels(true)

    try {
      const channels = await fetchSlackChannels(wsUrl, slackDraft.includePrivateChannels)
      setSlackChannels(channels)
      setSlackSuccess(`Loaded ${channels.length} channel${channels.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setSlackError(toErrorMessage(error))
    } finally {
      setIsLoadingChannels(false)
    }
  }

  const setCount = envVariables.filter((v) => v.isSet).length
  const totalCount = envVariables.length

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[700px]">
        <DialogHeader className="space-y-1 border-b border-border px-6 py-4">
          <DialogTitle className="text-base">Settings</DialogTitle>
          <DialogDescription>
            Configure runtime integrations and environment variables used by your agents.
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex-1 overflow-y-auto px-6 py-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--border) transparent' }}
        >
          <div className="space-y-6">
            <section className="space-y-3 rounded-lg border border-border bg-card/50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md bg-violet-500/10">
                    <MessageSquare className="size-3.5 text-violet-500" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold leading-tight">Slack integration</h3>
                    <p className="text-[11px] text-muted-foreground">Socket Mode + DM/channel routing</p>
                  </div>
                </div>
                <SlackConnectionBadge status={effectiveSlackStatus} />
              </div>

              {effectiveSlackStatus?.message ? (
                <p className="text-[11px] text-muted-foreground">{effectiveSlackStatus.message}</p>
              ) : null}

              {slackError ? (
                <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                  <p className="text-xs text-destructive">{slackError}</p>
                </div>
              ) : null}

              {slackSuccess ? (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
                  <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">{slackSuccess}</p>
                </div>
              ) : null}

              {isLoadingSlack || !slackDraft ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <ToggleRow
                      label="Enable Slack integration"
                      description="Slack stays opt-in until explicitly enabled."
                      checked={slackDraft.enabled}
                      onChange={(next) =>
                        setSlackDraft((prev) => (prev ? { ...prev, enabled: next } : prev))
                      }
                    />

                    <ToggleRow
                      label="Listen to DMs"
                      description="Handle message.im events as required replies."
                      checked={slackDraft.listenDm}
                      onChange={(next) =>
                        setSlackDraft((prev) => (prev ? { ...prev, listenDm: next } : prev))
                      }
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <ToggleRow
                      label="Respond in thread"
                      description="Reply in existing thread or start one when possible."
                      checked={slackDraft.respondInThread}
                      onChange={(next) =>
                        setSlackDraft((prev) => (prev ? { ...prev, respondInThread: next } : prev))
                      }
                    />

                    <ToggleRow
                      label="Reply broadcast"
                      description="Broadcast thread replies to channel (usually leave off)."
                      checked={slackDraft.replyBroadcast}
                      onChange={(next) =>
                        setSlackDraft((prev) => (prev ? { ...prev, replyBroadcast: next } : prev))
                      }
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <ToggleRow
                      label="Include private channels"
                      description="Allow private channel/group events and channel listing."
                      checked={slackDraft.includePrivateChannels}
                      onChange={(next) =>
                        setSlackDraft((prev) => (prev ? { ...prev, includePrivateChannels: next } : prev))
                      }
                    />

                    <ToggleRow
                      label="Allow image attachments"
                      description="Download inbound Slack images into Swarm attachments."
                      checked={slackDraft.allowImages}
                      onChange={(next) =>
                        setSlackDraft((prev) => (prev ? { ...prev, allowImages: next } : prev))
                      }
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <ToggleRow
                      label="Allow text attachments"
                      description="Include text/* files as prompt attachments."
                      checked={slackDraft.allowText}
                      onChange={(next) =>
                        setSlackDraft((prev) => (prev ? { ...prev, allowText: next } : prev))
                      }
                    />

                    <ToggleRow
                      label="Allow binary attachments"
                      description="Enable binary file ingestion (base64)."
                      checked={slackDraft.allowBinary}
                      onChange={(next) =>
                        setSlackDraft((prev) => (prev ? { ...prev, allowBinary: next } : prev))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Target manager</label>
                    <select
                      value={slackDraft.targetManagerId}
                      onChange={(event) =>
                        setSlackDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                targetManagerId: event.target.value,
                              }
                            : prev,
                        )
                      }
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {managerOptions.length === 0 ? (
                        <option value={slackDraft.targetManagerId || 'manager'}>{slackDraft.targetManagerId || 'manager'}</option>
                      ) : (
                        managerOptions.map((manager) => (
                          <option key={manager.agentId} value={manager.agentId}>
                            {manager.agentId}
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">App token (xapp-…)</label>
                      <Input
                        type="password"
                        value={slackDraft.appToken}
                        onChange={(event) =>
                          setSlackDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  appToken: event.target.value,
                                }
                              : prev,
                          )
                        }
                        placeholder={slackConfig?.appToken ?? 'xapp-...'}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {slackConfig?.hasAppToken ? 'Token saved. Enter a new value to rotate.' : 'Token not set yet.'}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Bot token (xoxb-…)</label>
                      <Input
                        type="password"
                        value={slackDraft.botToken}
                        onChange={(event) =>
                          setSlackDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  botToken: event.target.value,
                                }
                              : prev,
                          )
                        }
                        placeholder={slackConfig?.botToken ?? 'xoxb-...'}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {slackConfig?.hasBotToken ? 'Token saved. Enter a new value to rotate.' : 'Token not set yet.'}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Wake words</label>
                      <Input
                        value={slackDraft.wakeWords}
                        onChange={(event) =>
                          setSlackDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  wakeWords: event.target.value,
                                }
                              : prev,
                          )
                        }
                        placeholder="swarm, bot"
                      />
                      <p className="text-[11px] text-muted-foreground">Comma separated wake words for channel heuristics.</p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Max attachment size (bytes)</label>
                      <Input
                        value={slackDraft.maxFileBytes}
                        onChange={(event) =>
                          setSlackDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  maxFileBytes: event.target.value,
                                }
                              : prev,
                          )
                        }
                        placeholder="10485760"
                        inputMode="numeric"
                      />
                    </div>
                  </div>

                  <div className="space-y-2 rounded-md border border-border/70 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium">Channel picker</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleLoadChannels()}
                        disabled={isLoadingChannels}
                      >
                        {isLoadingChannels ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
                        {isLoadingChannels ? 'Loading...' : 'Refresh channels'}
                      </Button>
                    </div>

                    <Input
                      value={slackDraft.channelIds.join(', ')}
                      onChange={(event) =>
                        setSlackDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                channelIds: parseCommaSeparated(event.target.value),
                              }
                            : prev,
                        )
                      }
                      placeholder="C12345, C23456"
                    />

                    {slackChannels.length > 0 ? (
                      <div className="max-h-40 space-y-1 overflow-auto rounded border border-border/60 p-2">
                        {slackChannels.map((channel) => {
                          const checked = slackDraft.channelIds.includes(channel.id)

                          return (
                            <label key={channel.id} className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) =>
                                  setSlackDraft((prev) => {
                                    if (!prev) return prev

                                    const nextIds = new Set(prev.channelIds)
                                    if (event.target.checked) {
                                      nextIds.add(channel.id)
                                    } else {
                                      nextIds.delete(channel.id)
                                    }

                                    return {
                                      ...prev,
                                      channelIds: [...nextIds],
                                    }
                                  })
                                }
                              />
                              <span className="font-medium">#{channel.name}</span>
                              <span className="font-mono text-muted-foreground">({channel.id})</span>
                              {!channel.isMember ? (
                                <span className="text-muted-foreground">not joined</span>
                              ) : null}
                            </label>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">No channel list loaded yet. Use Refresh channels.</p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleTestSlack()}
                      disabled={isTestingSlack}
                      className="gap-1.5"
                    >
                      {isTestingSlack ? <Loader2 className="size-3.5 animate-spin" /> : <TestTube2 className="size-3.5" />}
                      {isTestingSlack ? 'Testing...' : 'Test connection'}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleDisableSlack()}
                      disabled={isDisablingSlack}
                      className="gap-1.5"
                    >
                      {isDisablingSlack ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                      {isDisablingSlack ? 'Disabling...' : 'Disable'}
                    </Button>

                    <Button
                      type="button"
                      onClick={() => void handleSaveSlack()}
                      disabled={isSavingSlack}
                      className="gap-1.5"
                    >
                      {isSavingSlack ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      {isSavingSlack ? 'Saving...' : 'Save Slack settings'}
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <section>
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md bg-primary/10">
                    <KeyRound className="size-3.5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold leading-tight">Environment Variables</h3>
                    {!isLoading && totalCount > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        {setCount} of {totalCount} configured
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {error ? (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                  <p className="text-xs text-destructive">{error}</p>
                </div>
              ) : null}

              {success ? (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
                  <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">{success}</p>
                </div>
              ) : null}

              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : envVariables.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
                  <KeyRound className="mb-2 size-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">No environment variables found</p>
                  <p className="mt-1 text-xs text-muted-foreground/60">
                    Install skills that declare environment variables to configure them here.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {envVariables.map((variable) => (
                    <EnvVariableRow
                      key={`${variable.skillName}:${variable.name}`}
                      variable={variable}
                      draftValue={draftByName[variable.name] ?? ''}
                      isRevealed={revealByName[variable.name] === true}
                      isSaving={savingVar === variable.name}
                      isDeleting={deletingVar === variable.name}
                      onDraftChange={(value) => {
                        setDraftByName((prev) => ({ ...prev, [variable.name]: value }))
                        setError(null)
                        setSuccess(null)
                      }}
                      onToggleReveal={() =>
                        setRevealByName((prev) => ({ ...prev, [variable.name]: !prev[variable.name] }))
                      }
                      onSave={() => void handleSave(variable.name)}
                      onDelete={() => void handleDelete(variable.name)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>

        <div className="border-t border-border px-6 py-3">
          <p className="text-[11px] text-muted-foreground">
            Values are stored locally in your swarm data directory and loaded by the daemon at runtime.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function toSlackDraft(config: SlackSettingsConfig): SlackDraft {
  return {
    enabled: config.enabled,
    appToken: '',
    botToken: '',
    targetManagerId: config.targetManagerId,
    listenDm: config.listen.dm,
    channelIds: [...config.listen.channelIds],
    includePrivateChannels: config.listen.includePrivateChannels,
    respondInThread: config.response.respondInThread,
    replyBroadcast: config.response.replyBroadcast,
    wakeWords: config.response.wakeWords.join(', '),
    maxFileBytes: String(config.attachments.maxFileBytes),
    allowImages: config.attachments.allowImages,
    allowText: config.attachments.allowText,
    allowBinary: config.attachments.allowBinary,
  }
}

function buildSlackPatch(draft: SlackDraft): Record<string, unknown> {
  const maxFileBytes = Number.parseInt(draft.maxFileBytes, 10)

  const patch: Record<string, unknown> = {
    enabled: draft.enabled,
    targetManagerId: draft.targetManagerId.trim() || 'manager',
    listen: {
      dm: draft.listenDm,
      channelIds: [...new Set(draft.channelIds.map((id) => id.trim()).filter(Boolean))],
      includePrivateChannels: draft.includePrivateChannels,
    },
    response: {
      respondInThread: draft.respondInThread,
      replyBroadcast: draft.replyBroadcast,
      wakeWords: parseCommaSeparated(draft.wakeWords).map((word) => word.toLowerCase()),
    },
    attachments: {
      maxFileBytes: Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 10 * 1024 * 1024,
      allowImages: draft.allowImages,
      allowText: draft.allowText,
      allowBinary: draft.allowBinary,
    },
  }

  if (draft.appToken.trim()) {
    patch.appToken = draft.appToken.trim()
  }

  if (draft.botToken.trim()) {
    patch.botToken = draft.botToken.trim()
  }

  return patch
}

function parseCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}
