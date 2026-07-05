/**
 * Typed encode/decode for Telnyx's Media Streaming over Websockets protocol
 * (https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming).
 * Field shapes below are modeled from Telnyx's published docs; verify exact
 * nesting against a live payload capture before going to production, since
 * Telnyx doesn't publish a formal JSON schema for these frames.
 */

export interface MediaFormat {
  encoding: string;
  sample_rate: number;
  channels: number;
}

export type InboundStreamFrame =
  | { event: "connected"; version: string }
  | {
      event: "start";
      sequence_number: string;
      start: { call_control_id: string; stream_id: string; media_format: MediaFormat };
    }
  | {
      event: "media";
      sequence_number: string;
      stream_id: string;
      media: { track: "inbound" | "outbound"; chunk: string; timestamp: string; payload: string };
    }
  | { event: "mark"; sequence_number: string; stream_id: string; mark: { name: string } }
  | { event: "dtmf"; sequence_number: string; stream_id: string; dtmf: { digit: string } }
  | { event: "stop"; sequence_number: string; stream_id: string };

export type OutboundStreamFrame =
  | { event: "media"; media: { payload: string } }
  | { event: "mark"; mark: { name: string } }
  | { event: "clear" };

export function decodeInboundFrame(raw: string): InboundStreamFrame | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.event !== "string") return null;
    return parsed as InboundStreamFrame;
  } catch {
    return null;
  }
}

export function encodeOutboundFrame(frame: OutboundStreamFrame): string {
  return JSON.stringify(frame);
}

export function encodeMediaFrame(payloadBase64: string): string {
  return encodeOutboundFrame({ event: "media", media: { payload: payloadBase64 } });
}

export function encodeClearFrame(): string {
  return encodeOutboundFrame({ event: "clear" });
}

export function encodeMarkFrame(name: string): string {
  return encodeOutboundFrame({ event: "mark", mark: { name } });
}

export function decodeAudioPayload(payloadBase64: string): Buffer {
  return Buffer.from(payloadBase64, "base64");
}

export function encodeAudioPayload(audio: Buffer): string {
  return audio.toString("base64");
}
