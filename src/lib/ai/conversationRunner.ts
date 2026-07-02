import { AIAgent, AgentMessage, ToolDefinition } from "./types";

const MAX_TOOL_ROUNDTRIPS = 4;

/**
 * Drives a single conversation turn: sends the message history to the agent,
 * executes any requested tool calls, feeds the results back, and repeats
 * until the agent responds with plain text (or the roundtrip cap is hit).
 * Returns the updated message history including tool call/result messages.
 */
export async function runConversationTurn(
  agent: AIAgent,
  history: AgentMessage[],
  tools: ToolDefinition[],
  systemPrompt?: string
): Promise<{ history: AgentMessage[]; finalReply: string }> {
  const messages = [...history];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round += 1) {
    const reply = await agent.generateReply(messages, tools, systemPrompt);

    if (reply.toolCalls.length === 0) {
      const finalReply = reply.content ?? "";
      messages.push({ role: "assistant", content: finalReply });
      return { history: messages, finalReply };
    }

    for (const toolCall of reply.toolCalls) {
      messages.push({
        role: "assistant",
        content: reply.content ?? "",
        toolName: toolCall.name,
        toolArgs: toolCall.args,
      });

      const tool = toolsByName.get(toolCall.name);
      let resultContent: string;
      try {
        const result = tool ? await tool.handler(toolCall.args) : { error: `Unknown tool: ${toolCall.name}` };
        resultContent = JSON.stringify(result);
      } catch (error) {
        resultContent = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }

      messages.push({ role: "tool", content: resultContent, toolName: toolCall.name });
    }
  }

  return { history: messages, finalReply: "I'm sorry, I wasn't able to complete that request right now." };
}
