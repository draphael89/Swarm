import { join } from "node:path";

const MEMORY_DIR_NAME = "memory";
const LEGACY_MEMORY_FILE_NAME = "MEMORY.md";
const MIGRATION_MARKER_FILE_NAME = ".migrated";

export function getMemoryDirPath(dataDir: string): string {
  return join(dataDir, MEMORY_DIR_NAME);
}

export function getAgentMemoryPath(dataDir: string, agentId: string): string {
  return join(getMemoryDirPath(dataDir), `${agentId}.md`);
}

export function getLegacyMemoryPath(dataDir: string): string {
  return join(dataDir, LEGACY_MEMORY_FILE_NAME);
}

export function getMemoryMigrationMarkerPath(dataDir: string): string {
  return join(getMemoryDirPath(dataDir), MIGRATION_MARKER_FILE_NAME);
}
