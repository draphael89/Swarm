#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";

const SCHEDULES_FILE_NAME = "schedules.json";

function resolvePathLike(rawPath) {
  if (rawPath === "~") {
    return homedir();
  }

  if (rawPath.startsWith("~/")) {
    return resolve(homedir(), rawPath.slice(2));
  }

  if (isAbsolute(rawPath)) {
    return resolve(rawPath);
  }

  return resolve(process.cwd(), rawPath);
}

function resolveDataDir() {
  const dataDirEnv = process.env.SWARM_DATA_DIR?.trim();
  if (dataDirEnv) {
    return resolvePathLike(dataDirEnv);
  }

  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === "production") {
    return resolve(homedir(), ".swarm");
  }

  return resolve(homedir(), ".swarm-dev");
}

function resolveSchedulesFilePath() {
  return resolve(resolveDataDir(), SCHEDULES_FILE_NAME);
}

function toDate(value) {
  if (value instanceof Date) {
    return value;
  }

  if (value && typeof value === "object") {
    if ("toDate" in value && typeof value.toDate === "function") {
      const nextDate = value.toDate();
      if (nextDate instanceof Date) {
        return nextDate;
      }
    }

    if ("toISOString" in value && typeof value.toISOString === "function") {
      return new Date(value.toISOString());
    }
  }

  throw new Error("Unsupported cron next() result format");
}

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function computeNextFireAt(cron, timezone, afterDate = new Date()) {
  const iterator = CronExpressionParser.parse(cron, {
    currentDate: afterDate,
    tz: timezone
  });
  return toDate(iterator.next()).toISOString();
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScheduleRecord(value) {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    typeof value.cron === "string" &&
    value.cron.trim().length > 0 &&
    typeof value.message === "string" &&
    value.message.trim().length > 0 &&
    typeof value.oneShot === "boolean" &&
    typeof value.timezone === "string" &&
    value.timezone.trim().length > 0 &&
    typeof value.createdAt === "string" &&
    value.createdAt.trim().length > 0 &&
    typeof value.nextFireAt === "string" &&
    value.nextFireAt.trim().length > 0
  );
}

async function ensureSchedulesFile(filePath) {
  try {
    await readFile(filePath, "utf8");
    return;
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  await writeSchedulesFile(filePath, { schedules: [] });
}

async function readSchedulesFile(filePath) {
  await ensureSchedulesFile(filePath);

  const raw = await readFile(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const schedules = Array.isArray(parsed?.schedules) ? parsed.schedules.filter(isScheduleRecord) : [];
  return { schedules };
}

async function writeSchedulesFile(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

function parseArgs(argv) {
  const command = argv[0];
  const flags = new Map();

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (!key) {
      throw new Error("Invalid argument: --");
    }

    if (key === "one-shot") {
      flags.set(key, "true");
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    flags.set(key, next);
    index += 1;
  }

  return { command, flags };
}

function getRequiredFlag(flags, name) {
  const value = flags.get(name);
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value.trim();
}

function printJson(payload) {
  console.log(`${JSON.stringify(payload, null, 2)}\n`);
}

function printUsage() {
  printJson({
    ok: false,
    error: "Usage: schedule.js <add|remove|list> [options]",
    commands: {
      add: 'schedule.js add --name "..." --cron "..." --message "..." [--timezone "America/Los_Angeles"] [--one-shot]',
      remove: 'schedule.js remove --id "..."',
      list: "schedule.js list"
    }
  });
}

async function handleAdd(flags, filePath) {
  const name = getRequiredFlag(flags, "name");
  const cron = getRequiredFlag(flags, "cron");
  const message = getRequiredFlag(flags, "message");
  const oneShot = flags.get("one-shot") === "true";
  const timezone = (flags.get("timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC").trim();

  if (!isValidTimezone(timezone)) {
    throw new Error(`Invalid timezone: ${timezone}`);
  }

  const now = new Date();
  const nextFireAt = computeNextFireAt(cron, timezone, now);
  const createdAt = now.toISOString();

  const schedule = {
    id: randomUUID(),
    name,
    cron,
    message,
    oneShot,
    timezone,
    createdAt,
    nextFireAt
  };

  const store = await readSchedulesFile(filePath);
  store.schedules.push(schedule);
  await writeSchedulesFile(filePath, store);

  printJson({
    ok: true,
    action: "add",
    schedule,
    filePath
  });
}

async function handleRemove(flags, filePath) {
  const id = getRequiredFlag(flags, "id");
  const store = await readSchedulesFile(filePath);

  const beforeCount = store.schedules.length;
  const schedules = store.schedules.filter((schedule) => schedule.id !== id);

  if (schedules.length === beforeCount) {
    throw new Error(`No schedule found for id: ${id}`);
  }

  await writeSchedulesFile(filePath, { schedules });

  printJson({
    ok: true,
    action: "remove",
    id,
    removed: true,
    filePath
  });
}

async function handleList(filePath) {
  const store = await readSchedulesFile(filePath);

  const schedules = [...store.schedules].sort((left, right) => {
    const leftTimestamp = Date.parse(left.nextFireAt);
    const rightTimestamp = Date.parse(right.nextFireAt);
    return leftTimestamp - rightTimestamp;
  });

  printJson({
    ok: true,
    action: "list",
    count: schedules.length,
    schedules,
    filePath
  });
}

function isEnoentError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const schedulesFilePath = resolveSchedulesFilePath();

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exitCode = command ? 0 : 1;
    return;
  }

  switch (command) {
    case "add":
      await handleAdd(flags, schedulesFilePath);
      return;
    case "remove":
      await handleRemove(flags, schedulesFilePath);
      return;
    case "list":
      await handleList(schedulesFilePath);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printJson({
    ok: false,
    error: message
  });
  process.exitCode = 1;
});
