// AI reply-quality evals: unlike every other *.test.ts file in this repo,
// these call the REAL configured AIAgent (real Gemini API, billed) one turn
// at a time - no mocking GoogleAgent - and grade its output against ground
// truth. Tool calls are checked structurally (name + arg subset); free-text
// replies are graded by an LLM-as-judge against a rubric, since exact/GT
// string comparison is too brittle for generative text that varies in
// phrasing run to run.
//
// Not part of `npm test` - the `*.eval-test.ts` suffix is matched only by
// jest.eval.config.js, run via `npm run eval:ai` with a real
// GOOGLE_AI_API_KEY exported (everything else can keep the dummy values
// tests/setupEnv.ts already provides, since no other tool handlers run here).
//
// Each case can fire multiple real calls (one generateReply per chain round,
// plus a judgeReply call for rubric-graded cases), so the agent is wrapped
// with withRateLimit to throttle and retry-with-backoff against provider
// rate limits instead of firing every call back to back.
//
// Each test case is billed as real API calls against GOOGLE_AI_API_KEY - to
// avoid burning quota re-running the whole suite while iterating on one
// case, run a single case by name with Jest's -t filter, e.g.:
//   npm run eval:ai -- -t "booking chain via runConversationTurn"
import { getAIAgent } from "../agentFactory";
import { runConversationTurn } from "../conversationRunner";
import { AgentMessage, ToolDefinition } from "../types";
import { EVAL_CASES } from "./cases";
import { judgeReply } from "./judge";
import { withRateLimit } from "./rateLimitedAgent";
import { ExpectedToolCall } from "./types";

function matchesExpectedArgs(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));
}

function assertExpectedToolCall(expected: ExpectedToolCall, actualToolCalls: { name: string; args: Record<string, unknown> }[]) {
  const match = actualToolCalls.find((actual) => actual.name === expected.name && matchesExpectedArgs(expected.args ?? {}, actual.args));
  if (!match) {
    throw new Error(
      `expected a "${expected.name}" tool call matching args ${JSON.stringify(expected.args ?? {})}, ` +
        `got tool calls: ${JSON.stringify(actualToolCalls)}`
    );
  }
}

// Neither this suite's single-turn nor chain assertions fail on tool calls beyond the ones
// explicitly checked - a model calling something extra isn't necessarily wrong (e.g. an
// unplanned record_sentiment) and isn't necessarily fine either (e.g. a surprise
// cancel_appointment), so it's logged for a human to look at rather than silently ignored
// or auto-failed.
function logExtraToolCalls(caseName: string, extra: unknown[]) {
  if (extra.length === 0) return;
  console.log(`[extra tool calls] "${caseName}": ${JSON.stringify(extra)}`);
}

function findExtraToolCalls(
  expected: ExpectedToolCall[],
  actual: { name: string; args: Record<string, unknown> }[]
): { name: string; args: Record<string, unknown> }[] {
  return actual.filter((call) => !expected.some((exp) => exp.name === call.name && matchesExpectedArgs(exp.args ?? {}, call.args)));
}

interface ChainToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The stub handler's return value (parsed from the paired `role: "tool"` message), unlike
   * the single-turn path where no handler ever runs so there's nothing to report. */
  result: unknown;
}

// runConversationTurn pushes each tool call's `role: "tool"` result message immediately after
// its `role: "assistant"` call message (see conversationRunner.ts), so they can be paired by position.
function extractChainToolCalls(history: AgentMessage[]): ChainToolCall[] {
  const calls: ChainToolCall[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const message = history[i];
    if (message.role !== "assistant" || !message.toolName) continue;
    const resultMessage = history[i + 1];
    let result: unknown = undefined;
    if (resultMessage?.role === "tool" && resultMessage.toolName === message.toolName) {
      try {
        result = JSON.parse(resultMessage.content);
      } catch {
        result = resultMessage.content;
      }
    }
    calls.push({ name: message.toolName, args: message.toolArgs ?? {}, result });
  }
  return calls;
}

// Checks `expectedOrder` occurs as a subsequence of `actualCalls`' tool names - extra/incidental
// tool calls in between don't fail the chain, but are still returned with their args and result
// (see logExtraToolCalls) rather than just their names.
function splitToolChain(
  expectedOrder: string[],
  actualCalls: ChainToolCall[]
): { matchedAll: boolean; actualOrder: string[]; extra: ChainToolCall[] } {
  let cursor = 0;
  const extra: ChainToolCall[] = [];
  for (const call of actualCalls) {
    if (cursor < expectedOrder.length && call.name === expectedOrder[cursor]) {
      cursor += 1;
    } else {
      extra.push(call);
    }
  }
  return { matchedAll: cursor === expectedOrder.length, actualOrder: actualCalls.map((c) => c.name), extra };
}

describe("AI reply quality evals (real Gemini calls, LLM-as-judge for free text)", () => {
  const agent = withRateLimit(getAIAgent(), {
    minIntervalMs: process.env.EVAL_AI_MIN_INTERVAL_MS ? Number(process.env.EVAL_AI_MIN_INTERVAL_MS) : undefined,
  });

  it.each(EVAL_CASES)(
    "$name",
    async (evalCase) => {
      if (evalCase.chain) {
        const { stubResults, expectedOrder } = evalCase.chain;
        // Same tool name/description/parameters the model actually sees in production - only
        // the handler is swapped, so no real Prisma/Calendar/Telnyx side effects happen here.
        const stubbedTools: ToolDefinition[] = evalCase.tools.map((tool) => ({
          ...tool,
          handler: async () => stubResults[tool.name] ?? { ok: true },
        }));

        const { history, finalReply } = await runConversationTurn(agent, evalCase.messages, stubbedTools, evalCase.systemPrompt);
        const actualCalls = extractChainToolCalls(history);
        const { matchedAll, actualOrder, extra } = splitToolChain(expectedOrder, actualCalls);
        logExtraToolCalls(evalCase.name, extra);
        if (!matchedAll) {
          throw new Error(`expected tool call order ${JSON.stringify(expectedOrder)} as a subsequence, got: ${JSON.stringify(actualOrder)}`);
        }

        if (evalCase.rubric) {
          const verdict = await judgeReply(agent, history, finalReply, evalCase.rubric);
          if (!verdict.pass) {
            throw new Error(`LLM judge failed reply "${finalReply}" against rubric: ${verdict.reason}`);
          }
        }
        return;
      }

      const reply = await agent.generateReply(evalCase.messages, evalCase.tools, evalCase.systemPrompt);

      logExtraToolCalls(evalCase.name, findExtraToolCalls(evalCase.expectedToolCalls ?? [], reply.toolCalls));
      for (const expected of evalCase.expectedToolCalls ?? []) {
        assertExpectedToolCall(expected, reply.toolCalls);
      }

      const isRubricExempt = evalCase.rubricExemptToolCalls?.some((name) => reply.toolCalls.some((tc) => tc.name === name));

      if (evalCase.rubric && !isRubricExempt) {
        if (!reply.content) {
          throw new Error(`expected text content to grade against the rubric, got tool calls only: ${JSON.stringify(reply.toolCalls)}`);
        }
        const verdict = await judgeReply(agent, evalCase.messages, reply.content, evalCase.rubric);
        if (!verdict.pass) {
          throw new Error(`LLM judge failed reply "${reply.content}" against rubric: ${verdict.reason}`);
        }
      }
    }
  );
});
