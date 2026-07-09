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
  /** Called with any text the model attaches alongside a tool call (e.g. "Let
   * me check that for you" before calling a lookup tool). Without this, that
   * text was persisted to the transcript but never actually spoken - only the
   * final post-tool-result reply ever reached the caller, silently dropping
   * any acknowledgement/clarification the model made while invoking a tool. */
  onInterimReply?: (text: string) => void;
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
      let finalReply = reply.content ?? "";

      if (context.getCurrentVersion() !== context.version) {
        return { history: messages, finalReply: null };
      }

      if (!finalReply) {
        // The model can occasionally return a genuinely empty turn (no text,
        // no tool call - e.g. sometimes right after a function-call round)
        // with no error to catch. Never let that read as dead air to the
        // caller: retry once (a fresh sample from the same history usually
        // succeeds), and only fall back to a fixed line if it happens twice
        // in a row.
        if (round < MAX_TOOL_ROUNDTRIPS - 1) continue;
        finalReply = "Sorry, could you say that again?";
      }

      const assistantMessage: AgentMessage = { role: "assistant", content: finalReply };
      messages.push(assistantMessage);
      try {
        await persistMessage(context.callId, assistantMessage, false);
      } catch (error) {
        // The reply itself was already successfully generated - a DB hiccup
        // here is a transcript-logging failure, not a reason to throw away a
        // real reply the caller is about to hear (and, if this was the
        // goodbye after end_call, the caller's only chance to hear it before
        // the line goes dead). Losing this one row is preferable to losing
        // the reply.
        // eslint-disable-next-line no-console
        console.error(`Failed to persist assistant reply for call ${context.callId}:`, error);
      }
      return { history: messages, finalReply };
    }

    // Once per round, not once per tool call - reply.content is the same
    // string attached to every toolCall message below, so speaking it inside
    // the loop would repeat it once per tool call in a multi-tool-call round.
    if (reply.content) {
      context.onInterimReply?.(reply.content);
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
