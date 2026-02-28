import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { createConfig, detectRootDir, type ConfigOverrides } from "./config.js";
import { IntegrationRegistryService } from "./integrations/registry.js";
import { CronSchedulerService } from "./scheduler/cron-scheduler-service.js";
import { getScheduleFilePath } from "./scheduler/schedule-storage.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import type { AgentDescriptor, SwarmConfig } from "./swarm/types.js";
import { SwarmWebSocketServer } from "./ws/server.js";

export interface BootstrapOptions {
  rootDir?: string;
  dataDir?: string;
  envPath?: string | null;
  host?: string;
  port?: number;
}

export interface BootstrapResult {
  config: SwarmConfig;
  host: string;
  port: number;
  wsUrl: string;
  httpUrl: string;
  swarmManager: SwarmManager;
  stop: () => Promise<void>;
}

export async function startMiddlemanBackend(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const resolvedRootDir = options.rootDir ? resolve(options.rootDir) : detectRootDir();
  loadBootstrapDotenv(resolvedRootDir, options.envPath);

  const configOverrides: ConfigOverrides = {
    rootDir: resolvedRootDir,
    dataDir: options.dataDir,
    host: options.host,
    port: options.port,
  };
  const config = createConfig(configOverrides);

  const swarmManager = new SwarmManager(config);
  const schedulersByManagerId = new Map<string, CronSchedulerService>();
  let schedulerLifecycle: Promise<void> = Promise.resolve();
  let integrationRegistry: IntegrationRegistryService | null = null;
  let wsServer: SwarmWebSocketServer | null = null;
  let boundHost = config.host;
  let boundPort = config.port;
  let stopped = false;

  const syncSchedulers = async (managerIds: Set<string>): Promise<void> => {
    for (const managerId of managerIds) {
      if (schedulersByManagerId.has(managerId)) {
        continue;
      }

      const scheduler = new CronSchedulerService({
        swarmManager,
        schedulesFile: getScheduleFilePath(config.paths.dataDir, managerId),
        managerId,
      });
      await scheduler.start();
      schedulersByManagerId.set(managerId, scheduler);
    }

    for (const [managerId, scheduler] of schedulersByManagerId.entries()) {
      if (managerIds.has(managerId)) {
        continue;
      }

      await scheduler.stop();
      schedulersByManagerId.delete(managerId);
    }
  };

  const queueSchedulerSync = (managerIds: Set<string>): Promise<void> => {
    const next = schedulerLifecycle.then(
      () => syncSchedulers(managerIds),
      () => syncSchedulers(managerIds)
    );
    schedulerLifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const handleAgentsSnapshot = (event: unknown): void => {
    if (!event || typeof event !== "object") {
      return;
    }

    const payload = event as { type?: string; agents?: unknown };
    if (payload.type !== "agents_snapshot" || !Array.isArray(payload.agents)) {
      return;
    }

    const managerIds = collectManagerIds(payload.agents, config.managerId);
    void queueSchedulerSync(managerIds).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Failed to sync scheduler instances: ${message}`);
    });
  };

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    swarmManager.off("agents_snapshot", handleAgentsSnapshot);
    await Promise.allSettled([
      queueSchedulerSync(new Set<string>()),
      integrationRegistry?.stop() ?? Promise.resolve(),
      wsServer?.stop() ?? Promise.resolve(),
      swarmManager.shutdown(),
    ]);
  };

  try {
    await swarmManager.boot();
    await queueSchedulerSync(collectManagerIds(swarmManager.listAgents(), config.managerId));
    swarmManager.on("agents_snapshot", handleAgentsSnapshot);

    integrationRegistry = new IntegrationRegistryService({
      swarmManager,
      dataDir: config.paths.dataDir,
      defaultManagerId: config.managerId,
    });
    await integrationRegistry.start();

    wsServer = new SwarmWebSocketServer({
      swarmManager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      integrationRegistry,
    });
    const bound = await wsServer.start();
    boundHost = bound.host;
    boundPort = bound.port;
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    config,
    host: boundHost,
    port: boundPort,
    wsUrl: `ws://${boundHost}:${boundPort}`,
    httpUrl: `http://${boundHost}:${boundPort}`,
    swarmManager,
    stop,
  };
}

function loadBootstrapDotenv(rootDir: string, envPath: string | null | undefined): void {
  if (envPath === null) {
    return;
  }

  const pathToLoad =
    typeof envPath === "string"
      ? resolve(envPath)
      : resolve(rootDir, ".env");

  if (!existsSync(pathToLoad)) {
    return;
  }

  loadDotenv({ path: pathToLoad, override: false });
}

function collectManagerIds(agents: unknown[], fallbackManagerId?: string): Set<string> {
  const managerIds = new Set<string>();

  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      continue;
    }

    const descriptor = agent as Partial<AgentDescriptor>;
    if (descriptor.role !== "manager") {
      continue;
    }

    if (typeof descriptor.agentId !== "string" || descriptor.agentId.trim().length === 0) {
      continue;
    }

    managerIds.add(descriptor.agentId.trim());
  }

  const normalizedFallbackManagerId =
    typeof fallbackManagerId === "string" ? fallbackManagerId.trim() : "";
  if (managerIds.size === 0 && normalizedFallbackManagerId.length > 0) {
    managerIds.add(normalizedFallbackManagerId);
  }

  return managerIds;
}
