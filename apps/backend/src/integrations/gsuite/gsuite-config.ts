import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { GsuiteIntegrationConfig, GsuiteIntegrationConfigPublic } from "./gsuite-types.js";

const GSUITE_CONFIG_RELATIVE_PATH = ["integrations", "gsuite", "config.json"] as const;
const DEFAULT_GSUITE_SERVICES = ["gmail", "calendar", "drive", "docs"] as const;

export function createDefaultGsuiteConfig(): GsuiteIntegrationConfig {
  return {
    enabled: true,
    accountEmail: "",
    services: [...DEFAULT_GSUITE_SERVICES],
    hasOAuthClientCredentials: false,
    lastConnectedAt: null,
    updatedAt: new Date().toISOString()
  };
}

export function resolveGsuiteConfigPath(dataDir: string): string {
  return resolve(dataDir, ...GSUITE_CONFIG_RELATIVE_PATH);
}

export async function loadGsuiteConfig(options: { dataDir: string }): Promise<GsuiteIntegrationConfig> {
  const filePath = resolveGsuiteConfigPath(options.dataDir);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
    const fallback = createDefaultGsuiteConfig();
    await saveGsuiteConfig({ dataDir: options.dataDir, config: fallback });
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  const merged = mergeGsuiteConfig(createDefaultGsuiteConfig(), parsed ?? {}, {
    requireObject: false
  });
  await saveGsuiteConfig({ dataDir: options.dataDir, config: merged });
  return merged;
}

export async function saveGsuiteConfig(options: {
  dataDir: string;
  config: GsuiteIntegrationConfig;
}): Promise<void> {
  const filePath = resolveGsuiteConfigPath(options.dataDir);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(options.config, null, 2), "utf8");
}

export function mergeGsuiteConfig(
  current: GsuiteIntegrationConfig,
  patch: unknown,
  options?: { requireObject?: boolean }
): GsuiteIntegrationConfig {
  const requireObject = options?.requireObject ?? true;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    if (requireObject) {
      throw new Error("G Suite settings payload must be a JSON object");
    }
    return {
      ...current,
      updatedAt: new Date().toISOString()
    };
  }

  const next = { ...current };
  const update = patch as {
    enabled?: unknown;
    accountEmail?: unknown;
    services?: unknown;
    hasOAuthClientCredentials?: unknown;
    lastConnectedAt?: unknown;
  };

  if (update.enabled !== undefined) {
    if (typeof update.enabled !== "boolean") {
      throw new Error("gsuite.enabled must be a boolean");
    }
    next.enabled = update.enabled;
  }

  if (update.accountEmail !== undefined) {
    if (typeof update.accountEmail !== "string") {
      throw new Error("gsuite.accountEmail must be a string");
    }
    next.accountEmail = update.accountEmail.trim();
  }

  if (update.services !== undefined) {
    next.services = normalizeServiceList(update.services);
  }

  if (update.hasOAuthClientCredentials !== undefined) {
    if (typeof update.hasOAuthClientCredentials !== "boolean") {
      throw new Error("gsuite.hasOAuthClientCredentials must be a boolean");
    }
    next.hasOAuthClientCredentials = update.hasOAuthClientCredentials;
  }

  if (update.lastConnectedAt !== undefined) {
    if (update.lastConnectedAt !== null && typeof update.lastConnectedAt !== "string") {
      throw new Error("gsuite.lastConnectedAt must be a string or null");
    }
    next.lastConnectedAt = update.lastConnectedAt;
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

export function maskGsuiteConfig(config: GsuiteIntegrationConfig): GsuiteIntegrationConfigPublic {
  return {
    ...config,
    services: [...config.services]
  };
}

export function normalizeServiceList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("gsuite.services must be an array of strings");
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (normalized.length === 0) {
    return [...DEFAULT_GSUITE_SERVICES];
  }

  return [...new Set(normalized)];
}

function isEnoentError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
