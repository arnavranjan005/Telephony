jest.mock("@telephony/config", () => ({
  env: { ELEVENLABS_API_KEY: "test-key", ELEVENLABS_VOICE_ID: "voice_1", MEDIA_STREAM_SAMPLE_RATE: 8000 },
}));

import { sendSpeech } from "./ttsSender";

/** Mocks a fetch() response whose body streams the given chunks one read() at a time. */
function mockStreamingResponse(chunks: Buffer[]): Response {
  let index = 0;
  const reader = {
    read: async () => {
      if (index < chunks.length) {
        const chunk = chunks[index++];
        return { done: false, value: new Uint8Array(chunk) };
      }
      return { done: true, value: undefined };
    },
  };
  return {
    ok: true,
    body: { getReader: () => reader },
  } as unknown as Response;
}

describe("sendSpeech", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("streams from ElevenLabs' streaming endpoint with the configured voice and sample rate", async () => {
    const audio = Buffer.alloc(320); // exactly one 20ms frame at 8kHz/16-bit
    jest.spyOn(global, "fetch").mockResolvedValue(mockStreamingResponse([audio]));

    const sendFrame = jest.fn();
    const handle = sendSpeech("hello there", sendFrame);

    await jest.runAllTimersAsync();
    await handle.done;

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/text-to-speech/voice_1/stream?output_format=pcm_8000"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "xi-api-key": "test-key" }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(sendFrame).toHaveBeenCalledTimes(1);
  });

  it("plays a frame as soon as it arrives rather than waiting for the whole reply", async () => {
    // Two separate network reads, each delivering one frame - the first frame
    // must go out without waiting on the second chunk to arrive.
    const frame1 = Buffer.alloc(320, 1);
    const frame2 = Buffer.alloc(320, 2);
    jest.spyOn(global, "fetch").mockResolvedValue(mockStreamingResponse([frame1, frame2]));

    const sendFrame = jest.fn();
    const handle = sendSpeech("a longer reply", sendFrame);

    await jest.advanceTimersByTimeAsync(0);
    expect(sendFrame).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(20);
    expect(sendFrame).toHaveBeenCalledTimes(2);

    await jest.runAllTimersAsync();
    await handle.done;
  });

  it("paces multiple frames from a single chunk out over time rather than sending them all at once", async () => {
    const audio = Buffer.alloc(320 * 3); // three 20ms frames delivered in one network read
    jest.spyOn(global, "fetch").mockResolvedValue(mockStreamingResponse([audio]));

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

  it("sends a trailing partial frame instead of dropping it", async () => {
    const audio = Buffer.alloc(320 + 100); // one full frame plus a short tail
    jest.spyOn(global, "fetch").mockResolvedValue(mockStreamingResponse([audio]));

    const sendFrame = jest.fn();
    const handle = sendSpeech("hello", sendFrame);

    await jest.runAllTimersAsync();
    await handle.done;

    expect(sendFrame).toHaveBeenCalledTimes(2);
  });

  it("stops sending further frames and aborts the request once cancel() is called", async () => {
    const audio = Buffer.alloc(320 * 5);
    jest.spyOn(global, "fetch").mockResolvedValue(mockStreamingResponse([audio]));

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
