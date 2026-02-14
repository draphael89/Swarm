import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { ConversationEntry } from '@/lib/ws-types'

interface MessageListProps {
  messages: ConversationEntry[]
  isLoading: boolean
  activeAgentLabel: string
  onSuggestionClick?: (suggestion: string) => void
}

const suggestions = ['Plan a swarm workflow', 'Debug manager state', 'Summarize latest run']

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
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

  return (
    <div className="text-foreground">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {activeAgentLabel} • {formatTimestamp(message.timestamp)} • {message.source}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.text}</p>
    </div>
  )
}

function ConversationLog({
  entry,
}: {
  entry: Extract<ConversationEntry, { type: 'conversation_log' }>
}) {
  const label =
    entry.kind === 'message_start'
      ? 'Message start'
      : entry.kind === 'message_end'
        ? 'Message end'
        : entry.kind === 'tool_execution_start'
          ? `Tool start • ${entry.toolName ?? 'unknown tool'}`
          : entry.kind === 'tool_execution_update'
            ? `Tool output • ${entry.toolName ?? 'unknown tool'}`
            : `Tool end • ${entry.toolName ?? 'unknown tool'}`

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
        {entry.toolCallId ? <span>• {entry.toolCallId}</span> : null}
        {entry.isError ? <span>• error</span> : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{entry.text}</p>
    </div>
  )
}

function Message({ message, activeAgentLabel }: { message: ConversationEntry; activeAgentLabel: string }) {
  if (message.type === 'conversation_log') {
    return <ConversationLog entry={message} />
  }

  return <ConversationMessage message={message} activeAgentLabel={activeAgentLabel} />
}

export function MessageList({ messages, isLoading, activeAgentLabel, onSuggestionClick }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null)

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
      <div className={cn('space-y-3 p-3')}>
        {messages.map((message, index) => (
          <Message key={`${message.type}-${message.timestamp}-${index}`} message={message} activeAgentLabel={activeAgentLabel} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
