import { ErrorCode, WebClient } from "@slack/web-api";
import type { SlackChannelDescriptor, SlackFileDescriptor } from "./slack-types.js";

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  threadTs?: string;
  replyBroadcast?: boolean;
}

export interface SlackPostMessageResult {
  channel: string;
  ts?: string;
}

export interface SlackAuthResult {
  teamId?: string;
  teamName?: string;
  botUserId?: string;
}

export interface SlackDownloadedFile {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  size: number;
}

export class SlackWebApiClient {
  private readonly botToken: string;
  private readonly webClient: WebClient;

  constructor(botToken: string) {
    this.botToken = botToken.trim();
    if (!this.botToken) {
      throw new Error("Missing Slack bot token");
    }

    this.webClient = new WebClient(this.botToken);
  }

  async testAuth(): Promise<SlackAuthResult> {
    const response = await this.webClient.auth.test();

    if (!response.ok) {
      throw new Error(`Slack auth.test failed: ${response.error ?? "unknown_error"}`);
    }

    return {
      teamId: normalizeOptionalString(response.team_id),
      teamName: normalizeOptionalString(response.team),
      botUserId: normalizeOptionalString(response.user_id)
    };
  }

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult> {
    const channel = input.channel.trim();
    const text = input.text;

    if (!channel) {
      throw new Error("Slack channel is required for outbound delivery");
    }

    if (!text.trim()) {
      throw new Error("Slack message text is required for outbound delivery");
    }

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt += 1;

      try {
        const payload: Record<string, unknown> = {
          channel,
          text
        };

        const threadTs = normalizeOptionalString(input.threadTs);
        if (threadTs) {
          payload.thread_ts = threadTs;
        }

        const replyBroadcast = normalizeOptionalBoolean(input.replyBroadcast);
        if (replyBroadcast !== undefined) {
          payload.reply_broadcast = replyBroadcast;
        }

        const response = await this.webClient.chat.postMessage(payload as any);

        if (!response.ok) {
          throw new Error(`Slack chat.postMessage failed: ${response.error ?? "unknown_error"}`);
        }

        return {
          channel,
          ts: normalizeOptionalString(response.ts)
        };
      } catch (error) {
        const retryAfterMs = getRateLimitDelayMs(error);
        if (retryAfterMs === undefined || attempt >= maxAttempts) {
          throw error;
        }

        await sleep(retryAfterMs);
      }
    }

    throw new Error("Slack chat.postMessage failed after retries");
  }

  async listChannels(options: { includePrivateChannels: boolean }): Promise<SlackChannelDescriptor[]> {
    const types = options.includePrivateChannels
      ? "public_channel,private_channel"
      : "public_channel";

    const channels: SlackChannelDescriptor[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.webClient.conversations.list({
        limit: 200,
        exclude_archived: true,
        cursor,
        types
      });

      if (!response.ok) {
        throw new Error(`Slack conversations.list failed: ${response.error ?? "unknown_error"}`);
      }

      for (const channel of response.channels ?? []) {
        if (!channel?.id) {
          continue;
        }

        channels.push({
          id: channel.id,
          name: channel.name ?? channel.id,
          isPrivate: channel.is_private === true,
          isMember: channel.is_member === true
        });
      }

      cursor = normalizeOptionalString(response.response_metadata?.next_cursor);
    } while (cursor);

    channels.sort((left, right) => left.name.localeCompare(right.name));
    return channels;
  }

  async openDirectMessage(userId: string): Promise<string> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new Error("Slack user id is required to open DM channel");
    }

    const response = await this.webClient.conversations.open({ users: normalizedUserId });
    if (!response.ok) {
      throw new Error(`Slack conversations.open failed: ${response.error ?? "unknown_error"}`);
    }

    const channelId = normalizeOptionalString(response.channel?.id);
    if (!channelId) {
      throw new Error("Slack conversations.open did not return a channel id");
    }

    return channelId;
  }

  async getFileInfo(fileId: string): Promise<SlackFileDescriptor | null> {
    const normalizedFileId = fileId.trim();
    if (!normalizedFileId) {
      return null;
    }

    const response = await this.webClient.files.info({ file: normalizedFileId });
    if (!response.ok) {
      throw new Error(`Slack files.info failed: ${response.error ?? "unknown_error"}`);
    }

    if (!response.file) {
      return null;
    }

    return {
      id: normalizeOptionalString(response.file.id),
      name: normalizeOptionalString(response.file.name),
      mimetype: normalizeOptionalString(response.file.mimetype),
      size: typeof response.file.size === "number" ? response.file.size : undefined,
      url_private: normalizeOptionalString(response.file.url_private),
      url_private_download: normalizeOptionalString(response.file.url_private_download),
      is_external: response.file.is_external === true
    };
  }

  async downloadFile(file: SlackFileDescriptor): Promise<SlackDownloadedFile> {
    const downloadUrl =
      normalizeOptionalString(file.url_private_download) ?? normalizeOptionalString(file.url_private);

    if (!downloadUrl) {
      throw new Error("Slack file payload is missing url_private");
    }

    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${this.botToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Slack file download failed (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      size: buffer.byteLength,
      mimeType: normalizeOptionalString(file.mimetype) ?? "application/octet-stream",
      fileName: normalizeOptionalString(file.name) ?? "attachment"
    };
  }
}

export async function testSlackAppToken(appToken: string): Promise<void> {
  const normalized = appToken.trim();
  if (!normalized) {
    throw new Error("Missing Slack app token");
  }

  const webClient = new WebClient("", {
    headers: {
      Authorization: `Bearer ${normalized}`
    }
  });

  const response = await webClient.apps.connections.open({});
  if (!response.ok) {
    throw new Error(`Slack apps.connections.open failed: ${response.error ?? "unknown_error"}`);
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalBoolean(value: boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getRateLimitDelayMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const code = "code" in error ? (error as { code?: string }).code : undefined;
  if (code !== ErrorCode.RateLimitedError) {
    return undefined;
  }

  const retryAfterSeconds =
    "retryAfter" in error && typeof (error as { retryAfter?: number }).retryAfter === "number"
      ? (error as { retryAfter: number }).retryAfter
      : undefined;

  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return 1000;
  }

  return retryAfterSeconds * 1000;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
