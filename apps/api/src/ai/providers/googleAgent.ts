import type { Content, FunctionDeclaration, GoogleGenAI, Part } from "@google/genai";
import { env } from "@telephony/config";
import {
  AIAgent,
  AgentMessage,
  AgentReply,
  ToolCallRequest,
  ToolDefinition,
  ToolParameterSchema,
} from "../types";

// @google/genai ships as an ESM-only package whose CJS "require" export
// condition is itself broken, so requiring it (even lazily) resolves to an
// empty object instead of throwing. TypeScript's commonjs output rewrites
// `import()` into `require()`, which hits that bug - so we force a real
// dynamic import via the Function constructor, which tsc cannot rewrite.
type GenAIModule = typeof import("@google/genai");
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<GenAIModule>;

let genaiModulePromise: Promise<GenAIModule> | null = null;
function loadGenAiModule(): Promise<GenAIModule> {
  if (!genaiModulePromise) {
    genaiModulePromise = dynamicImport("@google/genai");
  }
  return genaiModulePromise;
}

function toGenAiSchema(schema: ToolParameterSchema, TypeEnum: GenAIModule["Type"]) {
  const typeMap: Record<string, unknown> = {
    string: TypeEnum.STRING,
    number: TypeEnum.NUMBER,
    boolean: TypeEnum.BOOLEAN,
    array: TypeEnum.ARRAY,
    object: TypeEnum.OBJECT,
  };

  return {
    type: TypeEnum.OBJECT,
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        {
          type: typeMap[value.type],
          description: value.description,
          enum: value.enum,
          items: value.items,
        },
      ])
    ),
    required: schema.required ?? [],
  };
}

function toolsToFunctionDeclarations(
  tools: ToolDefinition[],
  TypeEnum: GenAIModule["Type"]
): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toGenAiSchema(tool.parameters, TypeEnum) as never,
  }));
}

function messagesToContents(messages: AgentMessage[]): Content[] {
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content }] });
    } else if (message.role === "assistant") {
      const parts: Part[] = [];
      if (message.content) parts.push({ text: message.content });
      if (message.toolName) {
        parts.push({
          functionCall: { name: message.toolName, args: message.toolArgs ?? {} },
          thoughtSignature: message.thoughtSignature,
        });
      }
      contents.push({ role: "model", parts });
    } else if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.toolName ?? "unknown_tool",
              response: { result: message.content },
            },
          },
        ],
      });
    }
  }

  return contents;
}

export class GoogleAgent implements AIAgent {
  readonly providerName = "google";
  private client: GoogleGenAI | null = null;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string = env.GOOGLE_AI_API_KEY ?? "", model: string = env.GOOGLE_AI_MODEL) {
    if (!apiKey) {
      throw new Error("GOOGLE_AI_API_KEY is required to use the Google AI agent provider");
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  private async getClient(): Promise<{ client: GoogleGenAI; Type: GenAIModule["Type"] }> {
    const genai = await loadGenAiModule();
    if (!this.client) {
      this.client = new genai.GoogleGenAI({ apiKey: this.apiKey });
    }
    return { client: this.client, Type: genai.Type };
  }

  // Nothing bounded how long a single generateContent call could take - a
  // "503 model overloaded" response was observed taking ~9s to even arrive,
  // and the retry below would then make a second equally slow attempt,
  // stacking into ~20s of dead air on a live call before the fallback line
  // ever played. Every attempt is now capped at this, win or lose.
  //
  // Originally 6000 - live-tested against real API latency and found that
  // was cutting off a large fraction of calls that were going to genuinely
  // succeed a couple seconds later (5 direct calls: latencies of 2.5s, 3.0s,
  // 5.6s, 9.9s, plus one real 9.4s 503 - a 6s cap was a false-positive
  // timeout on the 9.9s success). Widened to cover that observed range.
  private static readonly REQUEST_TIMEOUT_MS = 10000;

  private async generateContentWithTimeout(
    client: GoogleGenAI,
    params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]
  ): ReturnType<GoogleGenAI["models"]["generateContent"]> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), GoogleAgent.REQUEST_TIMEOUT_MS);
    const combinedSignal = params.config?.abortSignal
      ? AbortSignal.any([params.config.abortSignal, timeoutController.signal])
      : timeoutController.signal;
    try {
      return await client.models.generateContent({ ...params, config: { ...params.config, abortSignal: combinedSignal } });
    } catch (error) {
      // Distinguishes our own timeout from a real barge-in abort (the
      // caller's signal) or any other rejection, so the retry logic below
      // can tell "Gemini was too slow" apart from "quota/overload error" -
      // the former shouldn't retry (that would just double the wait again),
      // the latter should get its one quick retry as before.
      if (timeoutController.signal.aborted) {
        throw new Error(`Gemini request timed out after ${GoogleAgent.REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One quick retry for transient failures (free-tier per-minute rate limits,
   * momentary "model overloaded" 503s) - NOT a full backoff strategy. This is
   * a live phone call, not a batch job: Google's own suggested retryDelay on
   * a 429 is 15-20s, far too slow to sit on while a caller waits in silence.
   * A short fixed delay catches the cases that clear almost immediately;
   * anything that doesn't (including a timeout on this retry itself, still
   * bounded by generateContentWithTimeout) is surfaced to the caller by
   * callStreamSession's fallback line instead of stalling the call further.
   */
  private async generateContentWithRetry(
    client: GoogleGenAI,
    params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]
  ): ReturnType<GoogleGenAI["models"]["generateContent"]> {
    try {
      return await this.generateContentWithTimeout(client, params);
    } catch (error) {
      const status = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
      if (status !== 429 && status !== 503) throw error; // includes our own timeout Error - no status, no retry
      await new Promise((resolve) => setTimeout(resolve, 600));
      return this.generateContentWithTimeout(client, params);
    }
  }

  async generateReply(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<AgentReply> {
    const { client, Type } = await this.getClient();
    const contents = messagesToContents(messages);

    // NOTE: per @google/genai's own types, abortSignal is a client-only
    // cancellation - it stops us from waiting on the response, it does not
    // cancel server-side generation or its billing. Callers that need actual
    // correctness on cancellation (not just avoiding a wasted wait) must still
    // gate on their own turn-versioning rather than relying on this alone.
    const response = await this.generateContentWithRetry(client, {
      model: this.model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools: tools.length > 0 ? [{ functionDeclarations: toolsToFunctionDeclarations(tools, Type) }] : undefined,
        abortSignal: signal,
      },
    });

    // Not response.functionCalls (the SDK's own convenience getter) - it maps
    // each part down to just the bare FunctionCall, dropping the sibling
    // thoughtSignature field this needs to read.
    const responseParts = response.candidates?.[0]?.content?.parts ?? [];
    const toolCalls: ToolCallRequest[] = responseParts
      .filter((part) => part.functionCall !== undefined)
      .map((part, index) => ({
        id: part.functionCall?.id ?? `${part.functionCall?.name}-${index}`,
        name: part.functionCall?.name ?? "",
        args: (part.functionCall?.args ?? {}) as Record<string, unknown>,
        thoughtSignature: part.thoughtSignature,
      }));

    return {
      content: response.text ?? null,
      toolCalls,
    };
  }
}
