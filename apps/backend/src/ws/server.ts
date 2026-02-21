import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicOAuthProvider } from "@mariozechner/pi-ai/dist/utils/oauth/anthropic.js";
import { openaiCodexOAuthProvider } from "@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface
} from "@mariozechner/pi-ai/dist/utils/oauth/types.js";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import type { ClientCommand, ServerEvent } from "../protocol/ws-types.js";
import type { SlackIntegrationService } from "../integrations/slack/slack-integration.js";
import type { TelegramIntegrationService } from "../integrations/telegram/telegram-integration.js";
import {
  isPathWithinRoots,
  normalizeAllowlistRoots,
  resolveDirectoryPath
} from "../swarm/cwd-policy.js";
import { describeSwarmModelPresets, isSwarmModelPreset } from "../swarm/model-presets.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";

const REBOOT_ENDPOINT_PATH = "/api/reboot";
const READ_FILE_ENDPOINT_PATH = "/api/read-file";
const AGENT_COMPACT_ENDPOINT_PATTERN = /^\/api\/agents\/([^/]+)\/compact$/;
const SETTINGS_ENV_ENDPOINT_PATH = "/api/settings/env";
const SETTINGS_AUTH_ENDPOINT_PATH = "/api/settings/auth";
const SETTINGS_AUTH_LOGIN_ENDPOINT_PATH = "/api/settings/auth/login";
const SLACK_INTEGRATION_ENDPOINT_PATH = "/api/integrations/slack";
const SLACK_INTEGRATION_TEST_ENDPOINT_PATH = "/api/integrations/slack/test";
const SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATH = "/api/integrations/slack/channels";
const TELEGRAM_INTEGRATION_ENDPOINT_PATH = "/api/integrations/telegram";
const TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATH = "/api/integrations/telegram/test";
const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";
const MAX_HTTP_BODY_SIZE_BYTES = 64 * 1024;
const MAX_READ_FILE_BODY_BYTES = 64 * 1024;
const MAX_READ_FILE_CONTENT_BYTES = 2 * 1024 * 1024;
const SETTINGS_AUTH_LOGIN_METHODS = "POST, OPTIONS";
const SETTINGS_AUTH_METHODS = "GET, PUT, DELETE, POST, OPTIONS";

type OAuthLoginProviderId = "anthropic" | "openai-codex";

type SettingsAuthLoginEventName = "auth_url" | "prompt" | "progress" | "complete" | "error";

type SettingsAuthLoginEventPayload = {
  auth_url: { url: string; instructions?: string };
  prompt: { message: string; placeholder?: string };
  progress: { message: string };
  complete: { provider: OAuthLoginProviderId; status: "connected" };
  error: { message: string };
};

interface SettingsAuthLoginFlow {
  providerId: OAuthLoginProviderId;
  pendingPrompt:
    | {
        resolve: (value: string) => void;
        reject: (error: Error) => void;
      }
    | null;
  abortController: AbortController;
  closed: boolean;
}

const SETTINGS_AUTH_LOGIN_PROVIDER_ALIASES: Record<string, OAuthLoginProviderId> = {
  anthropic: "anthropic",
  openai: "openai-codex",
  "openai-codex": "openai-codex"
};

const SETTINGS_AUTH_LOGIN_PROVIDERS: Record<OAuthLoginProviderId, OAuthProviderInterface> = {
  anthropic: anthropicOAuthProvider,
  "openai-codex": openaiCodexOAuthProvider
};

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private readonly allowNonManagerSubscriptions: boolean;
  private readonly slackIntegration: SlackIntegrationService | null;
  private readonly telegramIntegration: TelegramIntegrationService | null;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Map<WebSocket, string>();
  private readonly activeSettingsAuthLoginFlows = new Map<OAuthLoginProviderId, SettingsAuthLoginFlow>();

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

  private readonly onSlackStatus = (event: ServerEvent): void => {
    if (event.type !== "slack_status") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onTelegramStatus = (event: ServerEvent): void => {
    if (event.type !== "telegram_status") return;
    this.broadcastToSubscribed(event);
  };

  constructor(options: {
    swarmManager: SwarmManager;
    host: string;
    port: number;
    allowNonManagerSubscriptions: boolean;
    slackIntegration?: SlackIntegrationService;
    telegramIntegration?: TelegramIntegrationService;
  }) {
    this.swarmManager = options.swarmManager;
    this.host = options.host;
    this.port = options.port;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    this.slackIntegration = options.slackIntegration ?? null;
    this.telegramIntegration = options.telegramIntegration ?? null;
  }

  async start(): Promise<void> {
    if (this.httpServer || this.wss) return;

    const httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
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
    this.slackIntegration?.on("slack_status", this.onSlackStatus);
    this.telegramIntegration?.on("telegram_status", this.onTelegramStatus);
  }

  async stop(): Promise<void> {
    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("conversation_log", this.onConversationLog);
    this.swarmManager.off("conversation_reset", this.onConversationReset);
    this.swarmManager.off("agent_status", this.onAgentStatus);
    this.swarmManager.off("agents_snapshot", this.onAgentsSnapshot);
    this.slackIntegration?.off("slack_status", this.onSlackStatus);
    this.telegramIntegration?.off("telegram_status", this.onTelegramStatus);

    const currentWss = this.wss;
    const currentHttpServer = this.httpServer;

    this.wss = null;
    this.httpServer = null;
    this.subscriptions.clear();
    this.cancelAllActiveSettingsAuthLoginFlows();

    if (currentWss) {
      await closeWebSocketServer(currentWss);
    }

    if (currentHttpServer) {
      await closeHttpServer(currentHttpServer);
    }
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`
    );

    try {
      if (requestUrl.pathname === REBOOT_ENDPOINT_PATH) {
        this.handleRebootHttpRequest(request, response);
        return;
      }

      if (requestUrl.pathname === READ_FILE_ENDPOINT_PATH) {
        await this.handleReadFileHttpRequest(request, response);
        return;
      }

      if (AGENT_COMPACT_ENDPOINT_PATTERN.test(requestUrl.pathname)) {
        await this.handleCompactAgentHttpRequest(request, response, requestUrl);
        return;
      }

      if (
        requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH ||
        requestUrl.pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`)
      ) {
        await this.handleSettingsEnvHttpRequest(request, response, requestUrl);
        return;
      }

      if (
        requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH ||
        requestUrl.pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)
      ) {
        await this.handleSettingsAuthHttpRequest(request, response, requestUrl);
        return;
      }

      if (
        requestUrl.pathname === SLACK_INTEGRATION_ENDPOINT_PATH ||
        requestUrl.pathname === SLACK_INTEGRATION_TEST_ENDPOINT_PATH ||
        requestUrl.pathname === SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATH
      ) {
        await this.handleSlackIntegrationHttpRequest(request, response, requestUrl);
        return;
      }

      if (
        requestUrl.pathname === TELEGRAM_INTEGRATION_ENDPOINT_PATH ||
        requestUrl.pathname === TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATH
      ) {
        await this.handleTelegramIntegrationHttpRequest(request, response, requestUrl);
        return;
      }

      response.statusCode = 404;
      response.end("Not Found");
    } catch (error) {
      if (response.writableEnded || response.headersSent) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message.includes("must be") ||
        message.includes("Invalid") ||
        message.includes("Missing") ||
        message.includes("too large")
          ? 400
          : 500;

      if (
        requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH ||
        requestUrl.pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`)
      ) {
        this.applyCorsHeaders(request, response, "GET, PUT, DELETE, OPTIONS");
      } else if (
        requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH ||
        requestUrl.pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)
      ) {
        this.applyCorsHeaders(request, response, SETTINGS_AUTH_METHODS);
      } else if (requestUrl.pathname === READ_FILE_ENDPOINT_PATH) {
        this.applyCorsHeaders(request, response, "POST, OPTIONS");
      } else if (AGENT_COMPACT_ENDPOINT_PATTERN.test(requestUrl.pathname)) {
        this.applyCorsHeaders(request, response, "POST, OPTIONS");
      } else if (
        requestUrl.pathname === SLACK_INTEGRATION_ENDPOINT_PATH ||
        requestUrl.pathname === SLACK_INTEGRATION_TEST_ENDPOINT_PATH ||
        requestUrl.pathname === SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATH
      ) {
        this.applyCorsHeaders(request, response, "GET, PUT, DELETE, POST, OPTIONS");
      } else if (
        requestUrl.pathname === TELEGRAM_INTEGRATION_ENDPOINT_PATH ||
        requestUrl.pathname === TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATH
      ) {
        this.applyCorsHeaders(request, response, "GET, PUT, DELETE, POST, OPTIONS");
      }

      this.sendJson(response, statusCode, { error: message });
    }
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

  private async handleCompactAgentHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const methods = "POST, OPTIONS";
    const matched = requestUrl.pathname.match(AGENT_COMPACT_ENDPOINT_PATTERN);
    const rawAgentId = matched?.[1] ?? "";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST") {
      this.applyCorsHeaders(request, response, methods);
      response.setHeader("Allow", methods);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    this.applyCorsHeaders(request, response, methods);

    const agentId = decodeURIComponent(rawAgentId).trim();
    if (!agentId) {
      this.sendJson(response, 400, { error: "Missing agent id" });
      return;
    }

    const payload = await this.readJsonBody(request);
    const customInstructions = parseCompactCustomInstructionsBody(payload);

    try {
      const result = await this.swarmManager.compactAgentContext(agentId, {
        customInstructions,
        sourceContext: { channel: "web" },
        trigger: "api"
      });

      this.sendJson(response, 200, {
        ok: true,
        agentId,
        result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message.includes("Unknown target agent")
          ? 404
          : message.includes("not running") ||
              message.includes("does not support") ||
              message.includes("only supported")
            ? 409
            : message.includes("Invalid") || message.includes("Missing")
              ? 400
              : 500;

      this.sendJson(response, statusCode, { error: message });
    }
  }

  private async handleSettingsEnvHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const methods = "GET, PUT, DELETE, OPTIONS";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH) {
      this.applyCorsHeaders(request, response, methods);
      const variables = await this.swarmManager.listSettingsEnv();
      this.sendJson(response, 200, { variables });
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH) {
      this.applyCorsHeaders(request, response, methods);
      const payload = parseSettingsEnvUpdateBody(await this.readJsonBody(request));
      await this.swarmManager.updateSettingsEnv(payload);
      const variables = await this.swarmManager.listSettingsEnv();
      this.sendJson(response, 200, { ok: true, variables });
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`)) {
      this.applyCorsHeaders(request, response, methods);
      const variableName = decodeURIComponent(requestUrl.pathname.slice(SETTINGS_ENV_ENDPOINT_PATH.length + 1));
      if (!variableName) {
        this.sendJson(response, 400, { error: "Missing environment variable name" });
        return;
      }

      await this.swarmManager.deleteSettingsEnv(variableName);
      const variables = await this.swarmManager.listSettingsEnv();
      this.sendJson(response, 200, { ok: true, variables });
      return;
    }

    this.applyCorsHeaders(request, response, methods);
    response.setHeader("Allow", methods);
    this.sendJson(response, 405, { error: "Method Not Allowed" });
  }

  private async handleSettingsAuthHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    if (
      requestUrl.pathname === SETTINGS_AUTH_LOGIN_ENDPOINT_PATH ||
      requestUrl.pathname.startsWith(`${SETTINGS_AUTH_LOGIN_ENDPOINT_PATH}/`)
    ) {
      await this.handleSettingsAuthLoginHttpRequest(request, response, requestUrl);
      return;
    }

    const methods = SETTINGS_AUTH_METHODS;

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH) {
      this.applyCorsHeaders(request, response, methods);
      const providers = await this.swarmManager.listSettingsAuth();
      this.sendJson(response, 200, { providers });
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH) {
      this.applyCorsHeaders(request, response, methods);
      const payload = parseSettingsAuthUpdateBody(await this.readJsonBody(request));
      await this.swarmManager.updateSettingsAuth(payload);
      const providers = await this.swarmManager.listSettingsAuth();
      this.sendJson(response, 200, { ok: true, providers });
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)) {
      this.applyCorsHeaders(request, response, methods);
      const provider = decodeURIComponent(requestUrl.pathname.slice(SETTINGS_AUTH_ENDPOINT_PATH.length + 1));
      if (!provider) {
        this.sendJson(response, 400, { error: "Missing auth provider" });
        return;
      }

      await this.swarmManager.deleteSettingsAuth(provider);
      const providers = await this.swarmManager.listSettingsAuth();
      this.sendJson(response, 200, { ok: true, providers });
      return;
    }

    this.applyCorsHeaders(request, response, methods);
    response.setHeader("Allow", methods);
    this.sendJson(response, 405, { error: "Method Not Allowed" });
  }

  private async handleSettingsAuthLoginHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, SETTINGS_AUTH_LOGIN_METHODS);
      response.statusCode = 204;
      response.end();
      return;
    }

    const relativePath = requestUrl.pathname.startsWith(`${SETTINGS_AUTH_LOGIN_ENDPOINT_PATH}/`)
      ? requestUrl.pathname.slice(SETTINGS_AUTH_LOGIN_ENDPOINT_PATH.length + 1)
      : "";
    const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0);
    const rawProvider = pathSegments[0] ?? "";
    const providerId = resolveSettingsAuthLoginProviderId(rawProvider);
    const action = pathSegments[1];

    this.applyCorsHeaders(request, response, SETTINGS_AUTH_LOGIN_METHODS);

    if (!providerId) {
      this.sendJson(response, 400, { error: "Invalid OAuth provider" });
      return;
    }

    if (action === "respond") {
      if (request.method !== "POST") {
        response.setHeader("Allow", SETTINGS_AUTH_LOGIN_METHODS);
        this.sendJson(response, 405, { error: "Method Not Allowed" });
        return;
      }

      if (pathSegments.length !== 2) {
        this.sendJson(response, 400, { error: "Invalid OAuth login respond path" });
        return;
      }

      const payload = parseSettingsAuthLoginRespondBody(await this.readJsonBody(request));
      const flow = this.activeSettingsAuthLoginFlows.get(providerId);
      if (!flow) {
        this.sendJson(response, 409, { error: "No active OAuth login flow for provider" });
        return;
      }

      if (!flow.pendingPrompt) {
        this.sendJson(response, 409, { error: "OAuth login flow is not waiting for input" });
        return;
      }

      const pendingPrompt = flow.pendingPrompt;
      flow.pendingPrompt = null;
      pendingPrompt.resolve(payload.value);
      this.sendJson(response, 200, { ok: true });
      return;
    }

    if (action !== undefined || pathSegments.length !== 1) {
      this.sendJson(response, 400, { error: "Invalid OAuth login path" });
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", SETTINGS_AUTH_LOGIN_METHODS);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    if (this.activeSettingsAuthLoginFlows.has(providerId)) {
      this.sendJson(response, 409, { error: "OAuth login already in progress for provider" });
      return;
    }

    const flow: SettingsAuthLoginFlow = {
      providerId,
      pendingPrompt: null,
      abortController: new AbortController(),
      closed: false
    };
    this.activeSettingsAuthLoginFlows.set(providerId, flow);

    const provider = SETTINGS_AUTH_LOGIN_PROVIDERS[providerId];
    const authStorage = AuthStorage.create(this.swarmManager.getConfig().paths.authFile);

    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("X-Accel-Buffering", "no");

    if (typeof response.flushHeaders === "function") {
      response.flushHeaders();
    }

    const sendSseEvent = <TEventName extends SettingsAuthLoginEventName>(
      eventName: TEventName,
      data: SettingsAuthLoginEventPayload[TEventName]
    ): void => {
      if (flow.closed || response.writableEnded || response.destroyed) {
        return;
      }

      response.write(`event: ${eventName}\n`);
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const closeFlow = (reason: string): void => {
      if (flow.closed) {
        return;
      }

      flow.closed = true;
      flow.abortController.abort();

      if (flow.pendingPrompt) {
        const pendingPrompt = flow.pendingPrompt;
        flow.pendingPrompt = null;
        pendingPrompt.reject(new Error(reason));
      }

      const activeFlow = this.activeSettingsAuthLoginFlows.get(providerId);
      if (activeFlow === flow) {
        this.activeSettingsAuthLoginFlows.delete(providerId);
      }
    };

    const requestPromptInput = (prompt: {
      message: string;
      placeholder?: string;
    }): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        if (flow.closed) {
          reject(new Error("OAuth login flow is closed"));
          return;
        }

        if (flow.pendingPrompt) {
          const previousPrompt = flow.pendingPrompt;
          flow.pendingPrompt = null;
          previousPrompt.reject(new Error("OAuth login prompt replaced by a newer request"));
        }

        const wrappedResolve = (value: string): void => {
          if (flow.pendingPrompt?.resolve === wrappedResolve) {
            flow.pendingPrompt = null;
          }
          resolve(value);
        };

        const wrappedReject = (error: Error): void => {
          if (flow.pendingPrompt?.reject === wrappedReject) {
            flow.pendingPrompt = null;
          }
          reject(error);
        };

        flow.pendingPrompt = {
          resolve: wrappedResolve,
          reject: wrappedReject
        };

        sendSseEvent("prompt", prompt);
      });

    const onClose = (): void => {
      closeFlow("OAuth login stream closed");
    };

    request.on("close", onClose);
    response.on("close", onClose);

    sendSseEvent("progress", { message: `Starting ${provider.name} OAuth login...` });

    try {
      const callbacks: OAuthLoginCallbacks = {
        onAuth: (info) => {
          sendSseEvent("auth_url", {
            url: info.url,
            instructions: info.instructions
          });
        },
        onPrompt: (prompt) =>
          requestPromptInput({
            message: prompt.message,
            placeholder: prompt.placeholder
          }),
        onProgress: (message) => {
          sendSseEvent("progress", { message });
        },
        signal: flow.abortController.signal
      };

      if (provider.usesCallbackServer) {
        callbacks.onManualCodeInput = () =>
          requestPromptInput({
            message: "Paste redirect URL below, or complete login in browser:",
            placeholder: "http://localhost:1455/auth/callback?code=..."
          });
      }

      const credentials = (await provider.login(callbacks)) as OAuthCredentials;
      if (flow.closed) {
        return;
      }

      authStorage.set(providerId, {
        type: "oauth",
        ...credentials
      });

      sendSseEvent("complete", {
        provider: flow.providerId,
        status: "connected"
      });
    } catch (error) {
      if (!flow.closed) {
        const message = error instanceof Error ? error.message : String(error);
        sendSseEvent("error", { message });
      }
    } finally {
      request.off("close", onClose);
      response.off("close", onClose);
      closeFlow("OAuth login flow closed");
      if (!response.writableEnded) {
        response.end();
      }
    }
  }

  private cancelAllActiveSettingsAuthLoginFlows(): void {
    for (const flow of this.activeSettingsAuthLoginFlows.values()) {
      flow.closed = true;
      flow.abortController.abort();
      if (flow.pendingPrompt) {
        const pendingPrompt = flow.pendingPrompt;
        flow.pendingPrompt = null;
        pendingPrompt.reject(new Error("OAuth login flow cancelled"));
      }
    }
    this.activeSettingsAuthLoginFlows.clear();
  }

  private async handleSlackIntegrationHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const methods = "GET, PUT, DELETE, POST, OPTIONS";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    this.applyCorsHeaders(request, response, methods);

    if (!this.slackIntegration) {
      this.sendJson(response, 501, { error: "Slack integration is unavailable" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === SLACK_INTEGRATION_ENDPOINT_PATH) {
      this.sendJson(response, 200, {
        config: this.slackIntegration.getMaskedConfig(),
        status: this.slackIntegration.getStatus()
      });
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === SLACK_INTEGRATION_ENDPOINT_PATH) {
      const payload = await this.readJsonBody(request);
      const updated = await this.slackIntegration.updateConfig(payload);
      this.sendJson(response, 200, { ok: true, ...updated });
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname === SLACK_INTEGRATION_ENDPOINT_PATH) {
      const disabled = await this.slackIntegration.disable();
      this.sendJson(response, 200, { ok: true, ...disabled });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === SLACK_INTEGRATION_TEST_ENDPOINT_PATH) {
      const payload = await this.readJsonBody(request);
      const result = await this.slackIntegration.testConnection(payload);
      this.sendJson(response, 200, { ok: true, result });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATH) {
      const includePrivate = parseOptionalBoolean(
        requestUrl.searchParams.get("includePrivateChannels") ?? requestUrl.searchParams.get("includePrivate")
      );

      const channels = await this.slackIntegration.listChannels({
        includePrivateChannels: includePrivate
      });

      this.sendJson(response, 200, { channels });
      return;
    }

    response.setHeader("Allow", methods);
    this.sendJson(response, 405, { error: "Method Not Allowed" });
  }

  private async handleTelegramIntegrationHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const methods = "GET, PUT, DELETE, POST, OPTIONS";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    this.applyCorsHeaders(request, response, methods);

    if (!this.telegramIntegration) {
      this.sendJson(response, 501, { error: "Telegram integration is unavailable" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === TELEGRAM_INTEGRATION_ENDPOINT_PATH) {
      this.sendJson(response, 200, {
        config: this.telegramIntegration.getMaskedConfig(),
        status: this.telegramIntegration.getStatus()
      });
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === TELEGRAM_INTEGRATION_ENDPOINT_PATH) {
      const payload = await this.readJsonBody(request);
      const updated = await this.telegramIntegration.updateConfig(payload);
      this.sendJson(response, 200, { ok: true, ...updated });
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname === TELEGRAM_INTEGRATION_ENDPOINT_PATH) {
      const disabled = await this.telegramIntegration.disable();
      this.sendJson(response, 200, { ok: true, ...disabled });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATH) {
      const payload = await this.readJsonBody(request);
      const result = await this.telegramIntegration.testConnection(payload);
      this.sendJson(response, 200, { ok: true, result });
      return;
    }

    response.setHeader("Allow", methods);
    this.sendJson(response, 405, { error: "Method Not Allowed" });
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += chunkBuffer.length;

      if (totalBytes > MAX_HTTP_BODY_SIZE_BYTES) {
        throw new Error("Request body too large");
      }

      chunks.push(chunkBuffer);
    }

    if (chunks.length === 0) {
      return {};
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {};
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Request body must be valid JSON");
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
          attachments: command.attachments,
          sourceContext: { channel: "web" }
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

    if (this.slackIntegration) {
      this.send(socket, this.slackIntegration.getStatus());
    }

    if (this.telegramIntegration) {
      this.send(socket, this.telegramIntegration.getStatus());
    }
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

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return undefined;
}

function parseCompactCustomInstructionsBody(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const customInstructions = (value as { customInstructions?: unknown }).customInstructions;
  if (customInstructions === undefined) {
    return undefined;
  }

  if (typeof customInstructions !== "string") {
    throw new Error("customInstructions must be a string");
  }

  const trimmed = customInstructions.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSettingsEnvUpdateBody(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybeValues = "values" in value ? (value as { values?: unknown }).values : value;
  if (!maybeValues || typeof maybeValues !== "object" || Array.isArray(maybeValues)) {
    throw new Error("settings env payload must be an object map");
  }

  const updates: Record<string, string> = {};

  for (const [name, rawValue] of Object.entries(maybeValues)) {
    if (typeof rawValue !== "string") {
      throw new Error(`settings env value for ${name} must be a string`);
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      throw new Error(`settings env value for ${name} must be a non-empty string`);
    }

    updates[name] = normalized;
  }

  return updates;
}

function parseSettingsAuthUpdateBody(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const updates: Record<string, string> = {};

  for (const [provider, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      throw new Error(`settings auth value for ${provider} must be a string`);
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      throw new Error(`settings auth value for ${provider} must be a non-empty string`);
    }

    updates[provider] = normalized;
  }

  return updates;
}

function parseSettingsAuthLoginRespondBody(value: unknown): { value: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const rawValue = (value as { value?: unknown }).value;
  if (typeof rawValue !== "string") {
    throw new Error("OAuth response value must be a string");
  }

  const normalized = rawValue.trim();
  if (!normalized) {
    throw new Error("OAuth response value must be a non-empty string");
  }

  return { value: normalized };
}

function resolveSettingsAuthLoginProviderId(rawProvider: string): OAuthLoginProviderId | undefined {
  const normalized = rawProvider.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return SETTINGS_AUTH_LOGIN_PROVIDER_ALIASES[normalized];
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
