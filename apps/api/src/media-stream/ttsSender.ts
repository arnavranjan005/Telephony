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

  // Telnyx's playback buffer appears to need a brief warm-up at the start of
  // each fresh outbound audio burst - confirmed via recorded-call transcripts
  // where real speech was consistently missing or garbled in exactly that
  // window on every single utterance, not randomly. A short silent lead-in
  // sacrifices silence to that warm-up instead of real words. Fetched
  // concurrently with sending the silence (not awaited first) so it doesn't
  // add extra latency on top - by the time the lead-in finishes, ElevenLabs'
  // response has usually already started arriving.
  const SILENCE_LEAD_IN_FRAMES = 6; // ~120ms at FRAME_DURATION_MS=20
  const silenceFrame = Buffer.alloc(bytesPerFrame);

  (async () => {
    try {
      const streamPromise = fetchSpeechStream(text, abortController.signal);
      // Started above but not awaited until after the silence lead-in below,
      // so if it rejects in the meantime, Node sees a synchronously-unhandled
      // rejection - which crashes the process by default on Node 15+. The
      // real error is still fully handled via the `await streamPromise`
      // further down; this just marks it handled immediately so the gap in
      // between can't crash anything.
      streamPromise.catch(() => {});

      // Anchored to a single start time rather than sleeping a flat
      // FRAME_DURATION_MS after every frame - that naive approach ignores
      // the processing time each iteration actually takes (buffer slicing,
      // base64 encoding, the WS send, occasional stalls waiting on the next
      // network chunk from ElevenLabs), so the feed drifts later than
      // real-time as it accumulates - inaudible for a short reply, but
      // Telnyx's playout buffer starves progressively on a longer one. This
      // targets each frame's absolute send time and only sleeps the
      // remainder, catching back up automatically after any stall. One
      // continuous counter spans the silence lead-in and the real content so
      // there's no seam between them.
      const startTime = Date.now();
      let frameIndex = 0;

      for (let i = 0; i < SILENCE_LEAD_IN_FRAMES; i += 1) {
        if (cancelled) return;
        sendFrame(encodeAudioPayload(silenceFrame));
        frameIndex += 1;
        const leadInDelay = startTime + frameIndex * FRAME_DURATION_MS - Date.now();
        if (leadInDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, leadInDelay));
        }
      }

      const stream = await streamPromise;
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
          frameIndex += 1;
          const delay = startTime + frameIndex * FRAME_DURATION_MS - Date.now();
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
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
