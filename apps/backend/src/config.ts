import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { SwarmConfig } from "./swarm/types.js";

export function createConfig(): SwarmConfig {
  const debugEnv = process.env.SWARM_DEBUG?.trim().toLowerCase();
  const debug = debugEnv ? !["0", "false", "off", "no"].includes(debugEnv) : true;

  const rootDir = process.env.SWARM_ROOT_DIR
    ? resolve(process.env.SWARM_ROOT_DIR)
    : resolve(process.cwd(), "../..");

  const dataDir = resolve(rootDir, "data");
  const swarmDir = resolve(dataDir, "swarm");
  const sessionsDir = resolve(dataDir, "sessions");
  const authDir = resolve(dataDir, "auth");
  const defaultPiAuthFile = resolve(homedir(), ".pi", "agent", "auth.json");
  const authFile =
    process.env.SWARM_AUTH_FILE ??
    (existsSync(defaultPiAuthFile) ? defaultPiAuthFile : resolve(authDir, "auth.json"));
  const agentDir = resolve(dataDir, "agent");
  const managerAgentDir = resolve(agentDir, "manager");

  return {
    host: process.env.SWARM_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.SWARM_PORT ?? "47187", 10),
    debug,
    allowNonManagerSubscriptions: process.env.SWARM_ALLOW_NON_MANAGER_SUBSCRIPTIONS === "true",
    managerId: "manager",
    managerDisplayName: "Manager",
    defaultModel: {
      provider: process.env.SWARM_MODEL_PROVIDER ?? "openai-codex",
      modelId: process.env.SWARM_MODEL_ID ?? "gpt-5.3-codex",
      thinkingLevel: process.env.SWARM_THINKING_LEVEL ?? "xhigh"
    },
    defaultCwd: process.env.SWARM_DEFAULT_CWD ? resolve(process.env.SWARM_DEFAULT_CWD) : rootDir,
    paths: {
      rootDir,
      dataDir,
      swarmDir,
      sessionsDir,
      authDir,
      authFile,
      agentDir,
      managerAgentDir,
      managerAppendSystemPromptFile: resolve(managerAgentDir, "APPEND_SYSTEM.md"),
      agentsStoreFile: resolve(swarmDir, "agents.json")
    }
  };
}
