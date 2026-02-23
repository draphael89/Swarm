import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
  type AuthCredential
} from "@mariozechner/pi-coding-agent";
import type { ServerEvent } from "../protocol/ws-types.js";
import {
  loadArchetypePromptRegistry,
  normalizeArchetypeId,
  type ArchetypePromptRegistry
} from "./archetypes/archetype-prompt-registry.js";
import { AgentRuntime } from "./agent-runtime.js";
import { CodexAgentRuntime } from "./codex-agent-runtime.js";
import {
  getAgentMemoryPath as getAgentMemoryPathForDataDir,
  getLegacyMemoryPath,
  getMemoryMigrationMarkerPath
} from "./memory-paths.js";
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
import type {
  RuntimeImageAttachment,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  SwarmAgentRuntime
} from "./runtime-types.js";
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
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SettingsAuthProvider,
  SettingsAuthProviderName,
  SkillEnvRequirement,
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
- Persistent memory for this runtime is at \${SWARM_MEMORY_FILE} and is auto-loaded into context.
- Workers read their owning manager's memory file.
- Only write memory when explicitly asked to remember/update/forget durable information.
- Follow the memory skill workflow before editing the memory file, and never store secrets in memory.`;
const MANAGER_ARCHETYPE_ID = "manager";
const MERGER_ARCHETYPE_ID = "merger";
const INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: ";
const BOOT_WAKEUP_MESSAGE =
  "Swarm rebooted. You have been restarted. Check on any in-progress workers and resume any interrupted tasks. Use list_agents to see current agent states.";
const MAX_CONVERSATION_HISTORY = 2000;
const CONVERSATION_ENTRY_TYPE = "swarm_conversation_entry";
const LEGACY_CONVERSATION_ENTRY_TYPE = "swarm_conversation_message";
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const REPO_BRAVE_SEARCH_SKILL_RELATIVE_PATH = ".swarm/skills/brave-search/SKILL.md";
const REPO_CRON_SCHEDULING_SKILL_RELATIVE_PATH = ".swarm/skills/cron-scheduling/SKILL.md";
const REPO_AGENT_BROWSER_SKILL_RELATIVE_PATH = ".swarm/skills/agent-browser/SKILL.md";
const REPO_IMAGE_GENERATION_SKILL_RELATIVE_PATH = ".swarm/skills/image-generation/SKILL.md";
const REPO_GSUITE_SKILL_RELATIVE_PATH = ".swarm/skills/gsuite/SKILL.md";
const BUILT_IN_MEMORY_SKILL_RELATIVE_PATH = "apps/backend/src/swarm/skills/builtins/memory/SKILL.md";
const BUILT_IN_BRAVE_SEARCH_SKILL_RELATIVE_PATH =
  "apps/backend/src/swarm/skills/builtins/brave-search/SKILL.md";
const BUILT_IN_CRON_SCHEDULING_SKILL_RELATIVE_PATH =
  "apps/backend/src/swarm/skills/builtins/cron-scheduling/SKILL.md";
const BUILT_IN_AGENT_BROWSER_SKILL_RELATIVE_PATH =
  "apps/backend/src/swarm/skills/builtins/agent-browser/SKILL.md";
const BUILT_IN_IMAGE_GENERATION_SKILL_RELATIVE_PATH =
  "apps/backend/src/swarm/skills/builtins/image-generation/SKILL.md";
const BUILT_IN_GSUITE_SKILL_RELATIVE_PATH = "apps/backend/src/swarm/skills/builtins/gsuite/SKILL.md";
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
const BUILT_IN_CRON_SCHEDULING_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "cron-scheduling",
  "SKILL.md"
);
const BUILT_IN_AGENT_BROWSER_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "agent-browser",
  "SKILL.md"
);
const BUILT_IN_IMAGE_GENERATION_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "image-generation",
  "SKILL.md"
);
const BUILT_IN_GSUITE_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "gsuite",
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
const MEMORY_MIGRATION_MARKER_CONTENT = "per-agent-memory-migration-complete\n";
const SKILL_FRONTMATTER_BLOCK_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const SETTINGS_ENV_MASK = "********";
const SETTINGS_AUTH_MASK = "********";
const VALID_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETTINGS_AUTH_PROVIDER_DEFINITIONS: Array<{
  provider: SettingsAuthProviderName;
  storageProvider: string;
  aliases: string[];
}> = [
  {
    provider: "anthropic",
    storageProvider: "anthropic",
    aliases: ["anthropic"]
  },
  {
    provider: "openai",
    storageProvider: "openai-codex",
    aliases: ["openai", "openai-codex"]
  }
];

interface ParsedSkillEnvDeclaration {
  name: string;
  description?: string;
  required: boolean;
  helpUrl?: string;
}

interface SkillMetadata {
  skillName: string;
  path: string;
  env: ParsedSkillEnvDeclaration[];
}

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
  private readonly runtimes = new Map<string, SwarmAgentRuntime>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly originalProcessEnvByName = new Map<string, string | undefined>();
  private skillMetadata: SkillMetadata[] = [];
  private secrets: Record<string, string> = {};

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
    await this.loadSecretsStore();
    await this.reloadSkillMetadata();

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
    const wakeupManagerIds = this.collectBootWakeupManagerIds(loaded.agents);
    for (const descriptor of loaded.agents) {
      this.descriptors.set(descriptor.agentId, descriptor);
    }

    this.prepareDescriptorsForBoot();
    await this.ensureMemoryFilesForBoot();
    await this.saveStore();

    this.loadConversationHistoriesFromStore();
    await this.restoreRuntimesForBoot();

    const managerDescriptor = this.getBootLogManagerDescriptor();
    this.emitAgentsSnapshot();
    await this.sendBootWakeupMessages(wakeupManagerIds);

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

    let runtime: SwarmAgentRuntime;
    try {
      runtime = await this.createRuntimeForDescriptor(
        descriptor,
        this.resolveSystemPromptForDescriptor(descriptor)
      );
    } catch (error) {
      this.descriptors.delete(descriptor.agentId);
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
    const attachmentPathMessages: string[] = [];
    let binaryAttachmentDir: string | undefined;

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const persistedPath = normalizeOptionalAttachmentPath(attachment.filePath);

      if (persistedPath) {
        attachmentPathMessages.push(`[Attached file saved to: ${persistedPath}]`);
      }

      if (isConversationImageAttachment(attachment)) {
        continue;
      }

      if (isConversationTextAttachment(attachment)) {
        fileMessages.push(formatTextAttachmentForPrompt(attachment, index + 1));
        continue;
      }

      if (isConversationBinaryAttachment(attachment)) {
        let storedPath = persistedPath;
        if (!storedPath) {
          const directory = binaryAttachmentDir ?? (await this.createBinaryAttachmentDir(targetAgentId));
          binaryAttachmentDir = directory;
          storedPath = await this.writeBinaryAttachmentToDisk(directory, attachment, index + 1);
        }
        fileMessages.push(formatBinaryAttachmentForPrompt(attachment, storedPath, index + 1));
      }
    }

    if (fileMessages.length === 0 && attachmentPathMessages.length === 0) {
      return {
        images,
        attachmentMessage: ""
      };
    }

    const attachmentMessageSections: string[] = [];
    if (fileMessages.length > 0) {
      attachmentMessageSections.push("The user attached the following files:", "", ...fileMessages);
    }
    if (attachmentPathMessages.length > 0) {
      if (attachmentMessageSections.length > 0) {
        attachmentMessageSections.push("");
      }
      attachmentMessageSections.push(...attachmentPathMessages);
    }

    return {
      images,
      attachmentMessage: attachmentMessageSections.join("\n")
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

  async publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system" = "speak_to_user",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }> {
    let resolvedTargetContext: MessageSourceContext;

    if (source === "speak_to_user") {
      this.assertManager(agentId, "speak to user");
      resolvedTargetContext = this.resolveReplyTargetContext(targetContext);
    } else {
      resolvedTargetContext = normalizeMessageSourceContext(targetContext ?? { channel: "web" });
    }

    const payload: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      role: source === "system" ? "system" : "assistant",
      text,
      timestamp: this.now(),
      source,
      sourceContext: resolvedTargetContext
    };

    this.emitConversationMessage(payload);
    this.logDebug("manager:publish_to_user", {
      source,
      agentId,
      targetContext: resolvedTargetContext,
      textPreview: previewForLog(text)
    });

    return {
      targetContext: resolvedTargetContext
    };
  }

  async compactAgentContext(
    agentId: string,
    options?: {
      customInstructions?: string;
      sourceContext?: MessageSourceContext;
      trigger?: "api" | "slash_command";
    }
  ): Promise<unknown> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }

    if (descriptor.status === "terminated" || descriptor.status === "stopped_on_restart") {
      throw new Error(`Target agent is not running: ${agentId}`);
    }

    if (descriptor.role !== "manager") {
      throw new Error(`Compaction is only supported for manager agents: ${agentId}`);
    }

    const runtime = this.runtimes.get(agentId);
    if (!runtime) {
      throw new Error(`Target runtime is not available: ${agentId}`);
    }

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const customInstructions = options?.customInstructions?.trim() || undefined;

    this.logDebug("manager:compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? "")
    });

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: "Compacting manager context...",
      timestamp: this.now(),
      source: "system",
      sourceContext
    });

    try {
      const result = await runtime.compact(customInstructions);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: "Compaction complete.",
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api"
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: `Compaction failed: ${message}`,
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message
      });

      throw error;
    }
  }

  async handleUserMessage(
    text: string,
    options?: {
      targetAgentId?: string;
      delivery?: RequestedDeliveryMode;
      attachments?: ConversationAttachment[];
      sourceContext?: MessageSourceContext;
    }
  ): Promise<void> {
    const trimmed = text.trim();
    const attachments = normalizeConversationAttachments(options?.attachments);
    if (!trimmed && attachments.length === 0) return;

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });

    const targetAgentId = options?.targetAgentId ?? this.config.managerId;
    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (target.status === "terminated" || target.status === "stopped_on_restart") {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    const compactCommand =
      target.role === "manager" && attachments.length === 0 ? parseCompactSlashCommand(trimmed) : undefined;
    if (compactCommand) {
      await this.compactAgentContext(target.agentId, {
        customInstructions: compactCommand.customInstructions,
        sourceContext,
        trigger: "slash_command"
      });
      return;
    }

    const managerContextId = target.role === "manager" ? target.agentId : target.managerId;
    const receivedAt = this.now();

    this.logDebug("manager:user_message_received", {
      targetAgentId,
      managerContextId,
      sourceContext,
      textPreview: previewForLog(trimmed),
      attachmentCount: attachments.length
    });

    const userEvent: ConversationMessageEvent = {
      type: "conversation_message",
      agentId: targetAgentId,
      role: "user",
      text: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: receivedAt,
      source: "user_input",
      sourceContext
    };
    this.emitConversationMessage(userEvent);

    if (target.role !== "manager") {
      await this.sendMessage(managerContextId, targetAgentId, trimmed, options?.delivery ?? "auto", {
        origin: "user",
        attachments
      });
      return;
    }

    const managerRuntime = this.runtimes.get(managerContextId);
    if (!managerRuntime) {
      throw new Error(`Manager runtime is not initialized: ${managerContextId}`);
    }

    const managerVisibleMessage = formatInboundUserMessageForManager(trimmed, sourceContext);

    // User messages to managers should always steer in-flight work.
    const runtimeMessage = await this.prepareModelInboundMessage(
      managerContextId,
      {
        text: managerVisibleMessage,
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

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    if (this.skillMetadata.length === 0) {
      await this.reloadSkillMetadata();
    }

    const requirements: SkillEnvRequirement[] = [];

    for (const skill of this.skillMetadata) {
      for (const declaration of skill.env) {
        const resolvedValue = this.resolveEnvValue(declaration.name);
        requirements.push({
          name: declaration.name,
          description: declaration.description,
          required: declaration.required,
          helpUrl: declaration.helpUrl,
          skillName: skill.skillName,
          isSet: typeof resolvedValue === "string" && resolvedValue.trim().length > 0,
          maskedValue: resolvedValue ? SETTINGS_ENV_MASK : undefined
        });
      }
    }

    if (!requirements.some((requirement) => requirement.name === "CODEX_API_KEY")) {
      const codexApiKey = this.resolveEnvValue("CODEX_API_KEY");
      requirements.push({
        name: "CODEX_API_KEY",
        description: "API key used by the codex-app runtime when no existing Codex login session is available.",
        required: false,
        helpUrl: "https://platform.openai.com/api-keys",
        skillName: "codex-app-runtime",
        isSet: typeof codexApiKey === "string" && codexApiKey.trim().length > 0,
        maskedValue: codexApiKey ? SETTINGS_ENV_MASK : undefined
      });
    }

    requirements.sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      if (byName !== 0) return byName;
      return left.skillName.localeCompare(right.skillName);
    });

    return requirements;
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    for (const [rawName, rawValue] of entries) {
      const normalizedName = normalizeEnvVarName(rawName);
      if (!normalizedName) {
        throw new Error(`Invalid environment variable name: ${rawName}`);
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Environment variable ${normalizedName} must be a non-empty string`);
      }

      this.secrets[normalizedName] = normalizedValue;
      this.applySecretToProcessEnv(normalizedName, normalizedValue);
    }

    await this.saveSecretsStore();
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    const normalizedName = normalizeEnvVarName(name);
    if (!normalizedName) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }

    if (!(normalizedName in this.secrets)) {
      return;
    }

    delete this.secrets[normalizedName];
    this.restoreProcessEnvForSecret(normalizedName);
    await this.saveSecretsStore();
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    const authStorage = AuthStorage.create(this.config.paths.authFile);

    return SETTINGS_AUTH_PROVIDER_DEFINITIONS.map((definition) => {
      const credential = authStorage.get(definition.storageProvider);
      const resolvedToken = extractAuthCredentialToken(credential);

      return {
        provider: definition.provider,
        configured: typeof resolvedToken === "string" && resolvedToken.length > 0,
        authType: resolveAuthCredentialType(credential),
        maskedValue: resolvedToken ? maskSettingsAuthValue(resolvedToken) : undefined
      } satisfies SettingsAuthProvider;
    });
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    const authStorage = AuthStorage.create(this.config.paths.authFile);

    for (const [rawProvider, rawValue] of entries) {
      const resolvedProvider = resolveSettingsAuthProvider(rawProvider);
      if (!resolvedProvider) {
        throw new Error(`Invalid auth provider: ${rawProvider}`);
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Auth value for ${resolvedProvider.provider} must be a non-empty string`);
      }

      const credential = {
        type: "api_key",
        key: normalizedValue,
        access: normalizedValue,
        refresh: "",
        expires: ""
      };

      authStorage.set(resolvedProvider.storageProvider, credential as unknown as AuthCredential);
    }
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    const resolvedProvider = resolveSettingsAuthProvider(provider);
    if (!resolvedProvider) {
      throw new Error(`Invalid auth provider: ${provider}`);
    }

    const authStorage = AuthStorage.create(this.config.paths.authFile);
    authStorage.remove(resolvedProvider.storageProvider);
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

  private collectBootWakeupManagerIds(loadedAgents: AgentDescriptor[]): string[] {
    if (loadedAgents.length === 0) {
      return [];
    }

    const restoredManagerIds = new Set(
      loadedAgents
        .filter(
          (descriptor) =>
            descriptor.role === "manager" &&
            descriptor.status !== "terminated" &&
            descriptor.status !== "stopped_on_restart"
        )
        .map((descriptor) => descriptor.agentId)
    );

    if (restoredManagerIds.size === 0) {
      return [];
    }

    const managerIdsWithActiveWorkers = new Set<string>();

    for (const descriptor of loadedAgents) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (descriptor.status === "terminated" || descriptor.status === "stopped_on_restart") {
        continue;
      }

      if (!restoredManagerIds.has(descriptor.managerId)) {
        continue;
      }

      managerIdsWithActiveWorkers.add(descriptor.managerId);
    }

    return Array.from(managerIdsWithActiveWorkers).sort((left, right) => left.localeCompare(right));
  }

  private async sendBootWakeupMessages(managerIds: string[]): Promise<void> {
    for (const managerId of managerIds) {
      const manager = this.descriptors.get(managerId);
      if (!manager || manager.role !== "manager") {
        continue;
      }

      if (manager.status === "terminated" || manager.status === "stopped_on_restart") {
        continue;
      }

      if (!this.runtimes.has(managerId)) {
        continue;
      }

      try {
        await this.sendMessage(managerId, managerId, BOOT_WAKEUP_MESSAGE, "auto", { origin: "internal" });
        this.logDebug("boot:wakeup_message:sent", { managerId });
      } catch (error) {
        this.logDebug("boot:wakeup_message:error", {
          managerId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
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

    const primaryManager = this.descriptors.get(this.config.managerId);
    if (primaryManager) {
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
    const fallbackManagerId = liveManagerIds.has(this.config.managerId)
      ? this.config.managerId
      : liveManagerIds.values().next().value;

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (fallbackManagerId && !liveManagerIds.has(descriptor.managerId)) {
        descriptor.managerId = fallbackManagerId;
        descriptor.updatedAt = now;
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

  private resolveReplyTargetContext(explicitTargetContext?: MessageTargetContext): MessageSourceContext {
    if (!explicitTargetContext) {
      return { channel: "web" };
    }

    const normalizedExplicitTarget = normalizeMessageTargetContext(explicitTargetContext);

    if (
      (normalizedExplicitTarget.channel === "slack" ||
        normalizedExplicitTarget.channel === "telegram") &&
      !normalizedExplicitTarget.channelId
    ) {
      throw new Error(
        'speak_to_user target.channelId is required when target.channel is "slack" or "telegram"'
      );
    }

    return normalizeMessageSourceContext(normalizedExplicitTarget);
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

  protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }> {
    await this.ensureAgentMemoryFile(descriptor.agentId);

    const memoryOwnerAgentId = this.resolveMemoryOwnerAgentId(descriptor);
    const memoryFilePath = this.getAgentMemoryPath(memoryOwnerAgentId);
    await this.ensureAgentMemoryFile(memoryOwnerAgentId);

    if (this.skillMetadata.length === 0) {
      await this.reloadSkillMetadata();
    }

    const memoryContextFile = {
      path: memoryFilePath,
      content: await readFile(memoryFilePath, "utf8")
    };

    return {
      memoryContextFile,
      additionalSkillPaths: this.skillMetadata.map((skill) => skill.path)
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

  private resolveCronSchedulingSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "cron-scheduling",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_CRON_SCHEDULING_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_CRON_SCHEDULING_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_CRON_SCHEDULING_SKILL_FALLBACK_PATH
    });
  }

  private resolveAgentBrowserSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "agent-browser",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_AGENT_BROWSER_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_AGENT_BROWSER_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_AGENT_BROWSER_SKILL_FALLBACK_PATH
    });
  }

  private resolveImageGenerationSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "image-generation",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_IMAGE_GENERATION_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_IMAGE_GENERATION_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_IMAGE_GENERATION_SKILL_FALLBACK_PATH
    });
  }

  private resolveGsuiteSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "gsuite",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_GSUITE_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_GSUITE_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_GSUITE_SKILL_FALLBACK_PATH
    });
  }

  private async reloadSkillMetadata(): Promise<void> {
    const skillPaths = [
      {
        fallbackSkillName: "memory",
        path: this.resolveMemorySkillPath()
      },
      {
        fallbackSkillName: "brave-search",
        path: this.resolveBraveSearchSkillPath()
      },
      {
        fallbackSkillName: "cron-scheduling",
        path: this.resolveCronSchedulingSkillPath()
      },
      {
        fallbackSkillName: "agent-browser",
        path: this.resolveAgentBrowserSkillPath()
      },
      {
        fallbackSkillName: "image-generation",
        path: this.resolveImageGenerationSkillPath()
      },
      {
        fallbackSkillName: "gsuite",
        path: this.resolveGsuiteSkillPath()
      }
    ];

    const metadata: SkillMetadata[] = [];

    for (const skillPath of skillPaths) {
      const markdown = await readFile(skillPath.path, "utf8");
      const parsed = parseSkillFrontmatter(markdown);

      metadata.push({
        skillName: parsed.name ?? skillPath.fallbackSkillName,
        path: skillPath.path,
        env: parsed.env
      });
    }

    this.skillMetadata = metadata;
  }

  private resolveEnvValue(name: string): string | undefined {
    const secretValue = this.secrets[name];
    if (typeof secretValue === "string" && secretValue.trim().length > 0) {
      return secretValue;
    }

    const processValue = process.env[name];
    if (typeof processValue !== "string" || processValue.trim().length === 0) {
      return undefined;
    }

    return processValue;
  }

  private async loadSecretsStore(): Promise<void> {
    this.secrets = await this.readSecretsStore();

    for (const [name, value] of Object.entries(this.secrets)) {
      this.applySecretToProcessEnv(name, value);
    }
  }

  private async readSecretsStore(): Promise<Record<string, string>> {
    let raw: string;

    try {
      raw = await readFile(this.config.paths.secretsFile, "utf8");
    } catch (error) {
      if (isEnoentError(error)) {
        return {};
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const normalized: Record<string, string> = {};

    for (const [rawName, rawValue] of Object.entries(parsed)) {
      const normalizedName = normalizeEnvVarName(rawName);
      if (!normalizedName) {
        continue;
      }

      if (typeof rawValue !== "string") {
        continue;
      }

      const normalizedValue = rawValue.trim();
      if (!normalizedValue) {
        continue;
      }

      normalized[normalizedName] = normalizedValue;
    }

    return normalized;
  }

  private async saveSecretsStore(): Promise<void> {
    const target = this.config.paths.secretsFile;
    const tmp = `${target}.tmp`;

    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(this.secrets, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  private applySecretToProcessEnv(name: string, value: string): void {
    if (!this.originalProcessEnvByName.has(name)) {
      this.originalProcessEnvByName.set(name, process.env[name]);
    }

    process.env[name] = value;
  }

  private restoreProcessEnvForSecret(name: string): void {
    const original = this.originalProcessEnvByName.get(name);

    if (original === undefined) {
      delete process.env[name];
      return;
    }

    process.env[name] = original;
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
  ): Promise<SwarmAgentRuntime> {
    if (isCodexAppServerModelDescriptor(descriptor.model)) {
      return this.createCodexRuntimeForDescriptor(descriptor, systemPrompt);
    }

    return this.createPiRuntimeForDescriptor(descriptor, systemPrompt);
  }

  private async createPiRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = buildSwarmTools(this, descriptor);
    const thinkingLevel = normalizeThinkingLevel(descriptor.model.thinkingLevel);
    const runtimeAgentDir =
      descriptor.role === "manager" ? this.config.paths.managerAgentDir : this.config.paths.agentDir;
    const memoryResources = await this.getMemoryRuntimeResources(descriptor);

    this.logDebug("runtime:create:start", {
      runtime: "pi",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd,
      authFile: this.config.paths.authFile,
      agentDir: runtimeAgentDir,
      memoryFile: memoryResources.memoryContextFile.path,
      managerSystemPromptSource:
        descriptor.role === "manager" ? `archetype:${MANAGER_ARCHETYPE_ID}` : undefined
    });

    const authStorage = AuthStorage.create(this.config.paths.authFile);
    const modelRegistry = new ModelRegistry(authStorage);
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
      runtime: "pi",
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

  private async createCodexRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = buildSwarmTools(this, descriptor);
    const memoryResources = await this.getMemoryRuntimeResources(descriptor);
    const swarmContextFiles = await this.getSwarmContextFiles(descriptor.cwd);

    const codexSystemPrompt = this.buildCodexRuntimeSystemPrompt(systemPrompt, {
      memoryContextFile: memoryResources.memoryContextFile,
      swarmContextFiles
    });

    this.logDebug("runtime:create:start", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd
    });

    const runtime = await CodexAgentRuntime.create({
      descriptor,
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
      now: this.now,
      systemPrompt: codexSystemPrompt,
      tools: swarmTools,
      runtimeEnv: {
        SWARM_DATA_DIR: this.config.paths.dataDir,
        SWARM_MEMORY_FILE: memoryResources.memoryContextFile.path
      }
    });

    this.logDebug("runtime:create:ready", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      systemPromptPreview: previewForLog(codexSystemPrompt, 240)
    });

    return runtime;
  }

  private buildCodexRuntimeSystemPrompt(
    baseSystemPrompt: string,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): string {
    const sections: string[] = [];

    const trimmedBase = baseSystemPrompt.trim();
    if (trimmedBase.length > 0) {
      sections.push(trimmedBase);
    }

    for (const contextFile of options.swarmContextFiles) {
      const content = contextFile.content.trim();
      if (!content) {
        continue;
      }

      sections.push(
        [
          `Repository swarm policy (${contextFile.path}):`,
          "----- BEGIN SWARM CONTEXT -----",
          content,
          "----- END SWARM CONTEXT -----"
        ].join("\n")
      );
    }

    const memoryContent = options.memoryContextFile.content.trim();
    if (memoryContent) {
      sections.push(
        [
          `Persistent swarm memory (${options.memoryContextFile.path}):`,
          "----- BEGIN SWARM MEMORY -----",
          memoryContent,
          "----- END SWARM MEMORY -----"
        ].join("\n")
      );
    }

    return sections.join("\n\n");
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

  private async handleRuntimeSessionEvent(agentId: string, event: RuntimeSessionEvent): Promise<void> {
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

  private captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void {
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

  private async handleRuntimeAgentEnd(_agentId: string): Promise<void> {
    // No-op: managers now receive all inbound messages with sourceContext metadata
    // and decide whether to respond without pending-reply bookkeeping.
  }

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.config.paths.dataDir,
      this.config.paths.swarmDir,
      this.config.paths.sessionsDir,
      this.config.paths.uploadsDir,
      this.config.paths.authDir,
      this.config.paths.memoryDir,
      this.config.paths.agentDir,
      this.config.paths.managerAgentDir
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  private getAgentMemoryPath(agentId: string): string {
    return getAgentMemoryPathForDataDir(this.config.paths.dataDir, agentId);
  }

  private resolveMemoryOwnerAgentId(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return descriptor.agentId;
    }

    const managerId = descriptor.managerId.trim();
    return managerId.length > 0 ? managerId : this.config.managerId;
  }

  private async ensureMemoryFilesForBoot(): Promise<void> {
    const managerIds = Array.from(
      new Set(
        Array.from(this.descriptors.values())
          .filter((descriptor) => descriptor.role === "manager")
          .map((descriptor) => descriptor.agentId)
      )
    );

    if (managerIds.length === 0) {
      managerIds.push(this.config.managerId);
    }

    await this.migrateLegacyMemoryFileIfNeeded(managerIds);

    const memoryAgentIds = new Set<string>([this.config.managerId, ...managerIds]);
    for (const descriptor of this.descriptors.values()) {
      memoryAgentIds.add(descriptor.agentId);
      if (descriptor.role === "worker") {
        memoryAgentIds.add(this.resolveMemoryOwnerAgentId(descriptor));
      }
    }

    for (const agentId of memoryAgentIds) {
      await this.ensureAgentMemoryFile(agentId);
    }
  }

  private async migrateLegacyMemoryFileIfNeeded(managerIds: string[]): Promise<void> {
    const legacyMemoryFilePath = getLegacyMemoryPath(this.config.paths.dataDir);
    if (!existsSync(legacyMemoryFilePath)) {
      return;
    }

    const migrationMarkerPath = getMemoryMigrationMarkerPath(this.config.paths.dataDir);
    if (existsSync(migrationMarkerPath)) {
      return;
    }

    const existingMemoryFiles = await this.listMemoryMarkdownFiles();
    if (existingMemoryFiles.length > 0) {
      return;
    }

    const memoryContent = await readFile(legacyMemoryFilePath, "utf8");

    for (const managerId of managerIds) {
      const managerMemoryPath = this.getAgentMemoryPath(managerId);
      if (existsSync(managerMemoryPath)) {
        continue;
      }

      await mkdir(dirname(managerMemoryPath), { recursive: true });
      await writeFile(managerMemoryPath, memoryContent, "utf8");
    }

    await writeFile(migrationMarkerPath, MEMORY_MIGRATION_MARKER_CONTENT, "utf8");
  }

  private async listMemoryMarkdownFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.config.paths.memoryDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .map((entry) => entry.name);
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async ensureAgentMemoryFile(agentId: string): Promise<void> {
    const memoryFilePath = this.getAgentMemoryPath(agentId);

    try {
      await readFile(memoryFilePath, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await mkdir(dirname(memoryFilePath), { recursive: true });
    await writeFile(memoryFilePath, DEFAULT_MEMORY_FILE_CONTENT, "utf8");
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

function normalizeEnvVarName(name: string): string | undefined {
  const normalized = name.trim();
  if (!VALID_ENV_NAME_PATTERN.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function resolveSettingsAuthProvider(
  provider: string
): { provider: SettingsAuthProviderName; storageProvider: string } | undefined {
  const normalizedProvider = provider.trim().toLowerCase();

  for (const definition of SETTINGS_AUTH_PROVIDER_DEFINITIONS) {
    if (definition.aliases.includes(normalizedProvider)) {
      return {
        provider: definition.provider,
        storageProvider: definition.storageProvider
      };
    }
  }

  return undefined;
}

function resolveAuthCredentialType(
  credential: AuthCredential | undefined
): SettingsAuthProvider["authType"] | undefined {
  if (!credential) {
    return undefined;
  }

  if (credential.type === "api_key" || credential.type === "oauth") {
    return credential.type;
  }

  return "unknown";
}

function extractAuthCredentialToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object") {
    return undefined;
  }

  if (credential.type === "api_key") {
    const apiKey = normalizeAuthToken((credential as { key?: unknown }).key);
    if (apiKey) {
      return apiKey;
    }
  }

  const accessToken = normalizeAuthToken((credential as { access?: unknown }).access);
  if (accessToken) {
    return accessToken;
  }

  return undefined;
}

function normalizeAuthToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function maskSettingsAuthValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return SETTINGS_AUTH_MASK;
  }

  const suffix = trimmed.slice(-4);
  if (!suffix) {
    return SETTINGS_AUTH_MASK;
  }

  return `${SETTINGS_AUTH_MASK}${suffix}`;
}

function parseSkillFrontmatter(markdown: string): { name?: string; env: ParsedSkillEnvDeclaration[] } {
  const match = SKILL_FRONTMATTER_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return { env: [] };
  }

  const lines = match[1].split(/\r?\n/);
  let skillName: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || countLeadingSpaces(line) > 0) {
      continue;
    }

    const parsed = parseYamlKeyValue(trimmed);
    if (!parsed) {
      continue;
    }

    if (parsed.key === "name") {
      const candidate = parseYamlStringValue(parsed.value);
      if (candidate) {
        skillName = candidate;
      }
      break;
    }
  }

  return {
    name: skillName,
    env: parseSkillEnvDeclarations(lines)
  };
}

function parseSkillEnvDeclarations(lines: string[]): ParsedSkillEnvDeclaration[] {
  const envIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === "env:" || trimmed === "envVars:";
  });
  if (envIndex < 0) {
    return [];
  }

  const envIndent = countLeadingSpaces(lines[envIndex]);
  const declarations: ParsedSkillEnvDeclaration[] = [];
  let current: Partial<ParsedSkillEnvDeclaration> | undefined;

  const flushCurrent = (): void => {
    if (!current) {
      return;
    }

    const normalizedName =
      typeof current.name === "string" ? normalizeEnvVarName(current.name) : undefined;
    if (!normalizedName) {
      current = undefined;
      return;
    }

    declarations.push({
      name: normalizedName,
      description:
        typeof current.description === "string" && current.description.trim().length > 0
          ? current.description.trim()
          : undefined,
      required: current.required === true,
      helpUrl:
        typeof current.helpUrl === "string" && current.helpUrl.trim().length > 0
          ? current.helpUrl.trim()
          : undefined
    });

    current = undefined;
  };

  for (let index = envIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const lineIndent = countLeadingSpaces(line);
    if (lineIndent <= envIndent) {
      break;
    }

    if (trimmed.startsWith("-")) {
      flushCurrent();
      current = {};

      const inline = trimmed.slice(1).trim();
      if (inline.length > 0) {
        const parsedInline = parseYamlKeyValue(inline);
        if (parsedInline) {
          assignSkillEnvField(current, parsedInline.key, parsedInline.value);
        }
      }

      continue;
    }

    if (!current) {
      continue;
    }

    const parsed = parseYamlKeyValue(trimmed);
    if (!parsed) {
      continue;
    }

    assignSkillEnvField(current, parsed.key, parsed.value);
  }

  flushCurrent();

  return declarations;
}

function assignSkillEnvField(target: Partial<ParsedSkillEnvDeclaration>, key: string, value: string): void {
  switch (key) {
    case "name":
      target.name = parseYamlStringValue(value);
      return;

    case "description":
      target.description = parseYamlStringValue(value);
      return;

    case "required": {
      const parsed = parseYamlBooleanValue(value);
      if (parsed !== undefined) {
        target.required = parsed;
      }
      return;
    }

    case "helpUrl":
      target.helpUrl = parseYamlStringValue(value);
      return;

    default:
      return;
  }
}

function parseYamlKeyValue(line: string): { key: string; value: string } | undefined {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const key = line.slice(0, separatorIndex).trim();
  if (!key) {
    return undefined;
  }

  return {
    key,
    value: line.slice(separatorIndex + 1).trim()
  };
}

function parseYamlStringValue(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function parseYamlBooleanValue(value: string): boolean | undefined {
  const normalized = parseYamlStringValue(value).toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "no" || normalized === "off" || normalized === "0") {
    return false;
  }

  return undefined;
}

function countLeadingSpaces(value: string): number {
  const match = /^\s*/.exec(value);
  return match ? match[0].length : 0;
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
    const filePath = typeof attachment.filePath === "string" ? attachment.filePath.trim() : "";

    if (attachment.type === "text") {
      const text = typeof attachment.text === "string" ? attachment.text : "";
      if (!mimeType || text.trim().length === 0) {
        continue;
      }

      normalized.push({
        type: "text",
        mimeType,
        text,
        fileName: fileName || undefined,
        filePath: filePath || undefined
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
        fileName: fileName || undefined,
        filePath: filePath || undefined
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
      fileName: fileName || undefined,
      filePath: filePath || undefined
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

function normalizeOptionalAttachmentPath(path: string | undefined): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }

  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractRuntimeMessageText(message: string | RuntimeUserMessage): string {
  if (typeof message === "string") {
    return message;
  }

  return message.text;
}

function formatInboundUserMessageForManager(text: string, sourceContext: MessageSourceContext): string {
  const sourceMetadataLine = `[sourceContext] ${JSON.stringify(sourceContext)}`;
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return sourceMetadataLine;
  }

  return `${sourceMetadataLine}\n\n${trimmed}`;
}

function parseCompactSlashCommand(text: string): { customInstructions?: string } | undefined {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return undefined;
  }

  const customInstructions = match[1]?.trim();
  if (!customInstructions) {
    return {};
  }

  return {
    customInstructions
  };
}

function normalizeMessageTargetContext(input: MessageTargetContext): MessageTargetContext {
  return {
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId)
  };
}

function normalizeMessageSourceContext(input: MessageSourceContext): MessageSourceContext {
  return {
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    messageId: normalizeOptionalMetadataValue(input.messageId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId),
    channelType:
      input.channelType === "dm" ||
      input.channelType === "channel" ||
      input.channelType === "group" ||
      input.channelType === "mpim"
        ? input.channelType
        : undefined,
    teamId: normalizeOptionalMetadataValue(input.teamId)
  };
}

function normalizeOptionalMetadataValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCodexAppServerModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "openai-codex-app-server";
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

  if (maybe.sourceContext !== undefined && !isMessageSourceContext(maybe.sourceContext)) {
    return false;
  }

  return true;
}

function isMessageSourceContext(value: unknown): value is MessageSourceContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<MessageSourceContext>;

  if (maybe.channel !== "web" && maybe.channel !== "slack" && maybe.channel !== "telegram") {
    return false;
  }

  if (maybe.channelId !== undefined && typeof maybe.channelId !== "string") {
    return false;
  }

  if (maybe.userId !== undefined && typeof maybe.userId !== "string") {
    return false;
  }

  if (maybe.messageId !== undefined && typeof maybe.messageId !== "string") {
    return false;
  }

  if (maybe.threadTs !== undefined && typeof maybe.threadTs !== "string") {
    return false;
  }

  if (maybe.integrationProfileId !== undefined && typeof maybe.integrationProfileId !== "string") {
    return false;
  }

  if (
    maybe.channelType !== undefined &&
    maybe.channelType !== "dm" &&
    maybe.channelType !== "channel" &&
    maybe.channelType !== "group" &&
    maybe.channelType !== "mpim"
  ) {
    return false;
  }

  if (maybe.teamId !== undefined && typeof maybe.teamId !== "string") {
    return false;
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

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
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

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
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

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
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
