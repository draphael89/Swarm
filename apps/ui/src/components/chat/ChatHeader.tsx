import { Loader2, Menu, Minimize2, PanelRight, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ContextWindowIndicator } from '@/components/chat/ContextWindowIndicator'
import { cn } from '@/lib/utils'
import type { AgentStatus } from '@/lib/ws-types'

export type ChannelView = 'web' | 'all'

interface ChatHeaderProps {
  connected: boolean
  activeAgentId: string | null
  activeAgentLabel: string
  activeAgentArchetypeId?: string | null
  activeAgentStatus: AgentStatus | null
  channelView: ChannelView
  onChannelViewChange: (view: ChannelView) => void
  contextWindowUsage: { usedTokens: number; contextWindow: number } | null
  showCompact: boolean
  compactInProgress: boolean
  onCompact: () => void
  showStopAll: boolean
  stopAllInProgress: boolean
  stopAllDisabled: boolean
  onStopAll: () => void
  showNewChat: boolean
  onNewChat: () => void
  isArtifactsPanelOpen: boolean
  onToggleArtifactsPanel: () => void
  onToggleMobileSidebar?: () => void
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
  activeAgentArchetypeId,
  activeAgentStatus,
  channelView,
  onChannelViewChange,
  contextWindowUsage,
  showCompact,
  compactInProgress,
  onCompact,
  showStopAll,
  stopAllInProgress,
  stopAllDisabled,
  onStopAll,
  showNewChat,
  onNewChat,
  isArtifactsPanelOpen,
  onToggleArtifactsPanel,
  onToggleMobileSidebar,
}: ChatHeaderProps) {
  const isStreaming = connected && activeAgentStatus === 'streaming'
  const statusLabel = connected ? formatAgentStatus(activeAgentStatus) : 'Reconnecting'
  const archetypeLabel = activeAgentArchetypeId?.trim()

  return (
    <header className="sticky top-0 z-10 flex h-[62px] w-full shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-border/80 bg-card/80 px-2 backdrop-blur md:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
        {/* Mobile hamburger */}
        {onToggleMobileSidebar ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground md:hidden"
            onClick={onToggleMobileSidebar}
            aria-label="Open sidebar"
          >
            <Menu className="size-4" />
          </Button>
        ) : null}

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
          {archetypeLabel ? (
            <Badge
              variant="outline"
              className="h-5 max-w-32 shrink-0 border-border/60 bg-muted/40 px-1.5 text-[10px] font-medium text-muted-foreground"
              title={archetypeLabel}
            >
              <span className="truncate">{archetypeLabel}</span>
            </Badge>
          ) : null}
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            ·
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs font-mono text-muted-foreground">
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 md:gap-2">
        <div className="hidden sm:inline-flex h-8 items-center rounded-md border border-border/70 bg-muted/40 p-1">
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

        {contextWindowUsage ? (
          <span className="hidden sm:inline-flex">
            <ContextWindowIndicator
              usedTokens={contextWindowUsage.usedTokens}
              contextWindow={contextWindowUsage.contextWindow}
            />
          </span>
        ) : null}

        {showStopAll ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 border-destructive/50 bg-destructive/5 px-2 text-[11px] font-medium text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onStopAll}
            disabled={stopAllDisabled || stopAllInProgress}
            title={stopAllInProgress ? 'Stopping manager and workers...' : 'Stop manager and all workers'}
            aria-label={stopAllInProgress ? 'Stopping manager and all workers' : 'Stop manager and all workers'}
          >
            {stopAllInProgress ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
            <span>Stop All</span>
          </Button>
        ) : null}

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

        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 shrink-0 transition-colors',
            isArtifactsPanelOpen
              ? 'bg-accent/80 text-foreground'
              : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
          )}
          onClick={onToggleArtifactsPanel}
          title={isArtifactsPanelOpen ? 'Close artifacts panel' : 'Open artifacts panel'}
          aria-label={isArtifactsPanelOpen ? 'Close artifacts panel' : 'Open artifacts panel'}
          aria-pressed={isArtifactsPanelOpen}
        >
          <PanelRight className="size-3.5" />
        </Button>
      </div>
    </header>
  )
}
