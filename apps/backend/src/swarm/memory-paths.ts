import { join } from "node:path";

const MEMORY_DIR_NAME = "memory";

export function getMemoryDirPath(dataDir: string): string {
  return join(dataDir, MEMORY_DIR_NAME);
}

export function getAgentMemoryPath(dataDir: string, agentId: string): string {
  return join(getMemoryDirPath(dataDir), `${agentId}.md`);
}
