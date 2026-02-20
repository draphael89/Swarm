import { Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
    <header
      className="sticky top-0 z-10 flex h-[53px] shrink-0 items-center justify-between border-b border-border/60 bg-background px-4"
    >
      {/* Left: title */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <h1 className="truncate text-sm font-semibold">{activeAgentLabel}</h1>
      </div>

      {/* Right: status badges & actions */}
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            'gap-1.5 border-border/60 px-2 py-0.5 text-[10px] font-medium',
            connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
          )}
        >
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              connected ? 'bg-emerald-500' : 'bg-amber-500',
            )}
          />
          {connected ? 'Connected' : 'Reconnecting'}
        </Badge>

        {activeAgentId ? (
          <Badge variant="outline" className="hidden border-border/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-flex">
            {activeAgentId}
          </Badge>
        ) : null}

        {showNewChat ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={onNewChat}
            title="Clear conversation"
          >
            <Trash2 className="size-3" />
            Clear
          </Button>
        ) : null}
      </div>
    </header>
  )
}
