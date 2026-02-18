import { WebSocketServer, type RawData, WebSocket } from "ws";
import type { ClientCommand, ServerEvent } from "../protocol/ws-types.js";
import { describeSwarmModelPresets, isSwarmModelPreset } from "../swarm/model-presets.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private readonly allowNonManagerSubscriptions: boolean;

  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Map<WebSocket, string>();

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onConversationLog = (event: ServerEvent): void => {
    if (event.type !== "conversation_log") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onConversationReset = (event: ServerEvent): void => {
    if (event.type !== "conversation_reset") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onAgentStatus = (event: ServerEvent): void => {
    if (event.type !== "agent_status") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onAgentsSnapshot = (event: ServerEvent): void => {
    if (event.type !== "agents_snapshot") return;
    this.broadcastToSubscribed(event);
  };

  constructor(options: {
    swarmManager: SwarmManager;
    host: string;
    port: number;
    allowNonManagerSubscriptions: boolean;
  }) {
    this.swarmManager = options.swarmManager;
    this.host = options.host;
    this.port = options.port;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
  }

  async start(): Promise<void> {
    if (this.wss) return;

    const wss = new WebSocketServer({
      host: this.host,
      port: this.port
    });
    this.wss = wss;

    this.wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw);
      });

      socket.on("close", () => {
        this.subscriptions.delete(socket);
      });

      socket.on("error", () => {
        this.subscriptions.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup();
        resolve();
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        wss.off("listening", onListening);
        wss.off("error", onError);
      };

      wss.on("listening", onListening);
      wss.on("error", onError);
    });

    this.swarmManager.on("conversation_message", this.onConversationMessage);
    this.swarmManager.on("conversation_log", this.onConversationLog);
    this.swarmManager.on("conversation_reset", this.onConversationReset);
    this.swarmManager.on("agent_status", this.onAgentStatus);
    this.swarmManager.on("agents_snapshot", this.onAgentsSnapshot);
  }

  async stop(): Promise<void> {
    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("conversation_log", this.onConversationLog);
    this.swarmManager.off("conversation_reset", this.onConversationReset);
    this.swarmManager.off("agent_status", this.onAgentStatus);
    this.swarmManager.off("agents_snapshot", this.onAgentsSnapshot);

    const current = this.wss;
    this.wss = null;
    this.subscriptions.clear();

    if (!current) return;

    await new Promise<void>((resolve, reject) => {
      current.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleSocketMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const parsed = this.parseClientCommand(raw);
    if (!parsed.ok) {
      this.send(socket, {
        type: "error",
        code: "INVALID_COMMAND",
        message: parsed.error
      });
      return;
    }

    const command = parsed.command;

    if (command.type === "ping") {
      this.send(socket, {
        type: "ready",
        serverTime: new Date().toISOString(),
        subscribedAgentId: this.subscriptions.get(socket) ?? this.resolveDefaultSubscriptionAgentId()
      });
      return;
    }

    if (command.type === "subscribe") {
      await this.handleSubscribe(socket, command.agentId);
      return;
    }

    const subscribedAgentId = this.resolveSubscribedAgentId(socket);
    if (!subscribedAgentId) {
      this.send(socket, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: `Send subscribe before ${command.type}.`,
        requestId: this.extractRequestId(command)
      });
      return;
    }

    if (command.type === "kill_agent") {
      const managerContextId = this.resolveManagerContextAgentId(subscribedAgentId);
      if (!managerContextId) {
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message: `Agent ${subscribedAgentId} does not exist.`
        });
        return;
      }

      try {
        await this.swarmManager.killAgent(managerContextId, command.agentId);
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "KILL_AGENT_FAILED",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (command.type === "create_manager") {
      const managerContextId = this.resolveManagerContextAgentId(subscribedAgentId);
      if (!managerContextId) {
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message: `Agent ${subscribedAgentId} does not exist.`,
          requestId: command.requestId
        });
        return;
      }

      try {
        const manager = await this.swarmManager.createManager(managerContextId, {
          name: command.name,
          cwd: command.cwd,
          model: command.model
        });

        this.broadcastToSubscribed({
          type: "manager_created",
          manager,
          requestId: command.requestId
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "CREATE_MANAGER_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "delete_manager") {
      const managerContextId = this.resolveManagerContextAgentId(subscribedAgentId);
      if (!managerContextId) {
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message: `Agent ${subscribedAgentId} does not exist.`,
          requestId: command.requestId
        });
        return;
      }

      try {
        const deleted = await this.swarmManager.deleteManager(managerContextId, command.managerId);
        this.handleDeletedAgentSubscriptions(new Set([deleted.managerId, ...deleted.terminatedWorkerIds]));

        this.broadcastToSubscribed({
          type: "manager_deleted",
          managerId: deleted.managerId,
          terminatedWorkerIds: deleted.terminatedWorkerIds,
          requestId: command.requestId
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "DELETE_MANAGER_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "list_directories") {
      try {
        const listed = await this.swarmManager.listDirectories(command.path);
        this.send(socket, {
          type: "directories_listed",
          path: listed.resolvedPath,
          directories: listed.directories.map((entry) => entry.path),
          requestId: command.requestId,
          requestedPath: listed.requestedPath,
          resolvedPath: listed.resolvedPath,
          roots: listed.roots,
          entries: listed.directories
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "LIST_DIRECTORIES_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "validate_directory") {
      try {
        const validation = await this.swarmManager.validateDirectory(command.path);
        this.send(socket, {
          type: "directory_validated",
          path: validation.requestedPath,
          valid: validation.valid,
          message: validation.message,
          requestId: command.requestId,
          requestedPath: validation.requestedPath,
          roots: validation.roots,
          resolvedPath: validation.resolvedPath
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "VALIDATE_DIRECTORY_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "pick_directory") {
      try {
        const pickedPath = await this.swarmManager.pickDirectory(command.defaultPath);
        this.send(socket, {
          type: "directory_picked",
          path: pickedPath,
          requestId: command.requestId
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "PICK_DIRECTORY_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "user_message") {
      const managerId = this.swarmManager.getConfig().managerId;
      const targetAgentId = command.agentId ?? subscribedAgentId;

      if (!this.allowNonManagerSubscriptions && targetAgentId !== managerId) {
        this.send(socket, {
          type: "error",
          code: "SUBSCRIPTION_NOT_SUPPORTED",
          message: `Messages are currently limited to ${managerId}.`
        });
        return;
      }

      const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
      if (!targetDescriptor) {
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message: `Agent ${targetAgentId} does not exist.`
        });
        return;
      }

      try {
        if (targetDescriptor.role === "manager" && command.text.trim() === "/new") {
          await this.swarmManager.resetManagerSession(targetDescriptor.agentId, "user_new_command");
          return;
        }

        await this.swarmManager.handleUserMessage(command.text, {
          targetAgentId,
          delivery: command.delivery
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "USER_MESSAGE_FAILED",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
  }

  private async handleSubscribe(socket: WebSocket, requestedAgentId?: string): Promise<void> {
    const managerId = this.swarmManager.getConfig().managerId;
    const targetAgentId =
      requestedAgentId ?? this.resolvePreferredManagerSubscriptionId() ?? this.resolveDefaultSubscriptionAgentId();

    if (!this.allowNonManagerSubscriptions && targetAgentId !== managerId) {
      this.send(socket, {
        type: "error",
        code: "SUBSCRIPTION_NOT_SUPPORTED",
        message: `Subscriptions are currently limited to ${managerId}.`
      });
      return;
    }

    const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
    const canBootstrapSubscription =
      !targetDescriptor && requestedAgentId === managerId && !this.hasRunningManagers();

    if (!targetDescriptor && requestedAgentId && !canBootstrapSubscription) {
      this.send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${targetAgentId} does not exist.`
      });
      return;
    }

    this.subscriptions.set(socket, targetAgentId);
    this.sendSubscriptionBootstrap(socket, targetAgentId);
  }

  private resolveSubscribedAgentId(socket: WebSocket): string | undefined {
    const subscribedAgentId = this.subscriptions.get(socket);
    if (!subscribedAgentId) {
      return undefined;
    }

    if (this.swarmManager.getAgent(subscribedAgentId)) {
      return subscribedAgentId;
    }

    const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
    if (!fallbackAgentId) {
      return subscribedAgentId;
    }

    this.subscriptions.set(socket, fallbackAgentId);
    this.sendSubscriptionBootstrap(socket, fallbackAgentId);

    return fallbackAgentId;
  }

  private resolveManagerContextAgentId(subscribedAgentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    if (!descriptor) {
      if (!this.hasRunningManagers()) {
        return this.swarmManager.getConfig().managerId;
      }
      return undefined;
    }

    return descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
  }

  private handleDeletedAgentSubscriptions(deletedAgentIds: Set<string>): void {
    for (const [socket, subscribedAgentId] of this.subscriptions.entries()) {
      if (!deletedAgentIds.has(subscribedAgentId)) {
        continue;
      }

      const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
      if (!fallbackAgentId) {
        this.subscriptions.set(socket, this.resolveDefaultSubscriptionAgentId());
        continue;
      }

      this.subscriptions.set(socket, fallbackAgentId);
      this.sendSubscriptionBootstrap(socket, fallbackAgentId);
    }
  }

  private sendSubscriptionBootstrap(socket: WebSocket, targetAgentId: string): void {
    this.send(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      subscribedAgentId: targetAgentId
    });
    this.send(socket, {
      type: "agents_snapshot",
      agents: this.swarmManager.listAgents()
    });
    this.send(socket, {
      type: "conversation_history",
      agentId: targetAgentId,
      messages: this.swarmManager.getConversationHistory(targetAgentId)
    });
  }

  private resolveDefaultSubscriptionAgentId(): string {
    return this.resolvePreferredManagerSubscriptionId() ?? this.swarmManager.getConfig().managerId;
  }

  private resolvePreferredManagerSubscriptionId(): string | undefined {
    const managerId = this.swarmManager.getConfig().managerId;
    const configuredManager = this.swarmManager.getAgent(managerId);
    if (configuredManager && this.isSubscribable(configuredManager.status)) {
      return managerId;
    }

    const firstManager = this.swarmManager
      .listAgents()
      .find((agent) => agent.role === "manager" && this.isSubscribable(agent.status));

    return firstManager?.agentId;
  }

  private hasRunningManagers(): boolean {
    return this.swarmManager
      .listAgents()
      .some((agent) => agent.role === "manager" && this.isSubscribable(agent.status));
  }

  private isSubscribable(status: string): boolean {
    return status === "idle" || status === "streaming";
  }

  private extractRequestId(command: ClientCommand): string | undefined {
    switch (command.type) {
      case "create_manager":
      case "delete_manager":
      case "list_directories":
      case "validate_directory":
      case "pick_directory":
        return command.requestId;

      case "subscribe":
      case "user_message":
      case "kill_agent":
      case "ping":
        return undefined;
    }
  }

  private broadcastToSubscribed(event: ServerEvent): void {
    if (!this.wss) return;

    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      const subscribedAgent = this.subscriptions.get(client);
      if (!subscribedAgent) continue;

      if (
        event.type === "conversation_message" ||
        event.type === "conversation_log" ||
        event.type === "conversation_reset"
      ) {
        if (subscribedAgent !== event.agentId) {
          continue;
        }
      }

      this.send(client, event);
    }
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(event));
  }

  private parseClientCommand(raw: RawData):
    | { ok: true; command: ClientCommand }
    | { ok: false; error: string } {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "Command must be valid JSON" };
    }

    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "Command must be a JSON object" };
    }

    const maybe = parsed as Partial<ClientCommand> & { type?: unknown };

    if (maybe.type === "ping") {
      return { ok: true, command: { type: "ping" } };
    }

    if (maybe.type === "subscribe") {
      if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
        return { ok: false, error: "subscribe.agentId must be a string when provided" };
      }
      return { ok: true, command: { type: "subscribe", agentId: maybe.agentId } };
    }

    if (maybe.type === "kill_agent") {
      if (typeof maybe.agentId !== "string" || maybe.agentId.trim().length === 0) {
        return { ok: false, error: "kill_agent.agentId must be a non-empty string" };
      }

      return {
        ok: true,
        command: {
          type: "kill_agent",
          agentId: maybe.agentId.trim()
        }
      };
    }

    if (maybe.type === "create_manager") {
      const name = (maybe as { name?: unknown }).name;
      const cwd = (maybe as { cwd?: unknown }).cwd;
      const model = (maybe as { model?: unknown }).model;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (typeof name !== "string" || name.trim().length === 0) {
        return { ok: false, error: "create_manager.name must be a non-empty string" };
      }
      if (typeof cwd !== "string" || cwd.trim().length === 0) {
        return { ok: false, error: "create_manager.cwd must be a non-empty string" };
      }
      if (model !== undefined && !isSwarmModelPreset(model)) {
        return {
          ok: false,
          error: `create_manager.model must be one of ${describeSwarmModelPresets()}`
        };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "create_manager.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "create_manager",
          name: name.trim(),
          cwd,
          model,
          requestId
        }
      };
    }

    if (maybe.type === "delete_manager") {
      const managerId = (maybe as { managerId?: unknown }).managerId;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (typeof managerId !== "string" || managerId.trim().length === 0) {
        return { ok: false, error: "delete_manager.managerId must be a non-empty string" };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "delete_manager.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "delete_manager",
          managerId: managerId.trim(),
          requestId
        }
      };
    }

    if (maybe.type === "list_directories") {
      const path = (maybe as { path?: unknown }).path;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (path !== undefined && typeof path !== "string") {
        return { ok: false, error: "list_directories.path must be a string when provided" };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "list_directories.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "list_directories",
          path,
          requestId
        }
      };
    }

    if (maybe.type === "validate_directory") {
      const path = (maybe as { path?: unknown }).path;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (typeof path !== "string" || path.trim().length === 0) {
        return { ok: false, error: "validate_directory.path must be a non-empty string" };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "validate_directory.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "validate_directory",
          path,
          requestId
        }
      };
    }

    if (maybe.type === "pick_directory") {
      const defaultPath = (maybe as { defaultPath?: unknown }).defaultPath;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (defaultPath !== undefined && typeof defaultPath !== "string") {
        return { ok: false, error: "pick_directory.defaultPath must be a string when provided" };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "pick_directory.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "pick_directory",
          defaultPath: defaultPath?.trim() ? defaultPath : undefined,
          requestId
        }
      };
    }

    if (maybe.type === "user_message") {
      if (typeof maybe.text !== "string" || maybe.text.trim().length === 0) {
        return { ok: false, error: "user_message.text must be a non-empty string" };
      }

      if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
        return { ok: false, error: "user_message.agentId must be a string when provided" };
      }

      if (
        maybe.delivery !== undefined &&
        maybe.delivery !== "auto" &&
        maybe.delivery !== "followUp" &&
        maybe.delivery !== "steer"
      ) {
        return { ok: false, error: "user_message.delivery must be one of auto|followUp|steer" };
      }

      return {
        ok: true,
        command: {
          type: "user_message",
          text: maybe.text,
          agentId: maybe.agentId,
          delivery: maybe.delivery
        }
      };
    }

    return { ok: false, error: "Unknown command type" };
  }
}
