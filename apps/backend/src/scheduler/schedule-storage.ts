import { constants, type Dirent } from "node:fs";
import { access } from "node:fs/promises";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SCHEDULES_DIR_NAME = "schedules";
const LEGACY_GLOBAL_SCHEDULES_FILE_NAME = "schedules.json";
const MIGRATION_MARKER_FILE_NAME = ".migrated";
const LEGACY_DEFAULT_MANAGER_ID = "manager";

export function normalizeManagerId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("managerId is required");
  }

  return normalized;
}

export function getSchedulesDirectoryPath(dataDir: string): string {
  return resolve(dataDir, SCHEDULES_DIR_NAME);
}

export function getScheduleFilePath(dataDir: string, managerId: string): string {
  return resolve(getSchedulesDirectoryPath(dataDir), `${normalizeManagerId(managerId)}.json`);
}

export function getLegacyGlobalSchedulesFilePath(dataDir: string): string {
  return resolve(dataDir, LEGACY_GLOBAL_SCHEDULES_FILE_NAME);
}

export function getMigrationMarkerPath(dataDir: string): string {
  return resolve(getSchedulesDirectoryPath(dataDir), MIGRATION_MARKER_FILE_NAME);
}

export async function listManagerIdsWithSchedules(dataDir: string): Promise<string[]> {
  const schedulesDir = getSchedulesDirectoryPath(dataDir);

  let entries: Dirent[];
  try {
    entries = await readdir(schedulesDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }

    throw error;
  }

  const managerIds = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith(".json")) {
      continue;
    }

    const managerId = entry.name.slice(0, -".json".length).trim();
    if (!managerId) {
      continue;
    }

    managerIds.add(managerId);
  }

  return [...managerIds];
}

export async function migrateLegacyGlobalSchedulesIfNeeded(options: {
  dataDir: string;
  defaultManagerId?: string;
}): Promise<void> {
  const migrationMarkerPath = getMigrationMarkerPath(options.dataDir);
  if (await pathExists(migrationMarkerPath)) {
    return;
  }

  if (await hasAnyManagerScopedSchedule(options.dataDir)) {
    return;
  }

  const legacyGlobalSchedulesPath = getLegacyGlobalSchedulesFilePath(options.dataDir);
  if (!(await pathExists(legacyGlobalSchedulesPath))) {
    return;
  }

  const managerSchedulesPath = getScheduleFilePath(
    options.dataDir,
    normalizeOptionalManagerId(options.defaultManagerId) ?? LEGACY_DEFAULT_MANAGER_ID
  );
  await mkdir(dirname(managerSchedulesPath), { recursive: true });

  if (!(await pathExists(managerSchedulesPath))) {
    await copyFile(legacyGlobalSchedulesPath, managerSchedulesPath);
  }

  await writeFile(
    migrationMarkerPath,
    `${new Date().toISOString()} migrated legacy global schedules\n`,
    "utf8"
  );
}

async function hasAnyManagerScopedSchedule(dataDir: string): Promise<boolean> {
  const managerIds = await listManagerIdsWithSchedules(dataDir);
  return managerIds.length > 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function normalizeOptionalManagerId(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
