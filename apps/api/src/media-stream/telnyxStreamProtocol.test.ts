import {
  decodeAudioPayload,
  decodeInboundFrame,
  encodeAudioPayload,
  encodeClearFrame,
  encodeMarkFrame,
  encodeMediaFrame,
} from "./telnyxStreamProtocol";

describe("telnyxStreamProtocol", () => {
  it("decodes a start frame", () => {
    const raw = JSON.stringify({
      event: "start",
      sequence_number: "1",
      start: { call_control_id: "ctrl_1", stream_id: "stream_1", media_format: { encoding: "L16", sample_rate: 8000, channels: 1 } },
    });

    const frame = decodeInboundFrame(raw);

    expect(frame).toMatchObject({ event: "start", start: { stream_id: "stream_1" } });
  });

  it("decodes a media frame", () => {
    const raw = JSON.stringify({
      event: "media",
      sequence_number: "4",
      stream_id: "stream_1",
      media: { track: "inbound", chunk: "2", timestamp: "5", payload: "AAAA" },
    });

    const frame = decodeInboundFrame(raw);

    expect(frame).toMatchObject({ event: "media", media: { track: "inbound", payload: "AAAA" } });
  });

  it("returns null for invalid JSON", () => {
    expect(decodeInboundFrame("not json")).toBeNull();
  });

  it("returns null for JSON missing an event field", () => {
    expect(decodeInboundFrame(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("encodes a media frame", () => {
    expect(encodeMediaFrame("AAAA")).toBe(JSON.stringify({ event: "media", media: { payload: "AAAA" } }));
  });

  it("encodes a clear frame", () => {
    expect(encodeClearFrame()).toBe(JSON.stringify({ event: "clear" }));
  });

  it("encodes a mark frame", () => {
    expect(encodeMarkFrame("turn-1")).toBe(JSON.stringify({ event: "mark", mark: { name: "turn-1" } }));
  });

  it("round-trips audio payload base64 encoding", () => {
    const original = Buffer.from([0, 1, 2, 3, 255]);
    const encoded = encodeAudioPayload(original);
    const decoded = decodeAudioPayload(encoded);

    expect(decoded).toEqual(original);
  });
});
