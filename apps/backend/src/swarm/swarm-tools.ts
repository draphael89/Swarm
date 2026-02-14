import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SpawnAgentInput
} from "./types.js";

export interface SwarmToolHost {
  listAgents(): AgentDescriptor[];
  spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor>;
  killAgent(callerAgentId: string, targetAgentId: string): Promise<void>;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode
  ): Promise<SendMessageReceipt>;
  publishToUser(agentId: string, text: string, source?: "speak_to_user" | "system"): Promise<void>;
}

const deliveryModeSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("followUp"),
  Type.Literal("steer")
]);

export function buildSwarmTools(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition[] {
  const shared: ToolDefinition[] = [
    {
      name: "list_agents",
      label: "List Agents",
      description: "List swarm agents with ids, roles, status, model, and workspace.",
      parameters: Type.Object({}),
      async execute() {
        const agents = host.listAgents();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ agents }, null, 2)
            }
          ],
          details: { agents }
        };
      }
    },
    {
      name: "send_message_to_agent",
      label: "Send Message To Agent",
      description:
        "Send a message to another agent by id. Returns immediately with a delivery receipt. If target is busy, queued delivery is accepted as steer.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to receive the message." }),
        message: Type.String({ description: "Message text to deliver." }),
        delivery: Type.Optional(deliveryModeSchema)
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          targetAgentId: string;
          message: string;
          delivery?: RequestedDeliveryMode;
        };

        const receipt = await host.sendMessage(
          descriptor.agentId,
          parsed.targetAgentId,
          parsed.message,
          parsed.delivery
        );

        return {
          content: [
            {
              type: "text",
              text: `Queued message for ${receipt.targetAgentId}. deliveryId=${receipt.deliveryId}, mode=${receipt.acceptedMode}`
            }
          ],
          details: receipt
        };
      }
    }
  ];

  if (descriptor.role !== "manager") {
    return shared;
  }

  const managerOnly: ToolDefinition[] = [
    {
      name: "spawn_agent",
      label: "Spawn Agent",
      description:
        "Create and start a new worker agent. agentId is required and normalized to lowercase kebab-case; if taken, a numeric suffix (-2, -3, …) is appended. archetypeId, systemPrompt, model, cwd, and initialMessage are optional.",
      parameters: Type.Object({
        agentId: Type.String({
          description:
            "Required agent identifier. Normalized to lowercase kebab-case; collisions are suffixed numerically."
        }),
        archetypeId: Type.Optional(
          Type.String({ description: "Optional archetype id (for example: merger)." })
        ),
        systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt override." })),
        model: Type.Optional(
          Type.Object({
            provider: Type.String(),
            modelId: Type.String(),
            thinkingLevel: Type.Optional(Type.String())
          })
        ),
        cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
        initialMessage: Type.Optional(Type.String({ description: "Optional first message to send after spawn." }))
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          agentId: string;
          archetypeId?: string;
          systemPrompt?: string;
          model?: { provider: string; modelId: string; thinkingLevel?: string };
          cwd?: string;
          initialMessage?: string;
        };

        const spawned = await host.spawnAgent(descriptor.agentId, {
          agentId: parsed.agentId,
          archetypeId: parsed.archetypeId,
          systemPrompt: parsed.systemPrompt,
          model: parsed.model,
          cwd: parsed.cwd,
          initialMessage: parsed.initialMessage
        });

        return {
          content: [
            {
              type: "text",
              text: `Spawned agent ${spawned.agentId} (${spawned.displayName})`
            }
          ],
          details: spawned
        };
      }
    },
    {
      name: "kill_agent",
      label: "Kill Agent",
      description: "Terminate a running worker agent. Manager cannot be terminated.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to terminate." })
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { targetAgentId: string };
        await host.killAgent(descriptor.agentId, parsed.targetAgentId);
        return {
          content: [
            {
              type: "text",
              text: `Terminated agent ${parsed.targetAgentId}`
            }
          ],
          details: {
            targetAgentId: parsed.targetAgentId,
            terminated: true
          }
        };
      }
    },
    {
      name: "speak_to_user",
      label: "Speak To User",
      description: "Publish a user-visible manager message into the websocket conversation feed.",
      parameters: Type.Object({
        text: Type.String({ description: "Message content to show to the user." })
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { text: string };
        await host.publishToUser(descriptor.agentId, parsed.text, "speak_to_user");
        return {
          content: [
            {
              type: "text",
              text: "Published message to user."
            }
          ],
          details: {
            published: true
          }
        };
      }
    }
  ];

  return [...shared, ...managerOnly];
}
