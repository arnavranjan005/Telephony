import { prisma, CallDirection } from "@telephony/database";
import { getAIAgent } from "../ai/agentFactory";
import { runStreamingConversationTurn, StreamingTurnContext } from "../ai/streamingConversationRunner";
import { AgentMessage, ToolDefinition } from "../ai/types";
import { buildCalendarTools } from "../ai/tools/calendarTools";
import { buildLeadTools } from "../ai/tools/leadTools";
import { buildComplianceTools } from "../ai/tools/complianceTools";
import { buildFollowUpTools } from "../ai/tools/followUpTools";
import { loadHistory, ROLE_TO_DB } from "../conversationHistory";
import { SYSTEM_PROMPT } from "../callConversationService";
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
        streamingEnabled: call?.streamingEnabled,
      }),
    ];
    const campaignScript = call?.campaignContact?.campaign.script;
    this.systemPrompt = campaignScript ? `${SYSTEM_PROMPT}\n\nCampaign script/guidance:\n${campaignScript}` : SYSTEM_PROMPT;

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

  private async handleTurnEnd(): Promise<void> {
    if (this.state !== "LISTENING") return; // already handled (e.g. speechFinal beat a redundant utteranceEnd)

    const transcript = this.transcriptBuffer.trim();
    this.transcriptBuffer = "";
    if (!transcript) return;

    const userMessage: AgentMessage = { role: "user", content: transcript };
    this.history.push(userMessage);
    await this.persistMessage(userMessage, false); // unconditional - this genuinely happened

    this.abortController = new AbortController();
    const version = this.turnVersion;
    this.state = "THINKING";

    const context: StreamingTurnContext = {
      callId: this.options.callId,
      version,
      getCurrentVersion: () => this.turnVersion,
      signal: this.abortController.signal,
      runExclusive: (fn) => this.runExclusive(fn),
    };

    const { history: updatedHistory, finalReply } = await runStreamingConversationTurn(
      getAIAgent(),
      this.history,
      this.tools,
      this.systemPrompt,
      context
    );
    this.history = updatedHistory;

    if (this.turnVersion !== version) return; // superseded while generating - stay in LISTENING, don't speak

    if (finalReply) {
      await this.speak(finalReply);
    } else {
      this.state = "LISTENING";
    }
  }

  private async speak(text: string): Promise<void> {
    this.state = "SPEAKING";
    const version = this.turnVersion;
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
