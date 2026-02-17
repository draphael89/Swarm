export type AgentRole = "manager" | "worker";

export type AgentArchetypeId = string;

export type AgentStatus = "idle" | "streaming" | "terminated" | "stopped_on_restart";

export interface AgentModelDescriptor {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface AgentDescriptor {
  agentId: string;
  displayName: string;
  role: AgentRole;
  managerId: string;
  archetypeId?: AgentArchetypeId;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: AgentModelDescriptor;
  sessionFile: string;
}

export interface AgentsStoreFile {
  agents: AgentDescriptor[];
}

export type RequestedDeliveryMode = "auto" | "followUp" | "steer";

export type AcceptedDeliveryMode = "prompt" | "followUp" | "steer";

export interface SendMessageReceipt {
  targetAgentId: string;
  deliveryId: string;
  acceptedMode: AcceptedDeliveryMode;
}

export interface SpawnAgentInput {
  agentId: string;
  archetypeId?: AgentArchetypeId;
  systemPrompt?: string;
  model?: {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
  };
  cwd?: string;
  initialMessage?: string;
}

export interface SwarmPaths {
  rootDir: string;
  dataDir: string;
  swarmDir: string;
  sessionsDir: string;
  authDir: string;
  authFile: string;
  agentDir: string;
  managerAgentDir: string;
  repoArchetypesDir: string;
  memoryFile: string;
  repoMemorySkillFile: string;
  agentsStoreFile: string;
}

export interface SwarmConfig {
  host: string;
  port: number;
  debug: boolean;
  allowNonManagerSubscriptions: boolean;
  managerId: string;
  managerDisplayName: string;
  defaultModel: AgentModelDescriptor;
  defaultCwd: string;
  cwdAllowlistRoots: string[];
  paths: SwarmPaths;
}

export interface ConversationMessageEvent {
  type: "conversation_message";
  agentId: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  source: "user_input" | "speak_to_user" | "system";
}

export type ConversationLogKind =
  | "message_start"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end";

export interface ConversationLogEvent {
  type: "conversation_log";
  agentId: string;
  timestamp: string;
  source: "runtime_log";
  kind: ConversationLogKind;
  role?: "user" | "assistant" | "system";
  toolName?: string;
  toolCallId?: string;
  text: string;
  isError?: boolean;
}

export type ConversationEntryEvent = ConversationMessageEvent | ConversationLogEvent;

export interface AgentStatusEvent {
  type: "agent_status";
  agentId: string;
  status: AgentStatus;
  pendingCount: number;
}

export interface AgentsSnapshotEvent {
  type: "agents_snapshot";
  agents: AgentDescriptor[];
}
