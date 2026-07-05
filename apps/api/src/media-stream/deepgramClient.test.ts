const connect = jest.fn();
const sendMedia = jest.fn();
const socketOn = jest.fn();
const socketClose = jest.fn();

const fakeSocket = {
  on: socketOn,
  sendMedia,
  close: socketClose,
};

jest.mock("@deepgram/sdk", () => ({
  DeepgramClient: jest.fn().mockImplementation(() => ({
    listen: { v1: { connect } },
  })),
}));

jest.mock("@telephony/config", () => ({
  env: { DEEPGRAM_API_KEY: "test-key", DEEPGRAM_MODEL: "nova-2-phonecall", MEDIA_STREAM_SAMPLE_RATE: 8000 },
}));

import { DeepgramStreamClient } from "./deepgramClient";

describe("DeepgramStreamClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    connect.mockResolvedValue(fakeSocket);
  });

  function getMessageHandler(): (message: unknown) => void {
    const call = socketOn.mock.calls.find(([event]) => event === "message");
    if (!call) throw new Error("no message handler registered");
    return call[1];
  }

  it("connects with the configured model/encoding/sample rate", async () => {
    const client = new DeepgramStreamClient();
    await client.connect();

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "nova-2-phonecall",
        encoding: "linear16",
        sample_rate: 8000,
        interim_results: "true",
      })
    );
  });

  it("emits a transcript event for a Results message", async () => {
    const client = new DeepgramStreamClient();
    await client.connect();
    const onTranscript = jest.fn();
    client.on("transcript", onTranscript);

    getMessageHandler()({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "book me thursday at 2pm" }] },
    });

    expect(onTranscript).toHaveBeenCalledWith({
      transcript: "book me thursday at 2pm",
      isFinal: true,
      speechFinal: true,
    });
  });

  it("emits an interim transcript with speechFinal false", async () => {
    const client = new DeepgramStreamClient();
    await client.connect();
    const onTranscript = jest.fn();
    client.on("transcript", onTranscript);

    getMessageHandler()({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: "book me" }] },
    });

    expect(onTranscript).toHaveBeenCalledWith({ transcript: "book me", isFinal: false, speechFinal: false });
  });

  it("emits utteranceEnd for an UtteranceEnd message", async () => {
    const client = new DeepgramStreamClient();
    await client.connect();
    const onUtteranceEnd = jest.fn();
    client.on("utteranceEnd", onUtteranceEnd);

    getMessageHandler()({ type: "UtteranceEnd" });

    expect(onUtteranceEnd).toHaveBeenCalled();
  });

  it("forwards audio chunks to the socket", async () => {
    const client = new DeepgramStreamClient();
    await client.connect();

    const chunk = Buffer.from([1, 2, 3]);
    client.sendAudio(chunk);

    expect(sendMedia).toHaveBeenCalledWith(chunk);
  });

  it("closes the socket and stops sending audio afterward", async () => {
    const client = new DeepgramStreamClient();
    await client.connect();

    client.close();
    client.sendAudio(Buffer.from([1]));

    expect(socketClose).toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
  });
});
