import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_GOG_TIMEOUT_MS = 60_000;

export interface GogRunResult {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GogCommandError extends Error {
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly code?: string;

  constructor(options: {
    message: string;
    args: string[];
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    code?: string;
  }) {
    super(options.message);
    this.name = "GogCommandError";
    this.args = options.args;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.exitCode = options.exitCode ?? -1;
    this.code = options.code;
  }
}

export async function detectGogInstallation(dataDir: string): Promise<{
  installed: boolean;
  version?: string;
  message?: string;
}> {
  try {
    const result = await runGogCommand(["--version"], {
      dataDir,
      timeoutMs: 20_000
    });

    const line =
      result.stdout
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0) ??
      result.stderr
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);

    return {
      installed: true,
      version: line
    };
  } catch (error) {
    if (error instanceof GogCommandError && error.code === "ENOENT") {
      return {
        installed: false,
        message: "Install gog with `brew install steipete/tap/gog` (or build from source)."
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      installed: true,
      message
    };
  }
}

export async function runGogCommand(
  args: string[],
  options: {
    dataDir: string;
    stdin?: string;
    timeoutMs?: number;
    allowNonZeroExit?: boolean;
  }
): Promise<GogRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GOG_TIMEOUT_MS;
  const env = await buildGogProcessEnv(options.dataDir);

  return new Promise<GogRunResult>((resolveResult, rejectResult) => {
    const child = spawn("gog", args, {
      env,
      stdio: "pipe"
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let settled = false;
    const settle = (handler: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      handler();
    };

    const timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() => {
        rejectResult(
          new GogCommandError({
            message: `gog command timed out after ${timeoutMs}ms`,
            args
          })
        );
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    child.on("error", (error) => {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : undefined;
      settle(() => {
        rejectResult(
          new GogCommandError({
            message:
              code === "ENOENT"
                ? "gog executable not found. Install via `brew install steipete/tap/gog`."
                : `Failed to execute gog: ${error instanceof Error ? error.message : String(error)}`,
            args,
            code
          })
        );
      });
    });

    child.on("close", (exitCode) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const normalizedExitCode = typeof exitCode === "number" ? exitCode : -1;

      if (normalizedExitCode !== 0 && !options.allowNonZeroExit) {
        const details = stderr.trim() || stdout.trim() || `exit code ${normalizedExitCode}`;
        settle(() => {
          rejectResult(
            new GogCommandError({
              message: `gog ${args.join(" ")} failed: ${details}`,
              args,
              stdout,
              stderr,
              exitCode: normalizedExitCode
            })
          );
        });
        return;
      }

      settle(() => {
        resolveResult({
          args: [...args],
          stdout,
          stderr,
          exitCode: normalizedExitCode
        });
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export function parseGogJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/u).map((line) => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (!candidate) {
        continue;
      }

      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
  }

  throw new Error("Failed to parse JSON output from gog");
}

export function extractAuthUrlFromOutput(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const direct = payload as {
    auth_url?: unknown;
    authUrl?: unknown;
    url?: unknown;
    data?: unknown;
  };

  if (typeof direct.auth_url === "string" && direct.auth_url.trim()) {
    return direct.auth_url.trim();
  }

  if (typeof direct.authUrl === "string" && direct.authUrl.trim()) {
    return direct.authUrl.trim();
  }

  if (typeof direct.url === "string" && direct.url.trim()) {
    return direct.url.trim();
  }

  if (direct.data && typeof direct.data === "object" && !Array.isArray(direct.data)) {
    const nested = direct.data as { auth_url?: unknown; authUrl?: unknown; url?: unknown };
    if (typeof nested.auth_url === "string" && nested.auth_url.trim()) {
      return nested.auth_url.trim();
    }
    if (typeof nested.authUrl === "string" && nested.authUrl.trim()) {
      return nested.authUrl.trim();
    }
    if (typeof nested.url === "string" && nested.url.trim()) {
      return nested.url.trim();
    }
  }

  return undefined;
}

async function buildGogProcessEnv(dataDir: string): Promise<NodeJS.ProcessEnv> {
  const root = resolve(dataDir, "integrations", "gsuite");
  const configHome = resolve(root, "config-home");
  const homeDir = resolve(root, "home");
  const appData = resolve(root, "appdata");

  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(configHome, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(appData, { recursive: true })
  ]);

  const env: NodeJS.ProcessEnv = { ...process.env };

  if (process.platform === "darwin") {
    env.HOME = homeDir;
  } else if (process.platform === "win32") {
    env.APPDATA = appData;
  } else {
    env.XDG_CONFIG_HOME = configHome;
  }

  if (!env.GOG_KEYRING_BACKEND || !env.GOG_KEYRING_BACKEND.trim()) {
    env.GOG_KEYRING_BACKEND = "file";
  }

  if (env.GOG_KEYRING_BACKEND === "file" && (!env.GOG_KEYRING_PASSWORD || !env.GOG_KEYRING_PASSWORD.trim())) {
    env.GOG_KEYRING_PASSWORD = createHash("sha256").update(root).digest("hex");
  }

  return env;
}
