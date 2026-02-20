import type { ConversationAttachment, MessageSourceContext, ResponseExpectation } from "../../swarm/types.js";

export type SlackConnectionMode = "socket";

export interface SlackIntegrationConfig {
  enabled: boolean;
  mode: SlackConnectionMode;
  appToken: string;
  botToken: string;
  targetManagerId: string;
  listen: {
    dm: boolean;
    channelIds: string[];
    includePrivateChannels: boolean;
  };
  response: {
    respondInThread: boolean;
    replyBroadcast: boolean;
    wakeWords: string[];
  };
  attachments: {
    maxFileBytes: number;
    allowImages: boolean;
    allowText: boolean;
    allowBinary: boolean;
  };
}

export interface SlackIntegrationConfigPublic extends Omit<SlackIntegrationConfig, "appToken" | "botToken"> {
  appToken: string | null;
  botToken: string | null;
  hasAppToken: boolean;
  hasBotToken: boolean;
}

export interface SlackChannelDescriptor {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export interface SlackSocketEnvelope {
  type: string;
  body: unknown;
  envelopeId?: string;
  retryNum?: number;
  retryReason?: string;
}

export interface SlackEventsApiBody {
  team_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackEvent;
}

export type SlackEvent = SlackMessageEvent | SlackAppMentionEvent | SlackUnknownEvent;

export interface SlackUnknownEvent {
  type: string;
  [key: string]: unknown;
}

export interface SlackMessageEvent {
  type: "message";
  user?: string;
  text?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  channel_type?: "im" | "channel" | "group" | "mpim";
  subtype?: string;
  bot_id?: string;
  files?: SlackFileDescriptor[];
}

export interface SlackAppMentionEvent {
  type: "app_mention";
  user?: string;
  text?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  files?: SlackFileDescriptor[];
}

export interface SlackFileDescriptor {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  is_external?: boolean;
}

export interface SlackNormalizedInboundMessage {
  text: string;
  attachments: ConversationAttachment[];
  sourceContext: MessageSourceContext;
  responseExpectation: ResponseExpectation;
}

export interface SlackConnectionTestResult {
  ok: true;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
}
