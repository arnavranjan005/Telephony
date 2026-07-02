const campaignCreate = jest.fn();
const campaignFindMany = jest.fn();
const campaignFindUnique = jest.fn();
const campaignUpdate = jest.fn();
const campaignUpdateMany = jest.fn();
const campaignContactCreate = jest.fn();
const campaignContactFindMany = jest.fn();
const campaignContactUpdateMany = jest.fn();
const campaignContactUpdate = jest.fn();
const campaignContactFindUniqueOrThrow = jest.fn();
const campaignContactCount = jest.fn();
const leadUpsert = jest.fn();

function makeTx() {
  return {
    campaign: { create: (...args: unknown[]) => campaignCreate(...args) },
    campaignContact: { create: (...args: unknown[]) => campaignContactCreate(...args) },
    lead: { upsert: (...args: unknown[]) => leadUpsert(...args) },
  };
}

jest.mock("../config/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) => fn(makeTx()),
    campaign: {
      create: (...args: unknown[]) => campaignCreate(...args),
      findMany: (...args: unknown[]) => campaignFindMany(...args),
      findUnique: (...args: unknown[]) => campaignFindUnique(...args),
      update: (...args: unknown[]) => campaignUpdate(...args),
      updateMany: (...args: unknown[]) => campaignUpdateMany(...args),
    },
    campaignContact: {
      create: (...args: unknown[]) => campaignContactCreate(...args),
      findMany: (...args: unknown[]) => campaignContactFindMany(...args),
      updateMany: (...args: unknown[]) => campaignContactUpdateMany(...args),
      update: (...args: unknown[]) => campaignContactUpdate(...args),
      findUniqueOrThrow: (...args: unknown[]) => campaignContactFindUniqueOrThrow(...args),
      count: (...args: unknown[]) => campaignContactCount(...args),
    },
    lead: {
      upsert: (...args: unknown[]) => leadUpsert(...args),
    },
  },
}));

const placeOutboundCall = jest.fn();
jest.mock("./outboundDialService", () => ({
  placeOutboundCall: (...args: unknown[]) => placeOutboundCall(...args),
}));

const enqueueCampaignContactDial = jest.fn();
jest.mock("../queues/dialQueue", () => ({
  enqueueCampaignContactDial: (...args: unknown[]) => enqueueCampaignContactDial(...args),
}));

import { createCampaign, processCampaignContactJob, startCampaign } from "./campaignService";

describe("campaignService", () => {
  describe("createCampaign", () => {
    it("upserts a lead by phone number for contacts without a leadId, atomically", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      leadUpsert.mockResolvedValue({ id: "lead_new" });
      campaignContactCreate.mockResolvedValue({});
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({
        name: "Spring outreach",
        contacts: [{ phoneNumber: "+15551234567", firstName: "Jane" }],
      });

      expect(leadUpsert).toHaveBeenCalledWith({
        where: { phoneNumber: "+15551234567" },
        update: {},
        create: { phoneNumber: "+15551234567", firstName: "Jane", lastName: undefined },
      });
      expect(campaignContactCreate).toHaveBeenCalledWith({
        data: { campaignId: "camp_1", leadId: "lead_new" },
      });
    });

    it("uses the given leadId directly without upserting a lead", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      campaignContactCreate.mockResolvedValue({});
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({ name: "Spring outreach", contacts: [{ leadId: "lead_existing" }] });

      expect(leadUpsert).not.toHaveBeenCalled();
      expect(campaignContactCreate).toHaveBeenCalledWith({
        data: { campaignId: "camp_1", leadId: "lead_existing" },
      });
    });
  });

  describe("startCampaign", () => {
    it("flips status to RUNNING and enqueues a dial job per PENDING contact", async () => {
      campaignUpdate.mockResolvedValue({ id: "camp_1", status: "RUNNING" });
      campaignContactFindMany.mockResolvedValue([{ id: "cc_1" }, { id: "cc_2" }]);

      await startCampaign("camp_1");

      expect(campaignUpdate).toHaveBeenCalledWith({ where: { id: "camp_1" }, data: { status: "RUNNING" } });
      expect(enqueueCampaignContactDial).toHaveBeenCalledWith("cc_1");
      expect(enqueueCampaignContactDial).toHaveBeenCalledWith("cc_2");
    });
  });

  describe("processCampaignContactJob", () => {
    it("claims the row, dials, and marks the campaign COMPLETED once nothing PENDING remains", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
      campaignContactCount.mockResolvedValue(0);

      await processCampaignContactJob("cc_1");

      expect(campaignContactUpdateMany).toHaveBeenCalledWith({
        where: { id: "cc_1", status: "PENDING" },
        data: { status: "CALLING", attemptedAt: expect.any(Date) },
      });
      expect(campaignContactUpdate).toHaveBeenCalledWith({ where: { id: "cc_1" }, data: { callId: "call_1" } });
      expect(campaignUpdateMany).toHaveBeenCalledWith({
        where: { id: "camp_1", status: "RUNNING" },
        data: { status: "COMPLETED" },
      });
    });

    it("does not complete the campaign while PENDING contacts remain", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
      campaignContactCount.mockResolvedValue(3);

      await processCampaignContactJob("cc_1");

      expect(campaignUpdateMany).not.toHaveBeenCalled();
    });

    it("is a no-op when the row is no longer PENDING (already claimed elsewhere)", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 0 });

      await processCampaignContactJob("cc_1");

      expect(campaignContactFindUniqueOrThrow).not.toHaveBeenCalled();
      expect(placeOutboundCall).not.toHaveBeenCalled();
    });

    it("proves distributed-safety: a second concurrent claim attempt on the same row is a no-op", async () => {
      campaignContactUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
      campaignContactCount.mockResolvedValue(0);

      await Promise.all([processCampaignContactJob("cc_1"), processCampaignContactJob("cc_1")]);

      expect(placeOutboundCall).toHaveBeenCalledTimes(1);
    });

    it("marks a DNC-listed contact SKIPPED_DNC", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "skipped_dnc" });
      campaignContactCount.mockResolvedValue(0);

      await processCampaignContactJob("cc_1");

      expect(campaignContactUpdate).toHaveBeenCalledWith({
        where: { id: "cc_1" },
        data: { status: "SKIPPED_DNC" },
      });
    });
  });
});
