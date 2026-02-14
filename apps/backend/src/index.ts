import { createConfig } from "./config.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import { SwarmWebSocketServer } from "./ws/server.js";

async function main(): Promise<void> {
  const config = createConfig();

  const swarmManager = new SwarmManager(config);
  await swarmManager.boot();

  const wsServer = new SwarmWebSocketServer({
    swarmManager,
    host: config.host,
    port: config.port,
    allowNonManagerSubscriptions: config.allowNonManagerSubscriptions
  });
  await wsServer.start();

  console.log(`Swarm backend listening on ws://${config.host}:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}. Shutting down...`);
    await wsServer.stop();
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
