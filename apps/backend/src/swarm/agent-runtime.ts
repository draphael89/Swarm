import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type {
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "./types.js";

export interface RuntimeImageAttachment {
  mimeType: string;
  data: string;
}

export interface RuntimeUserMessage {
  text: string;
  images?: RuntimeImageAttachment[];
}

type RuntimeUserMessageInput = string | RuntimeUserMessage;

interface PendingDelivery {
  deliveryId: string;
  messageKey: string;
  mode: "steer";
}

export interface AgentRuntimeCallbacks {
  onStatusChange: (agentId: string, status: AgentStatus, pendingCount: number) => void | Promise<void>;
  onSessionEvent?: (agentId: string, event: AgentSessionEvent) => void | Promise<void>;
  onAgentEnd?: (agentId: string) => void | Promise<void>;
}

export class AgentRuntime {
  readonly descriptor: AgentDescriptor;

  private readonly session: AgentSession;
  private readonly callbacks: AgentRuntimeCallbacks;
  private readonly now: () => string;
  private pendingDeliveries: PendingDelivery[] = [];
  private status: AgentStatus;
  private unsubscribe: (() => void) | undefined;
  private readonly inFlightPrompts = new Set<Promise<void>>();
  private promptDispatchPending = false;

  constructor(options: {
    descriptor: AgentDescriptor;
    session: AgentSession;
    callbacks: AgentRuntimeCallbacks;
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
    this.inFlightPrompts.clear();
    this.status = "terminated";
    this.descriptor.status = "terminated";
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
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

    const images = toImageContent(message.images);
    const run = this.sendToSession(message.text, images)
      .catch((error) => {
        // Avoid unhandled rejections for fire-and-forget delivery.
        // Runtime status updates still flow through AgentSession events.
        console.error(
          `[agent-runtime:${this.descriptor.agentId}] prompt failed:`,
          error instanceof Error ? error.message : String(error)
        );
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
      await this.callbacks.onSessionEvent(this.descriptor.agentId, event);
    }

    if (event.type === "agent_start") {
      this.promptDispatchPending = false;
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
