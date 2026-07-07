import { AgentMessage, AgentReply, AIAgent, ToolDefinition } from "../types";

// A common free-tier Gemini cap is ~15 requests/minute - 4s between calls
// keeps a small eval suite under that without needing to know the exact
// number, and can be overridden via EVAL_AI_MIN_INTERVAL_MS.
const DEFAULT_MIN_INTERVAL_MS = 4000;
const DEFAULT_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// @google/genai's ApiError stringifies the raw error body straight into
// Error.message (no "got status: ..." prefix). A 429's QuotaFailure.violations
// carries a quotaId that says which cap was hit - parsed once and reused by
// both isRetryableError and parseSuggestedRetryDelayMs below.
function parseErrorBody(message: string): { error?: { details?: { ["@type"]?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[] } } | null {
  const jsonStart = message.indexOf("{");
  if (jsonStart === -1) return null;
  try {
    return JSON.parse(message.slice(jsonStart));
  } catch {
    return null;
  }
}

// A "PerDay" quotaId (e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier) means the
// daily cap is exhausted - no amount of waiting/retrying within this run will ever succeed,
// unlike a per-minute cap which clears itself within seconds.
function isDailyQuotaExhausted(message: string): boolean {
  const details = parseErrorBody(message)?.error?.details ?? [];
  const quotaFailure = details.find((d) => d["@type"] === "type.googleapis.com/google.rpc.QuotaFailure");
  return Boolean((quotaFailure as { violations?: { quotaId?: string }[] } | undefined)?.violations?.some((v) => v.quotaId?.includes("PerDay")));
}

// 429 is quota/rate-limit (retry after RetryInfo.retryDelay, parsed below) unless it's a
// daily-quota exhaustion, which is never worth retrying within the same run. 503 is the
// model being transiently overloaded ("high demand" - no RetryInfo, falls back to
// exponential backoff) - worth retrying, unlike a 400/permission error which would just repeat.
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: number }).status;
  if (status === 429) return !isDailyQuotaExhausted(error.message);
  return status === 503;
}

// Google's own RetryInfo.retryDelay (e.g. "34s") in the error body is a better wait than a
// guessed backoff.
function parseSuggestedRetryDelayMs(message: string): number | null {
  const details = parseErrorBody(message)?.error?.details ?? [];
  const retryInfo = details.find((d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo");
  if (!retryInfo?.retryDelay) return null;
  const seconds = parseFloat(retryInfo.retryDelay.replace(/s$/, ""));
  return Number.isFinite(seconds) ? seconds * 1000 : null;
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
