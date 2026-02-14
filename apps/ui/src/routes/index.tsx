import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { LoaderCircle, SendHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ManagerWsClient, type ManagerWsState } from '@/lib/ws-client'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

function IndexPage() {
  const wsUrl = import.meta.env.VITE_SWARM_WS_URL ?? 'ws://127.0.0.1:47187'
  const clientRef = useRef<ManagerWsClient | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [state, setState] = useState<ManagerWsState>({
    connected: false,
    subscribedAgentId: null,
    messages: [],
    agents: [],
    statuses: {},
    lastError: null,
  })
  const [input, setInput] = useState('')

  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const client = new ManagerWsClient(wsUrl, 'manager')
    clientRef.current = client
    setState(client.getState())

    const unsubscribe = client.subscribe((next) => {
      setState(next)
    })

    client.start()

    return () => {
      unsubscribe()
      if (clientRef.current === client) {
        clientRef.current = null
      }
      client.destroy()
    }
  }, [wsUrl])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [state.messages])

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = input.trim()
    if (!text) return

    clientRef.current?.sendUserMessage(text)
    setInput('')
  }

  const applyStarterPrompt = (prompt: string) => {
    setInput(prompt)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }

  return (
    <main className="relative min-h-screen bg-background text-foreground">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-primary/10 via-primary/5 to-transparent" />

      <div className="relative mx-auto flex h-screen w-full max-w-4xl flex-col px-4 py-3 md:px-6 md:py-4">
        <header className="mb-3 flex items-center justify-between rounded-xl border border-border bg-background/95 px-3 py-2 backdrop-blur-sm">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Swarm</p>
            <h1 className="truncate text-base font-semibold">Manager Chat</h1>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant={state.connected ? 'secondary' : 'outline'}>
              <span
                className={cn(
                  'mr-2 inline-block h-2 w-2 rounded-full',
                  state.connected ? 'bg-emerald-500' : 'bg-amber-500',
                )}
              />
              {state.connected ? 'Connected' : 'Reconnecting'}
            </Badge>
            <Badge variant="outline" className="hidden sm:inline-flex">
              {state.subscribedAgentId ?? 'Unsubscribed'}
            </Badge>
          </div>
        </header>

        {state.lastError ? <p className="mb-3 text-xs text-destructive">{state.lastError}</p> : null}

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {state.messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center p-6 text-center">
                <h2 className="text-base font-medium text-foreground">What can I do for you?</h2>
                <div className="mt-4 flex max-w-[320px] flex-wrap justify-center gap-2">
                  {['Plan a swarm workflow', 'Debug manager state', 'Summarize latest run'].map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => applyStarterPrompt(prompt)}
                      className="rounded-full border border-border bg-muted px-3 py-1.5 text-sm transition-colors hover:bg-muted/80"
                      type="button"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
                <p className="mt-6 text-xs text-muted-foreground">
                  Or send a direct message to begin agent orchestration.
                </p>
              </div>
            ) : (
              <ul className="space-y-3 p-4 md:p-5">
                {state.messages.map((message, index) => {
                  const isUser = message.role === 'user'
                  const isSystem = message.role === 'system'

                  return (
                    <li
                      key={`${message.timestamp}-${index}`}
                      className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
                    >
                      <div
                        className={cn(
                          'rounded-xl px-3 py-2 text-sm',
                          isUser && 'max-w-[85%] rounded-br-sm bg-primary text-primary-foreground',
                          isSystem && 'w-full border border-amber-200 bg-amber-50 text-amber-900',
                          !isUser && !isSystem && 'max-w-[90%] text-foreground',
                        )}
                      >
                        <div
                          className={cn(
                            'mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide',
                            isUser ? 'text-primary-foreground/80' : 'text-muted-foreground',
                          )}
                        >
                          <span>{message.role}</span>
                          <span>•</span>
                          <span>{new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                          <span>•</span>
                          <span>{message.source}</span>
                        </div>
                        <p className="whitespace-pre-wrap break-words leading-relaxed">{message.text}</p>
                      </div>
                    </li>
                  )
                })}
                <div ref={messagesEndRef} />
              </ul>
            )}
          </div>

          <form className="border-t border-border bg-background p-3" onSubmit={onSubmit}>
            <div className="flex items-center gap-2 rounded-2xl border border-border bg-background px-2 py-2">
              <Input
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Type a message..."
                autoComplete="off"
                className="h-8 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <Button type="submit" size="icon" disabled={!input.trim()} className="h-8 w-8 shrink-0 rounded-full">
                {state.connected ? (
                  <SendHorizontal className="h-3.5 w-3.5" />
                ) : (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                )}
              </Button>
            </div>
          </form>
        </section>
      </div>
    </main>
  )
}
