export type AgentStatus = 'idle' | 'streaming' | 'terminated' | 'stopped_on_restart'

export interface AgentDescriptor {
  agentId: string
  displayName: string
  role: 'manager' | 'worker'
  status: AgentStatus
  createdAt: string
  updatedAt: string
  cwd: string
  model: {
    provider: string
    modelId: string
    thinkingLevel: string
  }
  sessionFile: string
}

export type ClientCommand =
  | { type: 'subscribe'; agentId?: string }
  | { type: 'user_message'; text: string }
  | { type: 'ping' }

export type ServerEvent =
  | { type: 'ready'; serverTime: string; subscribedAgentId: string }
  | { type: 'conversation_reset'; agentId: string; timestamp: string; reason: 'user_new_command' | 'api_reset' }
  | {
      type: 'conversation_history'
      agentId: string
      messages: Array<{
        type: 'conversation_message'
        agentId: string
        role: 'user' | 'assistant' | 'system'
        text: string
        timestamp: string
        source: 'user_input' | 'speak_to_user' | 'system'
      }>
    }
  | {
      type: 'conversation_message'
      agentId: string
      role: 'user' | 'assistant' | 'system'
      text: string
      timestamp: string
      source: 'user_input' | 'speak_to_user' | 'system'
    }
  | { type: 'agent_status'; agentId: string; status: AgentStatus; pendingCount: number }
  | { type: 'agents_snapshot'; agents: AgentDescriptor[] }
  | { type: 'error'; code: string; message: string }
