import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  FileText,
  Loader2,
  MessageSquare,
  Terminal,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ConversationEntry } from '@/lib/ws-types'
import { MarkdownMessage } from './MarkdownMessage'

interface MessageListProps {
  messages: ConversationEntry[]
  isLoading: boolean
  activeAgentLabel: string
  onSuggestionClick?: (suggestion: string) => void
}

const suggestions = ['Plan a swarm workflow', 'Debug manager state', 'Summarize latest run']

type ConversationLogEntry = Extract<ConversationEntry, { type: 'conversation_log' }>
type ToolExecutionLogEntry = ConversationLogEntry & {
  kind: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'
}

type ToolDisplayStatus = 'pending' | 'completed' | 'cancelled' | 'error'

type ToolConfig = {
  label: string
  activeLabel: string
  cancelledLabel: string
  errorLabel: string
  icon?: LucideIcon
  getDetail?: (input: Record<string, unknown>) => string | null
}

const TOOL_CONFIG: Record<string, ToolConfig> = {
  bash: {
    label: 'Ran command',
    activeLabel: 'Running command',
    cancelledLabel: 'Command cancelled',
    errorLabel: 'Command failed',
    icon: Terminal,
    getDetail: (input) => {
      const command = pickString(input, ['description', 'command'])
      return command ? truncate(command, 72) : null
    },
  },
  read: {
    label: 'Read file',
    activeLabel: 'Reading file',
    cancelledLabel: 'Read cancelled',
    errorLabel: 'Read failed',
    icon: FileText,
    getDetail: (input) => {
      const path = pickString(input, ['path'])
      return path ? truncate(path, 72) : null
    },
  },
  write: {
    label: 'Wrote file',
    activeLabel: 'Writing file',
    cancelledLabel: 'Write cancelled',
    errorLabel: 'Write failed',
    icon: FileText,
    getDetail: (input) => {
      const path = pickString(input, ['path'])
      return path ? truncate(path, 72) : null
    },
  },
  edit: {
    label: 'Edited file',
    activeLabel: 'Editing file',
    cancelledLabel: 'Edit cancelled',
    errorLabel: 'Edit failed',
    icon: FileText,
    getDetail: (input) => {
      const path = pickString(input, ['path'])
      return path ? truncate(path, 72) : null
    },
  },
  list_agents: {
    label: 'Checked agents',
    activeLabel: 'Checking agents',
    cancelledLabel: 'Agent check cancelled',
    errorLabel: 'Agent check failed',
    icon: Users,
  },
  send_message_to_agent: {
    label: 'Sent agent message',
    activeLabel: 'Sending agent message',
    cancelledLabel: 'Message cancelled',
    errorLabel: 'Message failed',
    icon: MessageSquare,
    getDetail: (input) => pickString(input, ['targetAgentId']) ?? null,
  },
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return `${str.slice(0, maxLen)}…`
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

function parseJsonRecord(input: string | undefined): Record<string, unknown> {
  if (!input) return {}

  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function humanizeToolName(toolName: string): string {
  return toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim()
}

function isToolExecutionLog(entry: ConversationLogEntry): entry is ToolExecutionLogEntry {
  return (
    entry.kind === 'tool_execution_start' ||
    entry.kind === 'tool_execution_update' ||
    entry.kind === 'tool_execution_end'
  )
}

function mapToolStatus(entry: ToolExecutionLogEntry): ToolDisplayStatus {
  if (entry.kind !== 'tool_execution_end') {
    return 'pending'
  }

  if (!entry.isError) {
    return 'completed'
  }

  const lowered = entry.text.toLowerCase()
  if (lowered.includes('[aborted]') || lowered.includes('cancel')) {
    return 'cancelled'
  }

  return 'error'
}

function getFriendlyToolMessage(
  toolName: string | undefined,
  input: Record<string, unknown>,
  status: ToolDisplayStatus,
): string {
  const normalizedToolName = (toolName ?? '').trim() || 'tool'
  const config = TOOL_CONFIG[normalizedToolName]

  if (!config) {
    const friendlyName = humanizeToolName(normalizedToolName)
    if (status === 'completed') return `Ran ${friendlyName}`
    if (status === 'cancelled') return `Cancelled ${friendlyName}`
    if (status === 'error') return `${friendlyName} failed`
    return `Running ${friendlyName}`
  }

  const baseLabel =
    status === 'completed'
      ? config.label
      : status === 'cancelled'
        ? config.cancelledLabel
        : status === 'error'
          ? config.errorLabel
          : config.activeLabel

  const detail = config.getDetail?.(input)
  return detail ? `${baseLabel}: ${detail}` : baseLabel
}

function statusChipClass(status: ToolDisplayStatus): string {
  if (status === 'completed') {
    return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
  if (status === 'cancelled') {
    return 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300'
  }
  if (status === 'error') {
    return 'border-destructive/35 bg-destructive/10 text-destructive'
  }
  return 'border-border/70 bg-muted/40 text-muted-foreground'
}

function statusLabel(status: ToolDisplayStatus): string {
  if (status === 'completed') return 'Done'
  if (status === 'cancelled') return 'Cancelled'
  if (status === 'error') return 'Failed'
  return 'Running'
}

function ToolOutputBlock({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: ToolDisplayStatus | 'neutral'
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre
        className={cn(
          'w-full max-h-64 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words',
          tone === 'error'
            ? 'border-destructive/30 bg-destructive/10 text-destructive'
            : tone === 'cancelled'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
              : 'border-border/70 bg-muted/45 text-foreground',
        )}
      >
        {formatPayload(value)}
      </pre>
    </div>
  )
}

function ToolExecutionLog({ entry, inputPayload }: { entry: ToolExecutionLogEntry; inputPayload?: string }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const contentId = useId()

  const displayStatus = mapToolStatus(entry)
  const baseInputPayload = entry.kind === 'tool_execution_start' ? entry.text : inputPayload
  const inputRecord = parseJsonRecord(baseInputPayload)
  const friendlyMessage = getFriendlyToolMessage(entry.toolName, inputRecord, displayStatus)

  const toolConfig = entry.toolName ? TOOL_CONFIG[entry.toolName] : undefined
  const ToolIcon = toolConfig?.icon ?? Wrench

  const outputLabel =
    entry.kind === 'tool_execution_start'
      ? 'Input'
      : entry.kind === 'tool_execution_update'
        ? 'Update'
        : displayStatus === 'cancelled'
          ? 'Cancelled'
          : displayStatus === 'error'
            ? 'Error'
            : 'Result'

  return (
    <div className="rounded-md">
      <button
        type="button"
        className={cn(
          'group flex w-full items-start gap-1.5 rounded-md px-1 py-1 text-left text-sm text-foreground/70 italic transition-colors',
          'hover:bg-muted/35 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        )}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
          {displayStatus === 'completed' ? (
            <ToolIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          ) : displayStatus === 'cancelled' ? (
            <X className="size-3.5 text-rose-500 dark:text-rose-400" aria-hidden="true" />
          ) : displayStatus === 'error' ? (
            <AlertCircle className="size-3.5 text-destructive" aria-hidden="true" />
          ) : (
            <Loader2 className="size-3.5 animate-spin text-foreground/50" aria-hidden="true" />
          )}
        </span>

        <span className="min-w-0 flex-1 break-words">{friendlyMessage}</span>

        <span
          className={cn(
            'mt-0.5 inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] not-italic font-medium uppercase tracking-wide',
            statusChipClass(displayStatus),
          )}
        >
          {statusLabel(displayStatus)}
        </span>

        <ChevronRight
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-muted-foreground/80 transition-transform',
            isExpanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
      </button>

      <div
        id={contentId}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="ml-6 mt-1 space-y-2 pb-1">
            {entry.kind !== 'tool_execution_start' && inputPayload ? (
              <ToolOutputBlock label="Input" value={inputPayload} tone="neutral" />
            ) : null}

            <ToolOutputBlock label={outputLabel} value={entry.text} tone={displayStatus} />

            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>{formatTimestamp(entry.timestamp)}</span>
              {entry.toolName ? <span>• {entry.toolName}</span> : null}
              {entry.toolCallId ? <span>• {entry.toolCallId}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ onSuggestionClick }: { onSuggestionClick?: (suggestion: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <h2 className="mb-4 text-base font-medium text-foreground">What can I do for you?</h2>
      {onSuggestionClick ? (
        <div className="flex max-w-[320px] flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestionClick(suggestion)}
              type="button"
              className="rounded-full border border-border bg-muted px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/80"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <p className="mt-6 text-xs text-muted-foreground">AI can make mistakes. Always verify important actions.</p>
    </div>
  )
}

function ConversationMessage({
  message,
  activeAgentLabel,
}: {
  message: Extract<ConversationEntry, { type: 'conversation_message' }>
  activeAgentLabel: string
}) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-amber-700">System • {formatTimestamp(message.timestamp)}</div>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.text}</p>
      </div>
    )
  }

  if (isUser) {
    const fromUser = message.source === 'user_input'

    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-primary px-3 py-2 text-primary-foreground">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-primary-foreground/80">
            {fromUser ? 'You' : 'Input'} • {formatTimestamp(message.timestamp)}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.text}</p>
        </div>
      </div>
    )
  }

  const shouldRenderMarkdown = message.source === 'speak_to_user'

  return (
    <div className="text-foreground">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {activeAgentLabel} • {formatTimestamp(message.timestamp)} • {message.source}
      </div>
      {shouldRenderMarkdown ? (
        <MarkdownMessage content={message.text} />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.text}</p>
      )}
    </div>
  )
}

function ConversationLog({
  entry,
  toolInputsByCallId,
}: {
  entry: ConversationLogEntry
  toolInputsByCallId: Map<string, string>
}) {
  if (isToolExecutionLog(entry)) {
    const inputPayload = entry.toolCallId ? toolInputsByCallId.get(entry.toolCallId) : undefined
    return <ToolExecutionLog entry={entry} inputPayload={inputPayload} />
  }

  const label = entry.kind === 'message_start' ? 'Message start' : 'Message end'

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-xs font-mono',
        entry.isError
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border/70 bg-muted/40 text-muted-foreground',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] uppercase tracking-wide">
        <span>{label}</span>
        <span>• {formatTimestamp(entry.timestamp)}</span>
        {entry.role ? <span>• {entry.role}</span> : null}
        {entry.isError ? <span>• error</span> : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{entry.text}</p>
    </div>
  )
}

function Message({
  message,
  activeAgentLabel,
  toolInputsByCallId,
}: {
  message: ConversationEntry
  activeAgentLabel: string
  toolInputsByCallId: Map<string, string>
}) {
  if (message.type === 'conversation_log') {
    return <ConversationLog entry={message} toolInputsByCallId={toolInputsByCallId} />
  }

  return <ConversationMessage message={message} activeAgentLabel={activeAgentLabel} />
}

export function MessageList({ messages, isLoading, activeAgentLabel, onSuggestionClick }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const toolInputsByCallId = useMemo(() => {
    const inputMap = new Map<string, string>()

    for (const entry of messages) {
      if (entry.type !== 'conversation_log') continue
      if (entry.kind !== 'tool_execution_start') continue
      if (!entry.toolCallId) continue
      inputMap.set(entry.toolCallId, entry.text)
    }

    return inputMap
  }, [messages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isLoading])

  if (messages.length === 0 && !isLoading) {
    return <EmptyState onSuggestionClick={onSuggestionClick} />
  }

  return (
    <div
      className={cn(
        'flex-1 min-h-0 overflow-y-auto',
        '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
        '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent',
        '[scrollbar-width:thin] [scrollbar-color:transparent_transparent]',
        'hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]',
      )}
    >
      <div className={cn('space-y-2 px-3 py-3 sm:px-4 lg:px-5')}>
        {messages.map((message, index) => (
          <Message
            key={`${message.type}-${message.timestamp}-${index}`}
            message={message}
            activeAgentLabel={activeAgentLabel}
            toolInputsByCallId={toolInputsByCallId}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
