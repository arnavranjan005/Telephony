jest.mock("@telephony/config", () => ({
  env: { ELEVENLABS_API_KEY: "test-key", ELEVENLABS_VOICE_ID: "voice_1", MEDIA_STREAM_SAMPLE_RATE: 8000 },
}));

import { sendSpeech } from "./ttsSender";

describe("sendSpeech", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("synthesizes via the ElevenLabs REST endpoint with the configured voice and sample rate", async () => {
    const audio = Buffer.alloc(320); // exactly one 20ms frame at 8kHz/16-bit
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    } as Response);

    const sendFrame = jest.fn();
    const handle = sendSpeech("hello there", sendFrame);

    await jest.runAllTimersAsync();
    await handle.done;

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/text-to-speech/voice_1?output_format=pcm_8000"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "xi-api-key": "test-key" }),
      })
    );
    expect(sendFrame).toHaveBeenCalledTimes(1);
  });

  it("paces multiple frames out over time rather than sending the whole buffer at once", async () => {
    const audio = Buffer.alloc(320 * 3); // three 20ms frames
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    } as Response);

    const sendFrame = jest.fn();
    const handle = sendSpeech("a longer reply", sendFrame);

    await jest.advanceTimersByTimeAsync(0);
    expect(sendFrame).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(20);
    expect(sendFrame).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(20);
    expect(sendFrame).toHaveBeenCalledTimes(3);

    await jest.runAllTimersAsync();
    await handle.done;
  });

  it("stops sending further frames once cancel() is called", async () => {
    const audio = Buffer.alloc(320 * 5);
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    } as Response);

    const sendFrame = jest.fn();
    const handle = sendSpeech("a reply that gets interrupted", sendFrame);

    await jest.advanceTimersByTimeAsync(0);
    expect(sendFrame).toHaveBeenCalledTimes(1);

    handle.cancel();
    await jest.advanceTimersByTimeAsync(100);
    await handle.done;

    expect(sendFrame).toHaveBeenCalledTimes(1); // no further frames after cancel
  });

  it("throws when the ElevenLabs request fails", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    } as Response);

    const sendFrame = jest.fn();
    const handle = sendSpeech("hello", sendFrame);

    await expect(handle.done).resolves.toBeUndefined(); // done always resolves (finally), errors are swallowed after synthesis fails
    expect(sendFrame).not.toHaveBeenCalled();
  });
});
