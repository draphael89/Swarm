import type {
  AgentDescriptor,
  ConversationEntryEvent,
  ConversationLogEvent,
  ConversationMessageEvent
} from "../swarm/types.js";

export interface DirectoryItem {
  name: string;
  path: string;
}

export type ClientCommand =
  | { type: "subscribe"; agentId?: string }
  | { type: "user_message"; text: string; agentId?: string; delivery?: "auto" | "followUp" | "steer" }
  | { type: "kill_agent"; agentId: string }
  | { type: "create_manager"; name: string; cwd: string; requestId?: string }
  | { type: "delete_manager"; managerId: string; requestId?: string }
  | { type: "list_directories"; path?: string; requestId?: string }
  | { type: "validate_directory"; path: string; requestId?: string }
  | { type: "ping" };

export type ServerEvent =
  | { type: "ready"; serverTime: string; subscribedAgentId: string }
  | { type: "conversation_reset"; agentId: string; timestamp: string; reason: "user_new_command" | "api_reset" }
  | {
      type: "conversation_history";
      agentId: string;
      messages: ConversationEntryEvent[];
    }
  | ConversationMessageEvent
  | ConversationLogEvent
  | {
      type: "agent_status";
      agentId: string;
      status: "idle" | "streaming" | "terminated" | "stopped_on_restart";
      pendingCount: number;
    }
  | { type: "agents_snapshot"; agents: AgentDescriptor[] }
  | { type: "manager_created"; manager: AgentDescriptor; requestId?: string }
  | { type: "manager_deleted"; managerId: string; terminatedWorkerIds: string[]; requestId?: string }
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
  | { type: "error"; code: string; message: string; requestId?: string };
