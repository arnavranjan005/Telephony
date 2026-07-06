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
// Each case can fire up to two real calls (generateReply, plus a judgeReply
// call for rubric-graded cases), so the agent is wrapped with withRateLimit
// to throttle and retry-with-backoff against provider rate limits instead of
// firing every call back to back.
import { getAIAgent } from "../agentFactory";
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

describe("AI reply quality evals (real Gemini calls, LLM-as-judge for free text)", () => {
  const agent = withRateLimit(getAIAgent(), {
    minIntervalMs: process.env.EVAL_AI_MIN_INTERVAL_MS ? Number(process.env.EVAL_AI_MIN_INTERVAL_MS) : undefined,
  });

  it.each(EVAL_CASES)(
    "$name",
    async (evalCase) => {
      const reply = await agent.generateReply(evalCase.messages, evalCase.tools, evalCase.systemPrompt);

      for (const expected of evalCase.expectedToolCalls ?? []) {
        assertExpectedToolCall(expected, reply.toolCalls);
      }

      const isRubricExempt = evalCase.rubricExemptToolCalls?.some((name) => reply.toolCalls.some((tc) => tc.name === name));

      if (evalCase.rubric && !isRubricExempt) {
        if (!reply.content) {
          throw new Error(`expected text content to grade against the rubric, got tool calls only: ${JSON.stringify(reply.toolCalls)}`);
        }
        const verdict = await judgeReply(agent, reply.content, evalCase.rubric);
        if (!verdict.pass) {
          throw new Error(`LLM judge failed reply "${reply.content}" against rubric: ${verdict.reason}`);
        }
      }
    }
  );
});
