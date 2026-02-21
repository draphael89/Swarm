import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createConfig } from "./config.js";
import { SlackIntegrationService } from "./integrations/slack/slack-integration.js";
import { TelegramIntegrationService } from "./integrations/telegram/telegram-integration.js";
import { CronSchedulerService } from "./scheduler/cron-scheduler-service.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import { SwarmWebSocketServer } from "./ws/server.js";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(backendRoot, "..", "..");
loadDotenv({ path: resolve(repoRoot, ".env") });

async function main(): Promise<void> {
  const config = createConfig();

  const swarmManager = new SwarmManager(config);
  await swarmManager.boot();

  const scheduler = new CronSchedulerService({
    swarmManager,
    schedulesFile: config.paths.schedulesFile,
    managerId: config.managerId
  });
  await scheduler.start();

  const slackIntegration = new SlackIntegrationService({
    swarmManager,
    dataDir: config.paths.dataDir,
    defaultManagerId: config.managerId
  });
  await slackIntegration.start();

  const telegramIntegration = new TelegramIntegrationService({
    swarmManager,
    dataDir: config.paths.dataDir,
    defaultManagerId: config.managerId
  });
  await telegramIntegration.start();

  const wsServer = new SwarmWebSocketServer({
    swarmManager,
    host: config.host,
    port: config.port,
    allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    slackIntegration,
    telegramIntegration
  });
  await wsServer.start();

  console.log(`Swarm backend listening on ws://${config.host}:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}. Shutting down...`);
    await Promise.allSettled([
      scheduler.stop(),
      slackIntegration.stop(),
      telegramIntegration.stop(),
      wsServer.stop()
    ]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  ) {
    const config = createConfig();
    console.error(
      `Failed to start backend: ws://${config.host}:${config.port} is already in use. ` +
        `Stop the other process or run with SWARM_PORT=<port>.`
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});
