const conversationMessageCreate = jest.fn();
const callEventBusPublish = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: { conversationMessage: { create: (...args: unknown[]) => conversationMessageCreate(...args) } },
  MessageRole: { USER: "USER", ASSISTANT: "ASSISTANT", SYSTEM: "SYSTEM", TOOL: "TOOL" },
}));

jest.mock("../sse/eventBus", () => ({
  callEventBus: { publish: (...args: unknown[]) => callEventBusPublish(...args) },
}));

import { runStreamingConversationTurn, StreamingTurnContext } from "./streamingConversationRunner";
import { AIAgent, AgentReply } from "./types";

function makeContext(overrides: Partial<StreamingTurnContext> = {}): StreamingTurnContext {
  return {
    callId: "call_1",
    version: 1,
    getCurrentVersion: () => 1,
    signal: new AbortController().signal,
    runExclusive: async (fn) => fn(),
    ...overrides,
  };
}

function makeAgent(replies: AgentReply[]): AIAgent {
  let call = 0;
  return {
    providerName: "fake",
    generateReply: jest.fn(async () => replies[call++]),
  };
}

describe("runStreamingConversationTurn", () => {
  beforeEach(() => jest.clearAllMocks());

  it("persists the final reply and returns it when nothing goes stale", async () => {
    const agent = makeAgent([{ content: "Sure, 2pm works!", toolCalls: [] }]);
    const context = makeContext();

    const result = await runStreamingConversationTurn(agent, [], [], undefined, context);

    expect(result.finalReply).toBe("Sure, 2pm works!");
    expect(conversationMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ callId: "call_1", role: "ASSISTANT", content: "Sure, 2pm works!", interrupted: false }),
    });
  });

  it("abandons the turn (finalReply: null) if superseded before the first round even starts", async () => {
    const agent = makeAgent([{ content: "should never be spoken", toolCalls: [] }]);
    const context = makeContext({ getCurrentVersion: () => 2 }); // already stale vs version 1

    const result = await runStreamingConversationTurn(agent, [], [], undefined, context);

    expect(result.finalReply).toBeNull();
    expect(agent.generateReply).not.toHaveBeenCalled();
    expect(conversationMessageCreate).not.toHaveBeenCalled();
  });

  it("never speaks or persists a plain reply decided after the turn went stale", async () => {
    let current = 1;
    const agent = makeAgent([{ content: "stale reply", toolCalls: [] }]);
    const context = makeContext({ getCurrentVersion: () => current });

    // Simulate a barge-in landing while generateReply was in flight.
    (agent.generateReply as jest.Mock).mockImplementation(async () => {
      current = 2;
      return { content: "stale reply", toolCalls: [] };
    });

    const result = await runStreamingConversationTurn(agent, [], [], undefined, context);

    expect(result.finalReply).toBeNull();
    expect(conversationMessageCreate).not.toHaveBeenCalled();
  });

  it("always persists a tool call's result, even for a turn that went stale mid-flight, marked interrupted", async () => {
    let current = 1;
    const agent = makeAgent([
      { content: null, toolCalls: [{ id: "tc_1", name: "book_appointment", args: { time: "2pm" } }] },
    ]);
    const tool = {
      name: "book_appointment",
      description: "",
      parameters: { type: "object" as const, properties: {} },
      handler: jest.fn(async () => {
        current = 2; // barge-in lands while the tool is mid-flight
        return { booked: true };
      }),
    };
    const context = makeContext({ getCurrentVersion: () => current });

    const result = await runStreamingConversationTurn(agent, [], [tool], undefined, context);

    expect(tool.handler).toHaveBeenCalledWith({ time: "2pm" });
    expect(result.finalReply).toBeNull(); // turn abandoned, nothing spoken
    // Both the tool-call and tool-result messages are still persisted, marked interrupted.
    expect(conversationMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: "ASSISTANT", toolName: "book_appointment", interrupted: true }),
    });
    expect(conversationMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: "TOOL", toolName: "book_appointment", interrupted: true }),
    });
  });

  it("serializes tool execution through context.runExclusive", async () => {
    const agent = makeAgent([
      { content: null, toolCalls: [{ id: "tc_1", name: "add_to_dnc", args: {} }] },
      { content: "Done!", toolCalls: [] },
    ]);
    const tool = {
      name: "add_to_dnc",
      description: "",
      parameters: { type: "object" as const, properties: {} },
      handler: jest.fn(async () => ({ added: true })),
    };
    const runExclusive = jest.fn(async (fn: () => Promise<unknown>) => fn());
    const context = makeContext({ runExclusive: runExclusive as StreamingTurnContext["runExclusive"] });

    await runStreamingConversationTurn(agent, [], [tool], undefined, context);

    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(tool.handler).toHaveBeenCalled();
  });

  it("still returns the final reply even if persisting it to the DB fails", async () => {
    const agent = makeAgent([{ content: "Alright, goodbye!", toolCalls: [] }]);
    const context = makeContext();
    conversationMessageCreate.mockRejectedValueOnce(new Error("DB unavailable"));

    const result = await runStreamingConversationTurn(agent, [], [], undefined, context);

    expect(result.finalReply).toBe("Alright, goodbye!"); // reply already generated - never discarded
  });

  it("persists a tool result for an unknown tool name without throwing", async () => {
    const agent = makeAgent([
      { content: null, toolCalls: [{ id: "tc_1", name: "nonexistent_tool", args: {} }] },
      { content: "ok", toolCalls: [] },
    ]);
    const context = makeContext();

    const result = await runStreamingConversationTurn(agent, [], [], undefined, context);

    expect(result.finalReply).toBe("ok");
    expect(conversationMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: "TOOL", content: JSON.stringify({ error: "Unknown tool: nonexistent_tool" }) }),
    });
  });
});
