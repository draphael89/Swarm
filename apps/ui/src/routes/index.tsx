import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { AgentSidebar } from '@/components/chat/AgentSidebar'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList } from '@/components/chat/MessageList'
import { ManagerWsClient, type ManagerWsState } from '@/lib/ws-client'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

function IndexPage() {
  const wsUrl = import.meta.env.VITE_SWARM_WS_URL ?? 'ws://127.0.0.1:47187'
  const clientRef = useRef<ManagerWsClient | null>(null)
  const messageInputRef = useRef<MessageInputHandle | null>(null)

  const [state, setState] = useState<ManagerWsState>({
    connected: false,
    targetAgentId: 'manager',
    subscribedAgentId: null,
    messages: [],
    agents: [],
    statuses: {},
    lastError: null,
  })

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

  const activeAgentId = state.targetAgentId ?? state.subscribedAgentId ?? 'manager'

  const activeAgent = useMemo(() => {
    return state.agents.find((agent) => agent.agentId === activeAgentId) ?? null
  }, [activeAgentId, state.agents])

  const activeAgentLabel = activeAgent?.displayName ?? (activeAgentId === 'manager' ? 'Manager' : activeAgentId)

  const isLoading = useMemo(() => {
    const fromStatuses = state.statuses[activeAgentId]?.status
    if (fromStatuses) return fromStatuses === 'streaming'

    const fromAgents = state.agents.find((agent) => agent.agentId === activeAgentId)?.status
    return fromAgents === 'streaming'
  }, [activeAgentId, state.agents, state.statuses])

  const handleSend = (text: string) => {
    clientRef.current?.sendUserMessage(text, {
      agentId: activeAgentId,
      delivery: activeAgentId === 'manager' ? 'steer' : isLoading ? 'followUp' : 'auto',
    })
  }

  const handleNewChat = () => {
    clientRef.current?.sendUserMessage('/new', { agentId: 'manager', delivery: 'steer' })
  }

  const handleSelectAgent = (agentId: string) => {
    clientRef.current?.subscribeToAgent(agentId)
  }

  const handleSuggestionClick = (prompt: string) => {
    messageInputRef.current?.setInput(prompt)
  }

  return (
    <main className="h-screen bg-background text-foreground">
      <div className="mx-auto flex h-screen w-full max-w-[1400px] border-x border-border/60 bg-background shadow-sm">
        <AgentSidebar
          connected={state.connected}
          agents={state.agents}
          statuses={state.statuses}
          selectedAgentId={activeAgentId}
          onSelectAgent={handleSelectAgent}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <ChatHeader
            connected={state.connected}
            activeAgentId={activeAgentId}
            activeAgentLabel={`${activeAgentLabel} Chat`}
            showNewChat={activeAgentId === 'manager'}
            onNewChat={handleNewChat}
          />

          {state.lastError ? (
            <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {state.lastError}
            </div>
          ) : null}

          <MessageList
            messages={state.messages}
            isLoading={isLoading}
            activeAgentLabel={activeAgentLabel}
            onSuggestionClick={handleSuggestionClick}
          />

          <MessageInput
            ref={messageInputRef}
            onSend={handleSend}
            isLoading={isLoading}
            disabled={!state.connected}
            allowWhileLoading={activeAgentId !== 'manager'}
            agentLabel={activeAgentLabel}
          />
        </div>
      </div>
    </main>
  )
}
