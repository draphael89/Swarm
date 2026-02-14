import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "./types.js";

interface PendingDelivery {
  deliveryId: string;
  message: string;
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
    message: string,
    _requestedMode: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    this.ensureNotTerminated();

    const deliveryId = randomUUID();

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

  private dispatchPrompt(message: string): void {
    this.promptDispatchPending = true;

    const run = this.session
      .prompt(message)
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

  private async enqueueMessage(deliveryId: string, message: string): Promise<void> {
    await this.session.steer(message);

    this.pendingDeliveries.push({
      deliveryId,
      message,
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
      const text = extractMessageText(event.message.content);
      if (text !== undefined) {
        this.consumePendingMessage(text);
        await this.emitStatus();
      }
    }
  }

  private consumePendingMessage(text: string): void {
    if (this.pendingDeliveries.length === 0) return;

    const first = this.pendingDeliveries[0];
    if (first.message === text) {
      this.pendingDeliveries.shift();
      return;
    }

    const index = this.pendingDeliveries.findIndex((item) => item.message === text);
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

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const maybeText = item as { type?: string; text?: string };
      return maybeText.type === "text" && typeof maybeText.text === "string" ? maybeText.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
}
