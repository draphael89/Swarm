export type AgentRole = "manager" | "worker";

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
  name: string;
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
  managerAppendSystemPromptFile: string;
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
