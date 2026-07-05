jest.mock("./redis", () => ({ redisConnection: {} }));

// packages/queue is the package that directly imports `bullmq` - the repo
// root's __mocks__/bullmq.ts manual mock only auto-applies to test files
// whose jest `roots` includes the repo root, which this package's config
// deliberately doesn't (roots: ["<rootDir>/src"]). Without an explicit mock
// here, `new Queue(...)` at dialQueue.ts's module scope would construct a
// *real* BullMQ queue that tries to open a real ioredis connection and hangs
// retrying forever against the mocked (empty) connection options.
const getJobs = jest.fn();
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn(), getJobs, close: jest.fn() })),
}));

import { dialQueue, removeFollowUpDialJobs } from "./dialQueue";

function fakeJob(data: unknown) {
  return { data, remove: jest.fn().mockResolvedValue(undefined) };
}

describe("removeFollowUpDialJobs", () => {
  it("removes the delayed/waiting job(s) matching this follow-up id and nothing else", async () => {
    const matching = fakeJob({ type: "followup", followUpId: "fu_1" });
    const otherFollowUp = fakeJob({ type: "followup", followUpId: "fu_2" });
    const campaignContact = fakeJob({ type: "campaign-contact", campaignContactId: "fu_1" });
    (dialQueue.getJobs as jest.Mock).mockResolvedValue([matching, otherFollowUp, campaignContact]);

    await removeFollowUpDialJobs("fu_1");

    expect(dialQueue.getJobs).toHaveBeenCalledWith(["delayed", "waiting"]);
    expect(matching.remove).toHaveBeenCalled();
    expect(otherFollowUp.remove).not.toHaveBeenCalled();
    expect(campaignContact.remove).not.toHaveBeenCalled();
  });

  it("removes a retry job re-enqueued under a timestamp-suffixed id, not just the deterministic one", async () => {
    // enqueueFollowUpDialAt uses `followup-<id>-retry-<timestamp>` as the job
    // id after a calling-hours reschedule - this can't be found by id alone,
    // only by scanning job data.
    const retryJob = fakeJob({ type: "followup", followUpId: "fu_1" });
    (dialQueue.getJobs as jest.Mock).mockResolvedValue([retryJob]);

    await removeFollowUpDialJobs("fu_1");

    expect(retryJob.remove).toHaveBeenCalled();
  });

  it("is a no-op when there is no matching job", async () => {
    (dialQueue.getJobs as jest.Mock).mockResolvedValue([]);

    await expect(removeFollowUpDialJobs("fu_missing")).resolves.toBeUndefined();
  });

  it("swallows a failure to remove an individual job (e.g. it became active/locked in the meantime)", async () => {
    const lockedJob = { data: { type: "followup", followUpId: "fu_1" }, remove: jest.fn().mockRejectedValue(new Error("locked")) };
    (dialQueue.getJobs as jest.Mock).mockResolvedValue([lockedJob]);

    await expect(removeFollowUpDialJobs("fu_1")).resolves.toBeUndefined();
  });
});
