jest.mock("./redis", () => ({ redisConnection: {} }));

// See dialQueue.test.ts for why bullmq is mocked explicitly here rather than
// relying on the repo-root manual mock.
const add = jest.fn();
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add, getJobs: jest.fn(), close: jest.fn() })),
}));

import { enqueueRecordingDeletion, recordingDeletionJobId, recordingCleanupQueue } from "./recordingCleanupQueue";

describe("enqueueRecordingDeletion", () => {
  it("schedules a deletion delayed by the retention window, under a deterministic job id", async () => {
    await enqueueRecordingDeletion("call_1", 12);

    expect(recordingCleanupQueue.add).toHaveBeenCalledWith(
      "recording-delete",
      { callId: "call_1" },
      expect.objectContaining({
        jobId: recordingDeletionJobId("call_1"),
        delay: 12 * 60 * 60 * 1000,
      })
    );
  });

  it("supports a sub-hour retention window", async () => {
    await enqueueRecordingDeletion("call_1", 0.5);

    expect(recordingCleanupQueue.add).toHaveBeenCalledWith(
      "recording-delete",
      { callId: "call_1" },
      expect.objectContaining({ delay: 30 * 60 * 1000 })
    );
  });
});
