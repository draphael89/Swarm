#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESTART_SIGNAL = "SIGUSR1";
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const FORCE_KILL_AFTER_MS = 15_000;
const DEFAULT_COMMAND = "pnpm i && pnpm prod";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
const pidFile = path.join(os.tmpdir(), `swarm-prod-daemon-${repoHash}.pid`);
const command = process.env.SWARM_PROD_DAEMON_COMMAND?.trim() || DEFAULT_COMMAND;

let child = null;
let restarting = false;
let shuttingDown = false;
let forceKillTimer = null;

function log(message) {
  console.log(`[prod-daemon] ${message}`);
}

function isChildRunning() {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function writePidFile() {
  if (fs.existsSync(pidFile)) {
    const existingPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);

    if (Number.isInteger(existingPid) && existingPid > 0 && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`Daemon already running (pid ${existingPid}).`);
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  }

  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function removePidFile() {
  if (!fs.existsSync(pidFile)) {
    return;
  }

  const filePid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  if (filePid === process.pid) {
    fs.rmSync(pidFile, { force: true });
  }
}

function signalChildGroup(signal) {
  if (!child?.pid) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      try {
        process.kill(child.pid, signal);
      } catch {
        // ignore
      }
    }
  }
}

function scheduleForceKill() {
  clearTimeout(forceKillTimer);
  forceKillTimer = setTimeout(() => {
    if (!isChildRunning()) {
      return;
    }

    log(`Child did not exit in time; sending SIGKILL to process group ${child.pid}.`);
    signalChildGroup("SIGKILL");
  }, FORCE_KILL_AFTER_MS);

  forceKillTimer.unref();
}

function stopChild(reason) {
  if (!isChildRunning()) {
    return;
  }

  log(`${reason} Sending SIGTERM to process group ${child.pid}.`);
  signalChildGroup("SIGTERM");
  scheduleForceKill();
}

function handleChildExit(code, signal) {
  clearTimeout(forceKillTimer);

  const shouldRestart = restarting;
  restarting = false;

  log(`Child exited (${signal ? `signal ${signal}` : `code ${code ?? 0}`}).`);
  child = null;

  if (shuttingDown) {
    removePidFile();
    process.exit(code ?? 0);
  }

  if (shouldRestart) {
    startChild();
    return;
  }

  log(`Child is stopped. Send ${RESTART_SIGNAL} (or run \`pnpm prod:restart\`) to start it again.`);
}

function startChild() {
  if (isChildRunning()) {
    return;
  }

  log(`Starting child command: ${command}`);

  child = spawn(command, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: true,
    detached: true,
  });

  child.once("error", (error) => {
    log(`Child process error: ${error.message}`);
    child = null;
  });

  child.once("exit", handleChildExit);
}

function requestRestart(source) {
  if (shuttingDown) {
    return;
  }

  log(`Restart requested via ${source}.`);

  if (!isChildRunning()) {
    startChild();
    return;
  }

  if (restarting) {
    log("Restart already in progress; ignoring duplicate restart request.");
    return;
  }

  restarting = true;
  stopChild("Restart requested.");
}

function beginShutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log(`Received ${signal}; shutting down daemon.`);

  if (isChildRunning()) {
    stopChild("Shutdown requested.");
    return;
  }

  removePidFile();
  process.exit(0);
}

try {
  writePidFile();
} catch (error) {
  console.error(`[prod-daemon] Failed to write pid file: ${error.message}`);
  process.exit(1);
}

process.on(RESTART_SIGNAL, () => requestRestart(RESTART_SIGNAL));
for (const signal of STOP_SIGNALS) {
  process.on(signal, () => beginShutdown(signal));
}

process.on("exit", removePidFile);

log(`Daemon pid ${process.pid}. pid file: ${pidFile}`);
startChild();
