export type AgentRole = "manager" | "worker";

export type AgentArchetypeId = string;

export type AgentStatus = "idle" | "streaming" | "terminated" | "stopped_on_restart";

export const SWARM_MODEL_PRESETS = ["pi-codex", "pi-opus", "codex-app"] as const;

export type SwarmModelPreset = (typeof SWARM_MODEL_PRESETS)[number];

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

export type MessageChannel = "web" | "slack";

export interface MessageSourceContext {
  channel: MessageChannel;
  channelId?: string;
  userId?: string;
  threadTs?: string;
  channelType?: "dm" | "channel" | "group" | "mpim";
  teamId?: string;
}

export type MessageTargetContext = Pick<MessageSourceContext, "channel" | "channelId" | "userId" | "threadTs">;

export interface SendMessageReceipt {
  targetAgentId: string;
  deliveryId: string;
  acceptedMode: AcceptedDeliveryMode;
}

export interface SpawnAgentInput {
  agentId: string;
  archetypeId?: AgentArchetypeId;
  systemPrompt?: string;
  model?: SwarmModelPreset;
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
  secretsFile: string;
}

export interface SkillEnvRequirement {
  name: string;
  description?: string;
  required: boolean;
  helpUrl?: string;
  skillName: string;
  isSet: boolean;
  maskedValue?: string;
}

export type SettingsAuthProviderName = "anthropic" | "openai";

export interface SettingsAuthProvider {
  provider: SettingsAuthProviderName;
  configured: boolean;
  authType?: "api_key" | "oauth" | "unknown";
  maskedValue?: string;
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

export interface ConversationImageAttachment {
  type?: "image";
  mimeType: string;
  data: string;
  fileName?: string;
}

export interface ConversationTextAttachment {
  type: "text";
  mimeType: string;
  text: string;
  fileName?: string;
}

export interface ConversationBinaryAttachment {
  type: "binary";
  mimeType: string;
  data: string;
  fileName?: string;
}

export type ConversationAttachment =
  | ConversationImageAttachment
  | ConversationTextAttachment
  | ConversationBinaryAttachment;

export interface ConversationMessageEvent {
  type: "conversation_message";
  agentId: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ConversationAttachment[];
  timestamp: string;
  source: "user_input" | "speak_to_user" | "system";
  sourceContext?: MessageSourceContext;
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
