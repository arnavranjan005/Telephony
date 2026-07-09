import { env } from "@telephony/config";
import { telnyxClient, createScopedTelnyxClient } from "./telnyxClient";

/** Opts a call into Telnyx's bidirectional Media Streaming (real-time barge-in mode). */
export interface StreamingOptions {
  streamUrl: string;
  streamTrack?: "inbound_track" | "outbound_track" | "both_tracks";
  bidirectionalCodec?: string;
}

function streamingParams(streaming?: StreamingOptions): Record<string, unknown> {
  if (!streaming) return {};
  return {
    stream_url: streaming.streamUrl,
    stream_track: streaming.streamTrack ?? "both_tracks",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: streaming.bidirectionalCodec ?? "L16",
    // Telnyx defaults L16 to 16kHz - our whole pipeline (Deepgram, ElevenLabs,
    // the frame pacing in ttsSender.ts) is built around MEDIA_STREAM_SAMPLE_RATE
    // (8kHz), so this has to be explicit or playback comes out ~2x speed/pitch.
    stream_bidirectional_sampling_rate: env.MEDIA_STREAM_SAMPLE_RATE,
  };
}

export async function initiateOutboundCall(
  toNumber: string,
  clientState?: Record<string, unknown>,
  streaming?: StreamingOptions
) {
  const response = await createScopedTelnyxClient().calls.create({
    connection_id: env.TELNYX_CONNECTION_ID,
    to: toNumber,
    from: env.TELNYX_FROM_NUMBER,
    client_state: clientState ? Buffer.from(JSON.stringify(clientState)).toString("base64") : undefined,
    ...streamingParams(streaming),
  } as never);

  if (!response.data) {
    throw new Error("Telnyx call creation returned no data");
  }

  return response.data;
}

export async function answerCall(callControlId: string, streaming?: StreamingOptions, record?: boolean) {
  const recordParams = record
    ? { record: "record-from-answer" as const, record_channels: "dual" as const, record_format: "mp3" as const }
    : {};
  await telnyxClient.calls.answer(callControlId, { ...streamingParams(streaming), ...recordParams } as never);
}

export async function speakText(callControlId: string, text: string) {
  await telnyxClient.calls.speak(callControlId, {
    payload: text,
    voice: "female",
    language: "en-US",
  } as never);
}

export async function startTranscription(callControlId: string) {
  await telnyxClient.calls.transcriptionStart(callControlId, {
    transcription_engine: "A",
    language: "en",
  } as never);
}

export async function hangupCall(callControlId: string) {
  await telnyxClient.calls.hangup(callControlId, {} as never);
}

export function decodeClientState(clientState?: string): Record<string, unknown> {
  if (!clientState) return {};
  try {
    return JSON.parse(Buffer.from(clientState, "base64").toString("utf-8"));
  } catch {
    return {};
  }
}
