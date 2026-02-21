export type GsuiteIntegrationState = "disabled" | "ready" | "connected" | "error";

export interface GsuiteIntegrationConfig {
  enabled: boolean;
  accountEmail: string;
  services: string[];
  hasOAuthClientCredentials: boolean;
  lastConnectedAt: string | null;
  updatedAt: string;
}

export type GsuiteIntegrationConfigPublic = GsuiteIntegrationConfig;

export interface GsuiteIntegrationStatus {
  state: GsuiteIntegrationState;
  enabled: boolean;
  gogInstalled: boolean;
  gogVersion?: string;
  connected: boolean;
  accountEmail: string;
  message: string;
  updatedAt: string;
}

export interface GsuiteOAuthStartResult {
  authUrl: string;
  instructions: string;
  raw: unknown;
}

export interface GsuiteOAuthCompleteResult {
  connected: boolean;
  raw: unknown;
}

export interface GsuiteConnectionTestResult {
  connected: boolean;
  accountEmail: string;
  raw: unknown;
}

export interface GsuiteSnapshot {
  config: GsuiteIntegrationConfigPublic;
  status: GsuiteIntegrationStatus;
}
