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
      className={cn(
        'sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-3 py-2',
      )}
    >
      <div className="min-w-0 flex-1 mr-2">
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Swarm</p>
        <h1 className="truncate text-base font-semibold">{activeAgentLabel}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge variant={connected ? 'secondary' : 'outline'}>
          <span
            className={cn(
              'mr-2 inline-block h-2 w-2 rounded-full',
              connected ? 'bg-emerald-500' : 'bg-amber-500',
            )}
          />
          {connected ? 'Connected' : 'Reconnecting'}
        </Badge>

        <Badge variant="outline" className="hidden sm:inline-flex">
          {activeAgentId ?? 'Unsubscribed'}
        </Badge>

        {showNewChat ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2.5"
            onClick={onNewChat}
            title="Clear conversation"
          >
            <Trash2 className="size-3.5" />
            Clear
          </Button>
        ) : null}
      </div>
    </header>
  )
}
