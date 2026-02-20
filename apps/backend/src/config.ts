import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { normalizeAllowlistRoots } from "./swarm/cwd-policy.js";
import type { SwarmConfig } from "./swarm/types.js";

export function createConfig(): SwarmConfig {
  const debugEnv = process.env.SWARM_DEBUG?.trim().toLowerCase();
  const debug = debugEnv ? !["0", "false", "off", "no"].includes(debugEnv) : true;

  const allowNonManagerSubscriptionsEnv =
    process.env.SWARM_ALLOW_NON_MANAGER_SUBSCRIPTIONS?.trim().toLowerCase();
  const allowNonManagerSubscriptions = allowNonManagerSubscriptionsEnv
    ? ["1", "true", "yes", "on"].includes(allowNonManagerSubscriptionsEnv)
    : true;

  const rootDir = process.env.SWARM_ROOT_DIR
    ? resolve(process.env.SWARM_ROOT_DIR)
    : resolve(process.cwd(), "../..");

  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const defaultDataDir = resolve(homedir(), nodeEnv === "production" ? ".swarm" : ".swarm-dev");

  const dataDirEnv = process.env.SWARM_DATA_DIR?.trim();
  const dataDir = dataDirEnv ? resolveDataDir(rootDir, dataDirEnv) : defaultDataDir;
  const swarmDir = resolve(dataDir, "swarm");
  const sessionsDir = resolve(dataDir, "sessions");
  const authDir = resolve(dataDir, "auth");
  const defaultPiAuthFile = resolve(homedir(), ".pi", "agent", "auth.json");
  const authFile =
    process.env.SWARM_AUTH_FILE ??
    (existsSync(defaultPiAuthFile) ? defaultPiAuthFile : resolve(authDir, "auth.json"));
  const agentDir = resolve(dataDir, "agent");
  const managerAgentDir = resolve(agentDir, "manager");
  const repoArchetypesDir = resolve(rootDir, ".swarm", "archetypes");
  const memoryFile = resolve(dataDir, "MEMORY.md");
  const repoMemorySkillFile = resolve(rootDir, ".swarm", "skills", "memory", "SKILL.md");
  const secretsFile = resolve(dataDir, "secrets.json");
  const defaultCwd = process.env.SWARM_DEFAULT_CWD ? resolve(process.env.SWARM_DEFAULT_CWD) : rootDir;

  const configuredAllowlistRoots = (process.env.SWARM_CWD_ALLOWLIST_ROOTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => resolvePathLike(rootDir, value));

  const cwdAllowlistRoots = normalizeAllowlistRoots([
    rootDir,
    resolve(homedir(), "worktrees"),
    ...configuredAllowlistRoots
  ]);

  return {
    host: process.env.SWARM_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.SWARM_PORT ?? "47187", 10),
    debug,
    allowNonManagerSubscriptions,
    managerId: "manager",
    managerDisplayName: "Manager",
    defaultModel: {
      provider: process.env.SWARM_MODEL_PROVIDER ?? "openai-codex",
      modelId: process.env.SWARM_MODEL_ID ?? "gpt-5.3-codex",
      thinkingLevel: process.env.SWARM_THINKING_LEVEL ?? "xhigh"
    },
    defaultCwd,
    cwdAllowlistRoots,
    paths: {
      rootDir,
      dataDir,
      swarmDir,
      sessionsDir,
      authDir,
      authFile,
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      agentsStoreFile: resolve(swarmDir, "agents.json"),
      secretsFile
    }
  };
}

function resolveDataDir(rootDir: string, dataDirEnv: string): string {
  return resolvePathLike(rootDir, dataDirEnv);
}

function resolvePathLike(rootDir: string, rawPath: string): string {
  if (rawPath === "~") {
    return homedir();
  }

  if (rawPath.startsWith("~/")) {
    return resolve(homedir(), rawPath.slice(2));
  }

  if (isAbsolute(rawPath)) {
    return resolve(rawPath);
  }

  return resolve(rootDir, rawPath);
}
