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
  | { type: "create_manager"; name: string; cwd: string }
  | { type: "delete_manager"; managerId: string }
  | { type: "list_directories"; path?: string }
  | { type: "validate_directory"; path: string }
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
  | { type: "manager_created"; manager: AgentDescriptor }
  | { type: "manager_deleted"; managerId: string; terminatedWorkerIds: string[] }
  | {
      type: "directories_listed";
      requestedPath?: string;
      resolvedPath: string;
      roots: string[];
      directories: DirectoryItem[];
    }
  | {
      type: "directory_validated";
      requestedPath: string;
      valid: boolean;
      roots: string[];
      resolvedPath?: string;
      message?: string;
    }
  | { type: "error"; code: string; message: string };
