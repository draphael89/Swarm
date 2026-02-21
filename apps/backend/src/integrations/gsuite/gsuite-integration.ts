import {
  createDefaultGsuiteConfig,
  loadGsuiteConfig,
  maskGsuiteConfig,
  mergeGsuiteConfig,
  normalizeServiceList,
  saveGsuiteConfig
} from "./gsuite-config.js";
import {
  detectGogInstallation,
  extractAuthUrlFromOutput,
  parseGogJsonOutput,
  runGogCommand
} from "./gsuite-gog.js";
import type {
  GsuiteConnectionTestResult,
  GsuiteOAuthCompleteResult,
  GsuiteOAuthStartResult,
  GsuiteSnapshot,
  GsuiteIntegrationConfig,
  GsuiteIntegrationStatus
} from "./gsuite-types.js";

const DEFAULT_SERVICES = ["gmail", "calendar", "drive", "docs"] as const;

export class GsuiteIntegrationService {
  private readonly dataDir: string;
  private config: GsuiteIntegrationConfig = createDefaultGsuiteConfig();
  private lifecycle: Promise<void> = Promise.resolve();
  private started = false;

  constructor(options: { dataDir: string }) {
    this.dataDir = options.dataDir;
  }

  async start(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.started) {
        return;
      }

      this.config = await loadGsuiteConfig({ dataDir: this.dataDir });
      this.started = true;
    });
  }

  async stop(): Promise<void> {
    return this.runExclusive(async () => {
      this.started = false;
    });
  }

  getMaskedConfig() {
    return maskGsuiteConfig(this.config);
  }

  async getStatus(): Promise<GsuiteIntegrationStatus> {
    const install = await detectGogInstallation(this.dataDir);
    const accountEmail = this.config.accountEmail;

    if (!this.config.enabled) {
      return {
        state: "disabled",
        enabled: false,
        gogInstalled: install.installed,
        gogVersion: install.version,
        connected: false,
        accountEmail,
        message: "Google Workspace integration is disabled.",
        updatedAt: new Date().toISOString()
      };
    }

    if (!install.installed) {
      return {
        state: "error",
        enabled: true,
        gogInstalled: false,
        gogVersion: install.version,
        connected: false,
        accountEmail,
        message: install.message ?? "gog is not installed.",
        updatedAt: new Date().toISOString()
      };
    }

    if (!this.config.hasOAuthClientCredentials) {
      return {
        state: "ready",
        enabled: true,
        gogInstalled: true,
        gogVersion: install.version,
        connected: false,
        accountEmail,
        message: "Paste your Google OAuth client JSON, then click Connect Google.",
        updatedAt: new Date().toISOString()
      };
    }

    if (!accountEmail) {
      return {
        state: "ready",
        enabled: true,
        gogInstalled: true,
        gogVersion: install.version,
        connected: false,
        accountEmail,
        message: "Set the Google account email to continue OAuth setup.",
        updatedAt: new Date().toISOString()
      };
    }

    try {
      await runGogCommand(["--json", "auth", "status", "--account", accountEmail], {
        dataDir: this.dataDir,
        timeoutMs: 20_000
      });

      return {
        state: "connected",
        enabled: true,
        gogInstalled: true,
        gogVersion: install.version,
        connected: true,
        accountEmail,
        message: "Google account connected.",
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        state: "ready",
        enabled: true,
        gogInstalled: true,
        gogVersion: install.version,
        connected: false,
        accountEmail,
        message: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      };
    }
  }

  async getSnapshot(): Promise<GsuiteSnapshot> {
    return {
      config: this.getMaskedConfig(),
      status: await this.getStatus()
    };
  }

  async updateConfig(patch: unknown): Promise<GsuiteSnapshot> {
    return this.runExclusive(async () => {
      const merged = mergeGsuiteConfig(this.config, patch);
      await saveGsuiteConfig({
        dataDir: this.dataDir,
        config: merged
      });
      this.config = merged;
      return this.getSnapshot();
    });
  }

  async disable(): Promise<GsuiteSnapshot> {
    return this.updateConfig({ enabled: false });
  }

  async storeOAuthCredentials(payload: { oauthClientJson: string; clientName?: string }): Promise<GsuiteSnapshot> {
    return this.runExclusive(async () => {
      const oauthClientJson = payload.oauthClientJson.trim();
      if (!oauthClientJson) {
        throw new Error("oauthClientJson must be a non-empty string");
      }

      const args = ["auth", "credentials", "-"];
      if (payload.clientName && payload.clientName.trim()) {
        args.push("--client", payload.clientName.trim());
      }

      await runGogCommand(args, {
        dataDir: this.dataDir,
        stdin: oauthClientJson,
        timeoutMs: 20_000
      });

      this.config = mergeGsuiteConfig(this.config, {
        hasOAuthClientCredentials: true
      });
      await saveGsuiteConfig({ dataDir: this.dataDir, config: this.config });

      return this.getSnapshot();
    });
  }

  async startOAuth(payload: {
    email?: string;
    services?: string[];
    forceConsent?: boolean;
  }): Promise<{ snapshot: GsuiteSnapshot; result: GsuiteOAuthStartResult }> {
    return this.runExclusive(async () => {
      const email = this.resolveEmail(payload.email);
      const services = normalizeServices(payload.services ?? this.config.services);

      const args = [
        "--json",
        "auth",
        "add",
        email,
        "--services",
        services.join(","),
        "--remote",
        "--step",
        "1"
      ];

      if (payload.forceConsent === true) {
        args.push("--force-consent");
      }

      const output = await runGogCommand(args, {
        dataDir: this.dataDir
      });

      const parsed = parseGogJsonOutput(output.stdout);
      const authUrl = extractAuthUrlFromOutput(parsed);
      if (!authUrl) {
        throw new Error("gog did not return an authorization URL");
      }

      this.config = mergeGsuiteConfig(this.config, {
        accountEmail: email,
        services
      });
      await saveGsuiteConfig({ dataDir: this.dataDir, config: this.config });

      return {
        snapshot: await this.getSnapshot(),
        result: {
          authUrl,
          instructions:
            "Open the URL, approve Google access, then paste the full redirect URL below and click Complete Connection.",
          raw: parsed
        }
      };
    });
  }

  async completeOAuth(payload: {
    email?: string;
    authUrl: string;
    services?: string[];
    forceConsent?: boolean;
  }): Promise<{ snapshot: GsuiteSnapshot; result: GsuiteOAuthCompleteResult }> {
    return this.runExclusive(async () => {
      const email = this.resolveEmail(payload.email);
      const authUrl = payload.authUrl.trim();
      if (!authUrl) {
        throw new Error("authUrl must be a non-empty string");
      }

      const services = normalizeServices(payload.services ?? this.config.services);
      const args = [
        "--json",
        "auth",
        "add",
        email,
        "--services",
        services.join(","),
        "--remote",
        "--step",
        "2",
        "--auth-url",
        authUrl
      ];

      if (payload.forceConsent === true) {
        args.push("--force-consent");
      }

      const output = await runGogCommand(args, {
        dataDir: this.dataDir
      });
      const parsed = parseGogJsonOutput(output.stdout);

      this.config = mergeGsuiteConfig(this.config, {
        accountEmail: email,
        services,
        lastConnectedAt: new Date().toISOString()
      });
      await saveGsuiteConfig({ dataDir: this.dataDir, config: this.config });

      return {
        snapshot: await this.getSnapshot(),
        result: {
          connected: true,
          raw: parsed
        }
      };
    });
  }

  async testConnection(payload?: { email?: string }): Promise<GsuiteConnectionTestResult> {
    const email = this.resolveEmail(payload?.email);

    const output = await runGogCommand(["--json", "auth", "status", "--account", email], {
      dataDir: this.dataDir,
      timeoutMs: 20_000
    });

    return {
      connected: true,
      accountEmail: email,
      raw: parseGogJsonOutput(output.stdout)
    };
  }

  private resolveEmail(value: string | undefined): string {
    const email = (value ?? this.config.accountEmail).trim();
    if (!email) {
      throw new Error("email is required");
    }
    if (!email.includes("@")) {
      throw new Error("email must be a valid address");
    }
    return email;
  }

  private async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(action, action);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function normalizeServices(services: unknown): string[] {
  if (services === undefined) {
    return [...DEFAULT_SERVICES];
  }
  return normalizeServiceList(services);
}
