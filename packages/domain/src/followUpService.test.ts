const followUpFindMany = jest.fn();
const followUpUpdateMany = jest.fn();
const followUpUpdate = jest.fn();
const followUpFindUniqueOrThrow = jest.fn();
const followUpCreate = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: {
    followUp: {
      findMany: (...args: unknown[]) => followUpFindMany(...args),
      updateMany: (...args: unknown[]) => followUpUpdateMany(...args),
      update: (...args: unknown[]) => followUpUpdate(...args),
      findUniqueOrThrow: (...args: unknown[]) => followUpFindUniqueOrThrow(...args),
      create: (...args: unknown[]) => followUpCreate(...args),
    },
  },
  FollowUpStatus: {
    PENDING: "PENDING",
    CALLING: "CALLING",
    SKIPPED_DNC: "SKIPPED_DNC",
    SKIPPED_NO_CONSENT: "SKIPPED_NO_CONSENT",
    FAILED: "FAILED",
    CANCELED: "CANCELED",
    COMPLETED: "COMPLETED",
  },
}));

const placeOutboundCall = jest.fn();
jest.mock("./outboundDialService", () => ({
  placeOutboundCall: (...args: unknown[]) => placeOutboundCall(...args),
}));

const enqueueFollowUpDial = jest.fn();
const enqueueFollowUpDialAt = jest.fn();
jest.mock("@telephony/queue", () => ({
  enqueueFollowUpDial: (...args: unknown[]) => enqueueFollowUpDial(...args),
  enqueueFollowUpDialAt: (...args: unknown[]) => enqueueFollowUpDialAt(...args),
}));

const isWithinCallingHours = jest.fn();
const nextCallingWindowStart = jest.fn();
jest.mock("./compliance/callingHours", () => ({
  isWithinCallingHours: (...args: unknown[]) => isWithinCallingHours(...args),
  nextCallingWindowStart: (...args: unknown[]) => nextCallingWindowStart(...args),
}));

import { createFollowUp, processFollowUpJob } from "./followUpService";

beforeEach(() => {
  isWithinCallingHours.mockReturnValue(true); // default: every existing test dials as if within the legal window
});

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
      expect(placeOutboundCall).toHaveBeenCalledWith("+15551234567", "lead_1", { requireConsent: true });
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
      placeOutboundCall.mockResolvedValue({ outcome: "failed", error: "boom", callId: "call_1" });

      await processFollowUpJob("fu_1");

      expect(followUpUpdate).toHaveBeenCalledWith({
        where: { id: "fu_1" },
        data: { status: "FAILED", callId: "call_1" },
      });
    });

    it("marks a follow-up without on-file consent SKIPPED_NO_CONSENT", async () => {
      followUpUpdateMany.mockResolvedValue({ count: 1 });
      followUpFindUniqueOrThrow.mockResolvedValue({
        id: "fu_1",
        leadId: "lead_1",
        lead: { phoneNumber: "+15551234567" },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "skipped_no_consent" });

      await processFollowUpJob("fu_1");

      expect(followUpUpdate).toHaveBeenCalledWith({ where: { id: "fu_1" }, data: { status: "SKIPPED_NO_CONSENT" } });
    });

    it("outside the legal calling window: gives the claim back to PENDING and reschedules for the next window instead of dialing", async () => {
      followUpUpdateMany.mockResolvedValue({ count: 1 });
      followUpFindUniqueOrThrow.mockResolvedValue({
        id: "fu_1",
        leadId: "lead_1",
        lead: { phoneNumber: "+12125551234" },
      });
      isWithinCallingHours.mockReturnValue(false);
      const nextWindow = new Date("2026-01-16T13:00:00Z");
      nextCallingWindowStart.mockReturnValue(nextWindow);

      await processFollowUpJob("fu_1");

      expect(placeOutboundCall).not.toHaveBeenCalled();
      expect(followUpUpdate).toHaveBeenCalledWith({ where: { id: "fu_1" }, data: { status: "PENDING" } });
      expect(enqueueFollowUpDialAt).toHaveBeenCalledWith("fu_1", nextWindow);
    });
  });
});
