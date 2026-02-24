import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
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
      void this.handleEvent(event);
    });
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

    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session.dispose();
    this.pendingDeliveries = [];
    this.promptDispatchPending = false;
    this.ignoreNextAgentStart = false;
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
    this.ignoreNextAgentStart = false;

    const images = toImageContent(message.images);
    const run = this.sendToSession(message.text, images)
      .catch(async (error) => {
        await this.handlePromptDispatchError(error, message);
      })
      .finally(() => {
        this.promptDispatchPending = false;
        this.inFlightPrompts.delete(run);
      });

    this.inFlightPrompts.add(run);
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
    if (this.callbacks.onSessionEvent) {
      await this.callbacks.onSessionEvent(this.descriptor.agentId, event as unknown as RuntimeSessionEvent);
    }

    if (event.type === "agent_start") {
      this.promptDispatchPending = false;
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
      if (this.status !== "terminated") {
        await this.updateStatus("idle");
      }
      if (this.callbacks.onAgentEnd) {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      }
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

  private async handlePromptDispatchError(error: unknown, message: RuntimeUserMessage): Promise<void> {
    const normalized = normalizeRuntimeError(error);
    const phase: RuntimeErrorEvent["phase"] = isLikelyCompactionError(normalized.message)
      ? "compaction"
      : "prompt_dispatch";
    const details = {
      textPreview: previewForLog(message.text),
      imageCount: message.images?.length ?? 0,
      pendingCount: this.pendingDeliveries.length
    };

    this.logRuntimeError(phase, error, details);

    await this.reportRuntimeError({
      phase,
      message: normalized.message,
      stack: normalized.stack,
      details
    });

    this.ignoreNextAgentStart = true;

    if (this.status !== "terminated") {
      await this.updateStatus("idle");
    }

    if (this.status !== "terminated" && this.callbacks.onAgentEnd) {
      try {
        await this.callbacks.onAgentEnd(this.descriptor.agentId);
      } catch (callbackError) {
        this.logRuntimeError(phase, callbackError, {
          callback: "onAgentEnd"
        });
      }
    }
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
    await this.callbacks.onStatusChange(this.descriptor.agentId, this.status, this.pendingDeliveries.length);
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
