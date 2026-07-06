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
  /**
   * Tool names that, if present in the actual reply's tool calls, exempt it from the rubric
   * check entirely - for a transcript where the "correct" response is genuinely ambiguous
   * between free text and a stronger tool-driven action (e.g. a caller who sounds both
   * upset and like they want to opt out: acknowledging the frustration in text and
   * immediately calling add_to_dnc are both a legitimate way to handle it).
   */
  rubricExemptToolCalls?: string[];
}
