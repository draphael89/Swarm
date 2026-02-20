import { EventEmitter } from "node:events";

export type SlackConnectionState = "disabled" | "connecting" | "connected" | "disconnected" | "error";

export interface SlackStatusEvent {
  type: "slack_status";
  state: SlackConnectionState;
  enabled: boolean;
  updatedAt: string;
  message?: string;
  teamId?: string;
  botUserId?: string;
}

export class SlackStatusTracker extends EventEmitter {
  private snapshot: SlackStatusEvent;

  constructor(initial?: Partial<Omit<SlackStatusEvent, "type" | "updatedAt">>) {
    super();

    this.snapshot = {
      type: "slack_status",
      state: initial?.state ?? "disabled",
      enabled: initial?.enabled ?? false,
      updatedAt: new Date().toISOString(),
      message: initial?.message,
      teamId: initial?.teamId,
      botUserId: initial?.botUserId
    };
  }

  getSnapshot(): SlackStatusEvent {
    return { ...this.snapshot };
  }

  update(next: {
    state?: SlackConnectionState;
    enabled?: boolean;
    message?: string;
    teamId?: string;
    botUserId?: string;
  }): SlackStatusEvent {
    this.snapshot = {
      ...this.snapshot,
      state: next.state ?? this.snapshot.state,
      enabled: next.enabled ?? this.snapshot.enabled,
      message:
        next.message === undefined
          ? this.snapshot.message
          : normalizeOptionalString(next.message),
      teamId:
        "teamId" in next ? normalizeOptionalString(next.teamId) : this.snapshot.teamId,
      botUserId:
        "botUserId" in next ? normalizeOptionalString(next.botUserId) : this.snapshot.botUserId,
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
