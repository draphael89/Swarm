import { WebSocketServer, type RawData, WebSocket } from "ws";
import type { ClientCommand, ServerEvent } from "../protocol/ws-types.js";
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
    this.swarmManager.on("conversation_reset", this.onConversationReset);
    this.swarmManager.on("agent_status", this.onAgentStatus);
    this.swarmManager.on("agents_snapshot", this.onAgentsSnapshot);
  }

  async stop(): Promise<void> {
    this.swarmManager.off("conversation_message", this.onConversationMessage);
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
        subscribedAgentId: this.subscriptions.get(socket) ?? this.swarmManager.getConfig().managerId
      });
      return;
    }

    if (command.type === "subscribe") {
      const targetAgent = command.agentId ?? this.swarmManager.getConfig().managerId;

      if (!this.allowNonManagerSubscriptions && targetAgent !== this.swarmManager.getConfig().managerId) {
        this.send(socket, {
          type: "error",
          code: "SUBSCRIPTION_NOT_SUPPORTED",
          message: `Subscriptions are currently limited to ${this.swarmManager.getConfig().managerId}.`
        });
        return;
      }

      this.subscriptions.set(socket, targetAgent);

      this.send(socket, {
        type: "ready",
        serverTime: new Date().toISOString(),
        subscribedAgentId: targetAgent
      });
      this.send(socket, {
        type: "agents_snapshot",
        agents: this.swarmManager.listAgents()
      });
      this.send(socket, {
        type: "conversation_history",
        agentId: targetAgent,
        messages: this.swarmManager.getConversationHistory(targetAgent)
      });
      return;
    }

    if (command.type === "user_message") {
      if (!this.subscriptions.has(socket)) {
        this.send(socket, {
          type: "error",
          code: "NOT_SUBSCRIBED",
          message: "Send subscribe before user_message."
        });
        return;
      }

      try {
        if (command.text.trim() === "/new") {
          await this.swarmManager.resetManagerSession("user_new_command");
          return;
        }
        await this.swarmManager.handleUserMessage(command.text);
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

  private broadcastToSubscribed(event: ServerEvent): void {
    if (!this.wss) return;

    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      const subscribedAgent = this.subscriptions.get(client);
      if (!subscribedAgent) continue;

      if (event.type === "conversation_message" || event.type === "conversation_reset") {
        if (subscribedAgent !== this.swarmManager.getConfig().managerId) {
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

    if (maybe.type === "user_message") {
      if (typeof maybe.text !== "string" || maybe.text.trim().length === 0) {
        return { ok: false, error: "user_message.text must be a non-empty string" };
      }
      return { ok: true, command: { type: "user_message", text: maybe.text } };
    }

    return { ok: false, error: "Unknown command type" };
  }
}
