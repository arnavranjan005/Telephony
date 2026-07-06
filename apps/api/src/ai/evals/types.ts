import { AgentMessage, ToolDefinition } from "../types";

export interface ExpectedToolCall {
  name: string;
  /** Checked as a subset of the actual call's args - extra actual fields are ignored. */
  args?: Record<string, unknown>;
}

export interface EvalCase {
  name: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  messages: AgentMessage[];
  /** Every entry must be matched by at least one of the agent's actual tool calls. */
  expectedToolCalls?: ExpectedToolCall[];
  /** Graded on reply.content via LLM-as-judge; requires the reply to include text content. */
  rubric?: string;
}
