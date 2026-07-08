const callFindUnique = jest.fn();
const callUpdateMany = jest.fn();
const conversationMessageCreate = jest.fn();
const callEventBusPublish = jest.fn();
const loadHistory = jest.fn();
const runStreamingConversationTurn = jest.fn();
const getAIAgent = jest.fn();
const sendSpeech = jest.fn();
const hangupCall = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: {
    call: {
      findUnique: (...args: unknown[]) => callFindUnique(...args),
      updateMany: (...args: unknown[]) => callUpdateMany(...args),
    },
    conversationMessage: { create: (...args: unknown[]) => conversationMessageCreate(...args) },
  },
  CallDirection: { INBOUND: "INBOUND", OUTBOUND: "OUTBOUND" },
  MessageRole: { USER: "USER", ASSISTANT: "ASSISTANT", SYSTEM: "SYSTEM", TOOL: "TOOL" },
}));

jest.mock("@telephony/domain", () => ({ hangupCall: (...args: unknown[]) => hangupCall(...args) }));

jest.mock("../ai/agentFactory", () => ({ getAIAgent: (...args: unknown[]) => getAIAgent(...args) }));

jest.mock("../ai/streamingConversationRunner", () => ({
  runStreamingConversationTurn: (...args: unknown[]) => runStreamingConversationTurn(...args),
}));

jest.mock("../ai/tools/calendarTools", () => ({ buildCalendarTools: () => [] }));
jest.mock("../ai/tools/leadTools", () => ({ buildLeadTools: () => [] }));
jest.mock("../ai/tools/complianceTools", () => ({ buildComplianceTools: () => [] }));
jest.mock("../ai/tools/followUpTools", () => ({ buildFollowUpTools: () => [] }));
jest.mock("../ai/tools/sentimentTools", () => ({ buildSentimentTools: () => [] }));

jest.mock("../conversationHistory", () => ({
  loadHistory: (...args: unknown[]) => loadHistory(...args),
  ROLE_TO_DB: { user: "USER", assistant: "ASSISTANT", system: "SYSTEM", tool: "TOOL" },
}));

jest.mock("../callConversationService", () => ({
  SYSTEM_PROMPT: "you are a test agent",
  buildSystemPrompt: (campaign?: { script?: string | null; objectionPlaybook?: string | null } | null) => {
    const parts = ["you are a test agent"];
    if (campaign?.script) parts.push(campaign.script);
    if (campaign?.objectionPlaybook) parts.push(campaign.objectionPlaybook);
    return parts.join("\n\n");
  },
}));

jest.mock("../sse/eventBus", () => ({
  callEventBus: { publish: (...args: unknown[]) => callEventBusPublish(...args) },
}));

// Fake DeepgramStreamClient: captures the registered "transcript"/"utteranceEnd"
// handlers so tests can fire them directly, simulating real STT events.
let transcriptHandler: (event: { transcript: string; isFinal: boolean; speechFinal: boolean }) => void = () => {};
let utteranceEndHandler: () => void = () => {};
const sttConnect = jest.fn().mockResolvedValue(undefined);
const sttSendAudio = jest.fn();
const sttClose = jest.fn();

jest.mock("./deepgramClient", () => ({
  DeepgramStreamClient: jest.fn().mockImplementation(() => ({
    on: (event: string, handler: (...args: never[]) => void) => {
      if (event === "transcript") transcriptHandler = handler as never;
      if (event === "utteranceEnd") utteranceEndHandler = handler as never;
    },
    connect: sttConnect,
    sendAudio: sttSendAudio,
    close: sttClose,
  })),
}));

jest.mock("./ttsSender", () => ({ sendSpeech: (...args: unknown[]) => sendSpeech(...args) }));

import { CallStreamSession } from "./callStreamSession";
import { encodeClearFrame } from "./telnyxStreamProtocol";

describe("CallStreamSession", () => {
  let sendToTelnyx: jest.Mock;
  let session: CallStreamSession;
  const callOrder: string[] = [];

  beforeEach(async () => {
    jest.clearAllMocks();
    callOrder.length = 0;
    callFindUnique.mockResolvedValue({ id: "call_1", direction: "INBOUND", fromNumber: "+12125551234", leadId: "lead_1" });
    loadHistory.mockResolvedValue([]);
    sendToTelnyx = jest.fn((raw: string) => callOrder.push(`send:${raw}`));
    sendSpeech.mockImplementation(() => ({
      cancel: jest.fn(() => callOrder.push("cancel")),
      done: Promise.resolve(),
    }));

    session = new CallStreamSession({ callId: "call_1", callControlId: "ctrl_1", sendToTelnyx });
    await session.start();
  });

  it("loads history and connects to Deepgram on start", () => {
    expect(loadHistory).toHaveBeenCalledWith("call_1");
    expect(sttConnect).toHaveBeenCalled();
  });

  it("speaks a greeting once when the Telnyx start frame arrives", () => {
    session.handleTelnyxFrame(JSON.stringify({ event: "start", sequence_number: "1", start: { call_control_id: "ctrl_1", stream_id: "s1", media_format: {} } }));

    expect(sendSpeech).toHaveBeenCalledWith("Hi, thanks for calling! How can I help you today?", expect.any(Function));

    session.handleTelnyxFrame(JSON.stringify({ event: "start", sequence_number: "2", start: { call_control_id: "ctrl_1", stream_id: "s1", media_format: {} } }));
    expect(sendSpeech).toHaveBeenCalledTimes(1); // not re-greeted
  });

  it("forwards inbound media audio to Deepgram", () => {
    session.handleTelnyxFrame(
      JSON.stringify({ event: "media", sequence_number: "1", stream_id: "s1", media: { track: "inbound", chunk: "1", timestamp: "0", payload: "AAAA" } })
    );

    expect(sttSendAudio).toHaveBeenCalledWith(Buffer.from("AAAA", "base64"));
  });

  it("on turn-end: persists the user message, runs the agent, and speaks the reply", async () => {
    runStreamingConversationTurn.mockResolvedValue({ history: [], finalReply: "Sure, I can help with that." });

    transcriptHandler({ transcript: "book me thursday", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    expect(conversationMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "USER", content: "book me thursday", interrupted: false }) })
    );
    expect(runStreamingConversationTurn).toHaveBeenCalled();
    expect(sendSpeech).toHaveBeenCalledWith("Sure, I can help with that.", expect.any(Function));
  });

  it("utteranceEnd is a no-op if speechFinal already handled the turn", async () => {
    runStreamingConversationTurn.mockResolvedValue({ history: [], finalReply: "ok" });

    transcriptHandler({ transcript: "hello", isFinal: true, speechFinal: true });
    await flushMicrotasks();
    const callsAfterSpeechFinal = runStreamingConversationTurn.mock.calls.length;

    utteranceEndHandler(); // redundant fallback signal for the same utterance
    await flushMicrotasks();

    expect(runStreamingConversationTurn.mock.calls.length).toBe(callsAfterSpeechFinal);
  });

  it("barge-in during SPEAKING sends clear to Telnyx before cancelling local TTS", async () => {
    runStreamingConversationTurn.mockResolvedValue({ history: [], finalReply: "a fairly long reply that keeps playing" });
    // Keep `done` pending (unlike the default beforeEach mock) so the session
    // stays in SPEAKING - a real TTS pacing loop wouldn't resolve until every
    // frame is sent, which takes real wall-clock time.
    sendSpeech.mockImplementation(() => ({
      cancel: jest.fn(() => callOrder.push("cancel")),
      done: new Promise<void>(() => {}),
    }));

    transcriptHandler({ transcript: "book thursday", isFinal: true, speechFinal: true });
    await flushMicrotasks();
    expect(sendSpeech).toHaveBeenCalledTimes(1);

    // Caller starts talking again while the reply is still genuinely playing.
    transcriptHandler({ transcript: "wait no", isFinal: false, speechFinal: false });

    const clearIndex = callOrder.indexOf(`send:${encodeClearFrame()}`);
    const cancelIndex = callOrder.indexOf("cancel");
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(cancelIndex).toBeGreaterThan(clearIndex);
  });

  it("never speaks a reply decided after the turn was superseded by a barge-in", async () => {
    runStreamingConversationTurn.mockImplementation(async () => {
      // Simulate a barge-in landing while the agent is "thinking".
      transcriptHandler({ transcript: "actually never mind", isFinal: false, speechFinal: false });
      return { history: [], finalReply: "this should never be spoken" };
    });

    transcriptHandler({ transcript: "book thursday", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    expect(sendSpeech).not.toHaveBeenCalled();
  });

  it("hangs up after the goodbye finishes when end_call was requested during the turn", async () => {
    runStreamingConversationTurn.mockResolvedValue({ history: [], finalReply: "Goodbye!" });
    callFindUnique.mockResolvedValue({ endCallRequested: true });

    transcriptHandler({ transcript: "bye", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    expect(sendSpeech).toHaveBeenCalledWith("Goodbye!", expect.any(Function));
    expect(hangupCall).toHaveBeenCalledWith("ctrl_1");
  });

  it("a new utterance clears a stale end_call request, so the next reply doesn't hang up the call", async () => {
    // Simulate the flag left behind by a goodbye turn the caller barged in
    // on: the DB row still says endCallRequested until the new turn's own
    // reset lands.
    let endCallRequested = true;
    callUpdateMany.mockImplementation(async () => {
      endCallRequested = false;
      return { count: 1 };
    });
    callFindUnique.mockImplementation(async (args: { select?: { endCallRequested?: boolean } }) =>
      args?.select?.endCallRequested
        ? { endCallRequested }
        : { id: "call_1", direction: "INBOUND", fromNumber: "+12125551234", leadId: "lead_1" }
    );
    runStreamingConversationTurn.mockResolvedValue({ history: [], finalReply: "Sure, one more thing." });

    transcriptHandler({ transcript: "wait, actually one more question", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    expect(callUpdateMany).toHaveBeenCalledWith({
      where: { id: "call_1", endCallRequested: true },
      data: { endCallRequested: false },
    });
    expect(sendSpeech).toHaveBeenCalledWith("Sure, one more thing.", expect.any(Function));
    expect(hangupCall).not.toHaveBeenCalled();
  });

  it("close() closes the Deepgram connection and cancels any active TTS", async () => {
    runStreamingConversationTurn.mockResolvedValue({ history: [], finalReply: "hello" });
    transcriptHandler({ transcript: "hi", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    session.close();

    expect(sttClose).toHaveBeenCalled();
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
