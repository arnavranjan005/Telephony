jest.mock("@telephony/database", () => ({
  prisma: { call: { findUnique: jest.fn() }, conversationMessage: { createMany: jest.fn() } },
  CallDirection: { INBOUND: "INBOUND", OUTBOUND: "OUTBOUND" },
  MessageRole: { USER: "USER", ASSISTANT: "ASSISTANT", SYSTEM: "SYSTEM", TOOL: "TOOL" },
}));

jest.mock("@telephony/domain", () => ({ speakText: jest.fn() }));
jest.mock("./ai/agentFactory", () => ({ getAIAgent: jest.fn() }));
jest.mock("./ai/conversationRunner", () => ({ runConversationTurn: jest.fn() }));
jest.mock("./ai/tools/calendarTools", () => ({ buildCalendarTools: () => [] }));
jest.mock("./ai/tools/leadTools", () => ({ buildLeadTools: () => [] }));
jest.mock("./ai/tools/complianceTools", () => ({ buildComplianceTools: () => [] }));
jest.mock("./ai/tools/followUpTools", () => ({ buildFollowUpTools: () => [] }));
jest.mock("./ai/tools/sentimentTools", () => ({ buildSentimentTools: () => [] }));
jest.mock("./sse/eventBus", () => ({ callEventBus: { publish: jest.fn() } }));
jest.mock("./conversationHistory", () => ({
  loadHistory: jest.fn(),
  ROLE_TO_DB: { user: "USER", assistant: "ASSISTANT", system: "SYSTEM", tool: "TOOL" },
}));

import { buildSystemPrompt, SYSTEM_PROMPT } from "./callConversationService";

describe("buildSystemPrompt", () => {
  it("returns the baseline prompt when there's no campaign", () => {
    expect(buildSystemPrompt(null)).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined)).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({})).toBe(SYSTEM_PROMPT);
  });

  it("appends the campaign script when set", () => {
    const result = buildSystemPrompt({ script: "Ask about renewal" });
    expect(result).toBe(`${SYSTEM_PROMPT}\n\nCampaign script/guidance:\nAsk about renewal`);
  });

  it("appends the objection playbook when set", () => {
    const result = buildSystemPrompt({ objectionPlaybook: "If price comes up, mention the payment plan" });
    expect(result).toBe(`${SYSTEM_PROMPT}\n\nCampaign objection playbook:\nIf price comes up, mention the payment plan`);
  });

  it("appends both script and objection playbook, script first, when both are set", () => {
    const result = buildSystemPrompt({
      script: "Ask about renewal",
      objectionPlaybook: "If price comes up, mention the payment plan",
    });
    expect(result).toBe(
      `${SYSTEM_PROMPT}\n\nCampaign script/guidance:\nAsk about renewal` +
        `\n\nCampaign objection playbook:\nIf price comes up, mention the payment plan`
    );
  });

  it("ignores null/empty values for script and objectionPlaybook", () => {
    expect(buildSystemPrompt({ script: null, objectionPlaybook: null })).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({ script: "", objectionPlaybook: "" })).toBe(SYSTEM_PROMPT);
  });
});
