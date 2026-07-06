import { AgentMessage, AgentReply, AIAgent, ToolDefinition } from "../types";

// A common free-tier Gemini cap is ~15 requests/minute - 4s between calls
// keeps a small eval suite under that without needing to know the exact
// number, and can be overridden via EVAL_AI_MIN_INTERVAL_MS.
const DEFAULT_MIN_INTERVAL_MS = 4000;
const DEFAULT_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 429 is quota/rate-limit (retry after RetryInfo.retryDelay, parsed below).
// 503 is the model being transiently overloaded ("high demand" - no
// RetryInfo, falls back to exponential backoff) - both are worth retrying,
// unlike a 400/permission error which would just repeat.
function isRetryableError(error: unknown): boolean {
  return error instanceof Error && /got status:\s*(429|503)/.test(error.message);
}

// @google/genai doesn't expose a structured status/retry-after field - it
// bakes the whole JSON error body into Error.message as
// `got status: 429 Too Many Requests. {...}`. Google's own RetryInfo.retryDelay
// (e.g. "34s") in that body is a better wait than a guessed backoff.
function parseSuggestedRetryDelayMs(message: string): number | null {
  const jsonStart = message.indexOf("{");
  if (jsonStart === -1) return null;
  try {
    const body = JSON.parse(message.slice(jsonStart));
    const details = (body?.error?.details ?? []) as { ["@type"]?: string; retryDelay?: string }[];
    const retryInfo = details.find((d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo");
    if (!retryInfo?.retryDelay) return null;
    const seconds = parseFloat(retryInfo.retryDelay.replace(/s$/, ""));
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Wraps a real AIAgent so a run that fires several real API calls back to
 * back doesn't hammer the provider: enforces a minimum gap between calls,
 * and on a 429/503 retries after the provider's own suggested delay (falling
 * back to exponential backoff off minIntervalMs if none is given).
 */
export function withRateLimit(
  agent: AIAgent,
  { minIntervalMs = DEFAULT_MIN_INTERVAL_MS, maxRetries = DEFAULT_MAX_RETRIES } = {}
): AIAgent {
  let lastCallAt = 0;

  async function throttledGenerateReply(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<AgentReply> {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await agent.generateReply(messages, tools, systemPrompt, signal);
      } catch (error) {
        if (attempt >= maxRetries || !isRetryableError(error)) throw error;
        const delay = (error instanceof Error && parseSuggestedRetryDelayMs(error.message)) || minIntervalMs * 2 ** attempt;
        await sleep(delay);
        lastCallAt = Date.now();
      }
    }
  }

  return { providerName: agent.providerName, generateReply: throttledGenerateReply };
}
