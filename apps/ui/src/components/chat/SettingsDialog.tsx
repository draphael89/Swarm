import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Mail,
  MessageSquare,
  Monitor,
  Moon,
  Plug,
  Save,
  Send,
  Sun,
  TestTube2,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
} from '@/lib/theme'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, SlackStatusEvent, TelegramStatusEvent } from '@/lib/ws-types'

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

type SettingsAuthProviderId = 'anthropic' | 'openai-codex'

interface SettingsAuthProvider {
  provider: SettingsAuthProviderId
  configured: boolean
  authType?: 'api_key' | 'oauth' | 'unknown'
  maskedValue?: string
}

type SettingsAuthOAuthFlowStatus =
  | 'idle'
  | 'starting'
  | 'waiting_for_auth'
  | 'waiting_for_code'
  | 'complete'
  | 'error'

interface SettingsAuthOAuthFlowState {
  status: SettingsAuthOAuthFlowStatus
  authUrl?: string
  instructions?: string
  promptMessage?: string
  promptPlaceholder?: string
  progressMessage?: string
  errorMessage?: string
  codeValue: string
  isSubmittingCode: boolean
}

interface SlackSettingsConfig {
  profileId: string
  enabled: boolean
  mode: 'socket'
  appToken: string | null
  botToken: string | null
  hasAppToken: boolean
  hasBotToken: boolean
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
  listenDm: boolean
  channelIds: string[]
  includePrivateChannels: boolean
  respondInThread: boolean
  replyBroadcast: boolean
  maxFileBytes: string
  allowImages: boolean
  allowText: boolean
  allowBinary: boolean
}

interface TelegramSettingsConfig {
  profileId: string
  enabled: boolean
  mode: 'polling'
  botToken: string | null
  hasBotToken: boolean
  allowedUserIds: string[]
  polling: {
    timeoutSeconds: number
    limit: number
    dropPendingUpdatesOnStart: boolean
  }
  delivery: {
    parseMode: 'HTML'
    disableLinkPreview: boolean
    replyToInboundMessageByDefault: boolean
  }
  attachments: {
    maxFileBytes: number
    allowImages: boolean
    allowText: boolean
    allowBinary: boolean
  }
}

interface TelegramDraft {
  enabled: boolean
  botToken: string
  allowedUserIds: string[]
  timeoutSeconds: string
  limit: string
  dropPendingUpdatesOnStart: boolean
  disableLinkPreview: boolean
  replyToInboundMessageByDefault: boolean
  maxFileBytes: string
  allowImages: boolean
  allowText: boolean
  allowBinary: boolean
}

type GsuiteIntegrationState = 'disabled' | 'ready' | 'connected' | 'error'

interface GsuiteSettingsConfig {
  enabled: boolean
  accountEmail: string
  services: string[]
  hasOAuthClientCredentials: boolean
  lastConnectedAt: string | null
  updatedAt: string
}

interface GsuiteSettingsStatus {
  state: GsuiteIntegrationState
  enabled: boolean
  gogInstalled: boolean
  gogVersion?: string
  connected: boolean
  accountEmail: string
  message: string
  updatedAt: string
}

interface GsuiteDraft {
  enabled: boolean
  accountEmail: string
  services: string[]
  oauthClientJson: string
  redirectUrl: string
}

interface SettingsPanelProps {
  wsUrl: string
  managers: AgentDescriptor[]
  slackStatus?: SlackStatusEvent | null
  telegramStatus?: TelegramStatusEvent | null
  onBack?: () => void
}

const SETTINGS_AUTH_PROVIDER_META: Record<
  SettingsAuthProviderId,
  { label: string; description: string; placeholder: string; helpUrl: string }
> = {
  anthropic: {
    label: 'Anthropic API key',
    description: 'Used by pi-opus and Anthropic-backed managers/workers.',
    placeholder: 'sk-ant-...',
    helpUrl: 'https://console.anthropic.com/settings/keys',
  },
  'openai-codex': {
    label: 'OpenAI API key',
    description: 'Used for Codex runtime sessions and voice transcription.',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.openai.com/api-keys',
  },
}

const SETTINGS_AUTH_PROVIDER_ORDER: SettingsAuthProviderId[] = ['anthropic', 'openai-codex']

const DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE: SettingsAuthOAuthFlowState = {
  status: 'idle',
  codeValue: '',
  isSubmittingCode: false,
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

function normalizeSettingsAuthProviderId(value: unknown): SettingsAuthProviderId | undefined {
  if (value === 'anthropic') return 'anthropic'
  if (value === 'openai' || value === 'openai-codex') return 'openai-codex'
  return undefined
}

function parseSettingsAuthProvider(value: unknown): SettingsAuthProvider | null {
  if (!value || typeof value !== 'object') return null
  const provider = value as {
    provider?: unknown
    configured?: unknown
    authType?: unknown
    maskedValue?: unknown
  }

  const providerId = normalizeSettingsAuthProviderId(provider.provider)
  if (!providerId || typeof provider.configured !== 'boolean') {
    return null
  }

  if (
    provider.authType !== undefined &&
    provider.authType !== 'api_key' &&
    provider.authType !== 'oauth' &&
    provider.authType !== 'unknown'
  ) {
    return null
  }

  return {
    provider: providerId,
    configured: provider.configured,
    authType: provider.authType,
    maskedValue: typeof provider.maskedValue === 'string' ? provider.maskedValue : undefined,
  }
}

function isSlackSettingsConfig(value: unknown): value is SlackSettingsConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<SlackSettingsConfig>

  return (
    typeof config.profileId === 'string' &&
    typeof config.enabled === 'boolean' &&
    config.mode === 'socket' &&
    typeof config.hasAppToken === 'boolean' &&
    typeof config.hasBotToken === 'boolean' &&
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

function isTelegramSettingsConfig(value: unknown): value is TelegramSettingsConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<TelegramSettingsConfig>
  const hasValidAllowedUserIds =
    config.allowedUserIds === undefined ||
    (Array.isArray(config.allowedUserIds) &&
      config.allowedUserIds.every((entry) => typeof entry === 'string'))

  return (
    typeof config.profileId === 'string' &&
    typeof config.enabled === 'boolean' &&
    config.mode === 'polling' &&
    typeof config.hasBotToken === 'boolean' &&
    hasValidAllowedUserIds &&
    Boolean(config.polling) &&
    Boolean(config.delivery) &&
    Boolean(config.attachments)
  )
}

function isGsuiteSettingsConfig(value: unknown): value is GsuiteSettingsConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<GsuiteSettingsConfig>

  return (
    typeof config.enabled === 'boolean' &&
    typeof config.accountEmail === 'string' &&
    Array.isArray(config.services) &&
    typeof config.hasOAuthClientCredentials === 'boolean' &&
    (config.lastConnectedAt === null || typeof config.lastConnectedAt === 'string') &&
    typeof config.updatedAt === 'string'
  )
}

function isGsuiteSettingsStatus(value: unknown): value is GsuiteSettingsStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Partial<GsuiteSettingsStatus>

  return (
    (status.state === 'disabled' ||
      status.state === 'ready' ||
      status.state === 'connected' ||
      status.state === 'error') &&
    typeof status.enabled === 'boolean' &&
    typeof status.gogInstalled === 'boolean' &&
    typeof status.connected === 'boolean' &&
    typeof status.accountEmail === 'string' &&
    typeof status.message === 'string' &&
    typeof status.updatedAt === 'string'
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

async function fetchSettingsAuthProviders(wsUrl: string): Promise<SettingsAuthProvider[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/auth')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))

  const payload = (await response.json()) as { providers?: unknown }
  if (!payload || !Array.isArray(payload.providers)) return []

  const parsed = payload.providers
    .map((value) => parseSettingsAuthProvider(value))
    .filter((value): value is SettingsAuthProvider => value !== null)
  const configuredByProvider = new Map(parsed.map((entry) => [entry.provider, entry]))

  return SETTINGS_AUTH_PROVIDER_ORDER.map(
    (provider) =>
      configuredByProvider.get(provider) ?? {
        provider,
        configured: false,
      },
  )
}

async function updateSettingsAuthProviders(wsUrl: string, values: Partial<Record<SettingsAuthProviderId, string>>): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/auth')
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
}

async function deleteSettingsAuthProvider(wsUrl: string, provider: SettingsAuthProviderId): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/auth/${encodeURIComponent(provider)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
}

interface SettingsAuthOAuthAuthUrlEvent {
  url: string
  instructions?: string
}

interface SettingsAuthOAuthPromptEvent {
  message: string
  placeholder?: string
}

interface SettingsAuthOAuthProgressEvent {
  message: string
}

interface SettingsAuthOAuthCompleteEvent {
  provider: SettingsAuthProviderId
  status: 'connected'
}

interface SettingsAuthOAuthStreamHandlers {
  onAuthUrl: (event: SettingsAuthOAuthAuthUrlEvent) => void
  onPrompt: (event: SettingsAuthOAuthPromptEvent) => void
  onProgress: (event: SettingsAuthOAuthProgressEvent) => void
  onComplete: (event: SettingsAuthOAuthCompleteEvent) => void
  onError: (message: string) => void
}

function parseSettingsAuthOAuthEventData(rawData: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawData)
  } catch {
    throw new Error('Invalid OAuth event payload received from backend.')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid OAuth event payload received from backend.')
  }

  return parsed as Record<string, unknown>
}

function createIdleSettingsAuthOAuthFlowState(): SettingsAuthOAuthFlowState {
  return {
    ...DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE,
  }
}

async function startSettingsAuthOAuthLoginStream(
  wsUrl: string,
  provider: SettingsAuthProviderId,
  handlers: SettingsAuthOAuthStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/auth/login/${encodeURIComponent(provider)}`)
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  if (!response.body) {
    throw new Error('OAuth login stream is unavailable.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let eventName = 'message'
  let eventDataLines: string[] = []

  const flushEvent = (): void => {
    if (eventDataLines.length === 0) {
      eventName = 'message'
      return
    }

    const rawData = eventDataLines.join('\n')
    eventDataLines = []

    if (eventName === 'auth_url') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.url !== 'string' || !payload.url.trim()) {
        throw new Error('OAuth auth_url event is missing a URL.')
      }

      handlers.onAuthUrl({
        url: payload.url,
        instructions: typeof payload.instructions === 'string' ? payload.instructions : undefined,
      })
      eventName = 'message'
      return
    }

    if (eventName === 'prompt') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message !== 'string' || !payload.message.trim()) {
        throw new Error('OAuth prompt event is missing a message.')
      }

      handlers.onPrompt({
        message: payload.message,
        placeholder: typeof payload.placeholder === 'string' ? payload.placeholder : undefined,
      })
      eventName = 'message'
      return
    }

    if (eventName === 'progress') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message === 'string' && payload.message.trim()) {
        handlers.onProgress({ message: payload.message })
      }
      eventName = 'message'
      return
    }

    if (eventName === 'complete') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const providerId = normalizeSettingsAuthProviderId(payload.provider)
      if (!providerId || payload.status !== 'connected') {
        throw new Error('OAuth complete event payload is invalid.')
      }

      handlers.onComplete({
        provider: providerId,
        status: 'connected',
      })
      eventName = 'message'
      return
    }

    if (eventName === 'error') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const message =
        typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : 'OAuth login failed.'
      handlers.onError(message)
      eventName = 'message'
      return
    }

    eventName = 'message'
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    lineBuffer += decoder.decode(value, { stream: true })

    let newlineIndex = lineBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      let line = lineBuffer.slice(0, newlineIndex)
      lineBuffer = lineBuffer.slice(newlineIndex + 1)

      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }

      if (!line) {
        flushEvent()
      } else if (line.startsWith(':')) {
        // Ignore comments/keepalive markers.
      } else if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        eventDataLines.push(line.slice('data:'.length).trimStart())
      }

      newlineIndex = lineBuffer.indexOf('\n')
    }
  }

  flushEvent()
}

async function submitSettingsAuthOAuthPrompt(
  wsUrl: string,
  provider: SettingsAuthProviderId,
  value: string,
): Promise<void> {
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/settings/auth/login/${encodeURIComponent(provider)}/respond`,
  )

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
}

function resolveManagerIntegrationEndpoint(
  wsUrl: string,
  managerId: string,
  provider: 'slack' | 'telegram',
  suffix = '',
): string {
  const normalizedManagerId = managerId.trim() || 'manager'
  return resolveApiEndpoint(
    wsUrl,
    `/api/managers/${encodeURIComponent(normalizedManagerId)}/integrations/${provider}${suffix}`,
  )
}

async function fetchSlackSettings(
  wsUrl: string,
  managerId: string,
): Promise<{ config: SlackSettingsConfig; status: SlackStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack')
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

async function updateSlackSettings(
  wsUrl: string,
  managerId: string,
  patch: Record<string, unknown>,
): Promise<{ config: SlackSettingsConfig; status: SlackStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack')
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

async function disableSlackSettings(
  wsUrl: string,
  managerId: string,
): Promise<{ config: SlackSettingsConfig; status: SlackStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack')
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

async function testSlackConnection(
  wsUrl: string,
  managerId: string,
  patch?: Record<string, unknown>,
): Promise<{ teamName?: string; teamId?: string; botUserId?: string }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack', '/test')
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

async function fetchSlackChannels(
  wsUrl: string,
  managerId: string,
  includePrivateChannels: boolean,
): Promise<SlackChannelDescriptor[]> {
  const endpoint = new URL(resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack', '/channels'))
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

async function fetchTelegramSettings(
  wsUrl: string,
  managerId: string,
): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'telegram')
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as {
    config?: unknown
    status?: TelegramStatusEvent
  }

  if (!isTelegramSettingsConfig(payload.config)) {
    throw new Error('Invalid Telegram settings response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status ?? null,
  }
}

async function updateTelegramSettings(
  wsUrl: string,
  managerId: string,
  patch: Record<string, unknown>,
): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'telegram')
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
    status?: TelegramStatusEvent
  }

  if (!isTelegramSettingsConfig(payload.config)) {
    throw new Error('Invalid Telegram settings response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status ?? null,
  }
}

async function disableTelegramSettings(
  wsUrl: string,
  managerId: string,
): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'telegram')
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as {
    config?: unknown
    status?: TelegramStatusEvent
  }

  if (!isTelegramSettingsConfig(payload.config)) {
    throw new Error('Invalid Telegram settings response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status ?? null,
  }
}

async function testTelegramConnection(
  wsUrl: string,
  managerId: string,
  patch?: Record<string, unknown>,
): Promise<{ botId?: string; botUsername?: string; botDisplayName?: string }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'telegram', '/test')
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
      botId?: string
      botUsername?: string
      botDisplayName?: string
    }
  }

  return payload.result ?? {}
}

async function fetchGsuiteSettings(
  wsUrl: string,
): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite')
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as {
    config?: unknown
    status?: unknown
  }

  if (!isGsuiteSettingsConfig(payload.config) || !isGsuiteSettingsStatus(payload.status)) {
    throw new Error('Invalid G Suite settings response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status,
  }
}

async function updateGsuiteSettings(
  wsUrl: string,
  patch: Record<string, unknown>,
): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite')
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
    status?: unknown
  }

  if (!isGsuiteSettingsConfig(payload.config) || !isGsuiteSettingsStatus(payload.status)) {
    throw new Error('Invalid G Suite settings response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status,
  }
}

async function disableGsuiteSettings(
  wsUrl: string,
): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite')
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as {
    config?: unknown
    status?: unknown
  }

  if (!isGsuiteSettingsConfig(payload.config) || !isGsuiteSettingsStatus(payload.status)) {
    throw new Error('Invalid G Suite settings response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status,
  }
}

async function submitGsuiteOAuthCredentials(
  wsUrl: string,
  oauthClientJson: string,
): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite/oauth/credentials')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oauthClientJson }),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as {
    config?: unknown
    status?: unknown
  }

  if (!isGsuiteSettingsConfig(payload.config) || !isGsuiteSettingsStatus(payload.status)) {
    throw new Error('Invalid G Suite credentials response from backend.')
  }

  return {
    config: payload.config,
    status: payload.status,
  }
}

async function startGsuiteOAuth(
  wsUrl: string,
  payload: { email?: string; services?: string[] },
): Promise<{
  config: GsuiteSettingsConfig
  status: GsuiteSettingsStatus
  result: { authUrl: string; instructions?: string }
}> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite/oauth/start')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const body = (await response.json()) as {
    config?: unknown
    status?: unknown
    result?: {
      authUrl?: unknown
      instructions?: unknown
    }
  }

  if (!isGsuiteSettingsConfig(body.config) || !isGsuiteSettingsStatus(body.status)) {
    throw new Error('Invalid G Suite OAuth start response from backend.')
  }

  const authUrl = typeof body.result?.authUrl === 'string' ? body.result.authUrl : ''
  if (!authUrl.trim()) {
    throw new Error('Backend did not return a Google authorization URL.')
  }

  return {
    config: body.config,
    status: body.status,
    result: {
      authUrl,
      instructions: typeof body.result?.instructions === 'string' ? body.result.instructions : undefined,
    },
  }
}

async function completeGsuiteOAuth(
  wsUrl: string,
  payload: { email?: string; authUrl: string; services?: string[] },
): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite/oauth/complete')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const body = (await response.json()) as {
    config?: unknown
    status?: unknown
  }

  if (!isGsuiteSettingsConfig(body.config) || !isGsuiteSettingsStatus(body.status)) {
    throw new Error('Invalid G Suite OAuth complete response from backend.')
  }

  return {
    config: body.config,
    status: body.status,
  }
}

async function testGsuiteConnection(
  wsUrl: string,
  payload: { email?: string },
): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite/test')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const body = (await response.json()) as {
    config?: unknown
    status?: unknown
  }

  if (!isGsuiteSettingsConfig(body.config) || !isGsuiteSettingsStatus(body.status)) {
    throw new Error('Invalid G Suite test response from backend.')
  }

  return {
    config: body.config,
    status: body.status,
  }
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

function AuthStatusBadge({ configured }: { configured: boolean }) {
  if (configured) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      >
        <Check className="size-3" />
        Configured
      </Badge>
    )
  }

  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle className="size-3" />
      Not configured
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

function TelegramConnectionBadge({ status }: { status: TelegramStatusEvent | null }) {
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

function GsuiteConnectionBadge({ status }: { status: GsuiteSettingsStatus | null }) {
  const state = status?.state ?? 'disabled'

  const className =
    state === 'connected'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : state === 'ready'
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
  const switchId = useId()

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/70 p-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={switchId} className="text-xs font-medium text-foreground">
          {label}
        </Label>
        {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={switchId} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function AuthProviderRow({
  provider,
  authStatus,
  draftValue,
  isRevealed,
  isSaving,
  isDeleting,
  oauthFlow,
  onDraftChange,
  onToggleReveal,
  onSave,
  onDelete,
  onStartOAuth,
  onOAuthCodeChange,
  onSubmitOAuthCode,
  onResetOAuth,
}: {
  provider: SettingsAuthProviderId
  authStatus: SettingsAuthProvider
  draftValue: string
  isRevealed: boolean
  isSaving: boolean
  isDeleting: boolean
  oauthFlow: SettingsAuthOAuthFlowState
  onDraftChange: (value: string) => void
  onToggleReveal: () => void
  onSave: () => void
  onDelete: () => void
  onStartOAuth: () => void
  onOAuthCodeChange: (value: string) => void
  onSubmitOAuthCode: () => void
  onResetOAuth: () => void
}) {
  const metadata = SETTINGS_AUTH_PROVIDER_META[provider]
  const busy = isSaving || isDeleting
  const oauthInProgress =
    oauthFlow.status === 'starting' ||
    oauthFlow.status === 'waiting_for_auth' ||
    oauthFlow.status === 'waiting_for_code'

  return (
    <div className="rounded-lg border border-border bg-card/50 p-4 transition-colors hover:bg-card/80">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-semibold text-foreground">{metadata.label}</p>
            <AuthStatusBadge configured={authStatus.configured} />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{metadata.description}</p>
          {authStatus.configured ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Stored credential: <code className="font-mono">{authStatus.maskedValue ?? '********'}</code>
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">No credential stored yet.</p>
          )}
        </div>

        <a
          href={metadata.helpUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Get key
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={isRevealed ? 'text' : 'password'}
            placeholder={authStatus.configured ? (authStatus.maskedValue ?? metadata.placeholder) : metadata.placeholder}
            value={draftValue}
            onChange={(event) => onDraftChange(event.target.value)}
            className="pr-9 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleReveal}
            disabled={busy}
            className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"
            title={isRevealed ? 'Hide value' : 'Show value'}
          >
            {isRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
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

        {authStatus.configured ? (
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

      <div className="mt-4">
        <Separator className="mb-3" />

        <div className="space-y-2 rounded-md border border-border/70 bg-background/40 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">OAuth login</p>
              <p className="text-[11px] text-muted-foreground">
                Authorize in your browser and store refresh/access tokens automatically.
              </p>
            </div>

            <div className="flex items-center gap-2">
              {oauthFlow.status === 'complete' ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                >
                  <Check className="size-3" />
                  Connected
                </Badge>
              ) : null}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onStartOAuth}
                disabled={busy || oauthInProgress || oauthFlow.isSubmittingCode}
                className="gap-1.5"
              >
                {oauthInProgress ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                {oauthInProgress ? 'Authorizing...' : 'Login with OAuth'}
              </Button>
            </div>
          </div>

          {oauthFlow.authUrl ? (
            <a
              href={oauthFlow.authUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-primary hover:bg-muted/50"
            >
              Open authorization URL
              <ExternalLink className="size-3" />
            </a>
          ) : null}

          {oauthFlow.instructions ? (
            <p className="text-[11px] text-muted-foreground">{oauthFlow.instructions}</p>
          ) : null}

          {oauthFlow.progressMessage ? (
            <p className="text-[11px] text-muted-foreground">{oauthFlow.progressMessage}</p>
          ) : null}

          {oauthFlow.status === 'waiting_for_code' ? (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                {oauthFlow.promptMessage ?? 'Paste the authorization code to continue.'}
              </p>

              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  placeholder={oauthFlow.promptPlaceholder ?? 'Paste authorization code or URL'}
                  value={oauthFlow.codeValue}
                  onChange={(event) => onOAuthCodeChange(event.target.value)}
                  disabled={busy || oauthFlow.isSubmittingCode}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />

                <Button
                  type="button"
                  size="sm"
                  onClick={onSubmitOAuthCode}
                  disabled={!oauthFlow.codeValue.trim() || busy || oauthFlow.isSubmittingCode}
                  className="gap-1.5"
                >
                  {oauthFlow.isSubmittingCode ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  {oauthFlow.isSubmittingCode ? 'Submitting...' : 'Submit'}
                </Button>
              </div>
            </div>
          ) : null}

          {oauthFlow.errorMessage ? (
            <p className="text-[11px] text-destructive">{oauthFlow.errorMessage}</p>
          ) : null}

          {(oauthFlow.status === 'complete' || oauthFlow.status === 'error') && !oauthInProgress ? (
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={onResetOAuth}>
                Clear
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleReveal}
            disabled={busy}
            className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"
            title={isRevealed ? 'Hide value' : 'Show value'}
          >
            {isRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
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
/*  Main panel                                                        */
/* ------------------------------------------------------------------ */

export function SettingsPanel({
  wsUrl,
  managers,
  slackStatus,
  telegramStatus,
  onBack,
}: SettingsPanelProps) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readStoredThemePreference())
  const [envVariables, setEnvVariables] = useState<SettingsEnvVariable[]>([])
  const [draftByName, setDraftByName] = useState<Record<string, string>>({})
  const [revealByName, setRevealByName] = useState<Record<string, boolean>>({})
  const [authProviders, setAuthProviders] = useState<SettingsAuthProvider[]>([])
  const [authDraftByProvider, setAuthDraftByProvider] = useState<Partial<Record<SettingsAuthProviderId, string>>>({})
  const [authRevealByProvider, setAuthRevealByProvider] = useState<Partial<Record<SettingsAuthProviderId, boolean>>>({})
  const [oauthFlowByProvider, setOauthFlowByProvider] = useState<
    Partial<Record<SettingsAuthProviderId, SettingsAuthOAuthFlowState>>
  >({})
  const oauthAbortControllerByProviderRef = useRef<
    Partial<Record<SettingsAuthProviderId, AbortController>>
  >({})

  const [slackConfig, setSlackConfig] = useState<SlackSettingsConfig | null>(null)
  const [slackDraft, setSlackDraft] = useState<SlackDraft | null>(null)
  const [slackChannels, setSlackChannels] = useState<SlackChannelDescriptor[]>([])
  const [slackStatusFromApi, setSlackStatusFromApi] = useState<SlackStatusEvent | null>(null)
  const [telegramConfig, setTelegramConfig] = useState<TelegramSettingsConfig | null>(null)
  const [telegramDraft, setTelegramDraft] = useState<TelegramDraft | null>(null)
  const [telegramStatusFromApi, setTelegramStatusFromApi] = useState<TelegramStatusEvent | null>(null)
  const [gsuiteConfig, setGsuiteConfig] = useState<GsuiteSettingsConfig | null>(null)
  const [gsuiteDraft, setGsuiteDraft] = useState<GsuiteDraft | null>(null)
  const [gsuiteStatus, setGsuiteStatus] = useState<GsuiteSettingsStatus | null>(null)
  const [gsuiteAuthUrl, setGsuiteAuthUrl] = useState<string | null>(null)
  const [gsuiteInstructions, setGsuiteInstructions] = useState<string | null>(null)

  const [authError, setAuthError] = useState<string | null>(null)
  const [authSuccess, setAuthSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [slackError, setSlackError] = useState<string | null>(null)
  const [slackSuccess, setSlackSuccess] = useState<string | null>(null)
  const [telegramError, setTelegramError] = useState<string | null>(null)
  const [telegramSuccess, setTelegramSuccess] = useState<string | null>(null)
  const [gsuiteError, setGsuiteError] = useState<string | null>(null)
  const [gsuiteSuccess, setGsuiteSuccess] = useState<string | null>(null)

  const [isLoadingAuth, setIsLoadingAuth] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingSlack, setIsLoadingSlack] = useState(false)
  const [savingAuthProvider, setSavingAuthProvider] = useState<SettingsAuthProviderId | null>(null)
  const [deletingAuthProvider, setDeletingAuthProvider] = useState<SettingsAuthProviderId | null>(null)
  const [savingVar, setSavingVar] = useState<string | null>(null)
  const [deletingVar, setDeletingVar] = useState<string | null>(null)
  const [isSavingSlack, setIsSavingSlack] = useState(false)
  const [isTestingSlack, setIsTestingSlack] = useState(false)
  const [isDisablingSlack, setIsDisablingSlack] = useState(false)
  const [isLoadingChannels, setIsLoadingChannels] = useState(false)
  const [isLoadingTelegram, setIsLoadingTelegram] = useState(false)
  const [isSavingTelegram, setIsSavingTelegram] = useState(false)
  const [isTestingTelegram, setIsTestingTelegram] = useState(false)
  const [isDisablingTelegram, setIsDisablingTelegram] = useState(false)
  const [isLoadingGsuite, setIsLoadingGsuite] = useState(false)
  const [isSavingGsuite, setIsSavingGsuite] = useState(false)
  const [isConnectingGsuite, setIsConnectingGsuite] = useState(false)
  const [isCompletingGsuite, setIsCompletingGsuite] = useState(false)
  const [isTestingGsuite, setIsTestingGsuite] = useState(false)
  const [isDisablingGsuite, setIsDisablingGsuite] = useState(false)

  const managerOptions = useMemo(
    () =>
      managers.filter(
        (agent) =>
          agent.role === 'manager' &&
          agent.status !== 'terminated' &&
          agent.status !== 'stopped_on_restart',
      ),
    [managers],
  )
  const [selectedIntegrationManagerId, setSelectedIntegrationManagerId] = useState<string>('manager')
  const effectiveSlackStatus =
    slackStatus && (!slackStatus.managerId || slackStatus.managerId === selectedIntegrationManagerId)
      ? slackStatus
      : slackStatusFromApi
  const effectiveTelegramStatus =
    telegramStatus &&
    (!telegramStatus.managerId || telegramStatus.managerId === selectedIntegrationManagerId)
      ? telegramStatus
      : telegramStatusFromApi
  const authProviderById = useMemo(() => {
    return new Map(authProviders.map((entry) => [entry.provider, entry]))
  }, [authProviders])

  useEffect(() => {
    setSelectedIntegrationManagerId((previous) => {
      const availableIds = managerOptions.map((manager) => manager.agentId)
      if (availableIds.includes(previous)) {
        return previous
      }

      return availableIds[0] ?? 'manager'
    })
  }, [managerOptions])

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
      const result = await fetchSlackSettings(wsUrl, selectedIntegrationManagerId)
      setSlackConfig(result.config)
      setSlackDraft(toSlackDraft(result.config))
      setSlackStatusFromApi(result.status)
      setSlackChannels([])
    } catch (err) {
      setSlackError(toErrorMessage(err))
    } finally {
      setIsLoadingSlack(false)
    }
  }, [wsUrl, selectedIntegrationManagerId])

  const loadTelegram = useCallback(async () => {
    setIsLoadingTelegram(true)
    setTelegramError(null)

    try {
      const result = await fetchTelegramSettings(wsUrl, selectedIntegrationManagerId)
      setTelegramConfig(result.config)
      setTelegramDraft(toTelegramDraft(result.config))
      setTelegramStatusFromApi(result.status)
    } catch (err) {
      setTelegramError(toErrorMessage(err))
    } finally {
      setIsLoadingTelegram(false)
    }
  }, [wsUrl, selectedIntegrationManagerId])

  const loadGsuite = useCallback(async () => {
    setIsLoadingGsuite(true)
    setGsuiteError(null)

    try {
      const result = await fetchGsuiteSettings(wsUrl)
      setGsuiteConfig(result.config)
      setGsuiteDraft(toGsuiteDraft(result.config))
      setGsuiteStatus(result.status)
    } catch (err) {
      setGsuiteError(toErrorMessage(err))
    } finally {
      setIsLoadingGsuite(false)
    }
  }, [wsUrl])

  const loadAuth = useCallback(async () => {
    setIsLoadingAuth(true)
    setAuthError(null)

    try {
      const result = await fetchSettingsAuthProviders(wsUrl)
      setAuthProviders(result)
    } catch (err) {
      setAuthError(toErrorMessage(err))
    } finally {
      setIsLoadingAuth(false)
    }
  }, [wsUrl])

  useEffect(() => {
    setThemePreference(readStoredThemePreference())
  }, [])

  useEffect(() => {
    void Promise.all([loadVariables(), loadGsuite(), loadAuth()])
  }, [loadVariables, loadGsuite, loadAuth])

  useEffect(() => {
    void Promise.all([loadSlack(), loadTelegram()])
  }, [loadSlack, loadTelegram])

  const abortAllOAuthLoginFlows = useCallback(() => {
    for (const provider of SETTINGS_AUTH_PROVIDER_ORDER) {
      const controller = oauthAbortControllerByProviderRef.current[provider]
      if (controller) {
        controller.abort()
      }
    }
    oauthAbortControllerByProviderRef.current = {}
  }, [])

  useEffect(() => {
    return () => {
      abortAllOAuthLoginFlows()
    }
  }, [abortAllOAuthLoginFlows])

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

  const handleSaveAuth = async (provider: SettingsAuthProviderId) => {
    const value = authDraftByProvider[provider]?.trim() ?? ''
    if (!value) {
      setAuthError(`Enter a value for ${SETTINGS_AUTH_PROVIDER_META[provider].label} before saving.`)
      return
    }

    setAuthError(null)
    setAuthSuccess(null)
    setSavingAuthProvider(provider)

    try {
      await updateSettingsAuthProviders(wsUrl, { [provider]: value })
      setAuthDraftByProvider((prev) => ({ ...prev, [provider]: '' }))
      setAuthSuccess(`${SETTINGS_AUTH_PROVIDER_META[provider].label} saved.`)
      await loadAuth()
    } catch (err) {
      setAuthError(toErrorMessage(err))
    } finally {
      setSavingAuthProvider(null)
    }
  }

  const handleDeleteAuth = async (provider: SettingsAuthProviderId) => {
    setAuthError(null)
    setAuthSuccess(null)
    setDeletingAuthProvider(provider)

    try {
      await deleteSettingsAuthProvider(wsUrl, provider)
      setAuthDraftByProvider((prev) => ({ ...prev, [provider]: '' }))
      setAuthSuccess(`${SETTINGS_AUTH_PROVIDER_META[provider].label} removed.`)
      await loadAuth()
    } catch (err) {
      setAuthError(toErrorMessage(err))
    } finally {
      setDeletingAuthProvider(null)
    }
  }

  const handleStartOAuth = async (provider: SettingsAuthProviderId) => {
    const existingController = oauthAbortControllerByProviderRef.current[provider]
    if (existingController) {
      existingController.abort()
    }

    const controller = new AbortController()
    oauthAbortControllerByProviderRef.current[provider] = controller

    setAuthError(null)
    setAuthSuccess(null)
    setOauthFlowByProvider((prev) => ({
      ...prev,
      [provider]: {
        ...createIdleSettingsAuthOAuthFlowState(),
        status: 'starting',
        progressMessage: 'Waiting for authorization instructions...',
      },
    }))

    let completed = false

    try {
      await startSettingsAuthOAuthLoginStream(
        wsUrl,
        provider,
        {
          onAuthUrl: (event) => {
            setOauthFlowByProvider((prev) => {
              const current = prev[provider] ?? createIdleSettingsAuthOAuthFlowState()
              return {
                ...prev,
                [provider]: {
                  ...current,
                  status: current.status === 'waiting_for_code' ? 'waiting_for_code' : 'waiting_for_auth',
                  authUrl: event.url,
                  instructions: event.instructions,
                  errorMessage: undefined,
                },
              }
            })
          },
          onPrompt: (event) => {
            setOauthFlowByProvider((prev) => {
              const current = prev[provider] ?? createIdleSettingsAuthOAuthFlowState()
              return {
                ...prev,
                [provider]: {
                  ...current,
                  status: 'waiting_for_code',
                  promptMessage: event.message,
                  promptPlaceholder: event.placeholder,
                  errorMessage: undefined,
                },
              }
            })
          },
          onProgress: (event) => {
            setOauthFlowByProvider((prev) => {
              const current = prev[provider] ?? createIdleSettingsAuthOAuthFlowState()
              return {
                ...prev,
                [provider]: {
                  ...current,
                  status: current.status === 'waiting_for_code' ? 'waiting_for_code' : 'waiting_for_auth',
                  progressMessage: event.message,
                },
              }
            })
          },
          onComplete: () => {
            completed = true
            setAuthError(null)
            setAuthSuccess(`${SETTINGS_AUTH_PROVIDER_META[provider].label} connected via OAuth.`)
            setOauthFlowByProvider((prev) => ({
              ...prev,
              [provider]: {
                ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
                status: 'complete',
                errorMessage: undefined,
                progressMessage: 'Connected.',
                isSubmittingCode: false,
                codeValue: '',
              },
            }))
          },
          onError: (message) => {
            setAuthError(message)
            setOauthFlowByProvider((prev) => ({
              ...prev,
              [provider]: {
                ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
                status: 'error',
                errorMessage: message,
                isSubmittingCode: false,
              },
            }))
          },
        },
        controller.signal,
      )

      if (!controller.signal.aborted && completed) {
        await loadAuth()
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }

      const message = toErrorMessage(error)
      setAuthError(message)
      setOauthFlowByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
          status: 'error',
          errorMessage: message,
          isSubmittingCode: false,
        },
      }))
    } finally {
      if (oauthAbortControllerByProviderRef.current[provider] === controller) {
        delete oauthAbortControllerByProviderRef.current[provider]
      }
    }
  }

  const handleSubmitOAuthPrompt = async (provider: SettingsAuthProviderId) => {
    const flow = oauthFlowByProvider[provider] ?? createIdleSettingsAuthOAuthFlowState()
    const value = flow.codeValue.trim()

    if (!value) {
      setAuthError('Enter the authorization code before submitting.')
      return
    }

    setAuthError(null)
    setAuthSuccess(null)
    setOauthFlowByProvider((prev) => ({
      ...prev,
      [provider]: {
        ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
        isSubmittingCode: true,
        errorMessage: undefined,
      },
    }))

    try {
      await submitSettingsAuthOAuthPrompt(wsUrl, provider, value)
      setOauthFlowByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
          status: 'waiting_for_auth',
          codeValue: '',
          isSubmittingCode: false,
          progressMessage: 'Authorization code submitted. Waiting for completion...',
          errorMessage: undefined,
        },
      }))
    } catch (error) {
      const message = toErrorMessage(error)
      setAuthError(message)
      setOauthFlowByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
          status: 'waiting_for_code',
          isSubmittingCode: false,
          errorMessage: message,
        },
      }))
    }
  }

  const handleResetOAuthFlow = (provider: SettingsAuthProviderId) => {
    const controller = oauthAbortControllerByProviderRef.current[provider]
    if (controller) {
      controller.abort()
      delete oauthAbortControllerByProviderRef.current[provider]
    }

    setOauthFlowByProvider((prev) => ({
      ...prev,
      [provider]: createIdleSettingsAuthOAuthFlowState(),
    }))
  }

  const handleSaveSlack = async () => {
    if (!slackDraft) {
      return
    }

    setSlackError(null)
    setSlackSuccess(null)
    setIsSavingSlack(true)

    try {
      const updated = await updateSlackSettings(
        wsUrl,
        selectedIntegrationManagerId,
        buildSlackPatch(slackDraft),
      )
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
      const result = await testSlackConnection(
        wsUrl,
        selectedIntegrationManagerId,
        Object.keys(patch).length > 0 ? patch : undefined,
      )
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
      const disabled = await disableSlackSettings(wsUrl, selectedIntegrationManagerId)
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
      const channels = await fetchSlackChannels(
        wsUrl,
        selectedIntegrationManagerId,
        slackDraft.includePrivateChannels,
      )
      setSlackChannels(channels)
      setSlackSuccess(`Loaded ${channels.length} channel${channels.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setSlackError(toErrorMessage(error))
    } finally {
      setIsLoadingChannels(false)
    }
  }

  const handleThemePreferenceChange = useCallback((nextPreference: ThemePreference) => {
    setThemePreference(nextPreference)
    applyThemePreference(nextPreference)
  }, [])

  const handleSaveTelegram = async () => {
    if (!telegramDraft) {
      return
    }

    setTelegramError(null)
    setTelegramSuccess(null)
    setIsSavingTelegram(true)

    try {
      const updated = await updateTelegramSettings(
        wsUrl,
        selectedIntegrationManagerId,
        buildTelegramPatch(telegramDraft),
      )
      setTelegramConfig(updated.config)
      setTelegramDraft(toTelegramDraft(updated.config))
      setTelegramStatusFromApi(updated.status)
      setTelegramSuccess('Telegram settings saved.')
    } catch (error) {
      setTelegramError(toErrorMessage(error))
    } finally {
      setIsSavingTelegram(false)
    }
  }

  const handleTestTelegram = async () => {
    if (!telegramDraft) {
      return
    }

    setTelegramError(null)
    setTelegramSuccess(null)
    setIsTestingTelegram(true)

    const patch: Record<string, unknown> = {}
    if (telegramDraft.botToken.trim()) {
      patch.botToken = telegramDraft.botToken.trim()
    }

    try {
      const result = await testTelegramConnection(
        wsUrl,
        selectedIntegrationManagerId,
        Object.keys(patch).length > 0 ? patch : undefined,
      )
      const identity = result.botUsername ?? result.botDisplayName ?? result.botId ?? 'Telegram bot'
      setTelegramSuccess(`Connected to ${identity}.`)
      await loadTelegram()
    } catch (error) {
      setTelegramError(toErrorMessage(error))
    } finally {
      setIsTestingTelegram(false)
    }
  }

  const handleDisableTelegram = async () => {
    setTelegramError(null)
    setTelegramSuccess(null)
    setIsDisablingTelegram(true)

    try {
      const disabled = await disableTelegramSettings(wsUrl, selectedIntegrationManagerId)
      setTelegramConfig(disabled.config)
      setTelegramDraft(toTelegramDraft(disabled.config))
      setTelegramStatusFromApi(disabled.status)
      setTelegramSuccess('Telegram integration disabled.')
    } catch (error) {
      setTelegramError(toErrorMessage(error))
    } finally {
      setIsDisablingTelegram(false)
    }
  }

  const handleSaveGsuite = async () => {
    if (!gsuiteDraft) {
      return
    }

    setGsuiteError(null)
    setGsuiteSuccess(null)
    setIsSavingGsuite(true)

    try {
      const updated = await updateGsuiteSettings(wsUrl, {
        enabled: gsuiteDraft.enabled,
        accountEmail: gsuiteDraft.accountEmail.trim(),
        services: gsuiteDraft.services,
      })
      setGsuiteConfig(updated.config)
      setGsuiteDraft((prev) => (prev ? { ...toGsuiteDraft(updated.config), oauthClientJson: prev.oauthClientJson } : toGsuiteDraft(updated.config)))
      setGsuiteStatus(updated.status)
      setGsuiteSuccess('G Suite settings saved.')
    } catch (error) {
      setGsuiteError(toErrorMessage(error))
    } finally {
      setIsSavingGsuite(false)
    }
  }

  const handleConnectGsuite = async () => {
    if (!gsuiteDraft) {
      return
    }

    const email = gsuiteDraft.accountEmail.trim()
    if (!email) {
      setGsuiteError('Enter a Google account email before connecting.')
      return
    }

    setGsuiteError(null)
    setGsuiteSuccess(null)
    setIsConnectingGsuite(true)

    try {
      if (gsuiteDraft.oauthClientJson.trim()) {
        const credentials = await submitGsuiteOAuthCredentials(wsUrl, gsuiteDraft.oauthClientJson)
        setGsuiteConfig(credentials.config)
        setGsuiteStatus(credentials.status)
      }

      const started = await startGsuiteOAuth(wsUrl, {
        email,
        services: gsuiteDraft.services,
      })

      setGsuiteConfig(started.config)
      setGsuiteStatus(started.status)
      setGsuiteAuthUrl(started.result.authUrl)
      setGsuiteInstructions(started.result.instructions ?? null)
      setGsuiteDraft((prev) =>
        prev
          ? {
              ...prev,
              accountEmail: email,
            }
          : prev,
      )
      setGsuiteSuccess('Authorization URL created. Complete auth in Google, then paste the redirect URL below.')
    } catch (error) {
      setGsuiteError(toErrorMessage(error))
    } finally {
      setIsConnectingGsuite(false)
    }
  }

  const handleCompleteGsuite = async () => {
    if (!gsuiteDraft) {
      return
    }

    const authUrl = gsuiteDraft.redirectUrl.trim()
    if (!authUrl) {
      setGsuiteError('Paste the full redirect URL before completing connection.')
      return
    }

    setGsuiteError(null)
    setGsuiteSuccess(null)
    setIsCompletingGsuite(true)

    try {
      const completed = await completeGsuiteOAuth(wsUrl, {
        email: gsuiteDraft.accountEmail.trim(),
        authUrl,
        services: gsuiteDraft.services,
      })

      setGsuiteConfig(completed.config)
      setGsuiteStatus(completed.status)
      setGsuiteDraft((prev) => (prev ? { ...prev, redirectUrl: '' } : prev))
      setGsuiteSuccess('Google account connected.')
    } catch (error) {
      setGsuiteError(toErrorMessage(error))
    } finally {
      setIsCompletingGsuite(false)
    }
  }

  const handleTestGsuite = async () => {
    if (!gsuiteDraft) {
      return
    }

    setGsuiteError(null)
    setGsuiteSuccess(null)
    setIsTestingGsuite(true)

    try {
      const tested = await testGsuiteConnection(wsUrl, {
        email: gsuiteDraft.accountEmail.trim() || undefined,
      })
      setGsuiteConfig(tested.config)
      setGsuiteStatus(tested.status)
      setGsuiteSuccess(tested.status.connected ? 'Google connection is active.' : tested.status.message)
    } catch (error) {
      setGsuiteError(toErrorMessage(error))
    } finally {
      setIsTestingGsuite(false)
    }
  }

  const handleDisableGsuite = async () => {
    setGsuiteError(null)
    setGsuiteSuccess(null)
    setIsDisablingGsuite(true)

    try {
      const disabled = await disableGsuiteSettings(wsUrl)
      setGsuiteConfig(disabled.config)
      setGsuiteDraft(toGsuiteDraft(disabled.config))
      setGsuiteStatus(disabled.status)
      setGsuiteAuthUrl(null)
      setGsuiteInstructions(null)
      setGsuiteSuccess('G Suite integration disabled.')
    } catch (error) {
      setGsuiteError(toErrorMessage(error))
    } finally {
      setIsDisablingGsuite(false)
    }
  }

  const setCount = envVariables.filter((v) => v.isSet).length
  const totalCount = envVariables.length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-[62px] shrink-0 items-center border-b border-border/80 bg-card/80 px-4 backdrop-blur">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onBack ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              onClick={onBack}
              aria-label="Back to chat"
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-foreground">Settings</h1>
            <p className="truncate text-[11px] text-muted-foreground">
              Configure authentication, integrations, and environment variables.
            </p>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-6 px-6 py-4">
            <section className="space-y-3 rounded-lg border border-border bg-card/50 p-4">
              <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-md bg-primary/10">
                  <Monitor className="size-3.5 text-primary" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold leading-tight">Appearance</h3>
                  <p className="text-[11px] text-muted-foreground">Choose how the app theme is applied.</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="theme-preference" className="text-xs font-medium text-muted-foreground">
                  Theme
                </Label>
                <Select
                  value={themePreference}
                  onValueChange={(value) => {
                    if (value === 'light' || value === 'dark' || value === 'auto') {
                      handleThemePreferenceChange(value)
                    }
                  }}
                >
                  <SelectTrigger id="theme-preference" className="w-full sm:w-64">
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
                    <SelectItem value="auto">Auto (System)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">Auto follows your operating system preference.</p>
              </div>
            </section>

            <Separator />

            <section className="space-y-2 rounded-lg border border-border bg-card/50 p-4">
              <div>
                <h3 className="text-sm font-semibold leading-tight">Integrations manager</h3>
                <p className="text-[11px] text-muted-foreground">
                  Slack and Telegram settings below apply to the selected manager.
                </p>
              </div>
              <Select
                value={selectedIntegrationManagerId}
                onValueChange={(value) => {
                  setSelectedIntegrationManagerId(value)
                  setSlackError(null)
                  setSlackSuccess(null)
                  setTelegramError(null)
                  setTelegramSuccess(null)
                }}
              >
                <SelectTrigger id="integration-manager-picker" className="w-full sm:w-72">
                  <SelectValue placeholder="Select manager" />
                </SelectTrigger>
                <SelectContent>
                  {managerOptions.length === 0 ? (
                    <SelectItem value={selectedIntegrationManagerId}>
                      {selectedIntegrationManagerId}
                    </SelectItem>
                  ) : (
                    managerOptions.map((manager) => (
                      <SelectItem key={manager.agentId} value={manager.agentId}>
                        {manager.agentId}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </section>

            <Separator />

            <section className="space-y-3 rounded-lg border border-border bg-card/50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md bg-amber-500/10">
                    <Mail className="size-3.5 text-amber-500" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold leading-tight">Google Workspace (gog)</h3>
                    <p className="text-[11px] text-muted-foreground">Gmail, Calendar, Drive, Docs read+write</p>
                  </div>
                </div>
                <GsuiteConnectionBadge status={gsuiteStatus} />
              </div>

              {gsuiteStatus ? <p className="text-[11px] text-muted-foreground">{gsuiteStatus.message}</p> : null}

              {gsuiteConfig ? (
                <p className="text-[11px] text-muted-foreground">
                  OAuth client credentials {gsuiteConfig.hasOAuthClientCredentials ? 'stored' : 'not stored yet'}.
                  {gsuiteConfig.lastConnectedAt ? ` Last connected at ${gsuiteConfig.lastConnectedAt}.` : ''}
                </p>
              ) : null}

              {!gsuiteStatus?.gogInstalled ? (
                <p className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                  Install `gog` with `brew install steipete/tap/gog` (or build from source).
                </p>
              ) : null}

              {gsuiteStatus?.gogVersion ? (
                <p className="text-[11px] text-muted-foreground">Detected: {gsuiteStatus.gogVersion}</p>
              ) : null}

              {gsuiteError ? (
                <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                  <p className="text-xs text-destructive">{gsuiteError}</p>
                </div>
              ) : null}

              {gsuiteSuccess ? (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
                  <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">{gsuiteSuccess}</p>
                </div>
              ) : null}

              {isLoadingGsuite || !gsuiteDraft ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-3">
                  <ToggleRow
                    label="Enable G Suite integration"
                    description="Keeps Google tooling opt-in until enabled."
                    checked={gsuiteDraft.enabled}
                    onChange={(next) => setGsuiteDraft((prev) => (prev ? { ...prev, enabled: next } : prev))}
                  />

                  <div className="space-y-1.5">
                    <Label htmlFor="gsuite-account-email" className="text-xs font-medium text-muted-foreground">
                      Google account email
                    </Label>
                    <Input
                      id="gsuite-account-email"
                      type="email"
                      value={gsuiteDraft.accountEmail}
                      onChange={(event) =>
                        setGsuiteDraft((prev) => (prev ? { ...prev, accountEmail: event.target.value } : prev))
                      }
                      placeholder="you@company.com"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="gsuite-oauth-client-json" className="text-xs font-medium text-muted-foreground">
                      OAuth client JSON (paste from Google Cloud)
                    </Label>
                    <Textarea
                      id="gsuite-oauth-client-json"
                      value={gsuiteDraft.oauthClientJson}
                      onChange={(event) =>
                        setGsuiteDraft((prev) => (prev ? { ...prev, oauthClientJson: event.target.value } : prev))
                      }
                      placeholder='{\"installed\": { ... }}'
                      className="min-h-[120px] font-mono text-xs"
                      spellCheck={false}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Paste once, then click Connect Google. Stored credentials are handled by `gog auth credentials`.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleConnectGsuite()}
                      disabled={isConnectingGsuite || isCompletingGsuite || !gsuiteStatus?.gogInstalled}
                      className="gap-1.5"
                    >
                      {isConnectingGsuite ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                      {isConnectingGsuite ? 'Connecting...' : 'Connect Google'}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleTestGsuite()}
                      disabled={isTestingGsuite}
                      className="gap-1.5"
                    >
                      {isTestingGsuite ? <Loader2 className="size-3.5 animate-spin" /> : <TestTube2 className="size-3.5" />}
                      {isTestingGsuite ? 'Testing...' : 'Test connection'}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleDisableGsuite()}
                      disabled={isDisablingGsuite}
                      className="gap-1.5"
                    >
                      {isDisablingGsuite ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                      {isDisablingGsuite ? 'Disabling...' : 'Disable'}
                    </Button>

                    <Button
                      type="button"
                      onClick={() => void handleSaveGsuite()}
                      disabled={isSavingGsuite}
                      className="gap-1.5"
                    >
                      {isSavingGsuite ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      {isSavingGsuite ? 'Saving...' : 'Save G Suite settings'}
                    </Button>
                  </div>

                  {gsuiteAuthUrl ? (
                    <a
                      href={gsuiteAuthUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-primary hover:bg-muted/50"
                    >
                      Open Google authorization URL
                      <ExternalLink className="size-3" />
                    </a>
                  ) : null}

                  <p className="text-[11px] text-muted-foreground">
                    {gsuiteInstructions ??
                      'After authorizing in Google, paste the full redirect URL here to complete `gog auth add --remote --step 2`.'}
                  </p>

                  <div className="space-y-1.5">
                    <Label htmlFor="gsuite-redirect-url" className="text-xs font-medium text-muted-foreground">
                      Redirect URL / auth URL paste-back
                    </Label>
                    <Input
                      id="gsuite-redirect-url"
                      value={gsuiteDraft.redirectUrl}
                      onChange={(event) =>
                        setGsuiteDraft((prev) => (prev ? { ...prev, redirectUrl: event.target.value } : prev))
                      }
                      placeholder="http://localhost:.../callback?state=...&code=..."
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                  </div>

                  <div className="flex justify-end">
                    <Button
                      type="button"
                      onClick={() => void handleCompleteGsuite()}
                      disabled={isCompletingGsuite || !gsuiteDraft.redirectUrl.trim()}
                      className="gap-1.5"
                    >
                      {isCompletingGsuite ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      {isCompletingGsuite ? 'Completing...' : 'Complete Connection'}
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <Separator />

            <section className="space-y-3 rounded-lg border border-border bg-card/50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md bg-sky-500/10">
                    <Send className="size-3.5 text-sky-500" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold leading-tight">Telegram integration</h3>
                    <p className="text-[11px] text-muted-foreground">Bot API + long polling delivery</p>
                  </div>
                </div>
                <TelegramConnectionBadge status={effectiveTelegramStatus} />
              </div>

              {effectiveTelegramStatus?.message ? (
                <p className="text-[11px] text-muted-foreground">{effectiveTelegramStatus.message}</p>
              ) : null}

              {telegramError ? (
                <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                  <p className="text-xs text-destructive">{telegramError}</p>
                </div>
              ) : null}

              {telegramSuccess ? (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
                  <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">{telegramSuccess}</p>
                </div>
              ) : null}

              {isLoadingTelegram || !telegramDraft ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <ToggleRow
                      label="Enable Telegram integration"
                      description="Telegram stays opt-in until explicitly enabled."
                      checked={telegramDraft.enabled}
                      onChange={(next) =>
                        setTelegramDraft((prev) => (prev ? { ...prev, enabled: next } : prev))
                      }
                    />

                    <ToggleRow
                      label="Drop pending updates on start"
                      description="Skip backlog and only process new updates after startup."
                      checked={telegramDraft.dropPendingUpdatesOnStart}
                      onChange={(next) =>
                        setTelegramDraft((prev) =>
                          prev ? { ...prev, dropPendingUpdatesOnStart: next } : prev,
                        )
                      }
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <ToggleRow
                      label="Disable link previews"
                      description="Send outbound messages without link preview cards."
                      checked={telegramDraft.disableLinkPreview}
                      onChange={(next) =>
                        setTelegramDraft((prev) => (prev ? { ...prev, disableLinkPreview: next } : prev))
                      }
                    />

                    <ToggleRow
                      label="Reply to inbound message"
                      description="Reply to the triggering Telegram message by default."
                      checked={telegramDraft.replyToInboundMessageByDefault}
                      onChange={(next) =>
                        setTelegramDraft((prev) =>
                          prev ? { ...prev, replyToInboundMessageByDefault: next } : prev,
                        )
                      }
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <ToggleRow
                      label="Allow image attachments"
                      description="Ingest Telegram image uploads as Swarm attachments."
                      checked={telegramDraft.allowImages}
                      onChange={(next) =>
                        setTelegramDraft((prev) => (prev ? { ...prev, allowImages: next } : prev))
                      }
                    />

                    <ToggleRow
                      label="Allow text attachments"
                      description="Include text-like documents as prompt attachments."
                      checked={telegramDraft.allowText}
                      onChange={(next) =>
                        setTelegramDraft((prev) => (prev ? { ...prev, allowText: next } : prev))
                      }
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <ToggleRow
                      label="Allow binary attachments"
                      description="Enable binary document ingestion (base64)."
                      checked={telegramDraft.allowBinary}
                      onChange={(next) =>
                        setTelegramDraft((prev) => (prev ? { ...prev, allowBinary: next } : prev))
                      }
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="telegram-bot-token" className="text-xs font-medium text-muted-foreground">
                      Bot token
                    </Label>
                    <Input
                      id="telegram-bot-token"
                      type="password"
                      value={telegramDraft.botToken}
                      onChange={(event) =>
                        setTelegramDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                botToken: event.target.value,
                              }
                            : prev,
                        )
                      }
                      placeholder={telegramConfig?.botToken ?? '123456:ABC-...'}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {telegramConfig?.hasBotToken ? 'Token saved. Enter a new value to rotate.' : 'Token not set yet.'}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="telegram-allowed-user-ids" className="text-xs font-medium text-muted-foreground">
                      Allowed users
                    </Label>
                    <Input
                      id="telegram-allowed-user-ids"
                      value={telegramDraft.allowedUserIds.join(', ')}
                      onChange={(event) =>
                        setTelegramDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                allowedUserIds: parseCommaSeparated(event.target.value),
                              }
                            : prev,
                        )
                      }
                      placeholder="123456789, 987654321"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Leave empty to allow all users. Find your Telegram user ID by messaging @userinfobot, or send
                      /start to your bot and check logs.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="telegram-timeout-seconds" className="text-xs font-medium text-muted-foreground">
                        Poll timeout (seconds)
                      </Label>
                      <Input
                        id="telegram-timeout-seconds"
                        value={telegramDraft.timeoutSeconds}
                        onChange={(event) =>
                          setTelegramDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  timeoutSeconds: event.target.value,
                                }
                              : prev,
                          )
                        }
                        placeholder="25"
                        inputMode="numeric"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="telegram-limit" className="text-xs font-medium text-muted-foreground">
                        Poll limit
                      </Label>
                      <Input
                        id="telegram-limit"
                        value={telegramDraft.limit}
                        onChange={(event) =>
                          setTelegramDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  limit: event.target.value,
                                }
                              : prev,
                          )
                        }
                        placeholder="100"
                        inputMode="numeric"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="telegram-max-file-bytes" className="text-xs font-medium text-muted-foreground">
                      Max attachment size (bytes)
                    </Label>
                    <Input
                      id="telegram-max-file-bytes"
                      value={telegramDraft.maxFileBytes}
                      onChange={(event) =>
                        setTelegramDraft((prev) =>
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

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleTestTelegram()}
                      disabled={isTestingTelegram}
                      className="gap-1.5"
                    >
                      {isTestingTelegram ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <TestTube2 className="size-3.5" />
                      )}
                      {isTestingTelegram ? 'Testing...' : 'Test connection'}
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleDisableTelegram()}
                      disabled={isDisablingTelegram}
                      className="gap-1.5"
                    >
                      {isDisablingTelegram ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plug className="size-3.5" />
                      )}
                      {isDisablingTelegram ? 'Disabling...' : 'Disable'}
                    </Button>

                    <Button
                      type="button"
                      onClick={() => void handleSaveTelegram()}
                      disabled={isSavingTelegram}
                      className="gap-1.5"
                    >
                      {isSavingTelegram ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      {isSavingTelegram ? 'Saving...' : 'Save Telegram settings'}
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <Separator />

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

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="slack-app-token" className="text-xs font-medium text-muted-foreground">
                        App token (xapp-…)
                      </Label>
                      <Input
                        id="slack-app-token"
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
                      <Label htmlFor="slack-bot-token" className="text-xs font-medium text-muted-foreground">
                        Bot token (xoxb-…)
                      </Label>
                      <Input
                        id="slack-bot-token"
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

                  <div className="space-y-1.5">
                    <Label htmlFor="slack-max-file-bytes" className="text-xs font-medium text-muted-foreground">
                      Max attachment size (bytes)
                    </Label>
                    <Input
                      id="slack-max-file-bytes"
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

                  <div className="space-y-2 rounded-md border border-border/70 p-3">
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

                    <div className="space-y-1.5">
                      <Label htmlFor="slack-channel-ids" className="text-xs font-medium text-muted-foreground">
                        Channel IDs
                      </Label>
                      <Input
                        id="slack-channel-ids"
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
                    </div>

                    {slackChannels.length > 0 ? (
                      <ScrollArea className="h-40 rounded border border-border/60">
                        <div className="space-y-1 p-2">
                          {slackChannels.map((channel) => {
                            const checked = slackDraft.channelIds.includes(channel.id)
                            const checkboxId = `slack-channel-${channel.id}`

                            return (
                              <div key={channel.id} className="flex items-center gap-2 text-xs">
                                <Checkbox
                                  id={checkboxId}
                                  checked={checked}
                                  onCheckedChange={(nextChecked) =>
                                    setSlackDraft((prev) => {
                                      if (!prev) return prev

                                      const nextIds = new Set(prev.channelIds)
                                      if (nextChecked === true) {
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
                                <Label htmlFor={checkboxId} className="cursor-pointer text-xs font-normal">
                                  <span className="font-medium">#{channel.name}</span>
                                  <span className="font-mono text-muted-foreground">({channel.id})</span>
                                  {!channel.isMember ? (
                                    <span className="text-muted-foreground">not joined</span>
                                  ) : null}
                                </Label>
                              </div>
                            )
                          })}
                        </div>
                      </ScrollArea>
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

            <Separator />

            <section>
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md bg-primary/10">
                    <KeyRound className="size-3.5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold leading-tight">Authentication</h3>
                    <p className="text-[11px] text-muted-foreground">Stored in ~/.swarm/auth/auth.json</p>
                  </div>
                </div>
              </div>

              {authError ? (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                  <p className="text-xs text-destructive">{authError}</p>
                </div>
              ) : null}

              {authSuccess ? (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
                  <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">{authSuccess}</p>
                </div>
              ) : null}

              {isLoadingAuth ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-3">
                  {SETTINGS_AUTH_PROVIDER_ORDER.map((provider) => {
                    const authStatus = authProviderById.get(provider) ?? {
                      provider,
                      configured: false,
                    }

                    return (
                      <AuthProviderRow
                        key={provider}
                        provider={provider}
                        authStatus={authStatus}
                        draftValue={authDraftByProvider[provider] ?? ''}
                        isRevealed={authRevealByProvider[provider] === true}
                        isSaving={savingAuthProvider === provider}
                        isDeleting={deletingAuthProvider === provider}
                        oauthFlow={oauthFlowByProvider[provider] ?? DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE}
                        onDraftChange={(value) => {
                          setAuthDraftByProvider((prev) => ({ ...prev, [provider]: value }))
                          setAuthError(null)
                          setAuthSuccess(null)
                        }}
                        onToggleReveal={() =>
                          setAuthRevealByProvider((prev) => ({ ...prev, [provider]: !prev[provider] }))
                        }
                        onSave={() => void handleSaveAuth(provider)}
                        onDelete={() => void handleDeleteAuth(provider)}
                        onStartOAuth={() => void handleStartOAuth(provider)}
                        onOAuthCodeChange={(value) => {
                          setOauthFlowByProvider((prev) => ({
                            ...prev,
                            [provider]: {
                              ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
                              codeValue: value,
                              errorMessage: undefined,
                            },
                          }))
                          setAuthError(null)
                        }}
                        onSubmitOAuthCode={() => void handleSubmitOAuthPrompt(provider)}
                        onResetOAuth={() => handleResetOAuthFlow(provider)}
                      />
                    )
                  })}
                </div>
              )}
            </section>

            <Separator />

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
    </div>
  )
}

function toSlackDraft(config: SlackSettingsConfig): SlackDraft {
  return {
    enabled: config.enabled,
    appToken: '',
    botToken: '',
    listenDm: config.listen.dm,
    channelIds: [...config.listen.channelIds],
    includePrivateChannels: config.listen.includePrivateChannels,
    respondInThread: config.response.respondInThread,
    replyBroadcast: config.response.replyBroadcast,
    maxFileBytes: String(config.attachments.maxFileBytes),
    allowImages: config.attachments.allowImages,
    allowText: config.attachments.allowText,
    allowBinary: config.attachments.allowBinary,
  }
}

function toGsuiteDraft(config: GsuiteSettingsConfig): GsuiteDraft {
  return {
    enabled: config.enabled,
    accountEmail: config.accountEmail,
    services: [...config.services],
    oauthClientJson: '',
    redirectUrl: '',
  }
}

function buildSlackPatch(draft: SlackDraft): Record<string, unknown> {
  const maxFileBytes = Number.parseInt(draft.maxFileBytes, 10)

  const patch: Record<string, unknown> = {
    enabled: draft.enabled,
    listen: {
      dm: draft.listenDm,
      channelIds: [...new Set(draft.channelIds.map((id) => id.trim()).filter(Boolean))],
      includePrivateChannels: draft.includePrivateChannels,
    },
    response: {
      respondInThread: draft.respondInThread,
      replyBroadcast: draft.replyBroadcast,
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

function toTelegramDraft(config: TelegramSettingsConfig): TelegramDraft {
  return {
    enabled: config.enabled,
    botToken: '',
    allowedUserIds: Array.isArray(config.allowedUserIds) ? [...config.allowedUserIds] : [],
    timeoutSeconds: String(config.polling.timeoutSeconds),
    limit: String(config.polling.limit),
    dropPendingUpdatesOnStart: config.polling.dropPendingUpdatesOnStart,
    disableLinkPreview: config.delivery.disableLinkPreview,
    replyToInboundMessageByDefault: config.delivery.replyToInboundMessageByDefault,
    maxFileBytes: String(config.attachments.maxFileBytes),
    allowImages: config.attachments.allowImages,
    allowText: config.attachments.allowText,
    allowBinary: config.attachments.allowBinary,
  }
}

function buildTelegramPatch(draft: TelegramDraft): Record<string, unknown> {
  const timeoutSeconds = Number.parseInt(draft.timeoutSeconds, 10)
  const limit = Number.parseInt(draft.limit, 10)
  const maxFileBytes = Number.parseInt(draft.maxFileBytes, 10)

  const patch: Record<string, unknown> = {
    enabled: draft.enabled,
    allowedUserIds: draft.allowedUserIds,
    polling: {
      timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : 25,
      limit: Number.isFinite(limit) ? limit : 100,
      dropPendingUpdatesOnStart: draft.dropPendingUpdatesOnStart,
    },
    delivery: {
      parseMode: 'HTML',
      disableLinkPreview: draft.disableLinkPreview,
      replyToInboundMessageByDefault: draft.replyToInboundMessageByDefault,
    },
    attachments: {
      maxFileBytes: Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 10 * 1024 * 1024,
      allowImages: draft.allowImages,
      allowText: draft.allowText,
      allowBinary: draft.allowBinary,
    },
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
