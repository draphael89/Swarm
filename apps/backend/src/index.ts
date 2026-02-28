import { createConfig } from "./config.js";
import { startMiddlemanBackend } from "./bootstrap.js";

async function main(): Promise<void> {
  const backend = await startMiddlemanBackend();

  console.log(`Middleman backend listening on ${backend.wsUrl}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}. Shutting down...`);
    await backend.stop();
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
        `Stop the other process or run with MIDDLEMAN_PORT=<port>.`
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});
