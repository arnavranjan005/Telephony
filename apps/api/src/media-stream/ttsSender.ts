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
 * MVP TTS: one-shot synthesis via ElevenLabs' plain (non-streaming) REST
 * endpoint - the whole reply is synthesized and billed for up front, in one
 * request, before any audio is sent. Phase 2 swaps this for ElevenLabs'
 * streaming endpoint without changing this function's external contract.
 */
async function synthesizeSpeech(text: string): Promise<Buffer> {
  const voiceId = env.ELEVENLABS_VOICE_ID;
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_${env.MEDIA_STREAM_SAMPLE_RATE}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs TTS request failed: ${response.status} ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Synthesizes `text`, then paces the resulting raw PCM audio out via
 * `sendFrame` in ~20ms chunks (matching Telnyx's expected media cadence)
 * rather than dumping the whole buffer at once. `sendFrame` receives a
 * base64-encoded payload ready to wrap in a Telnyx `media` frame.
 */
export function sendSpeech(text: string, sendFrame: (base64Payload: string) => void): TtsSendHandle {
  let cancelled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const bytesPerFrame = Math.floor(env.MEDIA_STREAM_SAMPLE_RATE * (FRAME_DURATION_MS / 1000)) * BYTES_PER_SAMPLE;

  (async () => {
    try {
      const audio = await synthesizeSpeech(text);
      if (cancelled) return;

      for (let offset = 0; offset < audio.length; offset += bytesPerFrame) {
        if (cancelled) return;
        const frame = audio.subarray(offset, offset + bytesPerFrame);
        sendFrame(encodeAudioPayload(frame));
        await new Promise((resolve) => setTimeout(resolve, FRAME_DURATION_MS));
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("TTS synthesis/send failed:", error);
    } finally {
      resolveDone();
    }
  })();

  return {
    cancel: () => {
      cancelled = true;
    },
    done,
  };
}
