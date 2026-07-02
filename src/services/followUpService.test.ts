const followUpFindMany = jest.fn();
const followUpUpdate = jest.fn();
const followUpCreate = jest.fn();

jest.mock("../config/prisma", () => ({
  prisma: {
    followUp: {
      findMany: (...args: unknown[]) => followUpFindMany(...args),
      update: (...args: unknown[]) => followUpUpdate(...args),
      create: (...args: unknown[]) => followUpCreate(...args),
    },
  },
}));

const placeOutboundCall = jest.fn();
jest.mock("./outboundDialService", () => ({
  placeOutboundCall: (...args: unknown[]) => placeOutboundCall(...args),
}));

import { createFollowUp, dispatchDueFollowUps } from "./followUpService";

describe("followUpService", () => {
  it("createFollowUp persists the given fields", async () => {
    followUpCreate.mockResolvedValue({ id: "fu_1" });
    const scheduledAt = new Date("2025-01-16T18:00:00Z");

    await createFollowUp({ leadId: "lead_1", scheduledAt, reason: "callback" });

    expect(followUpCreate).toHaveBeenCalledWith({
      data: { leadId: "lead_1", scheduledAt, reason: "callback" },
    });
  });

  describe("dispatchDueFollowUps", () => {
    it("dials each due, non-DNC follow-up and marks it CALLING with the resulting callId", async () => {
      followUpFindMany.mockResolvedValue([
        { id: "fu_1", leadId: "lead_1", lead: { phoneNumber: "+15551234567" } },
      ]);
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });

      const dispatched = await dispatchDueFollowUps(5);

      expect(dispatched).toBe(1);
      expect(placeOutboundCall).toHaveBeenCalledWith("+15551234567", "lead_1");
      expect(followUpUpdate).toHaveBeenCalledWith({
        where: { id: "fu_1" },
        data: { status: "CALLING", callId: "call_1" },
      });
    });

    it("marks a DNC-listed follow-up SKIPPED_DNC without counting it as dispatched", async () => {
      followUpFindMany.mockResolvedValue([
        { id: "fu_1", leadId: "lead_1", lead: { phoneNumber: "+15551234567" } },
      ]);
      placeOutboundCall.mockResolvedValue({ outcome: "skipped_dnc" });

      const dispatched = await dispatchDueFollowUps(5);

      expect(dispatched).toBe(0);
      expect(followUpUpdate).toHaveBeenCalledWith({ where: { id: "fu_1" }, data: { status: "SKIPPED_DNC" } });
    });

    it("marks a failed dial FAILED without counting it as dispatched", async () => {
      followUpFindMany.mockResolvedValue([
        { id: "fu_1", leadId: "lead_1", lead: { phoneNumber: "+15551234567" } },
      ]);
      placeOutboundCall.mockResolvedValue({ outcome: "failed", error: "boom" });

      const dispatched = await dispatchDueFollowUps(5);

      expect(dispatched).toBe(0);
      expect(followUpUpdate).toHaveBeenCalledWith({ where: { id: "fu_1" }, data: { status: "FAILED" } });
    });

    it("only queries follow-ups that are PENDING and due", async () => {
      followUpFindMany.mockResolvedValue([]);

      await dispatchDueFollowUps(5);

      expect(followUpFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "PENDING", scheduledAt: { lte: expect.any(Date) } },
          take: 5,
        })
      );
    });
  });
});
