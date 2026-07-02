import type { Content, FunctionDeclaration, GoogleGenAI, Part } from "@google/genai";
import { env } from "../../../config/env";
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
        parts.push({ functionCall: { name: message.toolName, args: message.toolArgs ?? {} } });
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

  async generateReply(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string
  ): Promise<AgentReply> {
    const { client, Type } = await this.getClient();
    const contents = messagesToContents(messages);

    const response = await client.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools: tools.length > 0 ? [{ functionDeclarations: toolsToFunctionDeclarations(tools, Type) }] : undefined,
      },
    });

    const functionCalls = response.functionCalls ?? [];
    const toolCalls: ToolCallRequest[] = functionCalls.map((call, index) => ({
      id: call.id ?? `${call.name}-${index}`,
      name: call.name ?? "",
      args: (call.args ?? {}) as Record<string, unknown>,
    }));

    return {
      content: response.text ?? null,
      toolCalls,
    };
  }
}
