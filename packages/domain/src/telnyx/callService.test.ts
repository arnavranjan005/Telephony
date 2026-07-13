// callService.ts imports `env` at module scope (for the streaming/dial params),
// which would otherwise fail env validation in this package's test env. The
// recording helpers under test don't read env, so a minimal stub is enough.
jest.mock("@telephony/config", () => ({ env: { MEDIA_STREAM_SAMPLE_RATE: 8000 } }));

const callRecordingsList = jest.fn();
const callRecordingsDel = jest.fn();

jest.mock("./telnyxClient", () => ({
  telnyxClient: {
    callRecordings: {
      list: (...args: unknown[]) => callRecordingsList(...args),
      del: (...args: unknown[]) => callRecordingsDel(...args),
    },
  },
  createScopedTelnyxClient: jest.fn(),
}));

import { getRecordingDownloadUrl, deleteRecordingsForSession } from "./callService";

describe("getRecordingDownloadUrl", () => {
  it("filters recordings by call_session_id and returns a fresh mp3 URL", async () => {
    callRecordingsList.mockResolvedValue({
      data: [{ id: "rec_1", download_urls: { mp3: "https://fresh.example/rec.mp3" } }],
    });

    const url = await getRecordingDownloadUrl("sess_1");

    expect(callRecordingsList).toHaveBeenCalledWith({ filter: { call_session_id: "sess_1" } });
    expect(url).toBe("https://fresh.example/rec.mp3");
  });

  it("skips recordings that only have a wav URL and falls through to a usable mp3", async () => {
    callRecordingsList.mockResolvedValue({
      data: [
        { id: "rec_1", download_urls: { wav: "https://fresh.example/rec.wav" } },
        { id: "rec_2", download_urls: { mp3: "https://fresh.example/rec2.mp3" } },
      ],
    });

    expect(await getRecordingDownloadUrl("sess_1")).toBe("https://fresh.example/rec2.mp3");
  });

  it("returns null when Telnyx has no recording for the session", async () => {
    callRecordingsList.mockResolvedValue({ data: [] });

    expect(await getRecordingDownloadUrl("sess_1")).toBeNull();
  });
});

describe("deleteRecordingsForSession", () => {
  it("deletes every recording for the session and returns the count", async () => {
    callRecordingsList.mockResolvedValue({
      data: [{ id: "rec_1" }, { id: "rec_2" }],
    });
    callRecordingsDel.mockResolvedValue({});

    const deleted = await deleteRecordingsForSession("sess_1");

    expect(callRecordingsDel).toHaveBeenCalledWith("rec_1");
    expect(callRecordingsDel).toHaveBeenCalledWith("rec_2");
    expect(deleted).toBe(2);
  });

  it("is a no-op returning 0 when there is nothing to delete", async () => {
    callRecordingsList.mockResolvedValue({ data: [] });

    expect(await deleteRecordingsForSession("sess_1")).toBe(0);
    expect(callRecordingsDel).not.toHaveBeenCalled();
  });
});
