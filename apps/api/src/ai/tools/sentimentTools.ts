import { ToolDefinition } from "../types";

type Sentiment = "positive" | "neutral" | "negative" | "very_negative";

const GUIDANCE: Record<Sentiment, string> = {
  positive: "Caller sounds pleased - keep the same tone, no adjustment needed.",
  neutral: "No notable shift - continue as normal.",
  negative:
    "Caller sounds frustrated or annoyed - acknowledge their concern before continuing, and ease off the sales/booking agenda.",
  very_negative:
    "Caller sounds upset or angry - prioritize acknowledging their frustration over any other goal, and offer to address their concern directly or wrap up the call gracefully if that's what they want.",
};

/**
 * Lets the agent log a shift in the caller's tone/mood as it notices one,
 * purely so its own next reply in the same turn can react to it (the tool
 * result is folded back into conversation history before the final reply is
 * generated, same as any other tool call) - it performs no side effect of
 * its own.
 */
export function buildSentimentTools(): ToolDefinition[] {
  const recordSentiment: ToolDefinition = {
    name: "record_sentiment",
    description:
      "Record a shift in the caller's tone or mood as you notice it during the call. Call this every time " +
      "the caller's sentiment changes, not just the first time - it doesn't perform any action on its own, it " +
      "only helps you calibrate your own tone to how the caller is feeling.",
    parameters: {
      type: "object",
      properties: {
        sentiment: {
          type: "string",
          enum: ["positive", "neutral", "negative", "very_negative"],
          description: "The caller's current sentiment",
        },
        reason: { type: "string", description: "Brief note on what signaled this sentiment" },
      },
      required: ["sentiment"],
    },
    handler: async (args) => {
      const sentiment = args.sentiment as Sentiment;
      return { recorded: true, sentiment, guidance: GUIDANCE[sentiment] ?? GUIDANCE.neutral };
    },
  };

  return [recordSentiment];
}
