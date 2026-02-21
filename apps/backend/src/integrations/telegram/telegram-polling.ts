import { TelegramBotApiClient } from "./telegram-client.js";
import type { TelegramConnectionState } from "./telegram-status.js";
import type { TelegramUpdate } from "./telegram-types.js";

export class TelegramPollingBridge {
  private readonly telegramClient: TelegramBotApiClient;
  private readonly getPollingConfig: () => {
    timeoutSeconds: number;
    limit: number;
    dropPendingUpdatesOnStart: boolean;
  };
  private readonly getOffset: () => number | undefined;
  private readonly setOffset: (offset: number) => void;
  private readonly onUpdate: (update: TelegramUpdate) => Promise<void>;
  private readonly onStateChange: (state: TelegramConnectionState, message?: string) => void;

  private started = false;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(options: {
    telegramClient: TelegramBotApiClient;
    getPollingConfig: () => {
      timeoutSeconds: number;
      limit: number;
      dropPendingUpdatesOnStart: boolean;
    };
    getOffset: () => number | undefined;
    setOffset: (offset: number) => void;
    onUpdate: (update: TelegramUpdate) => Promise<void>;
    onStateChange: (state: TelegramConnectionState, message?: string) => void;
  }) {
    this.telegramClient = options.telegramClient;
    this.getPollingConfig = options.getPollingConfig;
    this.getOffset = options.getOffset;
    this.setOffset = options.setOffset;
    this.onUpdate = options.onUpdate;
    this.onStateChange = options.onStateChange;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    const abortController = new AbortController();
    this.abortController = abortController;

    this.onStateChange("connecting", "Connecting to Telegram polling...");

    const config = this.getPollingConfig();
    if (config.dropPendingUpdatesOnStart) {
      await this.drainPendingUpdates(abortController.signal);
    }

    this.onStateChange("connected");
    this.loopPromise = this.pollLoop(abortController.signal).catch((error: unknown) => {
      if (abortController.signal.aborted || !this.started) {
        return;
      }

      this.onStateChange(
        "error",
        `Telegram polling stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  async stop(): Promise<void> {
    this.started = false;

    const abortController = this.abortController;
    this.abortController = null;
    abortController?.abort();

    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // Ignore polling loop shutdown errors.
      }
    }

    this.loopPromise = null;
    this.onStateChange("disconnected", "Telegram polling stopped");
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (this.started && !signal.aborted) {
      const config = this.getPollingConfig();

      try {
        const updates = await this.telegramClient.getUpdates({
          offset: this.getOffset(),
          timeoutSeconds: config.timeoutSeconds,
          limit: config.limit,
          signal
        });

        if (!this.started || signal.aborted) {
          return;
        }

        if (updates.length === 0) {
          continue;
        }

        for (const update of updates) {
          if (!isTelegramUpdate(update)) {
            continue;
          }

          this.setOffset(update.update_id + 1);
          await this.onUpdate(update);
        }
      } catch (error) {
        if (signal.aborted || !this.started) {
          return;
        }

        this.onStateChange(
          "connecting",
          `Telegram polling interrupted: ${error instanceof Error ? error.message : String(error)}`
        );

        const retryAfterMs = getRetryDelayMs(error);
        await sleep(retryAfterMs, signal);
      }
    }
  }

  private async drainPendingUpdates(signal: AbortSignal): Promise<void> {
    const maxDrainIterations = 20;

    for (let iteration = 0; iteration < maxDrainIterations; iteration += 1) {
      if (signal.aborted || !this.started) {
        return;
      }

      const config = this.getPollingConfig();
      const updates = await this.telegramClient.getUpdates({
        offset: this.getOffset(),
        timeoutSeconds: 0,
        limit: config.limit,
        signal
      });

      if (updates.length === 0) {
        return;
      }

      const lastUpdate = updates[updates.length - 1];
      if (!lastUpdate || !isTelegramUpdate(lastUpdate)) {
        return;
      }

      this.setOffset(lastUpdate.update_id + 1);
    }
  }
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return (
    value !== null &&
    typeof value === "object" &&
    "update_id" in value &&
    typeof (value as { update_id?: unknown }).update_id === "number"
  );
}

function getRetryDelayMs(error: unknown): number {
  if (!error || typeof error !== "object") {
    return 1000;
  }

  const retryAfterSeconds =
    "retryAfterSeconds" in error &&
    typeof (error as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
      ? (error as { retryAfterSeconds: number }).retryAfterSeconds
      : undefined;

  if (!retryAfterSeconds || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return 1000;
  }

  return retryAfterSeconds * 1000;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
