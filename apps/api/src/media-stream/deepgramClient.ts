import { EventEmitter } from "events";
import { DeepgramClient } from "@deepgram/sdk";
import { env } from "@telephony/config";

export interface DeepgramTranscriptEvent {
  transcript: string;
  /** Deepgram has finalized its best guess for this segment - the caller may not be done talking yet. */
  isFinal: boolean;
  /** VAD-based silence detected after speech - the real "caller is done talking" turn-end signal. */
  speechFinal: boolean;
}

type Socket = Awaited<ReturnType<DeepgramClient["listen"]["v1"]["connect"]>>;

/**
 * Thin wrapper around @deepgram/sdk's live-transcription socket. Emits:
 * - "transcript" for every Results message (interim and final segments)
 * - "utteranceEnd" as a fallback turn-end signal, in case speechFinal never fires
 * - "error" / "close" passthroughs
 *
 * See apps/api/src/media-stream/callStreamSession.ts for how these are used
 * to detect barge-in (any transcript while SPEAKING/THINKING) vs turn-end
 * (speechFinal, with utteranceEnd as the fallback).
 */
export class DeepgramStreamClient extends EventEmitter {
  private socket: Socket | null = null;

  async connect(): Promise<void> {
    const client = new DeepgramClient({ apiKey: env.DEEPGRAM_API_KEY });

    this.socket = await client.listen.v1.connect({
      model: env.DEEPGRAM_MODEL,
      encoding: "linear16",
      sample_rate: env.MEDIA_STREAM_SAMPLE_RATE,
      channels: 1,
      interim_results: "true",
      punctuate: "true",
      endpointing: 300,
      utterance_end_ms: 1000,
    });

    // `client.listen.v1.connect()` only constructs the socket wrapper - it
    // doesn't start the connection or wait for it to open. Without these two
    // calls, sendMedia() throws "Socket is not open" for the whole call.
    this.socket.connect();
    await this.socket.waitForOpen();

    this.socket.on("message", (message) => {
      if (message.type === "Results") {
        const alternative = message.channel?.alternatives?.[0];
        this.emit("transcript", {
          transcript: alternative?.transcript ?? "",
          isFinal: Boolean(message.is_final),
          speechFinal: Boolean(message.speech_final),
        } satisfies DeepgramTranscriptEvent);
      } else if (message.type === "UtteranceEnd") {
        this.emit("utteranceEnd");
      }
    });

    this.socket.on("error", (error) => this.emit("error", error));
    this.socket.on("close", () => this.emit("close"));
  }

  sendAudio(chunk: Buffer): void {
    // A frame can still race the handshake (this.socket is assigned before
    // waitForOpen() resolves - see mediaStreamServer.ts's comment on the same
    // race for handleTelnyxFrame/session.start()). Drop it rather than throw;
    // losing a few ms of audio at turn start is fine, crashing the call isn't.
    if (!this.socket || this.socket.readyState !== 1 /* OPEN */) return;
    this.socket.sendMedia(chunk);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
