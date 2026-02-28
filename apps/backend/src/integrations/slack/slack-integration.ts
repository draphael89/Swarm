import { EventEmitter } from "node:events";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import {
  createDefaultSlackConfig,
  loadSlackConfig,
  maskSlackConfig,
  mergeSlackConfig,
  saveSlackConfig
} from "./slack-config.js";
import { SlackWebApiClient, testSlackAppToken } from "./slack-client.js";
import { SlackDeliveryBridge } from "./slack-delivery.js";
import { SlackInboundRouter } from "./slack-router.js";
import { SlackSocketModeBridge } from "./slack-socket.js";
import { SlackStatusTracker, type SlackStatusEvent } from "./slack-status.js";
import type {
  SlackChannelDescriptor,
  SlackConnectionTestResult,
  SlackIntegrationConfig,
  SlackIntegrationConfigPublic
} from "./slack-types.js";

export class SlackIntegrationService extends EventEmitter {
  private readonly swarmManager: SwarmManager;
  private readonly dataDir: string;
  private readonly managerId: string;

  private config: SlackIntegrationConfig;
  private slackClient: SlackWebApiClient | null = null;
  private inboundRouter: SlackInboundRouter | null = null;
  private socketBridge: SlackSocketModeBridge | null = null;
  private readonly statusTracker: SlackStatusTracker;
  private readonly deliveryBridge: SlackDeliveryBridge;

  private started = false;
  private lifecycle: Promise<void> = Promise.resolve();

  private botUserId: string | undefined;
  private teamId: string | undefined;

  constructor(options: { swarmManager: SwarmManager; dataDir: string; managerId: string }) {
    super();

    this.swarmManager = options.swarmManager;
    this.dataDir = options.dataDir;
    this.managerId = normalizeManagerId(options.managerId);
    this.config = createDefaultSlackConfig(this.managerId);

    this.statusTracker = new SlackStatusTracker({
      managerId: this.managerId,
      integrationProfileId: this.config.profileId,
      state: "disabled",
      enabled: false,
      message: "Slack integration disabled"
    });

    this.statusTracker.on("status", (event: SlackStatusEvent) => {
      this.emit("slack_status", event);
    });

    this.deliveryBridge = new SlackDeliveryBridge({
      swarmManager: this.swarmManager,
      managerId: this.managerId,
      getConfig: () => this.config,
      getProfileId: () => this.config.profileId,
      getSlackClient: () => this.slackClient,
      onError: (message, error) => {
        this.statusTracker.update({
          managerId: this.managerId,
          integrationProfileId: this.config.profileId,
          state: "error",
          enabled: this.config.enabled,
          message: `${message}: ${toErrorMessage(error)}`,
          teamId: this.teamId,
          botUserId: this.botUserId
        });
      }
    });
  }

  async start(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.started) {
        return;
      }

      this.started = true;
      this.deliveryBridge.start();

      try {
        this.config = await loadSlackConfig({
          dataDir: this.dataDir,
          managerId: this.managerId
        });
      } catch (error) {
        this.statusTracker.update({
          managerId: this.managerId,
          integrationProfileId: this.config.profileId,
          state: "error",
          enabled: false,
          message: `Failed to load Slack config: ${toErrorMessage(error)}`,
          teamId: undefined,
          botUserId: undefined
        });
        return;
      }

      await this.applyConfig();
    });
  }

  async stop(): Promise<void> {
    return this.runExclusive(async () => {
      if (!this.started) {
        return;
      }

      await this.stopSocket();
      this.deliveryBridge.stop();
      this.started = false;

      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: this.config.enabled ? "disconnected" : "disabled",
        enabled: this.config.enabled,
        message: this.config.enabled ? "Slack integration stopped" : "Slack integration disabled",
        teamId: this.teamId,
        botUserId: this.botUserId
      });
    });
  }

  getMaskedConfig(): SlackIntegrationConfigPublic {
    return maskSlackConfig(this.config);
  }

  getStatus(): SlackStatusEvent {
    return this.statusTracker.getSnapshot();
  }

  getManagerId(): string {
    return this.managerId;
  }

  getProfileId(): string {
    return this.config.profileId;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async updateConfig(
    patch: unknown
  ): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    return this.runExclusive(async () => {
      const nextConfig = mergeSlackConfig(this.config, patch);

      await saveSlackConfig({ dataDir: this.dataDir, managerId: this.managerId, config: nextConfig });
      this.config = nextConfig;

      if (this.started) {
        await this.applyConfig();
      }

      return {
        config: this.getMaskedConfig(),
        status: this.getStatus()
      };
    });
  }

  async disable(): Promise<{ config: SlackIntegrationConfigPublic; status: SlackStatusEvent }> {
    return this.updateConfig({ enabled: false });
  }

  async testConnection(patch?: unknown): Promise<SlackConnectionTestResult> {
    const effectiveConfig = patch ? mergeSlackConfig(this.config, patch) : this.config;

    const appToken = effectiveConfig.appToken.trim();
    const botToken = effectiveConfig.botToken.trim();

    if (!appToken) {
      throw new Error("Slack app token is required");
    }

    if (!botToken) {
      throw new Error("Slack bot token is required");
    }

    const client = new SlackWebApiClient(botToken);
    const auth = await client.testAuth();
    await testSlackAppToken(appToken);

    return {
      ok: true,
      teamId: auth.teamId,
      teamName: auth.teamName,
      botUserId: auth.botUserId
    };
  }

  async listChannels(options?: { includePrivateChannels?: boolean }): Promise<SlackChannelDescriptor[]> {
    const includePrivateChannels =
      options?.includePrivateChannels ?? this.config.listen.includePrivateChannels;
    const token = this.config.botToken.trim();

    if (!token) {
      throw new Error("Slack bot token is required before listing channels");
    }

    const client = this.slackClient ?? new SlackWebApiClient(token);
    return client.listChannels({ includePrivateChannels });
  }

  private async applyConfig(): Promise<void> {
    await this.stopSocket();

    this.slackClient = null;
    this.inboundRouter = null;
    this.botUserId = undefined;
    this.teamId = undefined;

    if (!this.config.enabled) {
      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "disabled",
        enabled: false,
        message: "Slack integration disabled",
        teamId: undefined,
        botUserId: undefined
      });
      return;
    }

    const appToken = this.config.appToken.trim();
    const botToken = this.config.botToken.trim();

    if (!appToken || !botToken) {
      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: "Slack app token and bot token are required",
        teamId: undefined,
        botUserId: undefined
      });
      return;
    }

    try {
      const slackClient = new SlackWebApiClient(botToken);
      const auth = await slackClient.testAuth();

      this.slackClient = slackClient;
      this.botUserId = auth.botUserId;
      this.teamId = auth.teamId;

      this.inboundRouter = new SlackInboundRouter({
        swarmManager: this.swarmManager,
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        slackClient,
        getConfig: () => this.config,
        getBotUserId: () => this.botUserId,
        onError: (message, error) => {
          this.statusTracker.update({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state: "error",
            enabled: this.config.enabled,
            message: `${message}: ${toErrorMessage(error)}`,
            teamId: this.teamId,
            botUserId: this.botUserId
          });
        }
      });

      const socketBridge = new SlackSocketModeBridge({
        appToken,
        onEnvelope: async (envelope) => {
          await this.inboundRouter?.handleEnvelope(envelope);
        },
        onStateChange: (state, message) => {
          this.statusTracker.update({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state,
            enabled: this.config.enabled,
            message,
            teamId: this.teamId,
            botUserId: this.botUserId
          });
        }
      });

      this.socketBridge = socketBridge;
      await socketBridge.start();

      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "connected",
        enabled: true,
        message: "Slack connected",
        teamId: this.teamId,
        botUserId: this.botUserId
      });
    } catch (error) {
      await this.stopSocket();
      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: `Slack startup failed: ${toErrorMessage(error)}`,
        teamId: this.teamId,
        botUserId: this.botUserId
      });
    }
  }

  private async stopSocket(): Promise<void> {
    if (!this.socketBridge) {
      return;
    }

    const existing = this.socketBridge;
    this.socketBridge = null;

    try {
      await existing.stop();
    } catch {
      // Ignore socket shutdown errors.
    }
  }

  private async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(action, action);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
