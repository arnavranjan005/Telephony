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

const DEFAULT_INBOUND_GREETING = "Hi, thanks for calling! How can I help you today?";
const DEFAULT_OUTBOUND_OPENING_LINE = "Hi, thanks for picking up - this is an automated call, do you have a quick moment?";

jest.mock("../callConversationService", () => ({
  SYSTEM_PROMPT: "you are a test agent",
  buildSystemPrompt: (campaign?: { script?: string | null; objectionPlaybook?: string | null } | null) => {
    const parts = ["you are a test agent"];
    if (campaign?.script) parts.push(campaign.script);
    if (campaign?.objectionPlaybook) parts.push(campaign.objectionPlaybook);
    return parts.join("\n\n");
  },
  resolveGreeting: (direction?: string, campaign?: { openingLine?: string | null } | null) => {
    if (direction === "OUTBOUND") return campaign?.openingLine?.trim() || DEFAULT_OUTBOUND_OPENING_LINE;
    return DEFAULT_INBOUND_GREETING;
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

  it("speaks a greeting once when the Telnyx start frame arrives, and persists it (both to the DB and to in-memory history for the LLM's own context)", async () => {
    session.handleTelnyxFrame(JSON.stringify({ event: "start", sequence_number: "1", start: { call_control_id: "ctrl_1", stream_id: "s1", media_format: {} } }));
    // speak() queues onto ttsQueue (see callStreamSession.ts) rather than
    // calling sendSpeech synchronously, so it needs a tick to actually run.
    await flushMicrotasks();

    expect(sendSpeech).toHaveBeenCalledWith(DEFAULT_INBOUND_GREETING, expect.any(Function));
    expect(conversationMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "ASSISTANT", content: DEFAULT_INBOUND_GREETING }) })
    );

    session.handleTelnyxFrame(JSON.stringify({ event: "start", sequence_number: "2", start: { call_control_id: "ctrl_1", stream_id: "s1", media_format: {} } }));
    await flushMicrotasks();
    expect(sendSpeech).toHaveBeenCalledTimes(1); // not re-greeted

    // The greeting is now part of the history handed to the model's next
    // turn, not just something that was spoken and forgotten.
    runStreamingConversationTurn.mockResolvedValue({ history: [], finalReply: "ok" });
    transcriptHandler({ transcript: "hi", isFinal: true, speechFinal: true });
    await flushMicrotasks();
    const historyArg = runStreamingConversationTurn.mock.calls[0][1];
    expect(historyArg).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "assistant", content: DEFAULT_INBOUND_GREETING })])
    );
  });

  it("speaks the campaign's openingLine (not the inbound greeting) when the call is outbound", async () => {
    callFindUnique.mockResolvedValue({
      id: "call_1",
      direction: "OUTBOUND",
      toNumber: "+12125551234",
      leadId: "lead_1",
      campaignContact: { campaign: { openingLine: "Hi, this is Acquire Right calling about your quote." } },
    });
    const outboundSession = new CallStreamSession({ callId: "call_2", callControlId: "ctrl_2", sendToTelnyx });
    await outboundSession.start();

    outboundSession.handleTelnyxFrame(JSON.stringify({ event: "start", sequence_number: "1", start: { call_control_id: "ctrl_2", stream_id: "s1", media_format: {} } }));
    await flushMicrotasks();

    expect(sendSpeech).toHaveBeenCalledWith("Hi, this is Acquire Right calling about your quote.", expect.any(Function));
  });

  it("falls back to the generic outbound opening line when there's no campaign (e.g. a follow-up call) or the campaign didn't set one", async () => {
    callFindUnique.mockResolvedValue({ id: "call_1", direction: "OUTBOUND", toNumber: "+12125551234", leadId: "lead_1" });
    const outboundSession = new CallStreamSession({ callId: "call_2", callControlId: "ctrl_2", sendToTelnyx });
    await outboundSession.start();

    outboundSession.handleTelnyxFrame(JSON.stringify({ event: "start", sequence_number: "1", start: { call_control_id: "ctrl_2", stream_id: "s1", media_format: {} } }));
    await flushMicrotasks();

    expect(sendSpeech).toHaveBeenCalledWith(DEFAULT_OUTBOUND_OPENING_LINE, expect.any(Function));
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

  it("hangs up immediately without speaking anything hardcoded, when end_call was already requested before the turn failed", async () => {
    runStreamingConversationTurn.mockRejectedValue(new Error("boom"));
    callFindUnique.mockResolvedValue({ endCallRequested: true });

    transcriptHandler({ transcript: "bye", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    expect(hangupCall).toHaveBeenCalledWith("ctrl_1");
    // Only a goodbye the model actually generated is ever spoken - the turn
    // failed to produce one, so the hangup is silent.
    expect(sendSpeech).not.toHaveBeenCalled();
  });

  it("does not hang up over a caller who starts talking while the end_call lookup is in flight", async () => {
    runStreamingConversationTurn.mockRejectedValue(new Error("boom"));
    callFindUnique.mockImplementation(async (args: { select?: { endCallRequested?: boolean } }) => {
      if (args?.select?.endCallRequested) {
        // Caller re-engages exactly while the recovery path is querying the
        // stale endCallRequested flag - state must still be THINKING here so
        // this registers as a barge-in (bumping turnVersion) instead of
        // going unnoticed.
        transcriptHandler({ transcript: "oh wait, one more thing", isFinal: false, speechFinal: false });
        return { endCallRequested: true };
      }
      return { id: "call_1", direction: "INBOUND", fromNumber: "+12125551234", leadId: "lead_1" };
    });

    transcriptHandler({ transcript: "bye", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    expect(hangupCall).not.toHaveBeenCalled();
    expect(sendSpeech).not.toHaveBeenCalled(); // no trouble line over the caller either
  });

  it("does not let a failing end_call lookup escape (fire-and-forget context) - falls back to the trouble line instead", async () => {
    runStreamingConversationTurn.mockRejectedValue(new Error("boom"));
    // The turn failed because the DB is down - so the endCallRequested
    // lookup in the recovery path hits the same dead DB.
    callFindUnique.mockRejectedValue(new Error("db down"));

    transcriptHandler({ transcript: "hello", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    expect(sendSpeech).toHaveBeenCalledWith(
      "Sorry, I'm having trouble on my end - could you give me just a moment?",
      expect.any(Function)
    );
    expect(hangupCall).not.toHaveBeenCalled();
  });

  it("does not let a failing hangup escape when the caller already hung up on their own", async () => {
    runStreamingConversationTurn.mockRejectedValue(new Error("boom"));
    callFindUnique.mockResolvedValue({ endCallRequested: true });
    hangupCall.mockRejectedValueOnce(new Error("call already ended"));

    transcriptHandler({ transcript: "bye", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    // The rejection is contained - reaching this assertion at all means
    // handleTurnEnd's promise settled instead of escaping unhandled.
    expect(hangupCall).toHaveBeenCalledWith("ctrl_1");
  });

  it("does not hang up (or speak) on a failed turn if the caller barged in before it failed, even with end_call set", async () => {
    runStreamingConversationTurn.mockImplementation(async () => {
      // Caller starts talking again while this turn is still "thinking" -
      // same as the barge-in test above, this bumps turnVersion immediately.
      transcriptHandler({ transcript: "wait, hold on", isFinal: false, speechFinal: false });
      throw new Error("boom");
    });
    callFindUnique.mockResolvedValue({ endCallRequested: true });

    transcriptHandler({ transcript: "bye", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    expect(hangupCall).not.toHaveBeenCalled();
    expect(sendSpeech).not.toHaveBeenCalled(); // not our turn to speak over the caller anymore
  });

  it("still speaks the fallback line when the turn fails and end_call was never requested", async () => {
    runStreamingConversationTurn.mockRejectedValue(new Error("boom"));
    callFindUnique.mockResolvedValue({ endCallRequested: false });

    transcriptHandler({ transcript: "hello", isFinal: true, speechFinal: true });
    await flushMicrotasks();

    expect(sendSpeech).toHaveBeenCalledWith(
      "Sorry, I'm having trouble on my end - could you give me just a moment?",
      expect.any(Function)
    );
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
