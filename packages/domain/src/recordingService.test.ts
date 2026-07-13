const callFindUnique = jest.fn();
const callUpdate = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: {
    call: {
      findUnique: (...args: unknown[]) => callFindUnique(...args),
      update: (...args: unknown[]) => callUpdate(...args),
    },
  },
}));

const deleteRecordingsForSession = jest.fn();
jest.mock("./telnyx/callService", () => ({
  deleteRecordingsForSession: (...args: unknown[]) => deleteRecordingsForSession(...args),
}));

import { processRecordingDeletion } from "./recordingService";

describe("processRecordingDeletion", () => {
  it("deletes the recording from Telnyx and clears our references", async () => {
    callFindUnique.mockResolvedValue({ id: "call_1", telnyxCallSessionId: "sess_1" });
    deleteRecordingsForSession.mockResolvedValue(1);

    await processRecordingDeletion("call_1");

    expect(deleteRecordingsForSession).toHaveBeenCalledWith("sess_1");
    expect(callUpdate).toHaveBeenCalledWith({
      where: { id: "call_1" },
      data: { telnyxCallSessionId: null, recordingUrl: null },
    });
  });

  it("is a no-op when the call is gone", async () => {
    callFindUnique.mockResolvedValue(null);

    await processRecordingDeletion("missing");

    expect(deleteRecordingsForSession).not.toHaveBeenCalled();
    expect(callUpdate).not.toHaveBeenCalled();
  });

  it("is a no-op when the call has no recording session id (already cleaned up)", async () => {
    callFindUnique.mockResolvedValue({ id: "call_1", telnyxCallSessionId: null });

    await processRecordingDeletion("call_1");

    expect(deleteRecordingsForSession).not.toHaveBeenCalled();
    expect(callUpdate).not.toHaveBeenCalled();
  });
});
