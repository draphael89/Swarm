import { EventEmitter } from "node:events";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import {
  createDefaultTelegramConfig,
  loadTelegramConfig,
  maskTelegramConfig,
  mergeTelegramConfig,
  saveTelegramConfig
} from "./telegram-config.js";
import { TelegramBotApiClient } from "./telegram-client.js";
import { TelegramDeliveryBridge } from "./telegram-delivery.js";
import { TelegramPollingBridge } from "./telegram-polling.js";
import { TelegramInboundRouter } from "./telegram-router.js";
import { TelegramStatusTracker, type TelegramStatusEvent } from "./telegram-status.js";
import type {
  TelegramConnectionTestResult,
  TelegramIntegrationConfig,
  TelegramIntegrationConfigPublic
} from "./telegram-types.js";

export class TelegramIntegrationService extends EventEmitter {
  private readonly swarmManager: SwarmManager;
  private readonly dataDir: string;
  private readonly managerId: string;

  private config: TelegramIntegrationConfig;
  private telegramClient: TelegramBotApiClient | null = null;
  private inboundRouter: TelegramInboundRouter | null = null;
  private pollingBridge: TelegramPollingBridge | null = null;
  private readonly statusTracker: TelegramStatusTracker;
  private readonly deliveryBridge: TelegramDeliveryBridge;

  private started = false;
  private lifecycle: Promise<void> = Promise.resolve();

  private botId: string | undefined;
  private botUsername: string | undefined;
  private nextUpdateOffset: number | undefined;

  constructor(options: { swarmManager: SwarmManager; dataDir: string; managerId: string }) {
    super();

    this.swarmManager = options.swarmManager;
    this.dataDir = options.dataDir;
    this.managerId = normalizeManagerId(options.managerId);
    this.config = createDefaultTelegramConfig(this.managerId);

    this.statusTracker = new TelegramStatusTracker({
      managerId: this.managerId,
      integrationProfileId: this.config.profileId,
      state: "disabled",
      enabled: false,
      message: "Telegram integration disabled"
    });

    this.statusTracker.on("status", (event: TelegramStatusEvent) => {
      this.emit("telegram_status", event);
    });

    this.deliveryBridge = new TelegramDeliveryBridge({
      swarmManager: this.swarmManager,
      managerId: this.managerId,
      getConfig: () => this.config,
      getProfileId: () => this.config.profileId,
      getTelegramClient: () => this.telegramClient,
      onError: (message, error) => {
        this.statusTracker.update({
          managerId: this.managerId,
          integrationProfileId: this.config.profileId,
          state: "error",
          enabled: this.config.enabled,
          message: `${message}: ${toErrorMessage(error)}`,
          botId: this.botId,
          botUsername: this.botUsername
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
        this.config = await loadTelegramConfig({
          dataDir: this.dataDir,
          managerId: this.managerId
        });
      } catch (error) {
        this.statusTracker.update({
          managerId: this.managerId,
          integrationProfileId: this.config.profileId,
          state: "error",
          enabled: false,
          message: `Failed to load Telegram config: ${toErrorMessage(error)}`,
          botId: undefined,
          botUsername: undefined
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

      await this.stopPolling();
      this.deliveryBridge.stop();
      this.started = false;

      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: this.config.enabled ? "disconnected" : "disabled",
        enabled: this.config.enabled,
        message: this.config.enabled ? "Telegram integration stopped" : "Telegram integration disabled",
        botId: this.botId,
        botUsername: this.botUsername
      });
    });
  }

  getMaskedConfig(): TelegramIntegrationConfigPublic {
    return maskTelegramConfig(this.config);
  }

  getStatus(): TelegramStatusEvent {
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
  ): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    return this.runExclusive(async () => {
      const nextConfig = mergeTelegramConfig(this.config, patch);

      await saveTelegramConfig({
        dataDir: this.dataDir,
        managerId: this.managerId,
        config: nextConfig
      });
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

  async disable(): Promise<{ config: TelegramIntegrationConfigPublic; status: TelegramStatusEvent }> {
    return this.updateConfig({ enabled: false });
  }

  async testConnection(patch?: unknown): Promise<TelegramConnectionTestResult> {
    const effectiveConfig = patch ? mergeTelegramConfig(this.config, patch) : this.config;

    const botToken = effectiveConfig.botToken.trim();
    if (!botToken) {
      throw new Error("Telegram bot token is required");
    }

    const client = new TelegramBotApiClient(botToken);
    const auth = await client.testAuth();

    return {
      ok: true,
      botId: auth.botId,
      botUsername: auth.botUsername,
      botDisplayName: auth.botDisplayName
    };
  }

  private async applyConfig(): Promise<void> {
    await this.stopPolling();

    this.telegramClient = null;
    this.inboundRouter = null;
    this.botId = undefined;
    this.botUsername = undefined;
    this.nextUpdateOffset = undefined;

    if (!this.config.enabled) {
      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "disabled",
        enabled: false,
        message: "Telegram integration disabled",
        botId: undefined,
        botUsername: undefined
      });
      return;
    }

    const botToken = this.config.botToken.trim();
    if (!botToken) {
      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: "Telegram bot token is required",
        botId: undefined,
        botUsername: undefined
      });
      return;
    }

    try {
      const telegramClient = new TelegramBotApiClient(botToken);
      const auth = await telegramClient.testAuth();

      this.telegramClient = telegramClient;
      this.botId = auth.botId;
      this.botUsername = auth.botUsername;

      this.inboundRouter = new TelegramInboundRouter({
        swarmManager: this.swarmManager,
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        getConfig: () => this.config,
        getBotId: () => this.botId,
        onError: (message, error) => {
          this.statusTracker.update({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state: "error",
            enabled: this.config.enabled,
            message: `${message}: ${toErrorMessage(error)}`,
            botId: this.botId,
            botUsername: this.botUsername
          });
        }
      });

      const pollingBridge = new TelegramPollingBridge({
        telegramClient,
        getPollingConfig: () => this.config.polling,
        getOffset: () => this.nextUpdateOffset,
        setOffset: (offset) => {
          this.nextUpdateOffset = offset;
        },
        onUpdate: async (update) => {
          await this.inboundRouter?.handleUpdate(update);
        },
        onStateChange: (state, message) => {
          this.statusTracker.update({
            managerId: this.managerId,
            integrationProfileId: this.config.profileId,
            state,
            enabled: this.config.enabled,
            message,
            botId: this.botId,
            botUsername: this.botUsername
          });
        }
      });

      this.pollingBridge = pollingBridge;
      await pollingBridge.start();

      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "connected",
        enabled: true,
        message: "Telegram connected",
        botId: this.botId,
        botUsername: this.botUsername
      });
    } catch (error) {
      await this.stopPolling();
      this.statusTracker.update({
        managerId: this.managerId,
        integrationProfileId: this.config.profileId,
        state: "error",
        enabled: true,
        message: `Telegram startup failed: ${toErrorMessage(error)}`,
        botId: this.botId,
        botUsername: this.botUsername
      });
    }
  }

  private async stopPolling(): Promise<void> {
    if (!this.pollingBridge) {
      return;
    }

    const existing = this.pollingBridge;
    this.pollingBridge = null;

    try {
      await existing.stop();
    } catch {
      // Ignore polling shutdown errors.
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
