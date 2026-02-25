import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeSessionMessage,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SwarmAgentRuntime,
  SwarmRuntimeCallbacks
} from "./runtime-types.js";
import type { AgentDescriptor, AgentStatus, RequestedDeliveryMode, SendMessageReceipt } from "./types.js";

interface PendingDelivery {
  deliveryId: string;
  messageKey: string;
  mode: "steer";
}

interface RuntimeContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

const MAX_PROMPT_DISPATCH_ATTEMPTS = 2;
const DEFAULT_PROMPT_DISPATCH_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_STREAMING_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15_000;
const DEFAULT_PROACTIVE_COMPACTION_THRESHOLD = 0.85;
const DEFAULT_PROACTIVE_COMPACTION_COOLDOWN_MS = 60_000;
const DEFAULT_COMPACTION_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_OVERFLOW_RECOVERY_COOLDOWN_MS = 60_000;

const PROMPT_DISPATCH_TIMEOUT_MS = parseEnvDurationMs(
  "SWARM_RUNTIME_PROMPT_TIMEOUT_MS",
  DEFAULT_PROMPT_DISPATCH_TIMEOUT_MS
);
const STREAMING_INACTIVITY_TIMEOUT_MS = parseEnvDurationMs(
  "SWARM_RUNTIME_STREAMING_TIMEOUT_MS",
  DEFAULT_STREAMING_INACTIVITY_TIMEOUT_MS
);
const HEALTH_CHECK_INTERVAL_MS = parseEnvDurationMs(
  "SWARM_RUNTIME_HEARTBEAT_INTERVAL_MS",
  DEFAULT_HEALTH_CHECK_INTERVAL_MS
);
const PROACTIVE_COMPACTION_THRESHOLD = parseEnvPercentage(
  "SWARM_RUNTIME_PROACTIVE_COMPACTION_THRESHOLD",
  DEFAULT_PROACTIVE_COMPACTION_THRESHOLD
);
const PROACTIVE_COMPACTION_COOLDOWN_MS = parseEnvDurationMs(
  "SWARM_RUNTIME_PROACTIVE_COMPACTION_COOLDOWN_MS",
  DEFAULT_PROACTIVE_COMPACTION_COOLDOWN_MS
);
const COMPACTION_TIMEOUT_MS = parseEnvDurationMs("SWARM_RUNTIME_COMPACTION_TIMEOUT_MS", DEFAULT_COMPACTION_TIMEOUT_MS);
const OVERFLOW_RECOVERY_COOLDOWN_MS = parseEnvDurationMs(
  "SWARM_RUNTIME_OVERFLOW_RECOVERY_COOLDOWN_MS",
  DEFAULT_OVERFLOW_RECOVERY_COOLDOWN_MS
);

export type { RuntimeImageAttachment, RuntimeUserMessage, RuntimeUserMessageInput } from "./runtime-types.js";

export class AgentRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;

  private readonly session: AgentSession;
  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private pendingDeliveries: PendingDelivery[] = [];
  private status: AgentStatus;
  private unsubscribe: (() => void) | undefined;
  private readonly inFlightPrompts = new Set<Promise<void>>();
  private promptDispatchPending = false;
  private ignoreNextAgentStart = false;
  private promptDispatchStartedAtMs: number | undefined;
  private lastPromptMessage: RuntimeUserMessage | undefined;
  private lastEventAtMs = Date.now();
  private healthCheckTimer: NodeJS.Timeout | undefined;
  private healthCheckInProgress = false;
  private recoveryInProgress = false;
  private autoCompactionInProgress = false;
  private lastProactiveCompactionAtMs = 0;
  private lastOverflowRecoveryAtMs = 0;

  private readonly promptDispatchTimeoutMs = PROMPT_DISPATCH_TIMEOUT_MS;
  private readonly streamingInactivityTimeoutMs = STREAMING_INACTIVITY_TIMEOUT_MS;
  private readonly healthCheckIntervalMs = HEALTH_CHECK_INTERVAL_MS;
  private readonly proactiveCompactionThreshold = PROACTIVE_COMPACTION_THRESHOLD;
  private readonly proactiveCompactionCooldownMs = PROACTIVE_COMPACTION_COOLDOWN_MS;
  private readonly compactionTimeoutMs = COMPACTION_TIMEOUT_MS;
  private readonly overflowRecoveryCooldownMs = OVERFLOW_RECOVERY_COOLDOWN_MS;

  constructor(options: {
    descriptor: AgentDescriptor;
    session: AgentSession;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
  }) {
    this.descriptor = options.descriptor;
    this.session = options.session;
    this.callbacks = options.callbacks;
    this.now = options.now ?? (() => new Date().toISOString());
    this.status = options.descriptor.status;

    this.unsubscribe = this.session.subscribe((event) => {
      void this.handleEvent(event).catch((error) => {
        this.logRuntimeError("prompt_execution", error, {
          stage: "session_event_handler",
          eventType: event.type
        });
      });
    });

    this.startHealthCheck();
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getPendingCount(): number {
    return this.pendingDeliveries.length;
  }

  isStreaming(): boolean {
    return this.session.isStreaming;
  }

  async sendMessage(
    input: RuntimeUserMessageInput,
    _requestedMode: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    this.ensureNotTerminated();

    const deliveryId = randomUUID();
    const message = normalizeRuntimeUserMessage(input);

    if (this.session.isStreaming || this.promptDispatchPending) {
      const resolvedQueueMode = "steer";
      await this.enqueueMessage(deliveryId, message);
      await this.emitStatus();
      return {
        targetAgentId: this.descriptor.agentId,
        deliveryId,
        acceptedMode: resolvedQueueMode
      };
    }

    this.dispatchPrompt(message);

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId,
      acceptedMode: "prompt"
    };
  }

  async terminate(options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") return;

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort) {
      await this.session.abort();
    }

    this.stopHealthCheck();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session.dispose();
    this.pendingDeliveries = [];
    this.promptDispatchPending = false;
    this.promptDispatchStartedAtMs = undefined;
    this.lastPromptMessage = undefined;
    this.ignoreNextAgentStart = false;
    this.autoCompactionInProgress = false;
    this.inFlightPrompts.clear();
    this.status = "terminated";
    this.descriptor.status = "terminated";
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.ensureNotTerminated();
    try {
      return await this.session.compact(customInstructions);
    } catch (error) {
      this.logRuntimeError("compaction", error, {
        customInstructionsPreview: previewForLog(customInstructions ?? "")
      });
      throw error;
    }
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.session.sessionManager.getEntries();
    const matches: unknown[] = [];

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === customType) {
        matches.push(entry.data);
      }
    }

    return matches;
  }

  appendCustomEntry(customType: string, data?: unknown): void {
    this.session.sessionManager.appendCustomEntry(customType, data);
  }

  private dispatchPrompt(message: RuntimeUserMessage): void {
    this.promptDispatchPending = true;
    this.promptDispatchStartedAtMs = Date.now();
    this.lastPromptMessage = message;
    this.ignoreNextAgentStart = false;

    const run = this.dispatchPromptWithRetry(message)
      .catch(async (error) => {
        const normalized = normalizeRuntimeError(error);
        await this.handlePromptDispatchError(error, message, {
          attempt: MAX_PROMPT_DISPATCH_ATTEMPTS,
          maxAttempts: MAX_PROMPT_DISPATCH_ATTEMPTS,
          stage: "dispatch_prompt_unhandled"
        });

        this.logRuntimeError("prompt_dispatch", error, {
          stage: "dispatch_prompt_unhandled",
          message: normalized.message
        });
      })
      .finally(() => {
        this.promptDispatchPending = false;
        this.promptDispatchStartedAtMs = undefined;
        this.inFlightPrompts.delete(run);
      });

    this.inFlightPrompts.add(run);
  }

  private async dispatchPromptWithRetry(message: RuntimeUserMessage): Promise<void> {
    const images = toImageContent(message.images);

    await this.maybeCompactBeforePrompt(message);

    for (let attempt = 1; attempt <= MAX_PROMPT_DISPATCH_ATTEMPTS; attempt += 1) {
      try {
        await this.sendToSessionWithTimeout(message.text, images);
        return;
      } catch (error) {
        const canRetry =
          attempt < MAX_PROMPT_DISPATCH_ATTEMPTS &&
          this.status !== "terminated" &&
          this.status !== "streaming" &&
          !this.session.isStreaming;

        if (canRetry) {
          this.logRuntimeError("prompt_dispatch", error, {
            attempt,
            maxAttempts: MAX_PROMPT_DISPATCH_ATTEMPTS,
            willRetry: true,
            textPreview: previewForLog(message.text),
            imageCount: message.images?.length ?? 0
          });
          continue;
        }

        await this.handlePromptDispatchError(error, message, {
          attempt,
          maxAttempts: MAX_PROMPT_DISPATCH_ATTEMPTS
        });
        return;
      }
    }
  }

  private async maybeCompactBeforePrompt(message: RuntimeUserMessage): Promise<void> {
    if (this.proactiveCompactionThreshold <= 0) {
      return;
    }

    if (this.status === "terminated") {
      return;
    }

    if ((this.session as { isCompacting?: boolean }).isCompacting === true || this.autoCompactionInProgress) {
      return;
    }

    const usage = this.readContextUsage();
    if (!usage || usage.percent === null || usage.percent < this.proactiveCompactionThreshold) {
      return;
    }

    if (Date.now() - this.lastProactiveCompactionAtMs < this.proactiveCompactionCooldownMs) {
      return;
    }

    try {
      await withTimeout(
        this.session.compact(),
        this.compactionTimeoutMs,
        `Proactive compaction timed out after ${this.compactionTimeoutMs}ms`
      );
      this.lastProactiveCompactionAtMs = Date.now();
    } catch (error) {
      const normalized = normalizeRuntimeError(error);
      const details = {
        source: "proactive_compaction",
        thresholdPercent: this.proactiveCompactionThreshold,
        usagePercent: usage.percent,
        usageTokens: usage.tokens,
        contextWindow: usage.contextWindow,
        textPreview: previewForLog(message.text),
        imageCount: message.images?.length ?? 0
      };

      this.logRuntimeError("compaction", error, details);
      await this.reportRuntimeError({
        phase: "compaction",
        message: `Proactive compaction failed before prompt dispatch: ${normalized.message}`,
        stack: normalized.stack,
        details
      });
    }
  }

  private async sendToSessionWithTimeout(text: string, images: ImageContent[]): Promise<void> {
    if (this.promptDispatchTimeoutMs <= 0) {
      await this.sendToSession(text, images);
      return;
    }

    await withTimeout(
      this.sendToSession(text, images),
      this.promptDispatchTimeoutMs,
      `Prompt dispatch timed out after ${this.promptDispatchTimeoutMs}ms`
    );
  }

  private async sendToSession(text: string, images: ImageContent[]): Promise<void> {
    if (text.trim().length === 0 && images.length > 0) {
      await this.session.sendUserMessage(buildUserMessageContent(text, images));
      return;
    }

    if (images.length > 0) {
      await this.session.prompt(text, { images });
      return;
    }

    await this.session.prompt(text);
  }

  private async enqueueMessage(deliveryId: string, message: RuntimeUserMessage): Promise<void> {
    const images = toImageContent(message.images);
    await this.session.steer(message.text, images.length > 0 ? images : undefined);

    this.pendingDeliveries.push({
      deliveryId,
      messageKey: buildRuntimeMessageKey(message),
      mode: "steer"
    });
  }

  private async handleEvent(event: AgentSessionEvent): Promise<void> {
    this.lastEventAtMs = Date.now();

    if (this.callbacks.onSessionEvent) {
      try {
        await this.callbacks.onSessionEvent(this.descriptor.agentId, event as unknown as RuntimeSessionEvent);
      } catch (error) {
        const normalized = normalizeRuntimeError(error);
        this.logRuntimeError("prompt_execution", error, {
          callback: "onSessionEvent",
          eventType: event.type
        });
        await this.reportRuntimeError({
          phase: "prompt_execution",
          message: `Session event callback failed: ${normalized.message}`,
          stack: normalized.stack,
          details: {
            callback: "onSessionEvent",
            eventType: event.type
          }
        });
      }
    }

    if (event.type === "auto_compaction_start") {
      this.autoCompactionInProgress = true;
      return;
    }

    if (event.type === "auto_compaction_end") {
      this.autoCompactionInProgress = false;
      await this.handleAutoCompactionEndEvent(event);
      return;
    }

    if (event.type === "agent_start") {
      this.promptDispatchPending = false;
      this.promptDispatchStartedAtMs = undefined;
      this.lastPromptMessage = undefined;
      if (this.ignoreNextAgentStart) {
        this.ignoreNextAgentStart = false;
        if (this.status !== "terminated") {
          await this.updateStatus("idle");
        }
        return;
      }
      await this.updateStatus("streaming");
      return;
    }

    if (event.type === "agent_end") {
      this.autoCompactionInProgress = false;
      this.lastPromptMessage = undefined;
      if (this.status !== "terminated") {
        await this.updateStatus("idle");
      }
      if (this.callbacks.onAgentEnd) {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      }
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      await this.handleAssistantMessageEnd(event.message);
      return;
    }

    if (event.type === "message_start" && event.message.role === "user") {
      const key = extractMessageKeyFromContent(event.message.content);
      if (key !== undefined) {
        this.consumePendingMessage(key);
        await this.emitStatus();
      }
    }
  }

  private async handleAutoCompactionEndEvent(event: {
    errorMessage?: string;
    aborted?: boolean;
    willRetry?: boolean;
  }): Promise<void> {
    const errorMessage = typeof event.errorMessage === "string" ? event.errorMessage.trim() : "";
    if (errorMessage.length === 0) {
      return;
    }

    await this.reportRuntimeError({
      phase: "compaction",
      message: errorMessage,
      details: {
        source: "auto_compaction_end",
        aborted: event.aborted === true,
        willRetry: event.willRetry === true
      }
    });
  }

  private async handleAssistantMessageEnd(message: RuntimeSessionMessage): Promise<void> {
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
    const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";

    if (stopReason !== "error" || errorMessage.length === 0) {
      return;
    }

    if (isLikelyContextOverflowError(errorMessage) && (await this.tryRecoverFromContextOverflow())) {
      return;
    }

    const phase: RuntimeErrorEvent["phase"] =
      isLikelyContextOverflowError(errorMessage) || isLikelyCompactionError(errorMessage)
        ? "compaction"
        : "prompt_execution";

    await this.reportRuntimeError({
      phase,
      message: errorMessage,
      details: {
        source: "assistant_message_end",
        stopReason,
        provider: typeof message.provider === "string" ? message.provider : undefined,
        model: typeof message.model === "string" ? message.model : undefined,
        contextOverflow: isLikelyContextOverflowError(errorMessage)
      }
    });
  }

  private async tryRecoverFromContextOverflow(): Promise<boolean> {
    if (this.status === "terminated") {
      return false;
    }

    if (this.recoveryInProgress) {
      return false;
    }

    if (!this.lastPromptMessage) {
      return false;
    }

    if (Date.now() - this.lastOverflowRecoveryAtMs < this.overflowRecoveryCooldownMs) {
      return false;
    }

    this.recoveryInProgress = true;
    this.lastOverflowRecoveryAtMs = Date.now();

    try {
      await withTimeout(
        this.session.compact(),
        this.compactionTimeoutMs,
        `Overflow recovery compaction timed out after ${this.compactionTimeoutMs}ms`
      );

      this.lastProactiveCompactionAtMs = Date.now();

      if (this.getStatus() === "terminated") {
        return false;
      }

      if (this.session.isStreaming || this.promptDispatchPending) {
        return false;
      }

      if (!this.lastPromptMessage) {
        return false;
      }

      this.dispatchPrompt(this.lastPromptMessage);
      return true;
    } catch (error) {
      this.logRuntimeError("compaction", error, {
        source: "overflow_recovery"
      });
      return false;
    } finally {
      this.recoveryInProgress = false;
    }
  }

  private async handlePromptDispatchError(
    error: unknown,
    message: RuntimeUserMessage,
    dispatchMeta?: { attempt: number; maxAttempts: number; stage?: string }
  ): Promise<void> {
    const normalized = normalizeRuntimeError(error);
    const isCompactionRelated =
      isLikelyCompactionError(normalized.message) || isLikelyContextOverflowError(normalized.message);
    const phase: RuntimeErrorEvent["phase"] = isCompactionRelated ? "compaction" : "prompt_dispatch";
    const droppedPendingCount = this.pendingDeliveries.length;
    if (droppedPendingCount > 0) {
      this.pendingDeliveries = [];
    }

    const details = {
      textPreview: previewForLog(message.text),
      imageCount: message.images?.length ?? 0,
      pendingCount: droppedPendingCount,
      droppedPendingCount,
      attempt: dispatchMeta?.attempt,
      maxAttempts: dispatchMeta?.maxAttempts,
      stage: dispatchMeta?.stage,
      contextOverflow: isLikelyContextOverflowError(normalized.message),
      promptTimeout: isLikelyTimeoutError(normalized.message)
    };

    if (isLikelyTimeoutError(normalized.message)) {
      await this.maybeAbortStuckSession();
    }

    this.logRuntimeError(phase, error, details);

    await this.reportRuntimeError({
      phase,
      message: normalized.message,
      stack: normalized.stack,
      details
    });

    this.ignoreNextAgentStart = true;
    this.lastPromptMessage = undefined;

    if (droppedPendingCount > 0) {
      await this.emitStatus();
    }

    if (this.getStatus() !== "terminated") {
      await this.updateStatus("idle");
    }

    if (this.getStatus() !== "terminated" && this.callbacks.onAgentEnd) {
      try {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      } catch (callbackError) {
        this.logRuntimeError(phase, callbackError, {
          callback: "onAgentEnd"
        });
      }
    }
  }

  private async handleWatchdogTimeout(reason: "streaming" | "prompt_dispatch", timedOutMs: number): Promise<void> {
    if (this.status === "terminated" || this.recoveryInProgress) {
      return;
    }

    this.recoveryInProgress = true;

    const droppedPendingCount = this.pendingDeliveries.length;
    if (droppedPendingCount > 0) {
      this.pendingDeliveries = [];
    }

    this.promptDispatchPending = false;
    this.promptDispatchStartedAtMs = undefined;
    this.lastPromptMessage = undefined;
    this.autoCompactionInProgress = false;
    this.ignoreNextAgentStart = true;

    const timeoutLabel = reason === "streaming" ? "streaming inactivity" : "prompt dispatch inactivity";
    const message = `Agent runtime became unresponsive (${timeoutLabel}) after ${timedOutMs}ms and was reset to idle.`;

    await this.maybeAbortStuckSession();

    await this.reportRuntimeError({
      phase: "watchdog_timeout",
      message,
      details: {
        reason,
        timedOutMs,
        droppedPendingCount
      }
    });

    if (droppedPendingCount > 0) {
      await this.emitStatus();
    }

    if (this.getStatus() !== "terminated") {
      await this.updateStatus("idle");
    }

    if (this.getStatus() !== "terminated" && this.callbacks.onAgentEnd) {
      try {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      } catch (callbackError) {
        this.logRuntimeError("watchdog_timeout", callbackError, {
          callback: "onAgentEnd"
        });
      }
    }

    this.recoveryInProgress = false;
  }

  private consumePendingMessage(messageKey: string): void {
    if (this.pendingDeliveries.length === 0) return;

    const first = this.pendingDeliveries[0];
    if (first.messageKey === messageKey) {
      this.pendingDeliveries.shift();
      return;
    }

    const index = this.pendingDeliveries.findIndex((item) => item.messageKey === messageKey);
    if (index >= 0) {
      this.pendingDeliveries.splice(index, 1);
    }
  }

  private ensureNotTerminated(): void {
    if (this.status === "terminated") {
      throw new Error(`Agent ${this.descriptor.agentId} is terminated`);
    }
  }

  private async updateStatus(status: AgentStatus): Promise<void> {
    if (this.status === status) {
      await this.emitStatus();
      return;
    }

    this.status = status;
    this.descriptor.status = status;
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
  }

  private async emitStatus(): Promise<void> {
    try {
      await this.callbacks.onStatusChange(this.descriptor.agentId, this.status, this.pendingDeliveries.length);
    } catch (error) {
      this.logRuntimeError("prompt_execution", error, {
        callback: "onStatusChange"
      });
    }
  }

  private async reportRuntimeError(error: RuntimeErrorEvent): Promise<void> {
    if (!this.callbacks.onRuntimeError) {
      return;
    }

    try {
      await this.callbacks.onRuntimeError(this.descriptor.agentId, error);
    } catch (callbackError) {
      this.logRuntimeError(error.phase, callbackError, {
        callback: "onRuntimeError"
      });
    }
  }

  private logRuntimeError(
    phase: RuntimeErrorEvent["phase"],
    error: unknown,
    details?: Record<string, unknown>
  ): void {
    const normalized = normalizeRuntimeError(error);
    console.error(`[swarm][${this.now()}] runtime:error`, {
      runtime: "pi",
      agentId: this.descriptor.agentId,
      phase,
      message: normalized.message,
      stack: normalized.stack,
      ...details
    });
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer || this.healthCheckIntervalMs <= 0) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      void this.runHealthCheck();
    }, this.healthCheckIntervalMs);

    this.healthCheckTimer.unref?.();
  }

  private stopHealthCheck(): void {
    if (!this.healthCheckTimer) {
      return;
    }

    clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = undefined;
  }

  private async runHealthCheck(): Promise<void> {
    if (this.status === "terminated" || this.healthCheckInProgress) {
      return;
    }

    this.healthCheckInProgress = true;

    try {
      const now = Date.now();

      if (
        this.status === "streaming" &&
        !this.autoCompactionInProgress &&
        this.streamingInactivityTimeoutMs > 0
      ) {
        const inactiveMs = now - this.lastEventAtMs;
        if (inactiveMs >= this.streamingInactivityTimeoutMs) {
          await this.handleWatchdogTimeout("streaming", inactiveMs);
          return;
        }
      }

      if (
        this.promptDispatchPending &&
        this.status !== "streaming" &&
        this.promptDispatchTimeoutMs > 0 &&
        this.promptDispatchStartedAtMs !== undefined
      ) {
        const pendingMs = now - this.promptDispatchStartedAtMs;
        if (pendingMs >= this.promptDispatchTimeoutMs) {
          await this.handleWatchdogTimeout("prompt_dispatch", pendingMs);
        }
      }
    } finally {
      this.healthCheckInProgress = false;
    }
  }

  private async maybeAbortStuckSession(): Promise<void> {
    try {
      await this.session.abort();
    } catch (error) {
      this.logRuntimeError("interrupt", error, {
        stage: "watchdog_abort"
      });
    }
  }

  private readContextUsage(): RuntimeContextUsage | undefined {
    const sessionWithUsage = this.session as {
      getContextUsage?: () => {
        tokens?: unknown;
        contextWindow?: unknown;
        percent?: unknown;
      };
    };

    const usage = sessionWithUsage.getContextUsage?.();
    if (!usage || typeof usage.contextWindow !== "number" || !Number.isFinite(usage.contextWindow)) {
      return undefined;
    }

    const tokens = typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
    const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null;

    return {
      tokens,
      contextWindow: usage.contextWindow,
      percent
    };
  }
}

function normalizeRuntimeUserMessage(input: RuntimeUserMessageInput): RuntimeUserMessage {
  if (typeof input === "string") {
    return {
      text: input,
      images: []
    };
  }

  const text = typeof input.text === "string" ? input.text : "";

  return {
    text,
    images: normalizeRuntimeImageAttachments(input.images)
  };
}

function normalizeRuntimeImageAttachments(
  images: RuntimeUserMessage["images"]
): RuntimeImageAttachment[] {
  if (!images || images.length === 0) {
    return [];
  }

  const normalized: RuntimeImageAttachment[] = [];

  for (const image of images) {
    if (!image || typeof image !== "object") {
      continue;
    }

    const mimeType = typeof image.mimeType === "string" ? image.mimeType.trim() : "";
    const data = typeof image.data === "string" ? image.data.trim() : "";

    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data
    });
  }

  return normalized;
}

function toImageContent(images: RuntimeImageAttachment[] | undefined): ImageContent[] {
  if (!images || images.length === 0) {
    return [];
  }

  return images.map((image) => ({
    type: "image",
    mimeType: image.mimeType,
    data: image.data
  }));
}

function buildUserMessageContent(text: string, images: ImageContent[]): string | (TextContent | ImageContent)[] {
  if (images.length === 0) {
    return text;
  }

  const parts: (TextContent | ImageContent)[] = [];
  if (text.length > 0) {
    parts.push({
      type: "text",
      text
    });
  }

  parts.push(...images);
  return parts;
}

function buildRuntimeMessageKey(message: RuntimeUserMessage): string {
  return buildMessageKey(message.text, message.images ?? []) ?? "text=|images=";
}

function extractMessageKeyFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return buildMessageKey(content, []);
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: string[] = [];
  const images: RuntimeImageAttachment[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const maybe = item as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown };
    if (maybe.type === "text" && typeof maybe.text === "string") {
      textParts.push(maybe.text);
      continue;
    }

    if (maybe.type === "image") {
      const mimeType = typeof maybe.mimeType === "string" ? maybe.mimeType : "";
      const data = typeof maybe.data === "string" ? maybe.data : "";
      if (mimeType && data) {
        images.push({ mimeType, data });
      }
    }
  }

  return buildMessageKey(textParts.join("\n"), images);
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function normalizeRuntimeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function isLikelyCompactionError(message: string): boolean {
  return /\bcompact(?:ion)?\b/i.test(message);
}

function isLikelyContextOverflowError(message: string): boolean {
  return /prompt is too long|context window|context length|token limit|input token count.*exceeds|maximum prompt length/i.test(
    message
  );
}

function isLikelyTimeoutError(message: string): boolean {
  return /timed out|timeout/i.test(message);
}

function buildMessageKey(text: string, images: RuntimeImageAttachment[]): string | undefined {
  const normalizedText = text.trim();
  const normalizedImages = normalizeRuntimeImageAttachments(images);

  if (!normalizedText && normalizedImages.length === 0) {
    return undefined;
  }

  const imageKey = normalizedImages
    .map((image) => `${image.mimeType}:${image.data.length}:${image.data.slice(0, 24)}`)
    .join(",");

  return `text=${normalizedText}|images=${imageKey}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function parseEnvDurationMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function parseEnvPercentage(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return fallback;
  }

  return parsed;
}
