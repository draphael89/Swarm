import { resolve } from "node:path";

const SCHEDULES_DIR_NAME = "schedules";

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
