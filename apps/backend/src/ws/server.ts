import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import type { ClientCommand, ServerEvent } from "../protocol/ws-types.js";
import {
  isPathWithinRoots,
  normalizeAllowlistRoots,
  resolveDirectoryPath
} from "../swarm/cwd-policy.js";
import { describeSwarmModelPresets, isSwarmModelPreset } from "../swarm/model-presets.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";

const REBOOT_ENDPOINT_PATH = "/api/reboot";
const READ_FILE_ENDPOINT_PATH = "/api/read-file";
const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";
const MAX_READ_FILE_BODY_BYTES = 64 * 1024;
const MAX_READ_FILE_CONTENT_BYTES = 2 * 1024 * 1024;

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private readonly allowNonManagerSubscriptions: boolean;

  private httpServer: HttpServer | null = null;
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
    if (this.httpServer || this.wss) return;

    const httpServer = createServer((request, response) => {
      this.handleHttpRequest(request, response);
    });
    const wss = new WebSocketServer({
      server: httpServer
    });

    this.httpServer = httpServer;
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
        httpServer.off("listening", onListening);
        httpServer.off("error", onError);
      };

      httpServer.on("listening", onListening);
      httpServer.on("error", onError);
      httpServer.listen(this.port, this.host);
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

    const currentWss = this.wss;
    const currentHttpServer = this.httpServer;

    this.wss = null;
    this.httpServer = null;
    this.subscriptions.clear();

    if (currentWss) {
      await closeWebSocketServer(currentWss);
    }

    if (currentHttpServer) {
      await closeHttpServer(currentHttpServer);
    }
  }

  private handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`
    );

    if (requestUrl.pathname === REBOOT_ENDPOINT_PATH) {
      this.handleRebootHttpRequest(request, response);
      return;
    }

    if (requestUrl.pathname === READ_FILE_ENDPOINT_PATH) {
      void this.handleReadFileHttpRequest(request, response);
      return;
    }

    response.statusCode = 404;
    response.end("Not Found");
  }

  private handleRebootHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, "POST, OPTIONS");
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST") {
      this.applyCorsHeaders(request, response, "POST, OPTIONS");
      response.setHeader("Allow", "POST, OPTIONS");
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    this.applyCorsHeaders(request, response, "POST, OPTIONS");
    this.sendJson(response, 200, { ok: true });

    const rebootTimer = setTimeout(() => {
      this.triggerRebootSignal();
    }, 25);
    rebootTimer.unref();
  }

  private async handleReadFileHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, "POST, OPTIONS");
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST") {
      this.applyCorsHeaders(request, response, "POST, OPTIONS");
      response.setHeader("Allow", "POST, OPTIONS");
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    this.applyCorsHeaders(request, response, "POST, OPTIONS");

    try {
      const payload = await this.parseJsonBody(request, MAX_READ_FILE_BODY_BYTES);
      if (!payload || typeof payload !== "object") {
        this.sendJson(response, 400, { error: "Request body must be a JSON object." });
        return;
      }

      const requestedPath = (payload as { path?: unknown }).path;
      if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
        this.sendJson(response, 400, { error: "path must be a non-empty string." });
        return;
      }

      const config = this.swarmManager.getConfig();
      const resolvedPath = resolveDirectoryPath(requestedPath, config.paths.rootDir);
      const allowedRoots = normalizeAllowlistRoots([
        ...config.cwdAllowlistRoots,
        config.paths.rootDir,
        homedir()
      ]);

      if (!isPathWithinRoots(resolvedPath, allowedRoots)) {
        this.sendJson(response, 403, { error: "Path is outside allowed roots." });
        return;
      }

      let fileStats;
      try {
        fileStats = await stat(resolvedPath);
      } catch {
        this.sendJson(response, 404, { error: "File not found." });
        return;
      }

      if (!fileStats.isFile()) {
        this.sendJson(response, 400, { error: "Requested path must point to a file." });
        return;
      }

      if (fileStats.size > MAX_READ_FILE_CONTENT_BYTES) {
        this.sendJson(response, 413, {
          error: `File is too large. Maximum supported size is ${MAX_READ_FILE_CONTENT_BYTES} bytes.`
        });
        return;
      }

      const content = await readFile(resolvedPath, "utf8");
      this.sendJson(response, 200, {
        path: resolvedPath,
        content
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read file.";

      if (message.includes("Request body exceeds")) {
        this.sendJson(response, 413, { error: message });
        return;
      }

      if (message.includes("valid JSON")) {
        this.sendJson(response, 400, { error: message });
        return;
      }

      this.sendJson(response, 500, { error: message });
    }
  }

  private applyCorsHeaders(request: IncomingMessage, response: ServerResponse, methods: string): void {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "*";

    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", methods);
    response.setHeader("Access-Control-Allow-Headers", "content-type");
  }

  private async parseJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let byteLength = 0;

    for await (const chunk of request) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      byteLength += buffer.byteLength;

      if (byteLength > maxBytes) {
        throw new Error(`Request body exceeds ${maxBytes} bytes.`);
      }

      chunks.push(buffer);
    }

    if (chunks.length === 0) {
      return {};
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");

    try {
      return JSON.parse(rawBody);
    } catch {
      throw new Error("Request body must be valid JSON.");
    }
  }

  private sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }

  private triggerRebootSignal(): void {
    try {
      const daemonPid = resolveProdDaemonPid(this.swarmManager.getConfig().paths.rootDir);
      const targetPid = daemonPid ?? process.pid;

      process.kill(targetPid, RESTART_SIGNAL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[reboot] Failed to send ${RESTART_SIGNAL}: ${message}`);
    }
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
          delivery: command.delivery,
          attachments: command.attachments
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
      if (typeof maybe.text !== "string") {
        return { ok: false, error: "user_message.text must be a string" };
      }

      const normalizedText = maybe.text.trim();
      const parsedAttachments = parseConversationAttachments(
        (maybe as { attachments?: unknown }).attachments,
        "user_message.attachments"
      );
      if (!parsedAttachments.ok) {
        return { ok: false, error: parsedAttachments.error };
      }

      if (!normalizedText && parsedAttachments.attachments.length === 0) {
        return {
          ok: false,
          error: "user_message must include non-empty text or at least one attachment"
        };
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
          text: normalizedText,
          attachments: parsedAttachments.attachments.length > 0 ? parsedAttachments.attachments : undefined,
          agentId: maybe.agentId,
          delivery: maybe.delivery
        }
      };
    }

    return { ok: false, error: "Unknown command type" };
  }
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function resolveProdDaemonPid(repoRoot: string): number | null {
  const pidFile = getProdDaemonPidFile(repoRoot);
  if (!existsSync(pidFile)) {
    return null;
  }

  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      rmSync(pidFile, { force: true });
    }

    return null;
  }
}

function getProdDaemonPidFile(repoRoot: string): string {
  const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
  return join(tmpdir(), `swarm-prod-daemon-${repoHash}.pid`);
}

function parseConversationAttachments(
  value: unknown,
  fieldName: string
):
  | {
      ok: true;
      attachments: Array<
        | { mimeType: string; data: string; fileName?: string }
        | { type: "text"; mimeType: string; text: string; fileName?: string }
        | { type: "binary"; mimeType: string; data: string; fileName?: string }
      >;
    }
  | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, attachments: [] };
  }

  if (!Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be an array when provided` };
  }

  const attachments: Array<
    | { mimeType: string; data: string; fileName?: string }
    | { type: "text"; mimeType: string; text: string; fileName?: string }
    | { type: "binary"; mimeType: string; data: string; fileName?: string }
  > = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object") {
      return { ok: false, error: `${fieldName}[${index}] must be an object` };
    }

    const maybe = item as {
      type?: unknown;
      mimeType?: unknown;
      data?: unknown;
      text?: unknown;
      fileName?: unknown;
    };

    if (maybe.type !== undefined && typeof maybe.type !== "string") {
      return { ok: false, error: `${fieldName}[${index}].type must be a string when provided` };
    }

    if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
      return { ok: false, error: `${fieldName}[${index}].mimeType must be a non-empty string` };
    }

    if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
      return { ok: false, error: `${fieldName}[${index}].fileName must be a string when provided` };
    }

    const attachmentType = typeof maybe.type === "string" ? maybe.type.trim() : "";
    const mimeType = maybe.mimeType.trim();
    const fileName = typeof maybe.fileName === "string" ? maybe.fileName.trim() : "";

    if (attachmentType === "text") {
      if (typeof maybe.text !== "string" || maybe.text.trim().length === 0) {
        return { ok: false, error: `${fieldName}[${index}].text must be a non-empty string` };
      }

      attachments.push({
        type: "text",
        mimeType,
        text: maybe.text,
        fileName: fileName || undefined
      });
      continue;
    }

    if (attachmentType === "binary") {
      if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
        return { ok: false, error: `${fieldName}[${index}].data must be a non-empty base64 string` };
      }

      attachments.push({
        type: "binary",
        mimeType,
        data: maybe.data.trim(),
        fileName: fileName || undefined
      });
      continue;
    }

    if (attachmentType !== "" && attachmentType !== "image") {
      return {
        ok: false,
        error: `${fieldName}[${index}].type must be image|text|binary when provided`
      };
    }

    if (!mimeType.startsWith("image/")) {
      return { ok: false, error: `${fieldName}[${index}].mimeType must start with image/` };
    }

    if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
      return { ok: false, error: `${fieldName}[${index}].data must be a non-empty base64 string` };
    }

    attachments.push({
      mimeType,
      data: maybe.data.trim(),
      fileName: fileName || undefined
    });
  }

  return { ok: true, attachments };
}
