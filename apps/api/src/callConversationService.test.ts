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

import {
  buildSystemPrompt,
  OBJECTION_HANDLING_BASELINE,
  SYSTEM_PROMPT,
  VERBAL_FILLER_GUIDANCE,
} from "./callConversationService";

describe("OBJECTION_HANDLING_BASELINE", () => {
  it("is embedded in SYSTEM_PROMPT so every call gets it by default", () => {
    expect(SYSTEM_PROMPT).toContain(OBJECTION_HANDLING_BASELINE);
  });
});

describe("VERBAL_FILLER_GUIDANCE", () => {
  it("is embedded in SYSTEM_PROMPT so every call gets it by default", () => {
    expect(SYSTEM_PROMPT).toContain(VERBAL_FILLER_GUIDANCE);
  });
});

// buildSystemPrompt always appends a fresh "current date and time" line (see
// currentDateTimeGuidance in callConversationService.ts) so the model can
// resolve relative dates the caller mentions - fixing the clock keeps these
// assertions deterministic instead of racing the real timestamp.
const FIXED_NOW = "2025-06-01T12:00:00.000Z";
const DATE_GUIDANCE = `The current date and time is ${FIXED_NOW} (UTC). Use this as the reference point for resolving any relative date/time the caller mentions (e.g. "tomorrow", "next Monday", "in an hour") - never infer today's date from a tool parameter's example value or from your own training data.`;

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns the baseline prompt plus current-date guidance when there's no campaign", () => {
    const expected = `${SYSTEM_PROMPT}\n\n${DATE_GUIDANCE}`;
    expect(buildSystemPrompt(null)).toBe(expected);
    expect(buildSystemPrompt(undefined)).toBe(expected);
    expect(buildSystemPrompt({})).toBe(expected);
  });

  it("appends the campaign script when set", () => {
    const result = buildSystemPrompt({ script: "Ask about renewal" });
    expect(result).toBe(`${SYSTEM_PROMPT}\n\n${DATE_GUIDANCE}\n\nCampaign script/guidance:\nAsk about renewal`);
  });

  it("appends the objection playbook when set", () => {
    const result = buildSystemPrompt({ objectionPlaybook: "If price comes up, mention the payment plan" });
    expect(result).toBe(
      `${SYSTEM_PROMPT}\n\n${DATE_GUIDANCE}\n\nCampaign objection playbook:\nIf price comes up, mention the payment plan`
    );
  });

  it("appends both script and objection playbook, script first, when both are set", () => {
    const result = buildSystemPrompt({
      script: "Ask about renewal",
      objectionPlaybook: "If price comes up, mention the payment plan",
    });
    expect(result).toBe(
      `${SYSTEM_PROMPT}\n\n${DATE_GUIDANCE}\n\nCampaign script/guidance:\nAsk about renewal` +
        `\n\nCampaign objection playbook:\nIf price comes up, mention the payment plan`
    );
  });

  it("ignores null/empty values for script and objectionPlaybook", () => {
    const expected = `${SYSTEM_PROMPT}\n\n${DATE_GUIDANCE}`;
    expect(buildSystemPrompt({ script: null, objectionPlaybook: null })).toBe(expected);
    expect(buildSystemPrompt({ script: "", objectionPlaybook: "" })).toBe(expected);
  });

  it("appends inbound/outbound direction guidance when a direction is given", () => {
    expect(buildSystemPrompt(null, "INBOUND" as never)).toContain("This caller dialed in to reach you");
    expect(buildSystemPrompt(null, "OUTBOUND" as never)).toContain("You initiated this call");
  });
});
