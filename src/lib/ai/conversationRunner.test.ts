import { runConversationTurn } from "./conversationRunner";
import { AIAgent, AgentMessage, AgentReply, ToolDefinition } from "./types";

function makeAgent(replies: AgentReply[]): AIAgent {
  let call = 0;
  return {
    providerName: "fake",
    generateReply: jest.fn(async (): Promise<AgentReply> => {
      const reply = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return reply;
    }),
  };
}

describe("runConversationTurn", () => {
  it("returns the agent's text reply directly when no tool call is requested", async () => {
    const agent = makeAgent([{ content: "Hello there!", toolCalls: [] }]);
    const history: AgentMessage[] = [{ role: "user", content: "hi" }];

    const result = await runConversationTurn(agent, history, []);

    expect(result.finalReply).toBe("Hello there!");
    expect(result.history).toHaveLength(2);
    expect(result.history[1]).toMatchObject({ role: "assistant", content: "Hello there!" });
  });

  it("executes a requested tool call and feeds the result back to the agent", async () => {
    const handler = jest.fn(async (args: Record<string, unknown>) => ({ echoed: args.value }));
    const tools: ToolDefinition[] = [
      {
        name: "echo_tool",
        description: "echoes back the given value",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        handler,
      },
    ];

    const agent = makeAgent([
      { content: null, toolCalls: [{ id: "1", name: "echo_tool", args: { value: "abc" } }] },
      { content: "Done, the value was abc.", toolCalls: [] },
    ]);

    const { history, finalReply } = await runConversationTurn(agent, [{ role: "user", content: "echo abc" }], tools);

    expect(handler).toHaveBeenCalledWith({ value: "abc" });
    expect(finalReply).toBe("Done, the value was abc.");

    const toolResultMessage = history.find((m) => m.role === "tool");
    expect(toolResultMessage?.content).toBe(JSON.stringify({ echoed: "abc" }));

    const assistantToolCallMessage = history.find((m) => m.toolName === "echo_tool" && m.role === "assistant");
    expect(assistantToolCallMessage?.toolArgs).toEqual({ value: "abc" });
  });

  it("reports an error result and continues when the tool handler throws", async () => {
    const failingHandler = jest.fn(async () => {
      throw new Error("boom");
    });
    const tools: ToolDefinition[] = [
      {
        name: "failing_tool",
        description: "always fails",
        parameters: { type: "object", properties: {} },
        handler: failingHandler,
      },
    ];

    const agent = makeAgent([
      { content: null, toolCalls: [{ id: "1", name: "failing_tool", args: {} }] },
      { content: "Sorry, something went wrong.", toolCalls: [] },
    ]);

    const { history, finalReply } = await runConversationTurn(agent, [{ role: "user", content: "do it" }], tools);

    expect(finalReply).toBe("Sorry, something went wrong.");
    const toolResultMessage = history.find((m) => m.role === "tool");
    expect(JSON.parse(toolResultMessage!.content)).toEqual({ error: "boom" });
  });

  it("returns an unknown-tool error result when the agent calls a tool that was not provided", async () => {
    const agent = makeAgent([
      { content: null, toolCalls: [{ id: "1", name: "nonexistent_tool", args: {} }] },
      { content: "ok", toolCalls: [] },
    ]);

    const { history } = await runConversationTurn(agent, [{ role: "user", content: "hi" }], []);

    const toolResultMessage = history.find((m) => m.role === "tool");
    expect(JSON.parse(toolResultMessage!.content)).toEqual({ error: "Unknown tool: nonexistent_tool" });
  });

  it("stops after the max roundtrip cap and returns a fallback reply if the agent keeps calling tools", async () => {
    const handler = jest.fn(async () => ({ ok: true }));
    const tools: ToolDefinition[] = [
      {
        name: "looping_tool",
        description: "always requested again",
        parameters: { type: "object", properties: {} },
        handler,
      },
    ];

    const agent: AIAgent = {
      providerName: "fake",
      generateReply: jest.fn(async () => ({
        content: null,
        toolCalls: [{ id: "x", name: "looping_tool", args: {} }],
      })),
    };

    const { finalReply } = await runConversationTurn(agent, [{ role: "user", content: "loop" }], tools);

    expect(finalReply).toMatch(/wasn't able to complete/i);
    expect(agent.generateReply).toHaveBeenCalledTimes(4);
    expect(handler).toHaveBeenCalledTimes(4);
  });
});
