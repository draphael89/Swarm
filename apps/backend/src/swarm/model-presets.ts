import type { AgentModelDescriptor, SwarmModelPreset } from "./types.js";
import { SWARM_MODEL_PRESETS } from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "codex-5.3";

const MODEL_PRESET_DESCRIPTORS: Record<SwarmModelPreset, AgentModelDescriptor> = {
  "codex-5.3": {
    provider: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "xhigh"
  },
  "opus-4.6": {
    // Anthropic OAuth tokens trigger Claude Code auth headers in pi-ai,
    // matching the existing Claude Code integration path.
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    thinkingLevel: "xhigh"
  }
};

const VALID_SWARM_MODEL_PRESET_VALUES = new Set<string>(SWARM_MODEL_PRESETS);
const OPUS_MODEL_ID_ALIASES = new Set(["claude-opus-4-6", "claude-opus-4.6"]);

export function describeSwarmModelPresets(): string {
  return SWARM_MODEL_PRESETS.join("|");
}

export function isSwarmModelPreset(value: unknown): value is SwarmModelPreset {
  return typeof value === "string" && VALID_SWARM_MODEL_PRESET_VALUES.has(value);
}

export function parseSwarmModelPreset(value: unknown, fieldName: string): SwarmModelPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSwarmModelPreset(value)) {
    throw new Error(`${fieldName} must be one of ${describeSwarmModelPresets()}`);
  }

  return value;
}

export function resolveModelDescriptorFromPreset(preset: SwarmModelPreset): AgentModelDescriptor {
  const descriptor = MODEL_PRESET_DESCRIPTORS[preset];
  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    thinkingLevel: descriptor.thinkingLevel
  };
}

export function inferSwarmModelPresetFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined
): SwarmModelPreset | undefined {
  if (!descriptor) {
    return undefined;
  }

  const provider = descriptor.provider?.trim().toLowerCase();
  const modelId = descriptor.modelId?.trim().toLowerCase();

  if (provider === "openai-codex" && modelId === "gpt-5.3-codex") {
    return "codex-5.3";
  }

  if (provider === "anthropic" && OPUS_MODEL_ID_ALIASES.has(modelId)) {
    return "opus-4.6";
  }

  return undefined;
}

export function normalizeSwarmModelDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
  fallbackPreset: SwarmModelPreset = DEFAULT_SWARM_MODEL_PRESET
): AgentModelDescriptor {
  const preset = inferSwarmModelPresetFromDescriptor(descriptor) ?? fallbackPreset;
  return resolveModelDescriptorFromPreset(preset);
}
