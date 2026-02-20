import { LogLevel, SocketModeClient } from "@slack/socket-mode";
import type { SlackConnectionState } from "./slack-status.js";
import type { SlackSocketEnvelope } from "./slack-types.js";

interface SlackSocketEventPayload {
  ack: (response?: unknown) => Promise<void>;
  envelope_id?: string;
  type?: string;
  body?: unknown;
  retry_num?: number;
  retry_reason?: string;
}

export class SlackSocketModeBridge {
  private readonly appToken: string;
  private readonly onEnvelope: (envelope: SlackSocketEnvelope) => Promise<void>;
  private readonly onStateChange: (state: SlackConnectionState, message?: string) => void;

  private client: SocketModeClient | null = null;
  private readonly handleSlackEvent = (payload: SlackSocketEventPayload): void => {
    void this.processSlackEvent(payload);
  };

  private readonly handleConnecting = (): void => {
    this.onStateChange("connecting", "Connecting to Slack Socket Mode...");
  };

  private readonly handleConnected = (): void => {
    this.onStateChange("connected");
  };

  private readonly handleReconnecting = (): void => {
    this.onStateChange("connecting", "Reconnecting to Slack...");
  };

  private readonly handleDisconnected = (): void => {
    this.onStateChange("disconnected", "Slack connection closed");
  };

  private readonly handleError = (error: unknown): void => {
    this.onStateChange("error", error instanceof Error ? error.message : String(error));
  };

  constructor(options: {
    appToken: string;
    onEnvelope: (envelope: SlackSocketEnvelope) => Promise<void>;
    onStateChange: (state: SlackConnectionState, message?: string) => void;
  }) {
    this.appToken = options.appToken.trim();
    this.onEnvelope = options.onEnvelope;
    this.onStateChange = options.onStateChange;
  }

  async start(): Promise<void> {
    if (this.client) {
      return;
    }

    if (!this.appToken) {
      throw new Error("Missing Slack app token");
    }

    const client = new SocketModeClient({
      appToken: this.appToken,
      logLevel: LogLevel.WARN,
      autoReconnectEnabled: true
    });

    this.client = client;

    client.on("slack_event", this.handleSlackEvent);
    client.on("connecting", this.handleConnecting);
    client.on("connected", this.handleConnected);
    client.on("reconnecting", this.handleReconnecting);
    client.on("disconnected", this.handleDisconnected);
    client.on("error", this.handleError);

    this.onStateChange("connecting", "Connecting to Slack Socket Mode...");
    await client.start();
  }

  async stop(): Promise<void> {
    const current = this.client;
    if (!current) {
      return;
    }

    this.client = null;

    current.off("slack_event", this.handleSlackEvent);
    current.off("connecting", this.handleConnecting);
    current.off("connected", this.handleConnected);
    current.off("reconnecting", this.handleReconnecting);
    current.off("disconnected", this.handleDisconnected);
    current.off("error", this.handleError);

    try {
      await current.disconnect();
    } catch {
      // Ignore disconnect errors during shutdown.
    }
  }

  private async processSlackEvent(payload: SlackSocketEventPayload): Promise<void> {
    try {
      await payload.ack?.();
    } catch {
      // Ignore ack failures; Slack may retry the envelope.
    }

    await this.onEnvelope({
      type: typeof payload.type === "string" ? payload.type : "",
      body: payload.body,
      envelopeId: payload.envelope_id,
      retryNum: payload.retry_num,
      retryReason: payload.retry_reason
    });
  }
}
