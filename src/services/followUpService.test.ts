const followUpFindMany = jest.fn();
const followUpUpdateMany = jest.fn();
const followUpUpdate = jest.fn();
const followUpFindUniqueOrThrow = jest.fn();
const followUpCreate = jest.fn();

jest.mock("../config/prisma", () => ({
  prisma: {
    followUp: {
      findMany: (...args: unknown[]) => followUpFindMany(...args),
      updateMany: (...args: unknown[]) => followUpUpdateMany(...args),
      update: (...args: unknown[]) => followUpUpdate(...args),
      findUniqueOrThrow: (...args: unknown[]) => followUpFindUniqueOrThrow(...args),
      create: (...args: unknown[]) => followUpCreate(...args),
    },
  },
}));

const placeOutboundCall = jest.fn();
jest.mock("./outboundDialService", () => ({
  placeOutboundCall: (...args: unknown[]) => placeOutboundCall(...args),
}));

const enqueueFollowUpDial = jest.fn();
jest.mock("../queues/dialQueue", () => ({
  enqueueFollowUpDial: (...args: unknown[]) => enqueueFollowUpDial(...args),
}));

import { createFollowUp, processFollowUpJob } from "./followUpService";

describe("followUpService", () => {
  describe("createFollowUp", () => {
    it("persists the given fields and enqueues a delayed dial job", async () => {
      const scheduledAt = new Date("2025-01-16T18:00:00Z");
      followUpCreate.mockResolvedValue({ id: "fu_1", leadId: "lead_1", scheduledAt, reason: "callback" });

      await createFollowUp({ leadId: "lead_1", scheduledAt, reason: "callback" });

      expect(followUpCreate).toHaveBeenCalledWith({
        data: { leadId: "lead_1", scheduledAt, reason: "callback" },
      });
      expect(enqueueFollowUpDial).toHaveBeenCalledWith("fu_1", scheduledAt);
    });
  });

  describe("processFollowUpJob", () => {
    it("claims the row, dials, and attaches the resulting callId", async () => {
      followUpUpdateMany.mockResolvedValue({ count: 1 });
      followUpFindUniqueOrThrow.mockResolvedValue({
        id: "fu_1",
        leadId: "lead_1",
        lead: { phoneNumber: "+15551234567" },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });

      await processFollowUpJob("fu_1");

      expect(followUpUpdateMany).toHaveBeenCalledWith({
        where: { id: "fu_1", status: "PENDING" },
        data: { status: "CALLING" },
      });
      expect(placeOutboundCall).toHaveBeenCalledWith("+15551234567", "lead_1");
      expect(followUpUpdate).toHaveBeenCalledWith({ where: { id: "fu_1" }, data: { callId: "call_1" } });
    });

    it("is a no-op when the row is no longer PENDING (already claimed/canceled elsewhere)", async () => {
      followUpUpdateMany.mockResolvedValue({ count: 0 });

      await processFollowUpJob("fu_1");

      expect(followUpFindUniqueOrThrow).not.toHaveBeenCalled();
      expect(placeOutboundCall).not.toHaveBeenCalled();
    });

    it("proves distributed-safety: a second concurrent claim attempt on the same row is a no-op", async () => {
      followUpUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      followUpFindUniqueOrThrow.mockResolvedValue({
        id: "fu_1",
        leadId: "lead_1",
        lead: { phoneNumber: "+15551234567" },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });

      await Promise.all([processFollowUpJob("fu_1"), processFollowUpJob("fu_1")]);

      // Only the caller that won the atomic claim (count: 1) ever dials.
      expect(placeOutboundCall).toHaveBeenCalledTimes(1);
    });

    it("marks a DNC-listed follow-up SKIPPED_DNC", async () => {
      followUpUpdateMany.mockResolvedValue({ count: 1 });
      followUpFindUniqueOrThrow.mockResolvedValue({
        id: "fu_1",
        leadId: "lead_1",
        lead: { phoneNumber: "+15551234567" },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "skipped_dnc" });

      await processFollowUpJob("fu_1");

      expect(followUpUpdate).toHaveBeenCalledWith({ where: { id: "fu_1" }, data: { status: "SKIPPED_DNC" } });
    });

    it("marks a failed dial FAILED", async () => {
      followUpUpdateMany.mockResolvedValue({ count: 1 });
      followUpFindUniqueOrThrow.mockResolvedValue({
        id: "fu_1",
        leadId: "lead_1",
        lead: { phoneNumber: "+15551234567" },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "failed", error: "boom" });

      await processFollowUpJob("fu_1");

      expect(followUpUpdate).toHaveBeenCalledWith({ where: { id: "fu_1" }, data: { status: "FAILED" } });
    });
  });
});
