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

/**
 * Starts recording an outbound call. Unlike the inbound path, Telnyx's dial
 * command (`calls.create`) has no inline `record` field the way `answer`
 * does ("record-from-answer") - recording an outbound leg is a separate
 * explicit action, fired once the call is actually answered by the far end
 * (see callController.ts's call.answered handler), to get the same
 * "record from answer" behavior by another route.
 */
export async function startRecording(callControlId: string) {
  await telnyxClient.calls.recordStart(callControlId, { format: "mp3", channels: "dual" } as never);
}

/** A Telnyx recording resource, pared down to the fields we actually read. */
interface TelnyxRecording {
  id?: string;
  download_urls?: { mp3?: string | null; wav?: string | null };
}

/**
 * Looks up the recording(s) Telnyx holds for a call session. The
 * `call.recording.saved` webhook only hands us a signed URL that expires in
 * ~10 minutes and no recording id, so the durable handle we keep is the
 * call_session_id - the Recordings list API filters on it, and each list
 * response mints fresh (also ~10-min) download URLs, so calling this on
 * demand always yields a currently-valid link.
 */
async function listRecordingsForSession(callSessionId: string): Promise<TelnyxRecording[]> {
  const response = await telnyxClient.callRecordings.list({
    filter: { call_session_id: callSessionId },
  } as never);
  const data = (response as { data?: TelnyxRecording[] }).data;
  return Array.isArray(data) ? data : [];
}

/**
 * Returns a freshly-minted, ~10-minute-valid MP3 download URL for a call's
 * recording, or null if Telnyx has none (e.g. it was already deleted once the
 * retention window elapsed). Callers redirect to this rather than persisting
 * it, since it expires.
 */
export async function getRecordingDownloadUrl(callSessionId: string): Promise<string | null> {
  const recordings = await listRecordingsForSession(callSessionId);
  for (const recording of recordings) {
    const mp3 = recording.download_urls?.mp3;
    if (mp3) return mp3;
  }
  return null;
}

/**
 * Permanently deletes every recording Telnyx holds for a call session and
 * returns how many were removed. Used by the retention cleanup job. Idempotent
 * in effect: a session with no (remaining) recordings is a no-op that returns 0.
 */
export async function deleteRecordingsForSession(callSessionId: string): Promise<number> {
  const recordings = await listRecordingsForSession(callSessionId);
  let deleted = 0;
  for (const recording of recordings) {
    if (!recording.id) continue;
    await telnyxClient.callRecordings.del(recording.id);
    deleted += 1;
  }
  return deleted;
}

export function decodeClientState(clientState?: string): Record<string, unknown> {
  if (!clientState) return {};
  try {
    return JSON.parse(Buffer.from(clientState, "base64").toString("utf-8"));
  } catch {
    return {};
  }
}
