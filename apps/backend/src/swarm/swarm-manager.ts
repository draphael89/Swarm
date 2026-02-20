import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel, type Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  DefaultResourceLoader,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent
} from "@mariozechner/pi-coding-agent";
import type { ServerEvent } from "../protocol/ws-types.js";
import {
  loadArchetypePromptRegistry,
  normalizeArchetypeId,
  type ArchetypePromptRegistry
} from "./archetypes/archetype-prompt-registry.js";
import {
  AgentRuntime,
  type RuntimeImageAttachment,
  type RuntimeUserMessage
} from "./agent-runtime.js";
import {
  listDirectories,
  normalizeAllowlistRoots,
  validateDirectory as validateDirectoryInput,
  validateDirectoryPath,
  type DirectoryListingResult,
  type DirectoryValidationResult
} from "./cwd-policy.js";
import { pickDirectory as pickNativeDirectory } from "./directory-picker.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor,
  parseSwarmModelPreset,
  resolveModelDescriptorFromPreset
} from "./model-presets.js";
import { buildSwarmTools, type SwarmToolHost } from "./swarm-tools.js";
import type {
  AcceptedDeliveryMode,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  AgentStatusEvent,
  AgentsSnapshotEvent,
  AgentsStoreFile,
  ConversationAttachment,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationImageAttachment,
  ConversationLogEvent,
  ConversationMessageEvent,
  ConversationTextAttachment,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SpawnAgentInput,
  SwarmConfig,
  SwarmModelPreset
} from "./types.js";

const DEFAULT_WORKER_SYSTEM_PROMPT = `You are a worker agent in a swarm.
- You can list agents and send messages to other agents.
- Use coding tools (read/bash/edit/write) to execute implementation tasks.
- Report progress and outcomes back to the manager using send_message_to_agent.
- You are not user-facing.
- End users only see messages they send and manager speak_to_user outputs.
- Your plain assistant text is not directly visible to end users.
- Incoming messages prefixed with "SYSTEM:" are internal control/context updates, not direct end-user chat.
- Persistent memory lives at \${SWARM_DATA_DIR}/MEMORY.md and is auto-loaded into context.
- Only write memory when explicitly asked to remember/update/forget durable information.
- Follow the memory skill workflow before editing MEMORY.md, and never store secrets in memory.`;
const MANAGER_ARCHETYPE_ID = "manager";
const MERGER_ARCHETYPE_ID = "merger";
const INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: ";
const MAX_CONVERSATION_HISTORY = 2000;
const CONVERSATION_ENTRY_TYPE = "swarm_conversation_entry";
const LEGACY_CONVERSATION_ENTRY_TYPE = "swarm_conversation_message";
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const REPO_BRAVE_SEARCH_SKILL_RELATIVE_PATH = ".swarm/skills/brave-search/SKILL.md";
const BUILT_IN_MEMORY_SKILL_RELATIVE_PATH = "apps/backend/src/swarm/skills/builtins/memory/SKILL.md";
const BUILT_IN_BRAVE_SEARCH_SKILL_RELATIVE_PATH =
  "apps/backend/src/swarm/skills/builtins/brave-search/SKILL.md";
const SWARM_MANAGER_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_PACKAGE_DIR = resolve(SWARM_MANAGER_DIR, "..", "..");
const BUILT_IN_MEMORY_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "memory",
  "SKILL.md"
);
const BUILT_IN_BRAVE_SEARCH_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "brave-search",
  "SKILL.md"
);
const DEFAULT_MEMORY_FILE_CONTENT = `# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- (none yet)

## Decisions
- (none yet)

## Open Follow-ups
- (none yet)
`;

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyArchetypePromptRegistry(): ArchetypePromptRegistry {
  return {
    resolvePrompt: () => undefined,
    listArchetypeIds: () => []
  };
}

export class SwarmManager extends EventEmitter implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly defaultModelPreset: SwarmModelPreset;

  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly pendingUserRepliesByManagerId = new Map<string, number>();

  private archetypePromptRegistry: ArchetypePromptRegistry = createEmptyArchetypePromptRegistry();

  constructor(config: SwarmConfig, options?: { now?: () => string }) {
    super();

    this.defaultModelPreset =
      inferSwarmModelPresetFromDescriptor(config.defaultModel) ?? DEFAULT_SWARM_MODEL_PRESET;
    this.config = {
      ...config,
      defaultModel: resolveModelDescriptorFromPreset(this.defaultModelPreset)
    };
    this.now = options?.now ?? nowIso;
  }

  async boot(): Promise<void> {
    this.logDebug("boot:start", {
      host: this.config.host,
      port: this.config.port,
      authFile: this.config.paths.authFile,
      managerId: this.config.managerId
    });

    await this.ensureDirectories();
    await this.ensureMemoryFile();

    try {
      this.config.defaultCwd = await this.resolveAndValidateCwd(this.config.defaultCwd);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid SWARM_DEFAULT_CWD: ${error.message}`);
      }
      throw error;
    }

    this.archetypePromptRegistry = await loadArchetypePromptRegistry({
      repoOverridesDir: this.config.paths.repoArchetypesDir
    });

    const loaded = await this.loadStore();
    for (const descriptor of loaded.agents) {
      this.descriptors.set(descriptor.agentId, descriptor);
    }

    this.prepareDescriptorsForBoot();
    await this.saveStore();

    this.loadConversationHistoriesFromStore();
    await this.restoreRuntimesForBoot();

    const managerDescriptor = this.getBootLogManagerDescriptor();
    this.emitAgentsSnapshot();

    this.logDebug("boot:ready", {
      managerId: managerDescriptor?.agentId,
      managerStatus: managerDescriptor?.status,
      model: managerDescriptor?.model,
      cwd: managerDescriptor?.cwd,
      managerAgentDir: this.config.paths.managerAgentDir,
      managerSystemPromptSource: managerDescriptor ? `archetype:${MANAGER_ARCHETYPE_ID}` : undefined,
      loadedArchetypeIds: this.archetypePromptRegistry.listArchetypeIds(),
      restoredAgentIds: Array.from(this.runtimes.keys())
    });
  }

  listAgents(): AgentDescriptor[] {
    return this.sortedDescriptors().map((descriptor) => ({ ...descriptor, model: { ...descriptor.model } }));
  }

  getConversationHistory(agentId: string = this.config.managerId): ConversationEntryEvent[] {
    const history = this.conversationEntriesByAgentId.get(agentId) ?? [];
    return history.map((entry) => ({ ...entry }));
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.assertManager(callerAgentId, "spawn agents");

    const requestedAgentId = input.agentId?.trim();
    if (!requestedAgentId) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }

    const agentId = this.generateUniqueAgentId(requestedAgentId);
    const createdAt = this.now();

    const model = this.resolveSpawnModel(input.model, manager.model);
    const archetypeId = this.resolveSpawnWorkerArchetypeId(input, agentId);

    const descriptor: AgentDescriptor = {
      agentId,
      displayName: agentId,
      role: "worker",
      managerId: manager.agentId,
      archetypeId,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: input.cwd ? await this.resolveAndValidateCwd(input.cwd) : manager.cwd,
      model,
      sessionFile: join(this.config.paths.sessionsDir, `${agentId}.jsonl`)
    };

    this.descriptors.set(agentId, descriptor);
    await this.saveStore();

    this.logDebug("agent:spawn", {
      callerAgentId,
      agentId,
      managerId: descriptor.managerId,
      displayName: descriptor.displayName,
      archetypeId: descriptor.archetypeId,
      model: descriptor.model,
      cwd: descriptor.cwd
    });

    const explicitSystemPrompt = input.systemPrompt?.trim();
    const runtimeSystemPrompt =
      explicitSystemPrompt && explicitSystemPrompt.length > 0
        ? explicitSystemPrompt
        : this.resolveSystemPromptForDescriptor(descriptor);

    const runtime = await this.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
    this.runtimes.set(agentId, runtime);

    this.emitStatus(agentId, descriptor.status, runtime.getPendingCount());
    this.emitAgentsSnapshot();

    if (input.initialMessage && input.initialMessage.trim().length > 0) {
      await this.sendMessage(callerAgentId, agentId, input.initialMessage, "auto", { origin: "internal" });
    }

    return { ...descriptor, model: { ...descriptor.model } };
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    const manager = this.assertManager(callerAgentId, "kill agents");

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown agent: ${targetAgentId}`);
    }
    if (target.role === "manager") {
      throw new Error("Manager cannot be killed");
    }

    if (target.managerId !== manager.agentId) {
      throw new Error(`Only owning manager can kill agent ${targetAgentId}`);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: false });
    await this.saveStore();

    this.logDebug("agent:kill", {
      callerAgentId,
      targetAgentId,
      managerId: manager.agentId
    });

    this.emitStatus(targetAgentId, target.status, 0);
    this.emitAgentsSnapshot();
  }

  async createManager(
    callerAgentId: string,
    input: { name: string; cwd: string; model?: SwarmModelPreset }
  ): Promise<AgentDescriptor> {
    const callerDescriptor = this.descriptors.get(callerAgentId);
    if (!callerDescriptor || callerDescriptor.role !== "manager") {
      const canBootstrap = callerAgentId === this.config.managerId && !this.hasRunningManagers();
      if (!canBootstrap) {
        throw new Error("Only manager can create managers");
      }
    } else if (callerDescriptor.status === "terminated" || callerDescriptor.status === "stopped_on_restart") {
      throw new Error(`Manager is not running: ${callerAgentId}`);
    }

    const requestedName = input.name?.trim();
    if (!requestedName) {
      throw new Error("create_manager requires a non-empty name");
    }

    const requestedModelPreset = parseSwarmModelPreset(input.model, "create_manager.model");
    const managerId = this.generateUniqueManagerId(requestedName);
    const createdAt = this.now();
    const cwd = await this.resolveAndValidateCwd(input.cwd);

    const descriptor: AgentDescriptor = {
      agentId: managerId,
      displayName: managerId,
      role: "manager",
      managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd,
      model: requestedModelPreset
        ? resolveModelDescriptorFromPreset(requestedModelPreset)
        : this.resolveDefaultModelDescriptor(),
      sessionFile: join(this.config.paths.sessionsDir, `${managerId}.jsonl`)
    };

    this.descriptors.set(descriptor.agentId, descriptor);
    this.pendingUserRepliesByManagerId.set(managerId, 0);

    let runtime: AgentRuntime;
    try {
      runtime = await this.createRuntimeForDescriptor(
        descriptor,
        this.resolveSystemPromptForDescriptor(descriptor)
      );
    } catch (error) {
      this.descriptors.delete(descriptor.agentId);
      this.pendingUserRepliesByManagerId.delete(managerId);
      throw error;
    }

    this.runtimes.set(managerId, runtime);
    await this.saveStore();

    this.emitStatus(managerId, descriptor.status, runtime.getPendingCount());
    this.emitAgentsSnapshot();

    this.logDebug("manager:create", {
      callerAgentId,
      managerId,
      cwd: descriptor.cwd
    });

    return { ...descriptor, model: { ...descriptor.model } };
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    this.assertManager(callerAgentId, "delete managers");

    const target = this.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    const terminatedWorkerIds: string[] = [];

    for (const descriptor of Array.from(this.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }
      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      terminatedWorkerIds.push(descriptor.agentId);
      await this.terminateDescriptor(descriptor, { abort: true, emitStatus: true });
      this.descriptors.delete(descriptor.agentId);
      this.conversationEntriesByAgentId.delete(descriptor.agentId);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: true });
    this.descriptors.delete(targetManagerId);
    this.conversationEntriesByAgentId.delete(targetManagerId);
    this.pendingUserRepliesByManagerId.delete(targetManagerId);

    await this.saveStore();
    this.emitAgentsSnapshot();

    this.logDebug("manager:delete", {
      callerAgentId,
      targetManagerId,
      terminatedWorkerIds
    });

    return { managerId: targetManagerId, terminatedWorkerIds };
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return undefined;
    }

    return { ...descriptor, model: { ...descriptor.model } };
  }

  async listDirectories(path?: string): Promise<DirectoryListingResult> {
    return listDirectories(path, this.getCwdPolicy());
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return validateDirectoryInput(path, this.getCwdPolicy());
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    const pickedPath = await pickNativeDirectory({
      defaultPath,
      prompt: "Select a manager working directory"
    });

    if (!pickedPath) {
      return null;
    }

    return validateDirectoryPath(pickedPath, this.getCwdPolicy());
  }

  async sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode = "auto",
    options?: { origin?: "user" | "internal"; attachments?: ConversationAttachment[] }
  ): Promise<SendMessageReceipt> {
    const sender = this.descriptors.get(fromAgentId);
    if (!sender || sender.status === "terminated") {
      throw new Error(`Unknown or terminated sender agent: ${fromAgentId}`);
    }

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (target.status === "terminated" || target.status === "stopped_on_restart") {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    if (sender.role === "manager" && target.role === "worker" && target.managerId !== sender.agentId) {
      throw new Error(`Manager ${sender.agentId} does not own worker ${targetAgentId}`);
    }

    const runtime = this.runtimes.get(targetAgentId);
    if (!runtime) {
      throw new Error(`Target runtime is not available: ${targetAgentId}`);
    }

    const origin = options?.origin ?? "internal";
    const attachments = normalizeConversationAttachments(options?.attachments);
    const modelMessage = await this.prepareModelInboundMessage(
      targetAgentId,
      {
        text: message,
        attachments
      },
      origin
    );
    const receipt = await runtime.sendMessage(modelMessage, delivery);

    this.logDebug("agent:send_message", {
      fromAgentId,
      targetAgentId,
      origin,
      requestedDelivery: delivery,
      acceptedMode: receipt.acceptedMode,
      textPreview: previewForLog(message),
      attachmentCount: attachments.length,
      modelTextPreview: previewForLog(extractRuntimeMessageText(modelMessage))
    });

    return receipt;
  }

  private async prepareModelInboundMessage(
    targetAgentId: string,
    input: { text: string; attachments: ConversationAttachment[] },
    origin: "user" | "internal"
  ): Promise<string | RuntimeUserMessage> {
    let text = input.text;

    if (origin !== "user") {
      if (text.trim().length > 0 && !/^system:/i.test(text.trimStart())) {
        text = `${INTERNAL_MODEL_MESSAGE_PREFIX}${text}`;
      }
    }

    const runtimeAttachments = await this.prepareRuntimeAttachments(targetAgentId, input.attachments);

    if (runtimeAttachments.attachmentMessage.length > 0) {
      text = text.trim().length > 0 ? `${text}\n\n${runtimeAttachments.attachmentMessage}` : runtimeAttachments.attachmentMessage;
    }

    if (runtimeAttachments.images.length === 0) {
      return text;
    }

    return {
      text,
      images: runtimeAttachments.images
    };
  }

  private async prepareRuntimeAttachments(
    targetAgentId: string,
    attachments: ConversationAttachment[]
  ): Promise<{ images: RuntimeImageAttachment[]; attachmentMessage: string }> {
    if (attachments.length === 0) {
      return {
        images: [],
        attachmentMessage: ""
      };
    }

    const images = toRuntimeImageAttachments(attachments);
    const fileMessages: string[] = [];
    let binaryAttachmentDir: string | undefined;

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];

      if (isConversationImageAttachment(attachment)) {
        continue;
      }

      if (isConversationTextAttachment(attachment)) {
        fileMessages.push(formatTextAttachmentForPrompt(attachment, index + 1));
        continue;
      }

      if (isConversationBinaryAttachment(attachment)) {
        const directory = binaryAttachmentDir ?? (await this.createBinaryAttachmentDir(targetAgentId));
        binaryAttachmentDir = directory;
        const storedPath = await this.writeBinaryAttachmentToDisk(directory, attachment, index + 1);
        fileMessages.push(formatBinaryAttachmentForPrompt(attachment, storedPath, index + 1));
      }
    }

    if (fileMessages.length === 0) {
      return {
        images,
        attachmentMessage: ""
      };
    }

    return {
      images,
      attachmentMessage: ["The user attached the following files:", "", ...fileMessages].join("\n")
    };
  }

  private async createBinaryAttachmentDir(targetAgentId: string): Promise<string> {
    const agentSegment = sanitizePathSegment(targetAgentId, "agent");
    const batchId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const directory = join(this.config.paths.dataDir, "attachments", agentSegment, batchId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async writeBinaryAttachmentToDisk(
    directory: string,
    attachment: ConversationBinaryAttachment,
    attachmentIndex: number
  ): Promise<string> {
    const safeName = sanitizeAttachmentFileName(attachment.fileName, `attachment-${attachmentIndex}.bin`);
    const filePath = join(directory, `${String(attachmentIndex).padStart(2, "0")}-${safeName}`);
    const buffer = Buffer.from(attachment.data, "base64");
    await writeFile(filePath, buffer);
    return filePath;
  }

  async publishToUser(agentId: string, text: string, source: "speak_to_user" | "system" = "speak_to_user"): Promise<void> {
    const pendingBefore = this.getPendingUserReplies(agentId);
    if (source === "speak_to_user") {
      this.assertManager(agentId, "speak to user");
      this.decrementPendingUserReplies(agentId);
    }

    const payload: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      role: source === "system" ? "system" : "assistant",
      text,
      timestamp: this.now(),
      source
    };

    this.emitConversationMessage(payload);
    this.logDebug("manager:publish_to_user", {
      source,
      agentId,
      pendingBefore,
      pendingAfter: this.getPendingUserReplies(agentId),
      textPreview: previewForLog(text)
    });
  }

  async handleUserMessage(
    text: string,
    options?: {
      targetAgentId?: string;
      delivery?: RequestedDeliveryMode;
      attachments?: ConversationAttachment[];
    }
  ): Promise<void> {
    const trimmed = text.trim();
    const attachments = normalizeConversationAttachments(options?.attachments);
    if (!trimmed && attachments.length === 0) return;

    const targetAgentId = options?.targetAgentId ?? this.config.managerId;
    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (target.status === "terminated" || target.status === "stopped_on_restart") {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    const managerContextId = target.role === "manager" ? target.agentId : target.managerId;

    this.logDebug("manager:user_message_received", {
      targetAgentId,
      managerContextId,
      textPreview: previewForLog(trimmed),
      attachmentCount: attachments.length,
      pendingBefore: this.getPendingUserReplies(managerContextId)
    });

    const userEvent: ConversationMessageEvent = {
      type: "conversation_message",
      agentId: targetAgentId,
      role: "user",
      text: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: this.now(),
      source: "user_input"
    };
    this.emitConversationMessage(userEvent);

    if (target.role !== "manager") {
      await this.sendMessage(managerContextId, targetAgentId, trimmed, options?.delivery ?? "auto", {
        origin: "user",
        attachments
      });
      return;
    }

    this.incrementPendingUserReplies(managerContextId);
    this.logDebug("manager:user_message_dispatched", {
      managerContextId,
      pendingAfter: this.getPendingUserReplies(managerContextId)
    });

    const managerRuntime = this.runtimes.get(managerContextId);
    if (!managerRuntime) {
      throw new Error(`Manager runtime is not initialized: ${managerContextId}`);
    }

    // User messages to managers should always steer in-flight work.
    const runtimeMessage = await this.prepareModelInboundMessage(
      managerContextId,
      {
        text: trimmed,
        attachments
      },
      "user"
    );

    await managerRuntime.sendMessage(runtimeMessage, "steer");
  }

  async resetManagerSession(
    managerIdOrReason: string | "user_new_command" | "api_reset" = "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): Promise<void> {
    const parsed = this.parseResetManagerSessionArgs(managerIdOrReason, maybeReason);
    const managerId = parsed.managerId;
    const reason = parsed.reason;
    const managerDescriptor = this.getRequiredManagerDescriptor(managerId);

    this.logDebug("manager:reset:start", {
      managerId,
      reason,
      sessionFile: managerDescriptor.sessionFile
    });

    const existingRuntime = this.runtimes.get(managerId);
    if (existingRuntime) {
      await existingRuntime.terminate({ abort: true });
      this.runtimes.delete(managerId);
    }

    this.pendingUserRepliesByManagerId.set(managerId, 0);
    this.conversationEntriesByAgentId.set(managerId, []);
    await this.deleteManagerSessionFile(managerDescriptor.sessionFile);

    managerDescriptor.status = "idle";
    managerDescriptor.updatedAt = this.now();
    this.descriptors.set(managerId, managerDescriptor);
    await this.saveStore();

    const managerRuntime = await this.createRuntimeForDescriptor(
      managerDescriptor,
      this.resolveSystemPromptForDescriptor(managerDescriptor)
    );
    this.runtimes.set(managerId, managerRuntime);

    this.emitConversationReset(managerId, reason);
    this.emitStatus(managerId, managerDescriptor.status, managerRuntime.getPendingCount());
    this.emitAgentsSnapshot();

    this.logDebug("manager:reset:ready", {
      managerId,
      reason,
      sessionFile: managerDescriptor.sessionFile
    });
  }

  getConfig(): SwarmConfig {
    return this.config;
  }

  private emitConversationMessage(event: ConversationMessageEvent): void {
    this.emitConversationEntry(event);
    this.emit("conversation_message", event satisfies ServerEvent);
  }

  private emitConversationLog(event: ConversationLogEvent): void {
    this.emitConversationEntry(event);
    this.emit("conversation_log", event satisfies ServerEvent);
  }

  private emitConversationEntry(event: ConversationEntryEvent): void {
    const history = this.conversationEntriesByAgentId.get(event.agentId) ?? [];
    history.push(event);
    if (history.length > MAX_CONVERSATION_HISTORY) {
      history.splice(0, history.length - MAX_CONVERSATION_HISTORY);
    }
    this.conversationEntriesByAgentId.set(event.agentId, history);

    const runtime = this.runtimes.get(event.agentId);
    if (!runtime) {
      return;
    }

    try {
      runtime.appendCustomEntry(CONVERSATION_ENTRY_TYPE, event);
    } catch (error) {
      this.logDebug("history:save:error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.emit(
      "conversation_reset",
      {
        type: "conversation_reset",
        agentId,
        timestamp: this.now(),
        reason
      } satisfies ServerEvent
    );
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.config.debug) return;

    const prefix = `[swarm][${this.now()}] ${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }
    console.log(prefix, details);
  }

  private sortedDescriptors(): AgentDescriptor[] {
    return Array.from(this.descriptors.values()).sort((a, b) => {
      if (a.agentId === this.config.managerId) return -1;
      if (b.agentId === this.config.managerId) return 1;

      if (a.role === "manager" && b.role !== "manager") return -1;
      if (b.role === "manager" && a.role !== "manager") return 1;

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.agentId.localeCompare(b.agentId);
    });
  }

  private async restoreRuntimesForBoot(): Promise<void> {
    let shouldPersist = false;

    for (const descriptor of this.sortedDescriptors()) {
      if (descriptor.status === "terminated") {
        continue;
      }

      const systemPrompt = this.resolveSystemPromptForDescriptor(descriptor);

      try {
        const runtime = await this.createRuntimeForDescriptor(descriptor, systemPrompt);
        this.runtimes.set(descriptor.agentId, runtime);
        this.emitStatus(descriptor.agentId, descriptor.status, runtime.getPendingCount());
      } catch (error) {
        if (descriptor.role === "manager" && descriptor.agentId === this.config.managerId) {
          throw error;
        }

        descriptor.status = "stopped_on_restart";
        descriptor.updatedAt = this.now();
        this.descriptors.set(descriptor.agentId, descriptor);
        shouldPersist = true;

        this.emitStatus(descriptor.agentId, descriptor.status, 0);
        this.logDebug("boot:restore_runtime:error", {
          agentId: descriptor.agentId,
          role: descriptor.role,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (shouldPersist) {
      await this.saveStore();
    }

    const primaryManager = this.descriptors.get(this.config.managerId);
    if (
      primaryManager &&
      primaryManager.role === "manager" &&
      primaryManager.status !== "terminated" &&
      !this.runtimes.has(this.config.managerId)
    ) {
      throw new Error("Primary manager runtime is not initialized");
    }
  }

  private prepareDescriptorsForBoot(): void {
    const now = this.now();

    for (const descriptor of this.descriptors.values()) {
      let touched = false;

      descriptor.sessionFile = join(this.config.paths.sessionsDir, `${descriptor.agentId}.jsonl`);

      if (!descriptor.cwd) {
        descriptor.cwd = this.config.defaultCwd;
        touched = true;
      }

      const normalizedModel = this.normalizePersistedModelDescriptor(descriptor.model);
      if (
        !descriptor.model ||
        descriptor.model.provider !== normalizedModel.provider ||
        descriptor.model.modelId !== normalizedModel.modelId ||
        descriptor.model.thinkingLevel !== normalizedModel.thinkingLevel
      ) {
        descriptor.model = normalizedModel;
        touched = true;
      }

      if (descriptor.role === "manager") {
        if (descriptor.managerId !== descriptor.agentId) {
          descriptor.managerId = descriptor.agentId;
          touched = true;
        }

        if (descriptor.archetypeId !== MANAGER_ARCHETYPE_ID) {
          descriptor.archetypeId = MANAGER_ARCHETYPE_ID;
          touched = true;
        }

        if (descriptor.status !== "terminated" && descriptor.status !== "idle") {
          descriptor.status = "idle";
          touched = true;
        }
      } else {
        const maybeManagerId = typeof descriptor.managerId === "string" ? descriptor.managerId.trim() : "";
        if (!maybeManagerId) {
          descriptor.managerId = this.config.managerId;
          touched = true;
        }

        if (descriptor.status !== "terminated" && descriptor.status !== "idle") {
          descriptor.status = "idle";
          touched = true;
        }
      }

      if (touched) {
        descriptor.updatedAt = now;
      }
    }

    const hasOtherRunningAgents = Array.from(this.descriptors.values()).some(
      (descriptor) => descriptor.status !== "terminated"
    );

    let primaryManager = this.descriptors.get(this.config.managerId);
    if (!primaryManager) {
      if (!hasOtherRunningAgents) {
        primaryManager = {
          agentId: this.config.managerId,
          displayName: this.config.managerDisplayName,
          role: "manager",
          managerId: this.config.managerId,
          archetypeId: MANAGER_ARCHETYPE_ID,
          status: "idle",
          createdAt: now,
          updatedAt: now,
          cwd: this.config.defaultCwd,
          model: this.resolveDefaultModelDescriptor(),
          sessionFile: join(this.config.paths.sessionsDir, `${this.config.managerId}.jsonl`)
        };
        this.descriptors.set(primaryManager.agentId, primaryManager);
      }
    } else {
      primaryManager.role = "manager";
      primaryManager.managerId = primaryManager.agentId;
      primaryManager.archetypeId = MANAGER_ARCHETYPE_ID;
      primaryManager.status = "idle";
      primaryManager.sessionFile = join(this.config.paths.sessionsDir, `${primaryManager.agentId}.jsonl`);
      primaryManager.updatedAt = now;

      if (!primaryManager.cwd) {
        primaryManager.cwd = this.config.defaultCwd;
      }

      primaryManager.model = this.normalizePersistedModelDescriptor(primaryManager.model);
    }

    const liveManagerIds = new Set(
      Array.from(this.descriptors.values())
        .filter((descriptor) => descriptor.role === "manager" && descriptor.status !== "terminated")
        .map((descriptor) => descriptor.agentId)
    );

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (!liveManagerIds.has(descriptor.managerId)) {
        descriptor.managerId = this.config.managerId;
        descriptor.updatedAt = now;
      }
    }

    this.pendingUserRepliesByManagerId.clear();
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role === "manager" && descriptor.status !== "terminated") {
        this.pendingUserRepliesByManagerId.set(descriptor.agentId, 0);
      }
    }
  }

  private getBootLogManagerDescriptor(): AgentDescriptor | undefined {
    const configuredManager = this.descriptors.get(this.config.managerId);
    if (configuredManager && configuredManager.role === "manager" && configuredManager.status !== "terminated") {
      return configuredManager;
    }

    return Array.from(this.descriptors.values()).find(
      (descriptor) => descriptor.role === "manager" && descriptor.status !== "terminated"
    );
  }

  private getRequiredManagerDescriptor(managerId: string): AgentDescriptor {
    const descriptor = this.descriptors.get(managerId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Unknown manager: ${managerId}`);
    }

    return descriptor;
  }

  private resolveDefaultModelDescriptor(): AgentModelDescriptor {
    return resolveModelDescriptorFromPreset(this.defaultModelPreset);
  }

  private normalizePersistedModelDescriptor(
    descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined
  ): AgentModelDescriptor {
    return normalizeSwarmModelDescriptor(descriptor, this.defaultModelPreset);
  }

  private resolveSpawnModel(
    requested: SpawnAgentInput["model"] | undefined,
    fallback: AgentModelDescriptor
  ): AgentModelDescriptor {
    const requestedPreset = parseSwarmModelPreset(requested, "spawn_agent.model");
    if (requestedPreset) {
      return resolveModelDescriptorFromPreset(requestedPreset);
    }

    return this.normalizePersistedModelDescriptor(fallback);
  }

  private resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string
  ): string | undefined {
    if (input.archetypeId !== undefined) {
      const explicit = normalizeArchetypeId(input.archetypeId);
      if (!explicit) {
        throw new Error("spawn_agent archetypeId must include at least one letter or number");
      }
      if (!this.archetypePromptRegistry.resolvePrompt(explicit)) {
        throw new Error(`Unknown archetypeId: ${explicit}`);
      }
      return explicit;
    }

    if (
      normalizedAgentId === MERGER_ARCHETYPE_ID ||
      normalizedAgentId.startsWith(`${MERGER_ARCHETYPE_ID}-`)
    ) {
      return MERGER_ARCHETYPE_ID;
    }

    return undefined;
  }

  private resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return this.resolveRequiredArchetypePrompt(MANAGER_ARCHETYPE_ID);
    }

    if (descriptor.archetypeId) {
      const archetypePrompt = this.archetypePromptRegistry.resolvePrompt(descriptor.archetypeId);
      if (archetypePrompt) {
        return archetypePrompt;
      }
    }

    return DEFAULT_WORKER_SYSTEM_PROMPT;
  }

  private resolveRequiredArchetypePrompt(archetypeId: string): string {
    const prompt = this.archetypePromptRegistry.resolvePrompt(archetypeId);
    if (!prompt) {
      throw new Error(`Missing archetype prompt: ${archetypeId}`);
    }
    return prompt;
  }

  private async resolveAndValidateCwd(cwd: string): Promise<string> {
    return validateDirectoryPath(cwd, this.getCwdPolicy());
  }

  private getCwdPolicy(): { rootDir: string; allowlistRoots: string[] } {
    return {
      rootDir: this.config.paths.rootDir,
      allowlistRoots: normalizeAllowlistRoots(this.config.cwdAllowlistRoots)
    };
  }

  private generateUniqueAgentId(source: string): string {
    const base = normalizeAgentId(source);

    if (!base) {
      throw new Error("spawn_agent agentId must include at least one letter or number");
    }

    if (base === this.config.managerId) {
      throw new Error(`spawn_agent agentId \"${this.config.managerId}\" is reserved`);
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private generateUniqueManagerId(source: string): string {
    const base = normalizeAgentId(source);
    if (!base) {
      throw new Error("create_manager name must include at least one letter or number");
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private assertManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Only manager can ${action}`);
    }

    if (descriptor.status === "terminated" || descriptor.status === "stopped_on_restart") {
      throw new Error(`Manager is not running: ${agentId}`);
    }

    return descriptor;
  }

  private hasRunningManagers(): boolean {
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      if (descriptor.status === "terminated" || descriptor.status === "stopped_on_restart") {
        continue;
      }

      return true;
    }

    return false;
  }

  private getPendingUserReplies(managerId: string): number {
    return this.pendingUserRepliesByManagerId.get(managerId) ?? 0;
  }

  private incrementPendingUserReplies(managerId: string): void {
    this.pendingUserRepliesByManagerId.set(managerId, this.getPendingUserReplies(managerId) + 1);
  }

  private decrementPendingUserReplies(managerId: string): void {
    const current = this.getPendingUserReplies(managerId);
    if (current <= 0) {
      this.pendingUserRepliesByManagerId.set(managerId, 0);
      return;
    }

    this.pendingUserRepliesByManagerId.set(managerId, current - 1);
  }

  private parseResetManagerSessionArgs(
    managerIdOrReason: string | "user_new_command" | "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): { managerId: string; reason: "user_new_command" | "api_reset" } {
    if (managerIdOrReason === "user_new_command" || managerIdOrReason === "api_reset") {
      return {
        managerId: this.config.managerId,
        reason: managerIdOrReason
      };
    }

    return {
      managerId: managerIdOrReason,
      reason: maybeReason ?? "api_reset"
    };
  }

  private async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    const runtime = this.runtimes.get(descriptor.agentId);
    if (runtime) {
      await runtime.terminate({ abort: options.abort });
      this.runtimes.delete(descriptor.agentId);
    }

    descriptor.status = "terminated";
    descriptor.updatedAt = this.now();
    this.descriptors.set(descriptor.agentId, descriptor);

    if (options.emitStatus) {
      this.emitStatus(descriptor.agentId, descriptor.status, 0);
    }
  }

  protected async getMemoryRuntimeResources(): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }> {
    await this.ensureMemoryFile();

    const memoryContextFile = {
      path: this.config.paths.memoryFile,
      content: await readFile(this.config.paths.memoryFile, "utf8")
    };

    return {
      memoryContextFile,
      additionalSkillPaths: [this.resolveMemorySkillPath(), this.resolveBraveSearchSkillPath()]
    };
  }

  private resolveMemorySkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "memory",
      repoOverridePath: this.config.paths.repoMemorySkillFile,
      repositoryRelativePath: BUILT_IN_MEMORY_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_MEMORY_SKILL_FALLBACK_PATH
    });
  }

  private resolveBraveSearchSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "brave-search",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_BRAVE_SEARCH_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_BRAVE_SEARCH_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_BRAVE_SEARCH_SKILL_FALLBACK_PATH
    });
  }

  private resolveBuiltInSkillPath(options: {
    skillName: string;
    repoOverridePath: string;
    repositoryRelativePath: string;
    fallbackPath: string;
  }): string {
    const { skillName, repoOverridePath, repositoryRelativePath, fallbackPath } = options;

    if (existsSync(repoOverridePath)) {
      return repoOverridePath;
    }

    const candidatePaths = [resolve(this.config.paths.rootDir, repositoryRelativePath), fallbackPath];

    for (const candidatePath of candidatePaths) {
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    throw new Error(`Missing built-in ${skillName} skill file: ${candidatePaths[0]}`);
  }

  protected async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    const contextFiles: Array<{ path: string; content: string }> = [];
    const seenPaths = new Set<string>();
    const rootDir = resolve("/");
    let currentDir = resolve(cwd);

    while (true) {
      const candidatePath = join(currentDir, SWARM_CONTEXT_FILE_NAME);
      if (!seenPaths.has(candidatePath) && existsSync(candidatePath)) {
        try {
          contextFiles.unshift({
            path: candidatePath,
            content: await readFile(candidatePath, "utf8")
          });
          seenPaths.add(candidatePath);
        } catch (error) {
          this.logDebug("runtime:swarm_context:read:error", {
            cwd,
            path: candidatePath,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (currentDir === rootDir) {
        break;
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return contextFiles;
  }

  private mergeRuntimeContextFiles(
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): Array<{ path: string; content: string }> {
    const swarmContextPaths = new Set(options.swarmContextFiles.map((entry) => entry.path));
    const withoutSwarmAndMemory = baseAgentsFiles.filter(
      (entry) => entry.path !== options.memoryContextFile.path && !swarmContextPaths.has(entry.path)
    );

    return [...withoutSwarmAndMemory, ...options.swarmContextFiles, options.memoryContextFile];
  }

  protected async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<AgentRuntime> {
    const swarmTools = buildSwarmTools(this, descriptor);
    const thinkingLevel = normalizeThinkingLevel(descriptor.model.thinkingLevel);
    const runtimeAgentDir =
      descriptor.role === "manager" ? this.config.paths.managerAgentDir : this.config.paths.agentDir;

    this.logDebug("runtime:create:start", {
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd,
      authFile: this.config.paths.authFile,
      agentDir: runtimeAgentDir,
      memoryFile: this.config.paths.memoryFile,
      managerSystemPromptSource:
        descriptor.role === "manager" ? `archetype:${MANAGER_ARCHETYPE_ID}` : undefined
    });

    const authStorage = AuthStorage.create(this.config.paths.authFile);
    const modelRegistry = new ModelRegistry(authStorage);
    const memoryResources = await this.getMemoryRuntimeResources();
    const swarmContextFiles = await this.getSwarmContextFiles(descriptor.cwd);
    const applyRuntimeContext = (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
      agentsFiles: this.mergeRuntimeContextFiles(base.agentsFiles, {
        memoryContextFile: memoryResources.memoryContextFile,
        swarmContextFiles
      })
    });

    const resourceLoader =
      descriptor.role === "manager"
        ? new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalSkillPaths: memoryResources.additionalSkillPaths,
            agentsFilesOverride: applyRuntimeContext,
            // Manager prompt comes from the archetype prompt registry.
            systemPrompt,
            appendSystemPromptOverride: () => []
          })
        : new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalSkillPaths: memoryResources.additionalSkillPaths,
            agentsFilesOverride: applyRuntimeContext,
            appendSystemPromptOverride: (base) => [...base, systemPrompt]
          });
    await resourceLoader.reload();

    const model = this.resolveModel(modelRegistry, descriptor.model);
    if (!model) {
      throw new Error(
        `Unable to resolve model ${descriptor.model.provider}/${descriptor.model.modelId}. ` +
          "Set SWARM_MODEL_PROVIDER/SWARM_MODEL_ID or install a model supported by @mariozechner/pi-ai."
      );
    }

    const { session } = await createAgentSession({
      cwd: descriptor.cwd,
      agentDir: runtimeAgentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: thinkingLevel as any,
      sessionManager: SessionManager.open(descriptor.sessionFile),
      resourceLoader,
      customTools: swarmTools
    });

    const activeToolNames = new Set(session.getActiveToolNames());
    for (const tool of swarmTools) {
      activeToolNames.add(tool.name);
    }
    session.setActiveToolsByName(Array.from(activeToolNames));

    this.logDebug("runtime:create:ready", {
      agentId: descriptor.agentId,
      activeTools: session.getActiveToolNames(),
      systemPromptPreview: previewForLog(session.systemPrompt, 240),
      containsSpeakToUserRule:
        descriptor.role === "manager" ? session.systemPrompt.includes("speak_to_user") : undefined
    });

    return new AgentRuntime({
      descriptor,
      session: session as AgentSession,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount) => {
          await this.handleRuntimeStatus(agentId, status, pendingCount);
        },
        onSessionEvent: async (agentId, event) => {
          await this.handleRuntimeSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.handleRuntimeAgentEnd(agentId);
        }
      },
      now: this.now
    });
  }

  private resolveModel(modelRegistry: ModelRegistry, descriptor: AgentModelDescriptor): Model<any> | undefined {
    const direct = modelRegistry.find(descriptor.provider, descriptor.modelId);
    if (direct) return direct;

    const fromCatalog = getModel(descriptor.provider as any, descriptor.modelId as any);
    if (fromCatalog) return fromCatalog;

    return modelRegistry.getAll()[0];
  }

  private async handleRuntimeStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number
  ): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) return;

    if (descriptor.status !== status) {
      descriptor.status = status;
      descriptor.updatedAt = this.now();
      this.descriptors.set(agentId, descriptor);
      await this.saveStore();
    }

    this.emitStatus(agentId, status, pendingCount);
    this.logDebug("runtime:status", {
      agentId,
      status,
      pendingCount
    });
  }

  private async handleRuntimeSessionEvent(agentId: string, event: AgentSessionEvent): Promise<void> {
    this.captureConversationEventFromRuntime(agentId, event);

    if (!this.config.debug) return;

    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    switch (event.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
        this.logDebug(`manager:event:${event.type}`);
        return;

      case "turn_end":
        this.logDebug("manager:event:turn_end", {
          toolResults: event.toolResults.length
        });
        return;

      case "tool_execution_start":
        this.logDebug("manager:tool:start", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: previewForLog(safeJson(event.args), 240)
        });
        return;

      case "tool_execution_end":
        this.logDebug("manager:tool:end", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: previewForLog(safeJson(event.result), 240)
        });
        return;

      case "message_start":
      case "message_end":
        this.logDebug(`manager:event:${event.type}`, {
          role: extractRole(event.message),
          textPreview: previewForLog(extractMessageText(event.message) ?? "")
        });
        return;

      case "message_update":
      case "tool_execution_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }

  private captureConversationEventFromRuntime(agentId: string, event: AgentSessionEvent): void {
    const descriptor = this.descriptors.get(agentId);
    if (descriptor?.role === "manager") {
      return;
    }

    const timestamp = this.now();

    switch (event.type) {
      case "message_start": {
        const role = extractRole(event.message);
        if (role !== "user" && role !== "assistant" && role !== "system") {
          return;
        }

        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "message_start",
          role,
          text: extractMessageText(event.message) ?? "(non-text message)"
        });
        return;
      }

      case "message_end": {
        const role = extractRole(event.message);
        if (role !== "user" && role !== "assistant" && role !== "system") {
          return;
        }

        const extractedText = extractMessageText(event.message);
        const text = extractedText ?? "(non-text message)";
        const attachments = extractMessageImageAttachments(event.message);

        if ((role === "assistant" || role === "system") && (extractedText || attachments.length > 0)) {
          this.emitConversationMessage({
            type: "conversation_message",
            agentId,
            role,
            text: extractedText ?? "",
            attachments: attachments.length > 0 ? attachments : undefined,
            timestamp,
            source: "system"
          });
        }

        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "message_end",
          role,
          text
        });
        return;
      }

      case "tool_execution_start":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.args)
        });
        return;

      case "tool_execution_update":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_update",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.partialResult)
        });
        return;

      case "tool_execution_end":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.result),
          isError: event.isError
        });
        return;

      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }


  private emitStatus(agentId: string, status: AgentStatus, pendingCount: number): void {
    const payload: AgentStatusEvent = {
      type: "agent_status",
      agentId,
      status,
      pendingCount
    };

    this.emit("agent_status", payload satisfies ServerEvent);
  }

  private emitAgentsSnapshot(): void {
    const payload: AgentsSnapshotEvent = {
      type: "agents_snapshot",
      agents: this.listAgents()
    };

    this.emit("agents_snapshot", payload satisfies ServerEvent);
  }

  private async handleRuntimeAgentEnd(agentId: string): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    const pending = this.getPendingUserReplies(agentId);
    if (pending <= 0) {
      return;
    }

    this.pendingUserRepliesByManagerId.set(agentId, 0);

    this.logDebug("manager:missing_speak_to_user", {
      agentId,
      pending
    });

    await this.publishToUser(
      agentId,
      `Manager finished without speak_to_user for ${pending} pending user message(s).`,
      "system"
    );
  }

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.config.paths.dataDir,
      this.config.paths.swarmDir,
      this.config.paths.sessionsDir,
      this.config.paths.authDir,
      this.config.paths.agentDir,
      this.config.paths.managerAgentDir
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  private async ensureMemoryFile(): Promise<void> {
    try {
      await readFile(this.config.paths.memoryFile, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await writeFile(this.config.paths.memoryFile, DEFAULT_MEMORY_FILE_CONTENT, "utf8");
  }

  private async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    try {
      await unlink(sessionFile);
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async loadStore(): Promise<AgentsStoreFile> {
    try {
      const raw = await readFile(this.config.paths.agentsStoreFile, "utf8");
      const parsed = JSON.parse(raw) as AgentsStoreFile;
      if (!Array.isArray(parsed.agents)) {
        return { agents: [] };
      }
      return {
        agents: parsed.agents
      };
    } catch {
      return { agents: [] };
    }
  }

  private loadConversationHistoriesFromStore(): void {
    this.conversationEntriesByAgentId.clear();

    for (const descriptor of this.descriptors.values()) {
      this.loadConversationHistoryForDescriptor(descriptor);
    }
  }

  private loadConversationHistoryForDescriptor(descriptor: AgentDescriptor): void {
    const entriesForAgent: ConversationEntryEvent[] = [];

    try {
      const sessionManager = SessionManager.open(descriptor.sessionFile);
      const entries = sessionManager.getEntries();

      for (const entry of entries) {
        if (entry.type !== "custom") {
          continue;
        }

        if (
          entry.customType !== CONVERSATION_ENTRY_TYPE &&
          entry.customType !== LEGACY_CONVERSATION_ENTRY_TYPE
        ) {
          continue;
        }
        if (!isConversationEntryEvent(entry.data)) {
          continue;
        }
        entriesForAgent.push(entry.data);
      }

      if (entriesForAgent.length > MAX_CONVERSATION_HISTORY) {
        entriesForAgent.splice(0, entriesForAgent.length - MAX_CONVERSATION_HISTORY);
      }

      this.logDebug("history:load:ready", {
        agentId: descriptor.agentId,
        messageCount: entriesForAgent.length
      });
    } catch (error) {
      this.logDebug("history:load:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    this.conversationEntriesByAgentId.set(descriptor.agentId, entriesForAgent);
  }

  private async saveStore(): Promise<void> {
    const payload: AgentsStoreFile = {
      agents: this.sortedDescriptors()
    };

    const target = this.config.paths.agentsStoreFile;
    const tmp = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function normalizeAgentId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const maybeRole = (message as { role?: unknown }).role;
  return typeof maybeRole === "string" ? maybeRole : undefined;
}

function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const maybeText = item as { type?: unknown; text?: unknown };
      return maybeText.type === "text" && typeof maybeText.text === "string" ? maybeText.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
}

function extractMessageImageAttachments(message: unknown): ConversationImageAttachment[] {
  if (!message || typeof message !== "object") {
    return [];
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const attachments: ConversationImageAttachment[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const maybeImage = item as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (maybeImage.type !== "image") {
      continue;
    }

    if (typeof maybeImage.mimeType !== "string" || !maybeImage.mimeType.startsWith("image/")) {
      continue;
    }

    if (typeof maybeImage.data !== "string" || maybeImage.data.length === 0) {
      continue;
    }

    attachments.push({
      mimeType: maybeImage.mimeType,
      data: maybeImage.data
    });
  }

  return attachments;
}

function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: ConversationAttachment[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName.trim() : "";

    if (attachment.type === "text") {
      const text = typeof attachment.text === "string" ? attachment.text : "";
      if (!mimeType || text.trim().length === 0) {
        continue;
      }

      normalized.push({
        type: "text",
        mimeType,
        text,
        fileName: fileName || undefined
      });
      continue;
    }

    if (attachment.type === "binary") {
      const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
      if (!mimeType || data.length === 0) {
        continue;
      }

      normalized.push({
        type: "binary",
        mimeType,
        data,
        fileName: fileName || undefined
      });
      continue;
    }

    const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined
    });
  }

  return normalized;
}

function toRuntimeImageAttachments(attachments: ConversationAttachment[]): RuntimeImageAttachment[] {
  const images: RuntimeImageAttachment[] = [];

  for (const attachment of attachments) {
    if (!isConversationImageAttachment(attachment)) {
      continue;
    }

    images.push({
      mimeType: attachment.mimeType,
      data: attachment.data
    });
  }

  return images;
}

function formatTextAttachmentForPrompt(attachment: ConversationTextAttachment, index: number): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.txt`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    "Content:",
    "----- BEGIN FILE -----",
    attachment.text,
    "----- END FILE -----"
  ].join("\n");
}

function formatBinaryAttachmentForPrompt(
  attachment: ConversationBinaryAttachment,
  storedPath: string,
  index: number
): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.bin`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    `Saved to: ${storedPath}`,
    "Use read/bash tools to inspect the file directly from disk."
  ].join("\n");
}

function sanitizeAttachmentFileName(fileName: string | undefined, fallback: string): string {
  const fallbackName = fallback.trim() || "attachment.bin";
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";

  if (!trimmed) {
    return fallbackName;
  }

  const cleaned = trimmed
    .replace(/[\\/]+/g, "-")
    .replace(/[\0-\x1f\x7f]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned || fallbackName;
}

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return cleaned || fallback;
}

function extractRuntimeMessageText(message: string | RuntimeUserMessage): string {
  if (typeof message === "string") {
    return message;
  }

  return message.text;
}

function normalizeThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}

function isConversationEntryEvent(value: unknown): value is ConversationEntryEvent {
  return isConversationMessageEvent(value) || isConversationLogEvent(value);
}

function isConversationMessageEvent(value: unknown): value is ConversationMessageEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ConversationMessageEvent>;
  if (maybe.type !== "conversation_message") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (maybe.role !== "user" && maybe.role !== "assistant" && maybe.role !== "system") return false;
  if (typeof maybe.text !== "string") return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "user_input" && maybe.source !== "speak_to_user" && maybe.source !== "system") return false;

  if (maybe.attachments !== undefined) {
    if (!Array.isArray(maybe.attachments)) {
      return false;
    }

    for (const attachment of maybe.attachments) {
      if (!isConversationAttachment(attachment)) {
        return false;
      }
    }
  }

  return true;
}

function isConversationAttachment(value: unknown): value is ConversationAttachment {
  return (
    isConversationImageAttachment(value) ||
    isConversationTextAttachment(value) ||
    isConversationBinaryAttachment(value)
  );
}

function isConversationImageAttachment(value: unknown): value is ConversationImageAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationImageAttachment> & { type?: unknown };
  if (maybe.type !== undefined && maybe.type !== "image") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || !maybe.mimeType.startsWith("image/")) {
    return false;
  }

  if (typeof maybe.data !== "string" || maybe.data.length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  return true;
}

function isConversationTextAttachment(value: unknown): value is ConversationTextAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationTextAttachment>;
  if (maybe.type !== "text") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (typeof maybe.text !== "string" || maybe.text.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  return true;
}

function isConversationBinaryAttachment(value: unknown): value is ConversationBinaryAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationBinaryAttachment>;
  if (maybe.type !== "binary") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  return true;
}

function isConversationLogEvent(value: unknown): value is ConversationLogEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ConversationLogEvent>;
  if (maybe.type !== "conversation_log") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "runtime_log") return false;

  if (
    maybe.kind !== "message_start" &&
    maybe.kind !== "message_end" &&
    maybe.kind !== "tool_execution_start" &&
    maybe.kind !== "tool_execution_update" &&
    maybe.kind !== "tool_execution_end"
  ) {
    return false;
  }

  if (maybe.role !== undefined && maybe.role !== "user" && maybe.role !== "assistant" && maybe.role !== "system") {
    return false;
  }

  if (maybe.toolName !== undefined && typeof maybe.toolName !== "string") return false;
  if (maybe.toolCallId !== undefined && typeof maybe.toolCallId !== "string") return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.isError !== undefined && typeof maybe.isError !== "boolean") return false;

  return true;
}
