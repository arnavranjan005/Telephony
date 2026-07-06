import { AIAgent } from "../types";

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

const JUDGE_SYSTEM_PROMPT = `You are grading a single reply from an AI phone agent against a rubric.
Respond with ONLY a JSON object of the shape {"pass": boolean, "reason": string} - no markdown fences,
no text outside the JSON. Be strict: mark pass=false if the reply violates any part of the rubric, even
if the wording is otherwise good.`;

/**
 * Grades free-text agent output against a rubric using the same provider-agnostic
 * AIAgent interface the app already uses, rather than exact-match/GT string
 * comparison, since generative replies vary in phrasing even at low temperature.
 */
export async function judgeReply(agent: AIAgent, reply: string, rubric: string): Promise<JudgeVerdict> {
  const prompt = `Rubric:\n${rubric}\n\nAgent reply to grade:\n"""\n${reply}\n"""`;
  const result = await agent.generateReply([{ role: "user", content: prompt }], [], JUDGE_SYSTEM_PROMPT);
  const raw = (result.content ?? "")
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(raw) as { pass?: unknown; reason?: unknown };
    if (typeof parsed.pass !== "boolean") throw new Error("missing boolean `pass` field");
    return { pass: parsed.pass, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    return { pass: false, reason: `judge returned unparseable output: ${raw || "(empty)"}` };
  }
}
