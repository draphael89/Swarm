import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SlackIntegrationConfig, SlackIntegrationConfigPublic } from "./slack-types.js";

const INTEGRATIONS_DIR_NAME = "integrations";
const INTEGRATIONS_MANAGERS_DIR_NAME = "managers";
const SLACK_CONFIG_FILE_NAME = "slack.json";
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_FILE_BYTES = 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export function getLegacySlackConfigPath(dataDir: string): string {
  return resolve(dataDir, INTEGRATIONS_DIR_NAME, SLACK_CONFIG_FILE_NAME);
}

export function getSlackConfigPath(dataDir: string, managerId: string): string {
  return resolve(
    dataDir,
    INTEGRATIONS_DIR_NAME,
    INTEGRATIONS_MANAGERS_DIR_NAME,
    managerId,
    SLACK_CONFIG_FILE_NAME
  );
}

export function buildSlackProfileId(managerId: string): string {
  const normalizedManagerId = normalizeManagerId(managerId);
  return `slack:${normalizedManagerId}`;
}

export function createDefaultSlackConfig(managerId: string): SlackIntegrationConfig {
  return {
    profileId: buildSlackProfileId(managerId),
    enabled: false,
    mode: "socket",
    appToken: "",
    botToken: "",
    listen: {
      dm: true,
      channelIds: [],
      includePrivateChannels: false
    },
    response: {
      respondInThread: true,
      replyBroadcast: false,
      wakeWords: ["swarm", "bot"]
    },
    attachments: {
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      allowImages: true,
      allowText: true,
      allowBinary: false
    }
  };
}

export async function loadSlackConfig(options: {
  dataDir: string;
  managerId: string;
}): Promise<SlackIntegrationConfig> {
  const defaults = createDefaultSlackConfig(options.managerId);
  const configPath = getSlackConfigPath(options.dataDir, options.managerId);

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return mergeSlackConfig(defaults, parsed);
  } catch (error) {
    if (isEnoentError(error)) {
      return defaults;
    }

    if (isSyntaxError(error)) {
      throw new Error(`Invalid Slack config JSON at ${configPath}`);
    }

    throw error;
  }
}

export async function saveSlackConfig(options: {
  dataDir: string;
  managerId: string;
  config: SlackIntegrationConfig;
}): Promise<void> {
  const configPath = getSlackConfigPath(options.dataDir, options.managerId);
  const tmpPath = `${configPath}.tmp`;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(options.config, null, 2)}\n`, "utf8");
  await rename(tmpPath, configPath);
}

export function mergeSlackConfig(
  base: SlackIntegrationConfig,
  patch: unknown
): SlackIntegrationConfig {
  const root = asRecord(patch);
  const listen = asRecord(root.listen);
  const response = asRecord(root.response);
  const attachments = asRecord(root.attachments);

  const normalized: SlackIntegrationConfig = {
    profileId: normalizeProfileId(root.profileId, base.profileId),
    enabled: normalizeBoolean(root.enabled, base.enabled),
    mode: "socket",
    appToken: normalizeToken(root.appToken, base.appToken),
    botToken: normalizeToken(root.botToken, base.botToken),
    listen: {
      dm: normalizeBoolean(listen.dm, base.listen.dm),
      channelIds: normalizeStringArray(listen.channelIds, base.listen.channelIds),
      includePrivateChannels: normalizeBoolean(
        listen.includePrivateChannels,
        base.listen.includePrivateChannels
      )
    },
    response: {
      respondInThread: normalizeBoolean(response.respondInThread, base.response.respondInThread),
      replyBroadcast: normalizeBoolean(response.replyBroadcast, base.response.replyBroadcast),
      wakeWords: normalizeWakeWords(response.wakeWords, base.response.wakeWords)
    },
    attachments: {
      maxFileBytes: normalizeFileSize(attachments.maxFileBytes, base.attachments.maxFileBytes),
      allowImages: normalizeBoolean(attachments.allowImages, base.attachments.allowImages),
      allowText: normalizeBoolean(attachments.allowText, base.attachments.allowText),
      allowBinary: normalizeBoolean(attachments.allowBinary, base.attachments.allowBinary)
    }
  };

  return normalized;
}

export function maskSlackConfig(config: SlackIntegrationConfig): SlackIntegrationConfigPublic {
  return {
    profileId: config.profileId,
    enabled: config.enabled,
    mode: config.mode,
    appToken: config.appToken ? maskToken(config.appToken) : null,
    botToken: config.botToken ? maskToken(config.botToken) : null,
    hasAppToken: config.appToken.trim().length > 0,
    hasBotToken: config.botToken.trim().length > 0,
    listen: {
      dm: config.listen.dm,
      channelIds: [...config.listen.channelIds],
      includePrivateChannels: config.listen.includePrivateChannels
    },
    response: {
      respondInThread: config.response.respondInThread,
      replyBroadcast: config.response.replyBroadcast,
      wakeWords: [...config.response.wakeWords]
    },
    attachments: {
      maxFileBytes: config.attachments.maxFileBytes,
      allowImages: config.attachments.allowImages,
      allowText: config.attachments.allowText,
      allowBinary: config.attachments.allowBinary
    }
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeWakeWords(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const cleaned = entry.trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    normalized.push(cleaned);
  }

  return normalized;
}

function normalizeFileSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  if (rounded < MIN_FILE_BYTES) {
    return MIN_FILE_BYTES;
  }

  if (rounded > MAX_FILE_BYTES) {
    return MAX_FILE_BYTES;
  }

  return rounded;
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

function normalizeProfileId(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
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

function normalizeManagerId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "manager";
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
