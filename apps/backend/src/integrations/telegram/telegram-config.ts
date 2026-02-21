import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  TelegramIntegrationConfig,
  TelegramIntegrationConfigPublic,
  TelegramParseMode
} from "./telegram-types.js";

const INTEGRATIONS_DIR_NAME = "integrations";
const TELEGRAM_CONFIG_FILE_NAME = "telegram.json";
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_FILE_BYTES = 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MIN_POLL_TIMEOUT_SECONDS = 0;
const MAX_POLL_TIMEOUT_SECONDS = 60;
const MIN_POLL_LIMIT = 1;
const MAX_POLL_LIMIT = 100;

export function getTelegramConfigPath(dataDir: string): string {
  return resolve(dataDir, INTEGRATIONS_DIR_NAME, TELEGRAM_CONFIG_FILE_NAME);
}

export function createDefaultTelegramConfig(defaultManagerId: string): TelegramIntegrationConfig {
  return {
    enabled: false,
    mode: "polling",
    botToken: "",
    targetManagerId: defaultManagerId.trim() || "manager",
    allowedUserIds: [],
    polling: {
      timeoutSeconds: 25,
      limit: 100,
      dropPendingUpdatesOnStart: true
    },
    delivery: {
      parseMode: "HTML",
      disableLinkPreview: true,
      replyToInboundMessageByDefault: false
    },
    attachments: {
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      allowImages: true,
      allowText: true,
      allowBinary: false
    }
  };
}

export async function loadTelegramConfig(options: {
  dataDir: string;
  defaultManagerId: string;
}): Promise<TelegramIntegrationConfig> {
  const defaults = createDefaultTelegramConfig(options.defaultManagerId);
  const configPath = getTelegramConfigPath(options.dataDir);

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return mergeTelegramConfig(defaults, parsed);
  } catch (error) {
    if (isEnoentError(error)) {
      return defaults;
    }

    if (isSyntaxError(error)) {
      throw new Error(`Invalid Telegram config JSON at ${configPath}`);
    }

    throw error;
  }
}

export async function saveTelegramConfig(options: {
  dataDir: string;
  config: TelegramIntegrationConfig;
}): Promise<void> {
  const configPath = getTelegramConfigPath(options.dataDir);
  const tmpPath = `${configPath}.tmp`;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(options.config, null, 2)}\n`, "utf8");
  await rename(tmpPath, configPath);
}

export function mergeTelegramConfig(
  base: TelegramIntegrationConfig,
  patch: unknown,
  options?: { defaultManagerId?: string }
): TelegramIntegrationConfig {
  const root = asRecord(patch);
  const polling = asRecord(root.polling);
  const delivery = asRecord(root.delivery);
  const attachments = asRecord(root.attachments);

  return {
    enabled: normalizeBoolean(root.enabled, base.enabled),
    mode: "polling",
    botToken: normalizeToken(root.botToken, base.botToken),
    targetManagerId: normalizeString(
      root.targetManagerId,
      base.targetManagerId || options?.defaultManagerId || "manager"
    ),
    allowedUserIds: normalizeStringArray(root.allowedUserIds, base.allowedUserIds),
    polling: {
      timeoutSeconds: normalizeInteger(
        polling.timeoutSeconds,
        base.polling.timeoutSeconds,
        MIN_POLL_TIMEOUT_SECONDS,
        MAX_POLL_TIMEOUT_SECONDS
      ),
      limit: normalizeInteger(polling.limit, base.polling.limit, MIN_POLL_LIMIT, MAX_POLL_LIMIT),
      dropPendingUpdatesOnStart: normalizeBoolean(
        polling.dropPendingUpdatesOnStart,
        base.polling.dropPendingUpdatesOnStart
      )
    },
    delivery: {
      parseMode: normalizeParseMode(delivery.parseMode, base.delivery.parseMode),
      disableLinkPreview: normalizeBoolean(
        delivery.disableLinkPreview,
        base.delivery.disableLinkPreview
      ),
      replyToInboundMessageByDefault: normalizeBoolean(
        delivery.replyToInboundMessageByDefault,
        base.delivery.replyToInboundMessageByDefault
      )
    },
    attachments: {
      maxFileBytes: normalizeFileSize(attachments.maxFileBytes, base.attachments.maxFileBytes),
      allowImages: normalizeBoolean(attachments.allowImages, base.attachments.allowImages),
      allowText: normalizeBoolean(attachments.allowText, base.attachments.allowText),
      allowBinary: normalizeBoolean(attachments.allowBinary, base.attachments.allowBinary)
    }
  };
}

export function maskTelegramConfig(config: TelegramIntegrationConfig): TelegramIntegrationConfigPublic {
  return {
    enabled: config.enabled,
    mode: config.mode,
    botToken: config.botToken ? maskToken(config.botToken) : null,
    hasBotToken: config.botToken.trim().length > 0,
    targetManagerId: config.targetManagerId,
    allowedUserIds: [...config.allowedUserIds],
    polling: {
      timeoutSeconds: config.polling.timeoutSeconds,
      limit: config.polling.limit,
      dropPendingUpdatesOnStart: config.polling.dropPendingUpdatesOnStart
    },
    delivery: {
      parseMode: config.delivery.parseMode,
      disableLinkPreview: config.delivery.disableLinkPreview,
      replyToInboundMessageByDefault: config.delivery.replyToInboundMessageByDefault
    },
    attachments: {
      maxFileBytes: config.attachments.maxFileBytes,
      allowImages: config.attachments.allowImages,
      allowText: config.attachments.allowText,
      allowBinary: config.attachments.allowBinary
    }
  };
}

function normalizeParseMode(value: unknown, fallback: TelegramParseMode): TelegramParseMode {
  return value === "HTML" ? "HTML" : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    const normalizedEntry = normalizeArrayEntry(entry);
    if (!normalizedEntry || seen.has(normalizedEntry)) {
      continue;
    }

    seen.add(normalizedEntry);
    normalized.push(normalizedEntry);
  }

  return normalized;
}

function normalizeArrayEntry(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);

  if (rounded < min) {
    return min;
  }

  if (rounded > max) {
    return max;
  }

  return rounded;
}

function normalizeFileSize(value: unknown, fallback: number): number {
  return normalizeInteger(value, fallback, MIN_FILE_BYTES, MAX_FILE_BYTES);
}

function normalizeToken(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (isMaskedToken(trimmed)) {
    return fallback;
  }

  return trimmed;
}

function maskToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "********";
  }

  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}******`;
  }

  return `${trimmed.slice(0, 5)}…${trimmed.slice(-3)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function isMaskedToken(value: string): boolean {
  return value === "********" || value.includes("…") || /^\*+$/.test(value);
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError;
}
