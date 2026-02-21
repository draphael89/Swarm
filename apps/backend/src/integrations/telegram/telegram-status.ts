import { EventEmitter } from "node:events";

export type TelegramConnectionState =
  | "disabled"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface TelegramStatusEvent {
  type: "telegram_status";
  managerId?: string;
  integrationProfileId?: string;
  state: TelegramConnectionState;
  enabled: boolean;
  updatedAt: string;
  message?: string;
  botId?: string;
  botUsername?: string;
}

export class TelegramStatusTracker extends EventEmitter {
  private snapshot: TelegramStatusEvent;

  constructor(initial?: Partial<Omit<TelegramStatusEvent, "type" | "updatedAt">>) {
    super();

    this.snapshot = {
      type: "telegram_status",
      managerId: initial?.managerId,
      integrationProfileId: initial?.integrationProfileId,
      state: initial?.state ?? "disabled",
      enabled: initial?.enabled ?? false,
      updatedAt: new Date().toISOString(),
      message: initial?.message,
      botId: initial?.botId,
      botUsername: initial?.botUsername
    };
  }

  getSnapshot(): TelegramStatusEvent {
    return { ...this.snapshot };
  }

  update(next: {
    state?: TelegramConnectionState;
    enabled?: boolean;
    managerId?: string;
    integrationProfileId?: string;
    message?: string;
    botId?: string;
    botUsername?: string;
  }): TelegramStatusEvent {
    this.snapshot = {
      ...this.snapshot,
      state: next.state ?? this.snapshot.state,
      enabled: next.enabled ?? this.snapshot.enabled,
      managerId: "managerId" in next ? normalizeOptionalString(next.managerId) : this.snapshot.managerId,
      integrationProfileId:
        "integrationProfileId" in next
          ? normalizeOptionalString(next.integrationProfileId)
          : this.snapshot.integrationProfileId,
      message:
        next.message === undefined
          ? this.snapshot.message
          : normalizeOptionalString(next.message),
      botId: "botId" in next ? normalizeOptionalString(next.botId) : this.snapshot.botId,
      botUsername:
        "botUsername" in next
          ? normalizeOptionalString(next.botUsername)
          : this.snapshot.botUsername,
      updatedAt: new Date().toISOString()
    };

    this.emit("status", this.getSnapshot());
    return this.getSnapshot();
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
