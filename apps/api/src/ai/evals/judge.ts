import { AgentMessage, AIAgent } from "../types";

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

const JUDGE_SYSTEM_PROMPT = `You are grading a single reply from an AI phone agent against a rubric, using the
conversation transcript below (including any tool calls and their results) as the source of truth for what has
actually been established so far. Respond with ONLY a JSON object of the shape {"pass": boolean, "reason": string} -
no markdown fences, no text outside the JSON. Be strict: mark pass=false if the reply violates any part of the
rubric, even if the wording is otherwise good - but only treat a detail as invented/unestablished if it's truly
unsupported by the transcript, not merely because the reply paraphrases or doesn't quote it verbatim.`;

function formatTranscript(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "assistant" && m.toolName) return `assistant called ${m.toolName}(${JSON.stringify(m.toolArgs ?? {})})`;
      if (m.role === "tool") return `${m.toolName} returned: ${m.content}`;
      return `${m.role}: ${m.content}`;
    })
    .join("\n");
}

/**
 * Grades free-text agent output against a rubric using the same provider-agnostic
 * AIAgent interface the app already uses, rather than exact-match/GT string
 * comparison, since generative replies vary in phrasing even at low temperature.
 * `transcript` is the conversation (including tool calls/results) the reply followed from -
 * rubric language like "wasn't established in the conversation" is unverifiable without it,
 * so the judge previously had to guess blind and flagged real, established details as invented.
 */
export async function judgeReply(agent: AIAgent, transcript: AgentMessage[], reply: string, rubric: string): Promise<JudgeVerdict> {
  const prompt =
    `Conversation transcript so far:\n"""\n${formatTranscript(transcript)}\n"""\n\n` +
    `Rubric:\n${rubric}\n\nAgent reply to grade:\n"""\n${reply}\n"""`;
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
