#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
const pidFile = path.join(os.tmpdir(), `swarm-prod-daemon-${repoHash}.pid`);

if (!fs.existsSync(pidFile)) {
  console.error(`[prod-daemon] No daemon pid file found at ${pidFile}. Start it with \`pnpm prod:daemon\`.`);
  process.exit(1);
}

const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
if (!Number.isInteger(pid) || pid <= 0) {
  console.error(`[prod-daemon] Invalid pid file: ${pidFile}`);
  process.exit(1);
}

try {
  process.kill(pid, "SIGUSR1");
  console.log(`[prod-daemon] Sent SIGUSR1 to daemon pid ${pid}.`);
} catch (error) {
  if (error.code === "ESRCH") {
    fs.rmSync(pidFile, { force: true });
    console.error(`[prod-daemon] Daemon pid ${pid} is not running. Removed stale pid file.`);
    process.exit(1);
  }

  console.error(`[prod-daemon] Failed to signal daemon pid ${pid}: ${error.message}`);
  process.exit(1);
}
