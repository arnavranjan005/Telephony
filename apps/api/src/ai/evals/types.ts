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
  /**
   * Runs this case through the real multi-round runConversationTurn loop instead of a
   * single generateReply call, with every tool's handler replaced by a canned stub result
   * (so no real Prisma/Calendar/Telnyx side effects happen). Use this to assert an ordered
   * chain of dependent tool calls the model must produce unassisted across several rounds -
   * e.g. check availability, then book, then confirm - rather than one isolated call's
   * output with the intermediate steps pre-seeded into `messages`.
   */
  chain?: {
    /** Canned result returned whenever the named tool is called. Tools not listed here get a generic `{ ok: true }`. */
    stubResults: Record<string, unknown>;
    /** Tool names expected to occur in this relative order, as a subsequence of the actual chain (extra/incidental calls in between are fine). */
    expectedOrder: string[];
  };
}
