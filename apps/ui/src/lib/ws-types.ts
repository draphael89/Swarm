export type AgentStatus = 'idle' | 'streaming' | 'terminated' | 'stopped_on_restart'

export const MANAGER_MODEL_PRESETS = ['pi-codex', 'pi-opus', 'codex-app'] as const
export type ManagerModelPreset = (typeof MANAGER_MODEL_PRESETS)[number]

export interface AgentDescriptor {
  agentId: string
  managerId: string
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

export type DeliveryMode = 'auto' | 'followUp' | 'steer'

export type MessageChannel = 'web' | 'slack'

export interface MessageSourceContext {
  channel: MessageChannel
  channelId?: string
  userId?: string
  threadTs?: string
  channelType?: 'dm' | 'channel' | 'group' | 'mpim'
  teamId?: string
}

export type MessageTargetContext = Pick<MessageSourceContext, 'channel' | 'channelId' | 'userId' | 'threadTs'>

export interface ConversationImageAttachment {
  type?: 'image'
  mimeType: string
  data: string
  fileName?: string
}

export interface ConversationTextAttachment {
  type: 'text'
  mimeType: string
  text: string
  fileName?: string
}

export interface ConversationBinaryAttachment {
  type: 'binary'
  mimeType: string
  data: string
  fileName?: string
}

export type ConversationAttachment =
  | ConversationImageAttachment
  | ConversationTextAttachment
  | ConversationBinaryAttachment

export type ClientCommand =
  | { type: 'subscribe'; agentId?: string }
  | {
      type: 'user_message'
      text: string
      attachments?: ConversationAttachment[]
      agentId?: string
      delivery?: DeliveryMode
    }
  | { type: 'kill_agent'; agentId: string }
  | { type: 'create_manager'; name: string; cwd: string; model: ManagerModelPreset; requestId?: string }
  | { type: 'delete_manager'; managerId: string; requestId?: string }
  | { type: 'list_directories'; path?: string; requestId?: string }
  | { type: 'validate_directory'; path: string; requestId?: string }
  | { type: 'pick_directory'; defaultPath?: string; requestId?: string }
  | { type: 'ping' }

export interface ConversationMessageEvent {
  type: 'conversation_message'
  agentId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: ConversationAttachment[]
  timestamp: string
  source: 'user_input' | 'speak_to_user' | 'system'
  sourceContext?: MessageSourceContext
}

export type ConversationLogKind =
  | 'message_start'
  | 'message_end'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'

export interface ConversationLogEvent {
  type: 'conversation_log'
  agentId: string
  timestamp: string
  source: 'runtime_log'
  kind: ConversationLogKind
  role?: 'user' | 'assistant' | 'system'
  toolName?: string
  toolCallId?: string
  text: string
  isError?: boolean
}

export interface ManagerCreatedEvent {
  type: 'manager_created'
  manager: AgentDescriptor
  requestId?: string
}

export interface ManagerDeletedEvent {
  type: 'manager_deleted'
  managerId: string
  requestId?: string
}

export interface DirectoriesListedEvent {
  type: 'directories_listed'
  path: string
  directories: string[]
  requestId?: string
}

export interface DirectoryValidatedEvent {
  type: 'directory_validated'
  path: string
  valid: boolean
  message?: string
  requestId?: string
}

export interface DirectoryPickedEvent {
  type: 'directory_picked'
  path: string | null
  requestId?: string
}

export interface SlackStatusEvent {
  type: 'slack_status'
  state: 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error'
  enabled: boolean
  updatedAt: string
  message?: string
  teamId?: string
  botUserId?: string
}

export type ConversationEntry = ConversationMessageEvent | ConversationLogEvent

export type ServerEvent =
  | { type: 'ready'; serverTime: string; subscribedAgentId: string }
  | { type: 'conversation_reset'; agentId: string; timestamp: string; reason: 'user_new_command' | 'api_reset' }
  | {
      type: 'conversation_history'
      agentId: string
      messages: ConversationEntry[]
    }
  | ConversationMessageEvent
  | ConversationLogEvent
  | { type: 'agent_status'; agentId: string; status: AgentStatus; pendingCount: number }
  | { type: 'agents_snapshot'; agents: AgentDescriptor[] }
  | ManagerCreatedEvent
  | ManagerDeletedEvent
  | DirectoriesListedEvent
  | DirectoryValidatedEvent
  | DirectoryPickedEvent
  | SlackStatusEvent
  | { type: 'error'; code: string; message: string; requestId?: string }
