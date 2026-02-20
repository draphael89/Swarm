import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export interface CodexDynamicToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface CodexDynamicToolCall {
  tool: string;
  callId: string;
  arguments: unknown;
}

export interface CodexDynamicToolCallResponse {
  contentItems: Array<{
    type: "inputText";
    text: string;
  }>;
  success: boolean;
}

export interface CodexToolBridge {
  dynamicTools: CodexDynamicToolSpec[];
  handleToolCall(call: CodexDynamicToolCall): Promise<CodexDynamicToolCallResponse>;
}

export function createCodexToolBridge(tools: ToolDefinition[]): CodexToolBridge {
  const toolByName = new Map<string, ToolDefinition>();

  for (const tool of tools) {
    toolByName.set(tool.name, tool);
  }

  const dynamicTools: CodexDynamicToolSpec[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.label ?? `Run ${tool.name}`,
    inputSchema: cloneJsonSchema(tool.parameters)
  }));

  return {
    dynamicTools,
    async handleToolCall(call) {
      const definition = toolByName.get(call.tool);
      if (!definition) {
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `Unknown tool: ${call.tool}`
            }
          ]
        };
      }

      const args = normalizeToolArguments(call.arguments);

      try {
        const result = await definition.execute(
          call.callId,
          args,
          undefined,
          undefined,
          undefined as never
        );

        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: extractToolResultText(result, definition.name)
            }
          ]
        };
      } catch (error) {
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `Tool ${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  };
}

function cloneJsonSchema(schema: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(schema));
  } catch {
    return {
      type: "object",
      additionalProperties: true
    };
  }
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function extractToolResultText(result: unknown, toolName: string): string {
  const fromContent = extractTextFromContentItems(result);
  if (fromContent) {
    return fromContent;
  }

  if (result !== undefined) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  return `Tool ${toolName} completed.`;
}

function extractTextFromContentItems(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const chunks: string[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const maybeText = item as { type?: unknown; text?: unknown };
    if (maybeText.type === "text" && typeof maybeText.text === "string") {
      chunks.push(maybeText.text);
    }
  }

  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : undefined;
}
