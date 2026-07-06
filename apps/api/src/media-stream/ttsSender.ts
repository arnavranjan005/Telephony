import { env } from "@telephony/config";
import { encodeAudioPayload } from "./telnyxStreamProtocol";

const FRAME_DURATION_MS = 20;
const BYTES_PER_SAMPLE = 2; // pcm_8000 / L16 is 16-bit signed PCM

export interface TtsSendHandle {
  /** Stops the pacing loop early - already-sent frames keep playing on Telnyx's
   * side until a `clear` frame is sent (see callStreamSession.ts for ordering). */
  cancel(): void;
  /** Resolves once the whole reply has been sent, or cancel() was called. */
  done: Promise<void>;
}

/**
 * Requests speech via ElevenLabs' streaming endpoint. The full `text` still
 * has to be sent up front in one request (no LLM-side streaming feeds this),
 * but the response body arrives as a stream of PCM chunks as ElevenLabs
 * synthesizes them, instead of one buffer only available once the entire
 * clip is done - callers can start playing the first chunk while the rest is
 * still being generated. `signal` lets a barge-in cancel the in-flight HTTP
 * request itself, not just stop reading from it.
 */
async function fetchSpeechStream(text: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const voiceId = env.ELEVENLABS_VOICE_ID;
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_${env.MEDIA_STREAM_SAMPLE_RATE}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        voice_settings: {
          stability: env.ELEVENLABS_STABILITY,
          similarity_boost: env.ELEVENLABS_SIMILARITY_BOOST,
          style: env.ELEVENLABS_STYLE,
          use_speaker_boost: env.ELEVENLABS_SPEAKER_BOOST,
          speed: env.ELEVENLABS_SPEED,
        },
      }),
      signal,
    }
  );

  if (!response.ok || !response.body) {
    throw new Error(`ElevenLabs streaming TTS request failed: ${response.status} ${await response.text()}`);
  }

  return response.body;
}

/**
 * Streams `text` from ElevenLabs and paces the arriving raw PCM audio out via
 * `sendFrame` in ~20ms chunks (matching Telnyx's expected media cadence) as
 * bytes come in, rather than waiting for the whole reply to finish
 * synthesizing first. `sendFrame` receives a base64-encoded payload ready to
 * wrap in a Telnyx `media` frame.
 *
 * Barge-in cancellation: `cancel()` both aborts the underlying fetch (so we
 * stop paying for/downloading audio nobody will hear) and flips `cancelled`,
 * which every loop checks before doing further work - so no frame sent after
 * cancel() ever reaches Telnyx, matching the one-shot version's contract.
 */
export function sendSpeech(text: string, sendFrame: (base64Payload: string) => void): TtsSendHandle {
  let cancelled = false;
  const abortController = new AbortController();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const bytesPerFrame = Math.floor(env.MEDIA_STREAM_SAMPLE_RATE * (FRAME_DURATION_MS / 1000)) * BYTES_PER_SAMPLE;

  (async () => {
    try {
      const stream = await fetchSpeechStream(text, abortController.signal);
      if (cancelled) return;

      const reader = stream.getReader();
      let pending = Buffer.alloc(0);

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (cancelled) return;
        if (streamDone) break;

        pending = pending.length === 0 ? Buffer.from(value) : Buffer.concat([pending, Buffer.from(value)]);

        while (pending.length >= bytesPerFrame) {
          if (cancelled) return;
          sendFrame(encodeAudioPayload(pending.subarray(0, bytesPerFrame)));
          pending = pending.subarray(bytesPerFrame);
          await new Promise((resolve) => setTimeout(resolve, FRAME_DURATION_MS));
        }
      }

      // Trailing partial frame (audio length isn't guaranteed to be an exact
      // multiple of the frame size) - still worth playing rather than
      // dropping the last few milliseconds of the reply.
      if (!cancelled && pending.length > 0) {
        sendFrame(encodeAudioPayload(pending));
      }
    } catch (error) {
      if (!cancelled) {
        // eslint-disable-next-line no-console
        console.error("TTS synthesis/send failed:", error);
      }
    } finally {
      resolveDone();
    }
  })();

  return {
    cancel: () => {
      cancelled = true;
      abortController.abort();
    },
    done,
  };
}
