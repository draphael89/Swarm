import type {
  AgentContextUsage,
  AgentDescriptor,
  ConversationAttachment,
  ConversationEntryEvent,
  SwarmModelPreset
} from "../swarm/types.js";
import type { SlackStatusEvent } from "../integrations/slack/slack-status.js";
import type { TelegramStatusEvent } from "../integrations/telegram/telegram-status.js";

export type {
  MessageChannel,
  MessageSourceContext,
  MessageTargetContext
} from "../swarm/types.js";

export interface DirectoryItem {
  name: string;
  path: string;
}

export type ClientCommand =
  | { type: "subscribe"; agentId?: string }
  | {
      type: "user_message";
      text: string;
      attachments?: ConversationAttachment[];
      agentId?: string;
      delivery?: "auto" | "followUp" | "steer";
    }
  | { type: "kill_agent"; agentId: string }
  | { type: "stop_all_agents"; managerId: string; requestId?: string }
  | { type: "create_manager"; name: string; cwd: string; model?: SwarmModelPreset; requestId?: string }
  | { type: "delete_manager"; managerId: string; requestId?: string }
  | { type: "list_directories"; path?: string; requestId?: string }
  | { type: "validate_directory"; path: string; requestId?: string }
  | { type: "pick_directory"; defaultPath?: string; requestId?: string }
  | { type: "ping" };

export type ServerEvent =
  | { type: "ready"; serverTime: string; subscribedAgentId: string }
  | { type: "conversation_reset"; agentId: string; timestamp: string; reason: "user_new_command" | "api_reset" }
  | {
      type: "conversation_history";
      agentId: string;
      messages: ConversationEntryEvent[];
    }
  | ConversationEntryEvent
  | {
      type: "agent_status";
      agentId: string;
      status: "idle" | "streaming" | "terminated" | "stopped_on_restart";
      pendingCount: number;
      contextUsage?: AgentContextUsage;
    }
  | { type: "agents_snapshot"; agents: AgentDescriptor[] }
  | { type: "manager_created"; manager: AgentDescriptor; requestId?: string }
  | { type: "manager_deleted"; managerId: string; terminatedWorkerIds: string[]; requestId?: string }
  | {
      type: "stop_all_agents_result";
      managerId: string;
      stoppedWorkerIds: string[];
      managerStopped: boolean;
      terminatedWorkerIds?: string[];
      managerTerminated?: boolean;
      requestId?: string;
    }
  | {
      type: "directories_listed";
      path: string;
      directories: string[];
      requestId?: string;
      requestedPath?: string;
      resolvedPath: string;
      roots: string[];
      entries: DirectoryItem[];
    }
  | {
      type: "directory_validated";
      path: string;
      valid: boolean;
      message?: string;
      requestId?: string;
      requestedPath: string;
      roots: string[];
      resolvedPath?: string;
    }
  | { type: "directory_picked"; path: string | null; requestId?: string }
  | SlackStatusEvent
  | TelegramStatusEvent
  | { type: "error"; code: string; message: string; requestId?: string };
