import { env } from "@telephony/config";
import { AIAgent } from "./types";
import { GoogleAgent } from "./providers/googleAgent";

let cachedAgent: AIAgent | null = null;

/**
 * Returns the configured AI agent implementation. Swapping providers (e.g. to
 * OpenAI or Anthropic) only requires adding a new class implementing AIAgent
 * and a case here — nothing else in the app depends on the concrete SDK.
 */
export function getAIAgent(): AIAgent {
  if (cachedAgent) return cachedAgent;

  switch (env.AI_PROVIDER) {
    case "google":
      cachedAgent = new GoogleAgent();
      break;
    default:
      throw new Error(`Unsupported AI_PROVIDER: ${env.AI_PROVIDER}`);
  }

  return cachedAgent;
}
