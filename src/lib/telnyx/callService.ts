import { telnyxClient } from "./telnyxClient";
import { env } from "../../config/env";

export async function initiateOutboundCall(toNumber: string, clientState?: Record<string, unknown>) {
  const response = await telnyxClient.calls.create({
    connection_id: env.TELNYX_CONNECTION_ID,
    to: toNumber,
    from: env.TELNYX_FROM_NUMBER,
    client_state: clientState ? Buffer.from(JSON.stringify(clientState)).toString("base64") : undefined,
  } as never);

  if (!response.data) {
    throw new Error("Telnyx call creation returned no data");
  }

  return response.data;
}

export async function answerCall(callControlId: string) {
  await telnyxClient.calls.answer(callControlId, {} as never);
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
