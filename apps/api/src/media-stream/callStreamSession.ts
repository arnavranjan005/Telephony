import { prisma, CallDirection } from "@telephony/database";
import { hangupCall } from "@telephony/domain";
import { getAIAgent } from "../ai/agentFactory";
import { runStreamingConversationTurn, StreamingTurnContext } from "../ai/streamingConversationRunner";
import { AgentMessage, ToolDefinition } from "../ai/types";
import { buildCalendarTools } from "../ai/tools/calendarTools";
import { buildLeadTools } from "../ai/tools/leadTools";
import { buildComplianceTools } from "../ai/tools/complianceTools";
import { buildFollowUpTools } from "../ai/tools/followUpTools";
import { buildSentimentTools } from "../ai/tools/sentimentTools";
import { buildCallControlTools } from "../ai/tools/callControlTools";
import { loadHistory, ROLE_TO_DB } from "../conversationHistory";
import { SYSTEM_PROMPT, buildSystemPrompt } from "../callConversationService";
import { callEventBus } from "../sse/eventBus";
import { DeepgramStreamClient, DeepgramTranscriptEvent } from "./deepgramClient";
import { sendSpeech, TtsSendHandle } from "./ttsSender";
import { decodeAudioPayload, decodeInboundFrame, encodeClearFrame, encodeMediaFrame } from "./telnyxStreamProtocol";

type SessionState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING";

export interface CallStreamSessionOptions {
  callId: string;
  callControlId: string;
  /** Sends a raw frame string out over the Telnyx WebSocket - injected so this
   * class stays testable without a real `ws` connection. */
  sendToTelnyx: (raw: string) => void;
}

/**
 * Owns the real-time state machine for one streaming call: IDLE -> LISTENING
 * (Deepgram connected, waiting for speech) -> THINKING (turn ended, running
 * the agent) -> SPEAKING (playing the reply), with barge-in able to interrupt
 * THINKING or SPEAKING back to LISTENING at any point. See the plan doc /
 * README for the full design rationale; this class is the concrete
 * implementation of that state machine.
 */
export class CallStreamSession {
  private state: SessionState = "IDLE";
  private turnVersion = 0;
  private abortController: AbortController | null = null;
  private history: AgentMessage[] = [];
  private stt: DeepgramStreamClient | null = null;
  private activeTts: TtsSendHandle | null = null;
  private toolLock: Promise<void> = Promise.resolve();
  // FIFO mutex for speak() - an interim reply (see onInterimReply in
  // runTurn) is spoken fire-and-forget while its tool call keeps running, so
  // a later speak() (the eventual final reply, or another interim reply from
  // a subsequent round) can be requested before an earlier one finishes.
  // Waiting on a single snapshotted `this.activeTts` handle isn't enough - a
  // third call arriving while a second is still waiting on the first could
  // also see the first's handle and race the second to claim `activeTts`,
  // leaving two TTS streams sending frames concurrently. A real queue (same
  // pattern as toolLock above) rules that out regardless of how many
  // speak() calls stack up.
  private ttsQueue: Promise<void> = Promise.resolve();
  private transcriptBuffer = "";
  private tools: ToolDefinition[] = [];
  private systemPrompt = SYSTEM_PROMPT;
  private greeted = false;

  constructor(private readonly options: CallStreamSessionOptions) {}

  async start(): Promise<void> {
    const call = await prisma.call.findUnique({
      where: { id: this.options.callId },
      include: { campaignContact: { include: { campaign: true } } },
    });

    this.history = await loadHistory(this.options.callId);

    const callerPhoneNumber = call?.direction === CallDirection.INBOUND ? call.fromNumber : call?.toNumber;
    this.tools = [
      ...buildCalendarTools({ leadId: call?.leadId ?? undefined, callId: this.options.callId }),
      ...buildLeadTools({ leadId: call?.leadId ?? undefined }),
      ...buildComplianceTools({ phoneNumber: callerPhoneNumber }),
      ...buildFollowUpTools({
        leadId: call?.leadId ?? undefined,
        phoneNumber: callerPhoneNumber,
        callId: this.options.callId,
        streamingEnabled: call?.streamingEnabled,
      }),
      ...buildSentimentTools(),
      ...buildCallControlTools({ callId: this.options.callId }),
    ];
    this.systemPrompt = buildSystemPrompt(call?.campaignContact?.campaign, call?.direction);

    this.stt = new DeepgramStreamClient();
    this.stt.on("transcript", (event: DeepgramTranscriptEvent) => this.handleTranscript(event));
    this.stt.on("utteranceEnd", () => void this.handleTurnEnd());
    this.stt.on("error", (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`Deepgram stream error for call ${this.options.callId}:`, error);
    });
    await this.stt.connect();

    this.state = "LISTENING";
  }

  /** Handles one decoded Telnyx media-stream frame. */
  handleTelnyxFrame(raw: string): void {
    const frame = decodeInboundFrame(raw);
    if (!frame) return;

    if (frame.event === "media" && frame.media.track === "inbound") {
      this.stt?.sendAudio(decodeAudioPayload(frame.media.payload));
      return;
    }

    if (frame.event === "start" && !this.greeted) {
      this.greeted = true;
      // eslint-disable-next-line no-console
      console.log(`Media stream negotiated format for call ${this.options.callId}:`, frame.start.media_format);
      void this.speak("Hi, thanks for calling! How can I help you today?");
      return;
    }

    if (frame.event === "stop") {
      this.close();
    }
  }

  private handleTranscript(event: DeepgramTranscriptEvent): void {
    if (event.transcript && (this.state === "THINKING" || this.state === "SPEAKING")) {
      this.bargeIn();
    }

    if (event.transcript && event.isFinal) {
      this.transcriptBuffer = `${this.transcriptBuffer} ${event.transcript}`.trim();
    }

    if (event.speechFinal) {
      void this.handleTurnEnd();
    }
  }

  /**
   * Caller started talking while we were still generating/speaking a reply.
   * Bumps turnVersion (the authoritative staleness check everywhere), sends
   * `clear` to Telnyx *before* tearing down our own TTS resources (stale
   * audio is already buffered on Telnyx's side regardless of what we do
   * locally - see the plan's TTS-cancellation-ordering note), then returns to
   * LISTENING. AbortSignal is best-effort only (doesn't stop server-side LLM
   * billing/generation, see googleAgent.ts) - turnVersion is what actually
   * prevents a stale reply from being spoken or persisted.
   */
  private bargeIn(): void {
    this.turnVersion += 1;
    this.abortController?.abort();

    if (this.state === "SPEAKING") {
      this.options.sendToTelnyx(encodeClearFrame());
      this.activeTts?.cancel();
      this.activeTts = null;
    }

    this.state = "LISTENING";
  }

  /**
   * Invoked fire-and-forget (`void this.handleTurnEnd()`) from Deepgram event
   * handlers, not from the WebSocket message handler's own promise chain - so
   * any rejection here (e.g. the abort signal firing mid-generateContent on a
   * barge-in) would otherwise be an unhandled rejection that crashes the
   * whole process, taking down every other in-progress call. Catches
   * everything and falls back to LISTENING so one bad turn can't kill the
   * server or wedge this call.
   */
  private async handleTurnEnd(): Promise<void> {
    const version = this.turnVersion;
    try {
      await this.runTurn();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Turn failed for call ${this.options.callId}:`, error);
      // Only speak the fallback if we'd actually committed to replying (state
      // reached THINKING) and nothing superseded this turn in the meantime
      // (e.g. a barge-in) - otherwise this would talk over/after a turn that
      // isn't ours anymore. A caller who gets silence after "I can't hear
      // you" has no idea whether to keep talking or hang up; this at least
      // tells them something's wrong rather than leaving dead air.
      if (this.state === "THINKING" && this.turnVersion === version) {
        this.state = "LISTENING";
        const fallbackReply = "Sorry, I'm having trouble on my end - could you give me just a moment?";
        try {
          await this.speak(fallbackReply);
          // Without this the transcript shows dead air even though the AI
          // was actually talking - which is exactly what made this failure
          // mode look like a silent/audio bug instead of the rate-limit
          // errors it actually was.
          await this.persistMessage({ role: "assistant", content: fallbackReply }, false);
        } catch (speakError) {
          // eslint-disable-next-line no-console
          console.error(`Fallback speech also failed for call ${this.options.callId}:`, speakError);
        }
      } else if (this.state === "THINKING") {
        this.state = "LISTENING";
      }
    }
  }

  private async runTurn(): Promise<void> {
    if (this.state !== "LISTENING") return; // already handled (e.g. speechFinal beat a redundant utteranceEnd)

    const transcript = this.transcriptBuffer.trim();
    this.transcriptBuffer = "";
    if (!transcript) return;

    const userMessage: AgentMessage = { role: "user", content: transcript };
    this.history.push(userMessage);
    await this.persistMessage(userMessage, false); // unconditional - this genuinely happened

    // The caller re-engaged, so any earlier end_call intent is stale. Without
    // this reset a barge-in during the goodbye only keeps the call open for
    // one turn - the leftover flag would hang up right after the next reply,
    // mid-conversation. Routed through the tool lock so it's ordered after a
    // superseded turn's still-running end_call handler rather than racing it.
    await this.runExclusive(() =>
      prisma.call.updateMany({
        where: { id: this.options.callId, endCallRequested: true },
        data: { endCallRequested: false },
      })
    );

    this.abortController = new AbortController();
    const version = this.turnVersion;
    this.state = "THINKING";

    const context: StreamingTurnContext = {
      callId: this.options.callId,
      version,
      getCurrentVersion: () => this.turnVersion,
      signal: this.abortController.signal,
      runExclusive: (fn) => this.runExclusive(fn),
      // Speaks any text the model attaches to a tool call (e.g. an apology or
      // acknowledgement) as soon as it's produced, rather than letting it sit
      // silent in the transcript until - if ever - a later text-only reply
      // gets spoken. Guarded on version: a barge-in between the round
      // starting and this firing means it isn't ours to speak anymore.
      onInterimReply: (text) => {
        if (this.turnVersion === version) void this.speak(text);
      },
    };

    let updatedHistory: AgentMessage[];
    let finalReply: string | null;
    try {
      ({ history: updatedHistory, finalReply } = await runStreamingConversationTurn(
        getAIAgent(),
        this.history,
        this.tools,
        this.systemPrompt,
        context
      ));
    } catch (error) {
      if (this.turnVersion !== version) return; // aborted by our own barge-in - not a real failure
      throw error;
    }
    this.history = updatedHistory;

    if (this.turnVersion !== version) return; // superseded while generating - stay in LISTENING, don't speak

    if (finalReply) {
      await this.speak(finalReply);
      // Only hang up if nothing (e.g. barge-in) superseded this turn while the
      // goodbye line was still playing - an interruption means the caller
      // wants to keep talking, so the call should stay open.
      if (this.turnVersion === version) {
        const call = await prisma.call.findUnique({
          where: { id: this.options.callId },
          select: { endCallRequested: true },
        });
        if (call?.endCallRequested) {
          await hangupCall(this.options.callControlId);
        }
      }
    } else {
      this.state = "LISTENING";
    }
  }

  // Queues onto ttsQueue rather than running immediately - see the field's
  // comment. Version is captured now (at request time), not when this
  // actually gets to run, so a speak() queued behind another one correctly
  // detects a barge-in that happened while it was waiting its turn.
  private speak(text: string): Promise<void> {
    const version = this.turnVersion;
    const run = this.ttsQueue.then(
      () => this.speakNow(text, version),
      () => this.speakNow(text, version)
    );
    this.ttsQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async speakNow(text: string, version: number): Promise<void> {
    if (this.turnVersion !== version) return; // superseded while queued behind an earlier speak()

    this.state = "SPEAKING";
    this.activeTts = sendSpeech(text, (payload) => this.options.sendToTelnyx(encodeMediaFrame(payload)));
    await this.activeTts.done;
    if (this.turnVersion === version) {
      this.state = "LISTENING";
    }
  }

  /**
   * Serializes tool-handler execution across the whole call (not just one
   * turn): guarantees at most one tool handler ever runs at a time, so an old
   * superseded turn's tool call can never race a new turn's tool call and
   * produce two independently-successful, conflicting side effects (e.g. two
   * competing appointment bookings) - or worse, land in conversation history
   * out of order in a way the LLM has no way to detect (it has no innate
   * sense of timing, only message order). Scope is narrow on purpose: this
   * only gates the tool-handler invocation itself, not barge-in (still
   * instant), STT, or the next turn's own LLM call.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.toolLock.then(fn, fn);
    this.toolLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async persistMessage(message: AgentMessage, interrupted: boolean): Promise<void> {
    await prisma.conversationMessage.create({
      data: {
        callId: this.options.callId,
        role: ROLE_TO_DB[message.role],
        content: message.content,
        toolName: message.toolName,
        toolArgs: message.toolArgs as never,
        interrupted,
      },
    });
    callEventBus.publish(this.options.callId, "conversation.message", message);
  }

  close(): void {
    this.stt?.close();
    this.activeTts?.cancel();
    this.state = "IDLE";
  }
}
