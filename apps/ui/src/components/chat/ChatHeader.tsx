import { CircleDashed, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ChatHeaderProps {
  connected: boolean
  activeAgentId: string | null
  activeAgentLabel: string
  showNewChat: boolean
  onNewChat: () => void
}

export function ChatHeader({ connected, activeAgentId, activeAgentLabel, showNewChat, onNewChat }: ChatHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex h-[62px] w-full shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-border/80 bg-card/80 px-4 backdrop-blur">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className={cn(
            'inline-flex size-5 items-center justify-center rounded-full border',
            connected
              ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400',
          )}
          aria-hidden="true"
        >
          <CircleDashed className={cn('size-3', !connected && 'animate-spin')} />
        </div>

        <div className="min-w-0">
          <h1 className="truncate text-sm font-bold text-foreground">{activeAgentLabel}</h1>
          <div className="flex h-4 min-w-0 items-center gap-1.5 text-xs font-mono text-muted-foreground">
            <span className="whitespace-nowrap">{connected ? 'Connected' : 'Reconnecting'}</span>
            {activeAgentId ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{activeAgentId}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

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
    </header>
  )
}
