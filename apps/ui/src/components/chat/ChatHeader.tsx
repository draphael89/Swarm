import { Loader2, Minimize2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentStatus } from '@/lib/ws-types'

export type ChannelView = 'web' | 'all'

interface ChatHeaderProps {
  connected: boolean
  activeAgentId: string | null
  activeAgentLabel: string
  activeAgentStatus: AgentStatus | null
  channelView: ChannelView
  onChannelViewChange: (view: ChannelView) => void
  showCompact: boolean
  compactInProgress: boolean
  onCompact: () => void
  showNewChat: boolean
  onNewChat: () => void
}

function formatAgentStatus(status: AgentStatus | null): string {
  if (!status) return 'Idle'

  switch (status) {
    case 'streaming':
      return 'Streaming'
    case 'idle':
      return 'Idle'
    case 'terminated':
      return 'Terminated'
    case 'stopped_on_restart':
      return 'Stopped'
  }
}

function ChannelToggleButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'h-6 min-w-11 rounded px-2 text-[11px] font-medium transition-colors',
        active
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
      )}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}

export function ChatHeader({
  connected,
  activeAgentId,
  activeAgentLabel,
  activeAgentStatus,
  channelView,
  onChannelViewChange,
  showCompact,
  compactInProgress,
  onCompact,
  showNewChat,
  onNewChat,
}: ChatHeaderProps) {
  const isStreaming = connected && activeAgentStatus === 'streaming'
  const statusLabel = connected ? formatAgentStatus(activeAgentStatus) : 'Reconnecting'

  return (
    <header className="sticky top-0 z-10 flex h-[62px] w-full shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-border/80 bg-card/80 px-4 backdrop-blur">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className="relative inline-flex size-5 shrink-0 items-center justify-center"
          aria-label={`Agent status: ${statusLabel.toLowerCase()}`}
        >
          <span
            className={cn(
              'absolute inline-flex size-4 rounded-full',
              isStreaming ? 'animate-ping bg-emerald-500/45' : 'bg-transparent',
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              'relative inline-flex size-2.5 rounded-full',
              isStreaming ? 'bg-emerald-500' : 'bg-muted-foreground/45',
            )}
            aria-hidden="true"
          />
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          <h1
            className="min-w-0 truncate text-sm font-bold text-foreground"
            title={activeAgentId ?? activeAgentLabel}
          >
            {activeAgentLabel}
          </h1>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            ·
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs font-mono text-muted-foreground">
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="inline-flex h-8 items-center rounded-md border border-border/70 bg-muted/40 p-1">
          <ChannelToggleButton
            label="Web"
            active={channelView === 'web'}
            onClick={() => onChannelViewChange('web')}
          />
          <ChannelToggleButton
            label="All"
            active={channelView === 'all'}
            onClick={() => onChannelViewChange('all')}
          />
        </div>

        {showCompact ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
            onClick={onCompact}
            disabled={compactInProgress}
            title={compactInProgress ? 'Compacting manager context...' : 'Compact manager context'}
            aria-label={compactInProgress ? 'Compacting manager context' : 'Compact manager context'}
          >
            {compactInProgress ? <Loader2 className="size-3.5 animate-spin" /> : <Minimize2 className="size-3.5" />}
          </Button>
        ) : null}

        {showNewChat ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
            onClick={onNewChat}
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </header>
  )
}
