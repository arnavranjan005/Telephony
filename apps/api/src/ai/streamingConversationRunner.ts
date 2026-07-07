import { prisma } from "@telephony/database";
import { AIAgent, AgentMessage, ToolDefinition } from "./types";
import { ROLE_TO_DB } from "../conversationHistory";
import { callEventBus } from "../sse/eventBus";

// A legitimate multi-step chain (e.g. cancel an old booking, check availability, book the new
// slot) can need several roundtrips - this is a safety ceiling against a runaway loop (a model
// stuck calling tools forever), not a budget for normal conversation, so it's set generously.
const MAX_TOOL_ROUNDTRIPS = 8;

export interface StreamingTurnContext {
  callId: string;
  /** The turnVersion this turn was started at (captured once, at turn start). */
  version: number;
  /** Returns the session's *current* turnVersion - if it no longer matches
   * `version`, a barge-in has superseded this turn. */
  getCurrentVersion(): number;
  /** Best-effort cancellation for the in-flight LLM call; see googleAgent.ts -
   * this doesn't stop server-side generation/billing, only wasted local waiting. */
  signal: AbortSignal;
  /** Serializes tool-handler execution across the whole call (not just this
   * turn) - see callStreamSession.ts's toolLock. Guarantees an old, superseded
   * turn's tool call always finishes and gets persisted (in the correct order)
   * before a new turn's own tool call can start, so arrival order and intent
   * order can never come apart. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export interface StreamingConversationResult {
  history: AgentMessage[];
  /** null if the turn was abandoned (superseded by a barge-in) before ever
   * producing a reply worth speaking - never speak stale content. */
  finalReply: string | null;
}

async function persistMessage(callId: string, message: AgentMessage, interrupted: boolean): Promise<void> {
  await prisma.conversationMessage.create({
    data: {
      callId,
      role: ROLE_TO_DB[message.role],
      content: message.content,
      toolName: message.toolName,
      toolArgs: message.toolArgs as never,
      thoughtSignature: message.thoughtSignature,
      interrupted,
    },
  });
  callEventBus.publish(callId, "conversation.message", message);
}

/**
 * Streaming-call sibling of conversationRunner.ts's runConversationTurn.
 * Differs in two ways required by real-time barge-in:
 *
 * 1. Persists each message incrementally as it happens (one row at a time),
 *    rather than batching everything at the end of the turn - a turn can now
 *    be abandoned mid-way, so there's no single "end of turn" instant to
 *    batch-persist at.
 * 2. Checks `context.version` against the session's current turnVersion at
 *    every safe checkpoint (before starting a round, before speaking/
 *    persisting a plain reply) and abandons a stale turn rather than
 *    finishing it. The one exception: a tool call that has already started
 *    always runs to completion and its result is always persisted (with
 *    `interrupted: true` if the turn went stale while it was running) -
 *    tool side effects are never rolled back once real, see callStreamSession.ts.
 *
 * conversationRunner.ts itself is not used or modified by this file - the
 * webhook-based call flow is unaffected by anything here.
 */
export async function runStreamingConversationTurn(
  agent: AIAgent,
  history: AgentMessage[],
  tools: ToolDefinition[],
  systemPrompt: string | undefined,
  context: StreamingTurnContext
): Promise<StreamingConversationResult> {
  const messages = [...history];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round += 1) {
    if (context.getCurrentVersion() !== context.version) {
      return { history: messages, finalReply: null };
    }

    const reply = await agent.generateReply(messages, tools, systemPrompt, context.signal);

    if (reply.toolCalls.length === 0) {
      const finalReply = reply.content ?? "";

      if (context.getCurrentVersion() !== context.version) {
        return { history: messages, finalReply: null };
      }

      const assistantMessage: AgentMessage = { role: "assistant", content: finalReply };
      messages.push(assistantMessage);
      await persistMessage(context.callId, assistantMessage, false);
      return { history: messages, finalReply };
    }

    for (const toolCall of reply.toolCalls) {
      const assistantToolMessage: AgentMessage = {
        role: "assistant",
        content: reply.content ?? "",
        toolName: toolCall.name,
        toolArgs: toolCall.args,
        thoughtSignature: toolCall.thoughtSignature,
      };
      messages.push(assistantToolMessage);

      const tool = toolsByName.get(toolCall.name);
      const resultContent = await context.runExclusive(async () => {
        try {
          const value = tool ? await tool.handler(toolCall.args) : { error: `Unknown tool: ${toolCall.name}` };
          return JSON.stringify(value);
        } catch (error) {
          return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
      });

      const toolResultMessage: AgentMessage = { role: "tool", content: resultContent, toolName: toolCall.name };
      messages.push(toolResultMessage);

      const isStale = context.getCurrentVersion() !== context.version;
      await persistMessage(context.callId, assistantToolMessage, isStale);
      await persistMessage(context.callId, toolResultMessage, isStale);

      if (isStale) {
        return { history: messages, finalReply: null };
      }
    }
  }

  return { history: messages, finalReply: null };
}
