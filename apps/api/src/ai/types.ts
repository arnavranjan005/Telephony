export type AgentRole = "user" | "assistant" | "system" | "tool";

export interface AgentMessage {
  role: AgentRole;
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
}

export interface ToolParameterSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "array" | "object";
      description?: string;
      enum?: string[];
      items?: Record<string, unknown>;
    }
  >;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentReply {
  content: string | null;
  toolCalls: ToolCallRequest[];
}

/**
 * Provider-agnostic contract for an AI conversational agent with tool calling.
 * Any SDK (Google Gemini, OpenAI, Anthropic, etc.) can implement this interface
 * so the rest of the app never depends on a specific vendor SDK.
 */
export interface AIAgent {
  readonly providerName: string;

  generateReply(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<AgentReply>;
}
